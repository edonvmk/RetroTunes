import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import { getDb, recalculateArtistPopularityScores, TrackRow } from './db';
import { getSettings } from './settings';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.aiff',
  '.aif',
  '.alac',
]);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.m4v', '.webm']);
const COVER_FILENAMES = new Set([
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'folder.jpg',
  'album.jpg',
  'front.jpg',
  'poster.jpg',
  'poster.png',
  'banner.jpg',
]);

export interface IndexProgress {
  running: boolean;
  phase: 'artists' | 'albums' | 'songs' | 'video' | 'metadata' | 'popularity' | 'done' | 'error';
  processed: number;
  total: number;
  currentFile: string;
  artistsFound: number;
  albumsFound: number;
  audioAdded: number;
  videoAdded: number;
  metadataHydrated: number;
}

let currentProgress: IndexProgress = {
  running: false,
  phase: 'done',
  processed: 0,
  total: 0,
  currentFile: '',
  artistsFound: 0,
  albumsFound: 0,
  audioAdded: 0,
  videoAdded: 0,
  metadataHydrated: 0,
};

let cancelRequested = false;
let backgroundHydrationRunning = false;
let lastBroadcastTime = 0;

function broadcastProgress(update: Partial<IndexProgress>, force = false) {
  currentProgress = { ...currentProgress, ...update };
  const now = Date.now();
  if (!force && now - lastBroadcastTime < 120) return;
  lastBroadcastTime = now;

  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('indexer:progress', currentProgress);
      }
    }
  } catch {
    // ignore
  }
}

function broadcastBatchCommitted() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('indexer:batchCommitted', currentProgress);
      }
    }
  } catch {
    // ignore
  }
}

export function getIndexProgress(): IndexProgress {
  return currentProgress;
}

export function cancelLibraryScan(): void {
  cancelRequested = true;
  backgroundHydrationRunning = false;
  logger.info('INDEXER', 'User requested cancellation of active scan / background hydration.');
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fast filename & directory hierarchy parser so Phase 3 ("Build directory of songs")
 * can index thousands of tracks on an NFS/SMB share in seconds WITHOUT opening files!
 * Handles Plex / Lidarr naming patterns such as:
 * - "01 - Song"
 * - "01-02 - Song"
 * - "Artist - Album - 01 - Song"
 * - "Artist_Album_01-02_Song"
 */
export function parseTrackFromHierarchy(
  filePath: string,
  rootPath: string
): {
  title: string;
  artist: string;
  album: string;
  year: number | null;
  trackNum: number | null;
  discNum: number;
  format: string;
} {
  const ext = path.extname(filePath);
  const format = ext.replace('.', '').toUpperCase() || 'AUDIO';
  const rawBase = path.basename(filePath, ext);

  const rel = rootPath ? path.relative(rootPath, filePath) : filePath;
  const parts = rel.split(path.sep).filter(Boolean);

  let artist = 'Unknown Artist';
  let rawAlbumFolder = 'Unknown Album';

  // Detect if path includes /Music/<Artist>/<Album>/...
  const musicIdx = parts.findIndex((p) => /^(music|audio|audiobooks)$/i.test(p));
  if (musicIdx >= 0 && parts.length - musicIdx >= 4) {
    artist = parts[musicIdx + 1];
    rawAlbumFolder = parts[parts.length - 2];
  } else if (parts.length >= 3) {
    artist = parts[0];
    rawAlbumFolder = parts[parts.length - 2];
  } else if (parts.length === 2) {
    artist = parts[0];
    rawAlbumFolder = 'Singles';
  }

  // Extract (YYYY) or [YYYY] from album folder name: e.g., "Echoes In Eternity (2025)"
  let year: number | null = null;
  let album = rawAlbumFolder;
  const albumYearMatch = rawAlbumFolder.match(/^(.*?)\s*[([](19\d{2}|20\d{2})[)\]]\s*$/);
  if (albumYearMatch) {
    album = albumYearMatch[1].trim() || rawAlbumFolder;
    year = parseInt(albumYearMatch[2], 10);
  }

  let candidate = rawBase.trim();

  // Strip repeated leading Artist and/or Album prefixes in filenames:
  // e.g. "Aerosmith - Done With Mirrors - 01 - Let the Music Do the Talking"
  // or "Aerosmith_A Little South of Sanity_01-01_Eat the Rich"
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (artist && artist !== 'Unknown Artist') {
    const artistRe = new RegExp(`^${escapeRegex(artist)}\\s*[-_]+\\s*`, 'i');
    candidate = candidate.replace(artistRe, '');
  }
  if (album && album !== 'Unknown Album') {
    const albumRe = new RegExp(`^${escapeRegex(album)}\\s*[-_]+\\s*`, 'i');
    candidate = candidate.replace(albumRe, '');
  }
  if (rawAlbumFolder && rawAlbumFolder !== album) {
    const rawAlbumRe = new RegExp(`^${escapeRegex(rawAlbumFolder)}\\s*[-_]+\\s*`, 'i');
    candidate = candidate.replace(rawAlbumRe, '');
  }

  // Extract disc & track number from remaining filename: e.g. "01-01_Eat the Rich", "01 - Way of War", "1-04 - Song"
  let discNum = 1;
  let trackNum: number | null = null;
  let title = candidate;

  const discTrackMatch = candidate.match(/^(\d{1,2})[-.](\d{1,3})\s*[-._)\s]+\s*(.+)$/);
  if (discTrackMatch) {
    discNum = parseInt(discTrackMatch[1], 10);
    trackNum = parseInt(discTrackMatch[2], 10);
    title = discTrackMatch[3].trim();
  } else {
    const trackMatch = candidate.match(/^(\d{1,3})\s*[-._)\s]+\s*(.+)$/);
    if (trackMatch) {
      trackNum = parseInt(trackMatch[1], 10);
      title = trackMatch[2].trim();
    } else {
      // Fallback: if filename still had "Something - Something - 01 - Title"
      const trailingNumbered = candidate.match(/^(?:.+?[-_]\s*)+(\d{1,2})-(\d{1,3})\s*[-_.\s]+\s*(.+)$/);
      if (trailingNumbered) {
        discNum = parseInt(trailingNumbered[1], 10);
        trackNum = parseInt(trailingNumbered[2], 10);
        title = trailingNumbered[3].trim();
      } else {
        const trailingSingle = candidate.match(/^(?:.+?[-_]\s*)+(\d{1,3})\s*[-_.\s]+\s*(.+)$/);
        if (trailingSingle) {
          trackNum = parseInt(trailingSingle[1], 10);
          title = trailingSingle[2].trim();
        }
      }
    }
  }

  return {
    title: title || rawBase,
    artist,
    album,
    year,
    trackNum,
    discNum,
    format,
  };
}

export function cleanReleaseGroupNoise(str: string): string {
  return str
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(
      /\(\s*(?:2160p|1080p|720p|480p|360p|240p|4k|webdl|web-dl|webrip|bluray|bdrip|remux|hdtv|dvdrip|x264|x265|h264|h265|hevc)[^)]*\)/gi,
      ' '
    )
    .replace(
      /\b(2160p|1080p|720p|480p|360p|240p|4k|webdl|web-dl|webrip|bluray|bdrip|brrip|remux|hdtv|dvdrip|sdtv|x264|x265|h264|h265|hevc|avc|eac3|ac3|atmos|truehd|dts|aac|10bit|hdr|dv|proper|repack)\b.*/i,
      ''
    )
    // Strip trailing Sonarr/Radarr release group tags like "-iVy", "-PSA", "-NTb", "-FLUX", "-RARBG", "-Seed"
    .replace(/(?:\s+|\b)-(?:[A-Za-z0-9]{2,12})\s*$/, '')
    .replace(/[-._\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseVideoFilename(filePath: string, rootPath?: string): {
  title: string;
  type: 'movie' | 'tv';
  showName: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  tvdbId: string | null;
} {
  const base = path.basename(filePath, path.extname(filePath));
  const fullNormalized = filePath.split(path.sep).join('/');

  // Detect Plex / Sonarr TV Shows hierarchy:
  // e.g. /Volumes/PVE-Media/TV Shows/Bridgerton (2020) {tvdb-366668}/Season 1/...
  // or /Volumes/PVE-Media/TV Shows/Ed, Edd n Eddy (1999) {tvdb-77466}/Specials (2002-09)/...
  // or /Volumes/PVE-Media/TV Shows/Ed, Edd n Eddy (1999) {tvdb-77466}/EXTRAS/...
  let isUnderTvRoot = false;
  let folderShowName: string | null = null;
  let folderSeasonNum: number | null = null;
  let folderYear: number | null = null;
  let tvdbId: string | null = null;

  const tvdbMatch = fullNormalized.match(/\{tvdb-(\d+)\}/i);
  if (tvdbMatch) {
    tvdbId = tvdbMatch[1];
    isUnderTvRoot = true;
  }

  const segments = fullNormalized.split('/').filter(Boolean);
  const tvRootIdx = segments.findIndex((seg) =>
    /^(tv shows|tv|television|series|shows|anime)$/i.test(seg)
  );

  if (tvRootIdx >= 0) {
    isUnderTvRoot = true;
    if (segments.length > tvRootIdx + 1) {
      const rawShowFolder = segments[tvRootIdx + 1];
      const cleanedShow = rawShowFolder
        .replace(/\{[^}]*\}/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/^Star Wars\s*-\s*/i, '')
        .trim();
      const ym = cleanedShow.match(/\((\d{4})\)/);
      if (ym) folderYear = parseInt(ym[1], 10);
      folderShowName = cleanedShow;
    }
    if (segments.length > tvRootIdx + 2) {
      const rawSeasonFolder = segments[tvRootIdx + 2];
      if (/^(specials|extras|bonus|tv movies|ova|movies|season\s*0+)$/i.test(rawSeasonFolder) || /^(specials|extras)/i.test(rawSeasonFolder)) {
        folderSeasonNum = 0;
      } else {
        const sm = rawSeasonFolder.match(/season\s*(\d{1,4})/i);
        if (sm) folderSeasonNum = parseInt(sm[1], 10);
      }
    }
  } else if (rootPath) {
    const rel = path.relative(rootPath, filePath);
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts.length >= 2) {
      let candidateShow = parts[0];
      if (/^(tv|tv shows|series|shows)$/i.test(candidateShow) && parts.length >= 3) {
        isUnderTvRoot = true;
        candidateShow = parts[1];
      }
      if (!/^season\s*\d+/i.test(candidateShow)) {
        const cleanedShow = candidateShow
          .replace(/\{[^}]*\}/g, '')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/^Star Wars\s*-\s*/i, '')
          .trim();
        const ym = cleanedShow.match(/\((\d{4})\)/);
        if (ym) folderYear = parseInt(ym[1], 10);
        folderShowName = cleanedShow;
      }
      const subFolder = parts[1] || '';
      if (/^(specials|extras|bonus|tv movies)/i.test(subFolder)) {
        isUnderTvRoot = true;
        folderSeasonNum = 0;
      } else if (/^season\s*\d+/i.test(subFolder)) {
        isUnderTvRoot = true;
        const sm = subFolder.match(/season\s*(\d{1,4})/i);
        if (sm) folderSeasonNum = parseInt(sm[1], 10);
      }
    }
  }

  // Match S01E01, S05 E23, S00E04, S2003E01, or 1x01
  const tvMatch =
    base.match(/^(.*?)[.\s_-]+[Ss](\d{1,4})\s*[Ee](\d{1,3})(?:[.\s_-]+(.*))?$/) ||
    base.match(/^(.*?)[.\s_-]+(\d{1,2})x(\d{1,3})(?:[.\s_-]+(.*))?$/);

  if (tvMatch) {
    const parsedShow = tvMatch[1]
      .replace(/[._]/g, ' ')
      .replace(/\{[^}]*\}/g, '')
      .replace(/^Star Wars\s*-\s*/i, '')
      .trim();
    const showName = folderShowName || parsedShow || 'Unknown Show';
    const season = parseInt(tvMatch[2], 10);
    const episode = parseInt(tvMatch[3], 10);
    const rawEp = tvMatch[4]
      ? tvMatch[4].replace(/^\s*-\s*/, '').replace(/[._]/g, ' ').trim()
      : `Episode ${episode}`;
    const epTitle = cleanReleaseGroupNoise(rawEp) || `Episode ${episode}`;
    const ym = showName.match(/\((\d{4})\)/);
    const year = folderYear || (ym ? parseInt(ym[1], 10) : null);
    return {
      title: epTitle,
      type: 'tv',
      showName,
      season,
      episode,
      year,
      tvdbId,
    };
  }

  // If the file is inside a TV Shows directory (e.g., Specials / EXTRAS / TV Movies without SxxExx in filename),
  // keep it in TV Shows under Season 0 (Specials / Extras) instead of misclassifying it as a Movie!
  if (isUnderTvRoot && folderShowName) {
    const cleanShowPrefix = folderShowName.replace(/\(\d{4}\)/g, '').trim();
    let rawTitle = base.replace(/[._]/g, ' ').trim();
    if (cleanShowPrefix) {
      const prefixRe = new RegExp(`^${cleanShowPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-_]+\\s*`, 'i');
      rawTitle = rawTitle.replace(prefixRe, '');
    }
    rawTitle = rawTitle.replace(/^EXTRA\s*[-_]+\s*/i, '');
    const epTitle = cleanReleaseGroupNoise(rawTitle) || base;
    return {
      title: epTitle,
      type: 'tv',
      showName: folderShowName,
      season: folderSeasonNum ?? 0,
      episode: 1,
      year: folderYear,
      tvdbId,
    };
  }

  const movieMatch = base.match(/^(.*?)[.\s([_-]+(19\d{2}|20\d{2})[)\].\s_-]*/);
  if (movieMatch) {
    const cleanTitle = cleanReleaseGroupNoise(movieMatch[1].replace(/[._]/g, ' '));
    const year = parseInt(movieMatch[2], 10);
    return {
      title: cleanTitle || base,
      type: 'movie',
      showName: null,
      season: null,
      episode: null,
      year,
      tvdbId: null,
    };
  }

  return {
    title: cleanReleaseGroupNoise(base.replace(/[._]/g, ' ')) || base,
    type: 'movie',
    showName: null,
    season: null,
    episode: null,
    year: null,
    tvdbId: null,
  };
}

interface DiscoveredAlbumDir {
  rootPath: string;
  artistName: string;
  dirPath: string;
  audioFiles: string[];
  videoFiles: string[];
  lrcFiles: Set<string>;
  folderCoverPath: string | null;
}

/**
 * Multi-Phase Non-Blocking Directory Scanner:
 * Phase 1: Scan top-level Artist / Show directories
 * Phase 2: Scan Album directories inside each Artist
 * Phase 3: Build Song & Video catalog from filenames/hierarchy in fast SQLite batches
 * Phase 4: Hydrate detailed ID3/Vorbis tags & artwork on-demand or via gentle background trickle
 */
export async function runLibraryScan(customPaths?: string[]): Promise<{
  audioAdded: number;
  videoAdded: number;
  totalAudioScanned: number;
  totalVideoScanned: number;
}> {
  if (currentProgress.running) {
    logger.warn('INDEXER', 'Library scan requested while another scan is already running.');
    return { audioAdded: 0, videoAdded: 0, totalAudioScanned: 0, totalVideoScanned: 0 };
  }

  cancelRequested = false;
  const start = Date.now();
  const settings = getSettings();
  const roots = new Set<string>();

  if (customPaths && customPaths.length > 0) {
    for (const p of customPaths) {
      if (p && fs.existsSync(p)) roots.add(p);
    }
  } else {
    if (settings.musicRootPath && fs.existsSync(settings.musicRootPath)) {
      roots.add(settings.musicRootPath);
    }
    if (settings.videoRootPath && fs.existsSync(settings.videoRootPath)) {
      roots.add(settings.videoRootPath);
    }
    if (settings.tvRootPath && fs.existsSync(settings.tvRootPath)) {
      roots.add(settings.tvRootPath);
    }
    if (settings.nfsSharePath && fs.existsSync(settings.nfsSharePath)) {
      roots.add(settings.nfsSharePath);
    }
  }

  if (roots.size === 0) {
    logger.warn('INDEXER', 'No valid Music, Video, or Share directories exist to scan.');
    return { audioAdded: 0, videoAdded: 0, totalAudioScanned: 0, totalVideoScanned: 0 };
  }

  broadcastProgress(
    {
      running: true,
      phase: 'artists',
      processed: 0,
      total: 0,
      currentFile: 'Phase 1: Building directory of artists & shows...',
      artistsFound: 0,
      albumsFound: 0,
      audioAdded: 0,
      videoAdded: 0,
      metadataHydrated: 0,
    },
    true
  );

  logger.info('INDEXER', 'Starting phased non-blocking media scan', {
    roots: Array.from(roots),
  });

  try {
    // =========================================================================
    // PHASE 1: BUILD DIRECTORY OF ARTISTS / TOP-LEVEL FOLDERS
    // =========================================================================
    const artistDirs: { rootPath: string; artistName: string; dirPath: string }[] = [];
    const rootLevelAlbumDirs: DiscoveredAlbumDir[] = [];

    for (const rootPath of roots) {
      if (cancelRequested) break;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fsp.readdir(rootPath, { withFileTypes: true });
      } catch (err) {
        logger.warn('INDEXER', `Cannot read root directory: ${rootPath}`, { error: String(err) });
        continue;
      }

      const rootAudio: string[] = [];
      const rootVideo: string[] = [];
      const rootLrc = new Set<string>();
      let rootCover: string | null = null;

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
          artistDirs.push({ rootPath, artistName: entry.name, dirPath: fullPath });
          broadcastProgress({
            phase: 'artists',
            artistsFound: artistDirs.length,
            currentFile: `Artist: ${entry.name}`,
          });
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          const ext = path.extname(lower);
          if (AUDIO_EXTENSIONS.has(ext)) rootAudio.push(fullPath);
          else if (VIDEO_EXTENSIONS.has(ext)) rootVideo.push(fullPath);
          else if (ext === '.lrc') rootLrc.add(fullPath);
          else if (COVER_FILENAMES.has(lower) && !rootCover) rootCover = fullPath;
        }
      }

      if (rootAudio.length > 0 || rootVideo.length > 0) {
        rootLevelAlbumDirs.push({
          rootPath,
          artistName: path.basename(rootPath),
          dirPath: rootPath,
          audioFiles: rootAudio,
          videoFiles: rootVideo,
          lrcFiles: rootLrc,
          folderCoverPath: rootCover,
        });
      }
      await yieldToEventLoop();
    }

    logger.info('INDEXER', `Phase 1 complete: discovered ${artistDirs.length} artist/show directories.`);

    // =========================================================================
    // PHASE 2 & 3: BUILD DIRECTORY OF ALBUMS & FAST-INDEX SONGS INCREMENTALLY
    // =========================================================================
    const db = getDb();
    const fastInsertTrack = db.prepare(`
      INSERT INTO tracks (
        remote_nfs_path, title, artist, album, year,
        track_num, disc_num, format, cover_art_path, lrc_path, metadata_loaded
      ) VALUES (
        @remote_nfs_path, @title, @artist, @album, @year,
        @track_num, @disc_num, @format, @cover_art_path, @lrc_path, 0
      )
      ON CONFLICT(remote_nfs_path) DO UPDATE SET
        cover_art_path = COALESCE(tracks.cover_art_path, excluded.cover_art_path),
        lrc_path = COALESCE(tracks.lrc_path, excluded.lrc_path)
    `);

    const fastInsertVideo = db.prepare(`
      INSERT INTO videos (
        remote_nfs_path, title, type, show_name, season, episode, year, tvdb_id, format, poster_path
      ) VALUES (
        @remote_nfs_path, @title, @type, @show_name, @season, @episode, @year, @tvdb_id, @format, @poster_path
      )
      ON CONFLICT(remote_nfs_path) DO UPDATE SET
        title = excluded.title,
        type = excluded.type,
        show_name = COALESCE(excluded.show_name, videos.show_name),
        season = COALESCE(excluded.season, videos.season),
        episode = COALESCE(excluded.episode, videos.episode),
        tvdb_id = COALESCE(excluded.tvdb_id, videos.tvdb_id),
        poster_path = COALESCE(videos.poster_path, excluded.poster_path)
    `);

    let albumsFound = rootLevelAlbumDirs.length;
    let audioAdded = 0;
    let videoAdded = 0;

    const commitAlbumBatch = db.transaction((albumObj: DiscoveredAlbumDir) => {
      for (const audioPath of albumObj.audioFiles) {
        const parsed = parseTrackFromHierarchy(audioPath, albumObj.rootPath);
        const potentialLrc = audioPath.replace(/\.[^/.]+$/, '.lrc');
        const lrcPath = albumObj.lrcFiles.has(potentialLrc) ? potentialLrc : null;

        fastInsertTrack.run({
          remote_nfs_path: audioPath,
          title: parsed.title,
          artist: parsed.artist || albumObj.artistName,
          album: parsed.album,
          year: parsed.year,
          track_num: parsed.trackNum,
          disc_num: parsed.discNum,
          format: parsed.format,
          cover_art_path: albumObj.folderCoverPath,
          lrc_path: lrcPath,
        });
        audioAdded++;
      }

      for (const videoPath of albumObj.videoFiles) {
        const ext = path.extname(videoPath).replace('.', '').toUpperCase();
        const parsedV = parseVideoFilename(videoPath, albumObj.rootPath);
        fastInsertVideo.run({
          remote_nfs_path: videoPath,
          title: parsedV.title,
          type: parsedV.type,
          show_name: parsedV.showName,
          season: parsedV.season,
          episode: parsedV.episode,
          year: parsedV.year,
          tvdb_id: parsedV.tvdbId,
          format: ext,
          poster_path: albumObj.folderCoverPath,
        });
        videoAdded++;
      }
    });

    for (const rootAlb of rootLevelAlbumDirs) {
      commitAlbumBatch(rootAlb);
    }

    // Walk each artist directory asynchronously (yielding every folder so UI never freezes!)
    const scanAlbumTree = async (
      rootPath: string,
      artistName: string,
      dirPath: string,
      depth: number
    ) => {
      if (cancelRequested || depth > 5) return;
      await yieldToEventLoop();

      let entries: fs.Dirent[] = [];
      try {
        entries = await fsp.readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      const subDirs: string[] = [];
      const audioFiles: string[] = [];
      const videoFiles: string[] = [];
      const lrcFiles = new Set<string>();
      let folderCoverPath: string | null = null;

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          subDirs.push(full);
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          const ext = path.extname(lower);
          if (AUDIO_EXTENSIONS.has(ext)) {
            audioFiles.push(full);
          } else if (VIDEO_EXTENSIONS.has(ext)) {
            videoFiles.push(full);
          } else if (ext === '.lrc') {
            lrcFiles.add(full);
          } else if (COVER_FILENAMES.has(lower) && !folderCoverPath) {
            folderCoverPath = full;
          }
        }
      }

      if (audioFiles.length > 0 || videoFiles.length > 0) {
        albumsFound++;
        commitAlbumBatch({
          rootPath,
          artistName,
          dirPath,
          audioFiles,
          videoFiles,
          lrcFiles,
          folderCoverPath,
        });

        broadcastProgress({
          phase: 'songs',
          albumsFound,
          audioAdded,
          videoAdded,
          currentFile: `${artistName} — ${path.basename(dirPath)} (${audioAdded} songs)`,
        });

        // Notify UI every 10 albums so table & Cover Flow update live during scan!
        if (albumsFound % 10 === 0) {
          broadcastBatchCommitted();
        }
      }

      for (const sub of subDirs) {
        if (cancelRequested) break;
        await scanAlbumTree(rootPath, artistName, sub, depth + 1);
      }
    };

    for (let i = 0; i < artistDirs.length; i++) {
      if (cancelRequested) break;
      const item = artistDirs[i];
      broadcastProgress({
        phase: 'albums',
        processed: i + 1,
        total: artistDirs.length,
        currentFile: `Scanning ${item.artistName}...`,
      });
      await scanAlbumTree(item.rootPath, item.artistName, item.dirPath, 1);
    }

    broadcastProgress(
      {
        running: false,
        phase: 'done',
        processed: artistDirs.length,
        total: artistDirs.length,
        albumsFound,
        audioAdded,
        videoAdded,
        currentFile: `Indexed ${audioAdded} songs across ${albumsFound} albums.`,
      },
      true
    );
    broadcastBatchCommitted();

    logger.info(
      'INDEXER',
      `Phased directory scan finished in ${Date.now() - start}ms: ${ artistDirs.length } artists, ${albumsFound} albums, ${audioAdded} songs, ${videoAdded} videos.`,
      { artists: artistDirs.length, albumsFound, audioAdded, videoAdded },
      Date.now() - start
    );

    // Hydrate TV & Movie poster artwork in the background
    void hydrateVideoArtwork();

    // Scan extended media sections (Music Videos, Books, Audiobooks, Photos)
    await scanExtendedMediaSections();

    // Kick off gentle background metadata trickle if hybrid mode is enabled
    if (settings.metadataHydrationMode === 'hybrid' && !cancelRequested) {
      void startBackgroundMetadataTrickle();
    }

    return {
      audioAdded,
      videoAdded,
      totalAudioScanned: audioAdded,
      totalVideoScanned: videoAdded,
    };
  } catch (err) {
    broadcastProgress(
      {
        running: false,
        phase: 'error',
        currentFile: String(err),
      },
      true
    );
    logger.error('INDEXER', 'Phased library scan error', err, Date.now() - start);
    throw err;
  }
}

/**
 * Hydrates full ID3/Vorbis/FLAC tags, duration, bitrate, MBID, and embedded cover art
 * for a single track on-demand (e.g. when played or selected) or during background trickle.
 */
export async function hydrateTrackMetadata(
  trackId: number,
  extractCoverIfMissing = true
): Promise<TrackRow | null> {
  const db = getDb();
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as TrackRow | undefined;
  if (!track) return null;
  if (track.metadata_loaded === 1 && track.duration > 0) return track;

  const filePath = track.remote_nfs_path;
  try {
    const stat = await fsp.stat(filePath);
    const mm = await import('music-metadata');
    const settings = getSettings();
    const artworkDir = path.join(settings.localCachePath, 'artwork');

    // Only parse embedded cover art if the track/album doesn't already have a cover_art_path!
    const needCover = extractCoverIfMissing && !track.cover_art_path;
    const metadata = await mm.parseFile(filePath, {
      duration: true,
      skipCovers: !needCover,
      skipPostHeaders: true,
    });

    const common = metadata.common;
    const format = metadata.format;
    let coverArtPath = track.cover_art_path;

    if (needCover && common.picture && common.picture.length > 0) {
      const pic = common.picture[0];
      const hash = crypto
        .createHash('md5')
        .update(`${common.artist || track.artist}-${common.album || track.album}`)
        .digest('hex');
      const artFile = path.join(artworkDir, `${hash}.jpg`);
      if (!fs.existsSync(artFile)) {
        await fsp.mkdir(artworkDir, { recursive: true });
        await fsp.writeFile(artFile, pic.data);
      }
      coverArtPath = artFile;

      // Apply this newly extracted cover art to all tracks on the same album!
      db.prepare(
        'UPDATE tracks SET cover_art_path = ? WHERE artist = ? AND album = ? AND cover_art_path IS NULL'
      ).run(artFile, track.artist, track.album);
    }

    db.prepare(`
      UPDATE tracks SET
        title = COALESCE(?, title),
        artist = COALESCE(?, artist),
        album = COALESCE(?, album),
        genre = CASE WHEN ? != '' THEN ? ELSE genre END,
        year = COALESCE(?, year),
        track_num = COALESCE(?, track_num),
        disc_num = COALESCE(?, disc_num),
        duration = CASE WHEN ? > 0 THEN ? ELSE duration END,
        bitrate = CASE WHEN ? > 0 THEN ? ELSE bitrate END,
        file_size = ?,
        cover_art_path = COALESCE(?, cover_art_path),
        mbid_recording = COALESCE(?, mbid_recording),
        mbid_artist = COALESCE(?, mbid_artist),
        metadata_loaded = 1
      WHERE id = ?
    `).run(
      common.title || null,
      common.artist || common.albumartist || null,
      common.album || null,
      common.genre?.[0] || '',
      common.genre?.[0] || '',
      common.year || null,
      common.track?.no || null,
      common.disk?.no || null,
      format.duration || 0,
      format.duration || 0,
      format.bitrate ? Math.round(format.bitrate / 1000) : 0,
      format.bitrate ? Math.round(format.bitrate / 1000) : 0,
      stat.size,
      coverArtPath,
      common.musicbrainz_recordingid || common.musicbrainz_trackid || null,
      common.musicbrainz_artistid?.[0] || null,
      track.id
    );

    return db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as TrackRow;
  } catch (err) {
    // Mark metadata_loaded = -1 so a missing/offline network file isn't retried endlessly
    db.prepare('UPDATE tracks SET metadata_loaded = -1 WHERE id = ?').run(track.id);
    logger.debug('INDEXER', `Skipped tag hydration for ${filePath}`, { error: String(err) });
    return track;
  }
}

/**
 * On-demand hydration for an entire album when the user views it in Cover Flow, Grid, or Column Browser.
 */
export async function hydrateAlbumMetadata(artist: string, album: string): Promise<TrackRow[]> {
  const db = getDb();
  const albumTracks = db
    .prepare('SELECT * FROM tracks WHERE artist = ? AND album = ? ORDER BY disc_num ASC, track_num ASC')
    .all(artist, album) as TrackRow[];

  let firstCoverExtracted = false;
  for (const t of albumTracks) {
    if (t.metadata_loaded === 0) {
      await hydrateTrackMetadata(t.id, !firstCoverExtracted);
      firstCoverExtracted = true;
      await yieldToEventLoop();
    }
  }

  return db
    .prepare('SELECT * FROM tracks WHERE artist = ? AND album = ? ORDER BY disc_num ASC, track_num ASC')
    .all(artist, album) as TrackRow[];
}

/**
 * Gentle background trickle worker that hydrates remaining unhydrated tracks
 * without saturating the SMB/NFS network share or blocking the UI.
 */
export async function startBackgroundMetadataTrickle(): Promise<void> {
  if (backgroundHydrationRunning || currentProgress.running) return;
  backgroundHydrationRunning = true;

  const db = getDb();
  let hydratedCount = 0;

  try {
    while (backgroundHydrationRunning && !cancelRequested) {
      const settings = getSettings();
      if (settings.metadataHydrationMode === 'on_demand') {
        break;
      }

      // Grab next 10 unhydrated tracks, prioritizing one track per album first so album covers populate quickly!
      const batch = db
        .prepare(
          `SELECT id, artist, album FROM tracks
           WHERE metadata_loaded = 0
           GROUP BY artist, album
           LIMIT 10`
        )
        .all() as { id: number; artist: string; album: string }[];

      const targetBatch =
        batch.length > 0
          ? batch
          : (db
              .prepare('SELECT id, artist, album FROM tracks WHERE metadata_loaded = 0 LIMIT 10')
              .all() as { id: number; artist: string; album: string }[]);

      if (targetBatch.length === 0) {
        break;
      }

      for (const item of targetBatch) {
        if (!backgroundHydrationRunning || cancelRequested) break;
        await hydrateTrackMetadata(item.id, true);
        hydratedCount++;
        // Polite 60ms pause between network files so SMB/NFS share never chokes
        await new Promise((r) => setTimeout(r, 60));
      }

      if (hydratedCount % 25 === 0) {
        broadcastBatchCommitted();
      }
    }
  } finally {
    backgroundHydrationRunning = false;
    broadcastBatchCommitted();
  }
}

function normalizeSongTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\((feat|ft|with|remaster|live|acoustic|bonus|deluxe|version|edit)[^)]*\)/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Queries ListenBrainz & MusicBrainz APIs to populate global_listen_count
 * and mbid_recording for indexed tracks, then recalculates Artist-Relative
 * Median Popularity scores (Section 5).
 */
export async function syncListenBrainzPopularity(): Promise<{
  tracksChecked: number;
  mbidsResolved: number;
  popularityUpdated: number;
  artistsNormalized: number;
}> {
  const start = Date.now();
  const db = getDb();
  const settings = getSettings();
  const totalTracksCount = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;

  if (totalTracksCount === 0) {
    logger.info('LISTENBRAINZ', 'No tracks in database to fetch ListenBrainz popularity for.');
    return { tracksChecked: 0, mbidsResolved: 0, popularityUpdated: 0, artistsNormalized: 0 };
  }

  broadcastProgress(
    {
      running: true,
      phase: 'popularity',
      processed: 0,
      total: totalTracksCount,
      currentFile: 'Fetching ListenBrainz global listen counts for known MBIDs...',
    },
    true
  );

  logger.info('LISTENBRAINZ', `Starting ListenBrainz popularity ingestion for ${totalTracksCount} tracks.`);

  let mbidsResolved = 0;
  let popularityUpdated = 0;

  const updateListenCountByMbid = db.prepare(
    'UPDATE tracks SET global_listen_count = ? WHERE mbid_recording = ?'
  );

  // STEP 1: Immediately batch-query all tracks that already have mbid_recording in SQLite (100 MBIDs per request!)
  const tracksWithMbid = db
    .prepare("SELECT DISTINCT mbid_recording FROM tracks WHERE mbid_recording IS NOT NULL AND mbid_recording != ''")
    .all() as { mbid_recording: string }[];

  if (tracksWithMbid.length > 0) {
    const mbidList = tracksWithMbid.map((t) => t.mbid_recording);
    const batchSize = 100;
    for (let i = 0; i < mbidList.length; i += batchSize) {
      if (cancelRequested) break;
      const batch = mbidList.slice(i, i + batchSize);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (settings.listenbrainzToken) {
          headers.Authorization = `Token ${settings.listenbrainzToken.trim()}`;
        }
        const res = await fetch('https://api.listenbrainz.org/1/popularity/recording', {
          method: 'POST',
          headers,
          body: JSON.stringify({ recording_mbids: batch }),
        });

        if (res.ok) {
          const popData = (await res.json()) as {
            recording_mbid: string;
            total_listen_count: number | null;
          }[];

          const tx = db.transaction(() => {
            for (const item of popData) {
              if (item.recording_mbid && typeof item.total_listen_count === 'number') {
                const info = updateListenCountByMbid.run(item.total_listen_count, item.recording_mbid);
                popularityUpdated += info.changes;
              }
            }
          });
          tx();
        }
      } catch (err) {
        logger.warn('LISTENBRAINZ', 'ListenBrainz popularity batch fetch error', {
          error: String(err),
        });
      }
      broadcastProgress({
        phase: 'popularity',
        processed: Math.min(mbidList.length, i + batchSize),
        total: mbidList.length,
        currentFile: `Updated ${popularityUpdated} tracks from recording MBIDs...`,
      });
    }
    recalculateArtistPopularityScores();
    broadcastBatchCommitted();
  }

  // STEP 2: Artist-level bulk resolution via ListenBrainz top-recordings-for-artist
  // Resolves entire artist catalogs (all songs at once) instead of 1 track per second!
  const artistsToSync = db
    .prepare(
      `SELECT artist, MAX(mbid_artist) as mbid_artist, COUNT(*) as cnt
       FROM tracks
       WHERE artist IS NOT NULL AND artist != '' AND artist != 'Unknown Artist'
         AND global_listen_count = 0
       GROUP BY artist
       ORDER BY (CASE WHEN MAX(mbid_artist) IS NOT NULL AND MAX(mbid_artist) != '' THEN 0 ELSE 1 END), cnt DESC
       LIMIT 60`
    )
    .all() as { artist: string; mbid_artist: string | null; cnt: number }[];

  const setArtistMbidStmt = db.prepare('UPDATE tracks SET mbid_artist = ? WHERE artist = ?');
  const getArtistTracksStmt = db.prepare(
    'SELECT id, title, mbid_recording, global_listen_count FROM tracks WHERE artist = ?'
  );
  const updateTrackPopAndMbid = db.prepare(
    'UPDATE tracks SET global_listen_count = ?, mbid_recording = COALESCE(mbid_recording, ?), mbid_artist = COALESCE(mbid_artist, ?) WHERE id = ?'
  );

  for (let idx = 0; idx < artistsToSync.length; idx++) {
    if (cancelRequested) break;
    const artRow = artistsToSync[idx];
    let artistMbid = artRow.mbid_artist;

    broadcastProgress({
      phase: 'popularity',
      processed: idx + 1,
      total: artistsToSync.length,
      currentFile: `Syncing artist catalog: ${artRow.artist} (${idx + 1}/${artistsToSync.length})`,
    });

    // Resolve artist MBID via MusicBrainz if missing
    if (!artistMbid) {
      try {
        const mbUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(`"${artRow.artist.replace(/"/g, '')}"`)}&limit=1&fmt=json`;
        const mbRes = await fetch(mbUrl, {
          headers: {
            'User-Agent': 'RetroTunes/1.0.0 ( https://retrotunes.local )',
            Accept: 'application/json',
          },
        });
        if (mbRes.ok) {
          const mbData = (await mbRes.json()) as { artists?: { id: string; name: string }[] };
          if (mbData.artists?.[0]?.id) {
            artistMbid = mbData.artists[0].id;
            setArtistMbidStmt.run(artistMbid, artRow.artist);
          }
        }
        await new Promise((r) => setTimeout(r, 1050));
      } catch {
        // skip
      }
    }

    if (!artistMbid) continue;

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (settings.listenbrainzToken) {
        headers.Authorization = `Token ${settings.listenbrainzToken.trim()}`;
      }
      const lbRes = await fetch(
        `https://api.listenbrainz.org/1/popularity/top-recordings-for-artist/${artistMbid}`,
        { headers }
      );
      if (lbRes.ok) {
        const recordings = (await lbRes.json()) as {
          recording_mbid?: string;
          recording_name?: string;
          total_listen_count?: number | null;
        }[];

        if (Array.isArray(recordings) && recordings.length > 0) {
          const normMap = new Map<string, { mbid: string | null; count: number }>();
          for (const rec of recordings) {
            if (!rec.recording_name || typeof rec.total_listen_count !== 'number') continue;
            const key = normalizeSongTitle(rec.recording_name);
            if (!key) continue;
            const existing = normMap.get(key);
            if (!existing || rec.total_listen_count > existing.count) {
              normMap.set(key, {
                mbid: rec.recording_mbid || null,
                count: rec.total_listen_count,
              });
            }
          }

          const localTracks = getArtistTracksStmt.all(artRow.artist) as {
            id: number;
            title: string;
            mbid_recording: string | null;
            global_listen_count: number;
          }[];

          const tx = db.transaction(() => {
            for (const lt of localTracks) {
              const normTitle = normalizeSongTitle(lt.title);
              const matched = normMap.get(normTitle);
              if (matched) {
                updateTrackPopAndMbid.run(matched.count, matched.mbid, artistMbid, lt.id);
                popularityUpdated++;
                if (!lt.mbid_recording && matched.mbid) mbidsResolved++;
              }
            }
          });
          tx();
        }
      }
      await new Promise((r) => setTimeout(r, 220));
    } catch (err) {
      logger.debug('LISTENBRAINZ', `Artist popularity fetch skipped for ${artRow.artist}`, {
        error: String(err),
      });
    }

    if ((idx + 1) % 5 === 0) {
      recalculateArtistPopularityScores();
      broadcastBatchCommitted();
    }
  }

  const norm = recalculateArtistPopularityScores();

  broadcastProgress(
    {
      running: false,
      phase: 'done',
      processed: artistsToSync.length,
      total: artistsToSync.length,
      currentFile: `Updated ${popularityUpdated} tracks across ${norm.artistsUpdated} artists.`,
    },
    true
  );
  broadcastBatchCommitted();

  logger.info(
    'LISTENBRAINZ',
    `ListenBrainz popularity sync finished: ${mbidsResolved} MBIDs resolved, ${popularityUpdated} listen counts updated, ${norm.artistsUpdated} artists normalized.`,
    { mbidsResolved, popularityUpdated, artistsNormalized: norm.artistsUpdated },
    Date.now() - start
  );

  return {
    tracksChecked: totalTracksCount,
    mbidsResolved,
    popularityUpdated,
    artistsNormalized: norm.artistsUpdated,
  };
}

/**
 * Hydrates missing poster artwork for TV Shows and Movies from local folder images,
 * TVMaze API (for TV shows), or IMDb suggestion API (for Movies), caching locally.
 */
export async function hydrateVideoArtwork(): Promise<number> {
  const db = getDb();
  const settings = getSettings();
  const artworkDir = path.join(settings.localCachePath, 'artwork');
  await fsp.mkdir(artworkDir, { recursive: true });

  let updated = 0;

  // 1. Hydrate TV Shows grouped by show_name
  const missingShows = db
    .prepare(
      `SELECT DISTINCT show_name FROM videos
       WHERE type = 'tv' AND show_name IS NOT NULL AND show_name != ''
         AND (poster_path IS NULL OR poster_path = '')`
    )
    .all() as { show_name: string }[];

  for (const { show_name } of missingShows) {
    try {
      const cleanName = show_name.replace(/\(\d{4}\)/g, '').replace(/\{[^}]+\}/g, '').trim();
      const res = await fetch(
        `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(cleanName)}`
      );
      if (res.ok) {
        const data = (await res.json()) as {
          image?: { medium?: string; original?: string };
        };
        const imgUrl = data.image?.medium || data.image?.original;
        if (imgUrl) {
          const hash = crypto.createHash('md5').update(`tv-${show_name}`).digest('hex');
          const targetFile = path.join(artworkDir, `tv_${hash}.jpg`);
          if (!fs.existsSync(targetFile)) {
            const imgRes = await fetch(imgUrl);
            if (imgRes.ok) {
              const buf = Buffer.from(await imgRes.arrayBuffer());
              await fsp.writeFile(targetFile, buf);
            }
          }
          if (fs.existsSync(targetFile)) {
            db.prepare('UPDATE videos SET poster_path = ? WHERE show_name = ?').run(
              targetFile,
              show_name
            );
            updated++;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Hydrate Movies missing poster_path
  const missingMovies = db
    .prepare(
      `SELECT id, title, year FROM videos
       WHERE type = 'movie' AND (poster_path IS NULL OR poster_path = '')
       LIMIT 40`
    )
    .all() as { id: number; title: string; year: number | null }[];

  for (const mov of missingMovies) {
    try {
      const cleanTitle = mov.title.replace(/\(\d{4}\)/g, '').trim();
      const firstChar = (cleanTitle[0] || 'a').toLowerCase().replace(/[^a-z0-9]/, 'a');
      const res = await fetch(
        `https://v3.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(cleanTitle)}.json`
      );
      if (res.ok) {
        const data = (await res.json()) as {
          d?: { l?: string; y?: number; i?: { imageUrl?: string } }[];
        };
        const match =
          data.d?.find((d) => d.i?.imageUrl && (!mov.year || d.y === mov.year)) ||
          data.d?.find((d) => d.i?.imageUrl);
        if (match?.i?.imageUrl) {
          const hash = crypto.createHash('md5').update(`mov-${mov.id}-${mov.title}`).digest('hex');
          const targetFile = path.join(artworkDir, `mov_${hash}.jpg`);
          if (!fs.existsSync(targetFile)) {
            const imgRes = await fetch(match.i.imageUrl);
            if (imgRes.ok) {
              const buf = Buffer.from(await imgRes.arrayBuffer());
              await fsp.writeFile(targetFile, buf);
            }
          }
          if (fs.existsSync(targetFile)) {
            db.prepare('UPDATE videos SET poster_path = ? WHERE id = ?').run(targetFile, mov.id);
            updated++;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (updated > 0) {
    broadcastBatchCommitted();
  }
  return updated;
}

/**
 * Cleans and normalizes all existing Track and Video titles in SQLite (even offline without NAS access),
 * reclassifies TV Shows / Specials / Extras that were mistakenly tagged as Movies, strips Sonarr/Radarr
 * release group suffixes (-iVy, -PSA, etc.), and optionally kicks off background ID3 tag hydration.
 */
export async function cleanAndHydrateAllLibraryTitles(triggerTagSweep = true): Promise<{
  tracksCleaned: number;
  videosCleaned: number;
  tvReclassified: number;
}> {
  const start = Date.now();
  const db = getDb();
  const settings = getSettings();

  logger.info('INDEXER', 'Starting full library title & hierarchy cleanup pass across SQLite...');

  broadcastProgress(
    {
      running: true,
      phase: 'metadata',
      processed: 0,
      total: 100,
      currentFile: 'Cleaning track titles, stripping artist/album prefixes & extracting track numbers...',
    },
    true
  );

  // 1. Clean all Track rows
  const allTracks = db
    .prepare('SELECT id, remote_nfs_path, title, artist, album, track_num, disc_num, year FROM tracks')
    .all() as {
    id: number;
    remote_nfs_path: string;
    title: string;
    artist: string;
    album: string;
    track_num: number | null;
    disc_num: number | null;
    year: number | null;
  }[];

  const updateTrackCleanStmt = db.prepare(`
    UPDATE tracks
    SET title = ?,
        track_num = COALESCE(track_num, ?),
        disc_num = COALESCE(disc_num, ?),
        year = COALESCE(year, ?)
    WHERE id = ?
  `);

  let tracksCleaned = 0;
  const CHUNK_SIZE = 2500;
  for (let i = 0; i < allTracks.length; i += CHUNK_SIZE) {
    await yieldToEventLoop();
    const slice = allTracks.slice(i, i + CHUNK_SIZE);
    const tx = db.transaction(() => {
      for (const t of slice) {
        const parsed = parseTrackFromHierarchy(t.remote_nfs_path, settings.musicRootPath || '');
        if (parsed.title !== t.title || (t.track_num === null && parsed.trackNum !== null)) {
          updateTrackCleanStmt.run(
            parsed.title,
            parsed.trackNum,
            parsed.discNum,
            parsed.year,
            t.id
          );
          tracksCleaned++;
        }
      }
    });
    tx();
    broadcastProgress({
      running: true,
      phase: 'metadata',
      processed: Math.min(allTracks.length, i + CHUNK_SIZE),
      total: Math.max(1, allTracks.length),
      currentFile: `Cleaned ${tracksCleaned} song titles (${Math.min(allTracks.length, i + CHUNK_SIZE).toLocaleString()}/${allTracks.length.toLocaleString()})...`,
    });
  }

  // 2. Clean all Video rows & reclassify TV Specials/Extras
  const allVideos = db
    .prepare('SELECT id, remote_nfs_path, title, type, show_name, season, episode, year, tvdb_id FROM videos')
    .all() as {
    id: number;
    remote_nfs_path: string;
    title: string;
    type: 'movie' | 'tv';
    show_name: string | null;
    season: number | null;
    episode: number | null;
    year: number | null;
    tvdb_id: string | null;
  }[];

  const updateVideoCleanStmt = db.prepare(`
    UPDATE videos
    SET title = ?,
        type = ?,
        show_name = ?,
        season = ?,
        episode = ?,
        year = COALESCE(year, ?),
        tvdb_id = COALESCE(tvdb_id, ?)
    WHERE id = ?
  `);

  let videosCleaned = 0;
  let tvReclassified = 0;

  const videoTx = db.transaction(() => {
    for (const v of allVideos) {
      const parsed = parseVideoFilename(v.remote_nfs_path, settings.tvRootPath || settings.videoRootPath || '');
      const changed =
        parsed.title !== v.title ||
        parsed.type !== v.type ||
        parsed.showName !== v.show_name ||
        parsed.season !== v.season;

      if (changed) {
        if (v.type === 'movie' && parsed.type === 'tv') {
          tvReclassified++;
        }
        updateVideoCleanStmt.run(
          parsed.title,
          parsed.type,
          parsed.showName,
          parsed.season,
          parsed.episode,
          parsed.year,
          parsed.tvdbId,
          v.id
        );
        videosCleaned++;
      }
    }
  });
  videoTx();

  // Also reset metadata_loaded = -1 back to 0 so any tracks that failed when NAS was unmounted will be hydrated when online!
  db.prepare('UPDATE tracks SET metadata_loaded = 0 WHERE metadata_loaded = -1').run();

  broadcastProgress(
    {
      running: false,
      phase: 'done',
      processed: allTracks.length,
      total: allTracks.length,
      currentFile: `Cleaned ${tracksCleaned} tracks & ${videosCleaned} videos (${tvReclassified} TV specials reclassified).`,
    },
    true
  );
  broadcastBatchCommitted();

  logger.info(
    'INDEXER',
    `Completed library title & hierarchy cleanup: ${tracksCleaned} tracks cleaned, ${videosCleaned} videos cleaned, ${tvReclassified} TV specials/extras moved from Movies to TV Shows.`,
    { tracksCleaned, videosCleaned, tvReclassified },
    Date.now() - start
  );

  void hydrateVideoArtwork();
  if (triggerTagSweep) {
    void startBackgroundMetadataTrickle();
  }

  return { tracksCleaned, videosCleaned, tvReclassified };
}

/**
 * Priority 7: Scans configured Music Videos, Books (eBooks), Audiobooks, and Photos folders into SQLite.
 */
export async function scanExtendedMediaSections(): Promise<{
  musicVideosAdded: number;
  booksAdded: number;
  audiobooksAdded: number;
  photosAdded: number;
}> {
  const settings = getSettings();
  const db = getDb();
  let musicVideosAdded = 0;
  let booksAdded = 0;
  let audiobooksAdded = 0;
  let photosAdded = 0;

  const walkFiles = async (dir: string, exts: Set<string>, maxDepth = 4, depth = 0): Promise<string[]> => {
    if (depth > maxDepth || !dir || !fs.existsSync(dir)) return [];
    const out: string[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await walkFiles(full, exts, maxDepth, depth + 1);
        out.push(...sub);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.has(ext)) out.push(full);
      }
    }
    return out;
  };

  // 1. Music Videos
  if (settings.musicVideosRootPath && fs.existsSync(settings.musicVideosRootPath)) {
    const mvFiles = await walkFiles(
      settings.musicVideosRootPath,
      new Set(['.mp4', '.mkv', '.mov', '.m4v', '.webm'])
    );
    const insMv = db.prepare(`
      INSERT OR IGNORE INTO videos (title, type, artist, duration, resolution, remote_nfs_path)
      VALUES (?, 'music_video', ?, 0, '1080p', ?)
    `);
    for (const f of mvFiles) {
      const base = path.basename(f, path.extname(f));
      const parentDir = path.basename(path.dirname(f));
      const parts = base.split(/\s+-\s+/);
      const artist = parts.length >= 2 ? parts[0].trim() : parentDir;
      const title = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : base;
      const info = insMv.run(title, artist, f);
      musicVideosAdded += info.changes;
    }
  }

  // 2. Books (eBooks)
  if (settings.booksRootPath && fs.existsSync(settings.booksRootPath)) {
    const bookFiles = await walkFiles(
      settings.booksRootPath,
      new Set(['.epub', '.pdf', '.mobi', '.azw3', '.cbz'])
    );
    const insBook = db.prepare(`
      INSERT OR IGNORE INTO books (title, author, format, remote_path, file_size)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const f of bookFiles) {
      const ext = path.extname(f).replace('.', '').toUpperCase();
      const title = path.basename(f, path.extname(f));
      const author = path.basename(path.dirname(f));
      let sz = 0;
      try {
        sz = fs.statSync(f).size;
      } catch {
        // ignore
      }
      const info = insBook.run(title, author, ext, f, sz);
      booksAdded += info.changes;
    }
  }

  // 3. Audiobooks
  if (settings.audiobooksRootPath && fs.existsSync(settings.audiobooksRootPath)) {
    const abFiles = await walkFiles(
      settings.audiobooksRootPath,
      new Set(['.m4b', '.mp3', '.m4a', '.flac'])
    );
    const insAb = db.prepare(`
      INSERT OR IGNORE INTO audiobooks (title, author, remote_path, file_size)
      VALUES (?, ?, ?, ?)
    `);
    for (const f of abFiles) {
      const title = path.basename(f, path.extname(f));
      const author = path.basename(path.dirname(f));
      let sz = 0;
      try {
        sz = fs.statSync(f).size;
      } catch {
        // ignore
      }
      const info = insAb.run(title, author, f, sz);
      audiobooksAdded += info.changes;
    }
  }

  // 4. Photos
  if (settings.photosRootPath && fs.existsSync(settings.photosRootPath)) {
    const photoFiles = await walkFiles(
      settings.photosRootPath,
      new Set(['.jpg', '.jpeg', '.png', '.webp'])
    );
    const insPhoto = db.prepare(`
      INSERT OR IGNORE INTO photos (title, album_name, remote_path, file_size)
      VALUES (?, ?, ?, ?)
    `);
    for (const f of photoFiles) {
      const title = path.basename(f, path.extname(f));
      const album = path.basename(path.dirname(f));
      let sz = 0;
      try {
        sz = fs.statSync(f).size;
      } catch {
        // ignore
      }
      const info = insPhoto.run(title, album, f, sz);
      photosAdded += info.changes;
    }
  }

  return { musicVideosAdded, booksAdded, audiobooksAdded, photosAdded };
}

/**
 * Priority 6.3: Bidirectional Resume & Watched Progress Sync with Plex and Audiobookshelf.
 */
export async function syncPlexAndAudiobookshelfProgress(): Promise<{
  plexSynced: number;
  audiobookshelfSynced: number;
}> {
  const settings = getSettings();
  const db = getDb();
  let plexSynced = 0;
  let audiobookshelfSynced = 0;

  if (settings.plexUrl && settings.plexToken) {
    try {
      const base = settings.plexUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/library/onDeck`, {
        headers: {
          'X-Plex-Token': settings.plexToken.trim(),
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          MediaContainer?: {
            Metadata?: {
              title?: string;
              grandparentTitle?: string;
              parentIndex?: number;
              index?: number;
              viewOffset?: number;
              viewCount?: number;
            }[];
          };
        };
        const items = data.MediaContainer?.Metadata || [];
        const updateEpStmt = db.prepare(
          `UPDATE videos SET view_offset_ms = ?, watched = CASE WHEN ? > 0 THEN 1 ELSE watched END WHERE type = 'tv' AND LOWER(show_name) = LOWER(?) AND season = ? AND episode = ?`
        );
        const updateMovStmt = db.prepare(
          `UPDATE videos SET view_offset_ms = ?, watched = CASE WHEN ? > 0 THEN 1 ELSE watched END WHERE type = 'movie' AND LOWER(title) = LOWER(?)`
        );
        for (const item of items) {
          if (item.grandparentTitle && item.parentIndex !== undefined && item.index !== undefined) {
            const info = updateEpStmt.run(
              item.viewOffset || 0,
              item.viewCount || 0,
              item.grandparentTitle,
              item.parentIndex,
              item.index
            );
            plexSynced += info.changes;
          } else if (item.title) {
            const info = updateMovStmt.run(
              item.viewOffset || 0,
              item.viewCount || 0,
              item.title
            );
            plexSynced += info.changes;
          }
        }
      }
    } catch (err) {
      logger.debug('INDEXER', 'Plex On Deck sync skipped', { error: String(err) });
    }
  }

  if (settings.audiobookshelfUrl && settings.audiobookshelfToken) {
    try {
      const base = settings.audiobookshelfUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/api/me`, {
        headers: {
          Authorization: `Bearer ${settings.audiobookshelfToken.trim()}`,
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          mediaProgress?: {
            id: string;
            libraryItemId: string;
            currentTime?: number;
            duration?: number;
            isFinished?: boolean;
          }[];
        };
        const updAb = db.prepare(
          'UPDATE audiobooks SET current_time_sec = ?, duration = COALESCE(NULLIF(?, 0), duration), is_finished = ? WHERE abs_item_id = ?'
        );
        for (const mp of data.mediaProgress || []) {
          const info = updAb.run(
            mp.currentTime || 0,
            mp.duration || 0,
            mp.isFinished ? 1 : 0,
            mp.libraryItemId
          );
          audiobookshelfSynced += info.changes;
        }
      }
    } catch (err) {
      logger.debug('INDEXER', 'Audiobookshelf progress sync skipped', { error: String(err) });
    }
  }

  return { plexSynced, audiobookshelfSynced };
}

export async function updateVideoPlaybackProgress(
  videoId: number,
  viewOffsetMs: number,
  watched: boolean
): Promise<void> {
  const db = getDb();
  db.prepare(
    'UPDATE videos SET view_offset_ms = ?, watched = ?, play_count = CASE WHEN ? = 1 AND watched = 0 THEN COALESCE(play_count, 0) + 1 ELSE play_count END WHERE id = ?'
  ).run(Math.max(0, Math.round(viewOffsetMs)), watched ? 1 : 0, watched ? 1 : 0, videoId);
}

export async function updateAudiobookPlaybackProgress(
  audiobookId: number,
  currentTimeSec: number,
  isFinished: boolean
): Promise<void> {
  const db = getDb();
  db.prepare(
    'UPDATE audiobooks SET current_time_sec = ?, is_finished = ? WHERE id = ?'
  ).run(Math.max(0, currentTimeSec), isFinished ? 1 : 0, audiobookId);
}
