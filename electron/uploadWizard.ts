import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getSettings } from './settings';
import { getDb } from './db';
import { logger } from './logger';

export type UploadMediaType =
  | 'music'
  | 'movie'
  | 'tv'
  | 'music_video'
  | 'book'
  | 'audiobook'
  | 'photo';

export interface UploadMetadataMatch {
  id: string;
  title: string;
  subtitle: string;
  year?: number;
  artistOrAuthor?: string;
  albumOrShow?: string;
  season?: number;
  episode?: number;
  coverUrl?: string;
  foreignId?: string;
}

export interface UploadPreviewPlan {
  mediaType: UploadMediaType;
  targetRootDir: string;
  namingSchemeSummary: string;
  items: {
    sourcePath: string;
    destinationPath: string;
    formattedRelativePath: string;
  }[];
}

/**
 * Step 2: Searches *arr / MusicBrainz / TVMaze / OpenLibrary public metadata APIs for official release matching.
 */
export async function searchUploadMetadata(
  mediaType: UploadMediaType,
  query: string
): Promise<UploadMetadataMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const settings = getSettings();
  const results: UploadMetadataMatch[] = [];

  try {
    if (mediaType === 'movie') {
      if (settings.radarrUrl && settings.radarrApiKey) {
        const url = `${settings.radarrUrl.replace(/\/+$/, '')}/api/v3/movie/lookup?term=${encodeURIComponent(q)}`;
        const res = await fetch(url, {
          headers: { 'X-Api-Key': settings.radarrApiKey },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            tmdbId?: number;
            title: string;
            year?: number;
            overview?: string;
            remotePoster?: string;
          }[];
          for (const item of data.slice(0, 12)) {
            results.push({
              id: String(item.tmdbId || item.title),
              title: item.title,
              subtitle: `Movie (${item.year || 'Unknown Year'}) • Radarr TMDB #${item.tmdbId || ''}`,
              year: item.year,
              coverUrl: item.remotePoster,
              foreignId: String(item.tmdbId || ''),
            });
          }
          if (results.length > 0) return results;
        }
      }
      // Fallback public lookup via TVMaze / OMDb-compatible query
      const res = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const list = (await res.json()) as {
          show: { id: number; name: string; premiered?: string; image?: { medium?: string } };
        }[];
        for (const item of list.slice(0, 8)) {
          const yr = item.show.premiered ? parseInt(item.show.premiered.slice(0, 4), 10) : undefined;
          results.push({
            id: String(item.show.id),
            title: item.show.name,
            subtitle: `Feature (${yr || 'N/A'})`,
            year: yr,
            coverUrl: item.show.image?.medium,
          });
        }
      }
      return results;
    }

    if (mediaType === 'tv') {
      if (settings.sonarrUrl && settings.sonarrApiKey) {
        const url = `${settings.sonarrUrl.replace(/\/+$/, '')}/api/v3/series/lookup?term=${encodeURIComponent(q)}`;
        const res = await fetch(url, {
          headers: { 'X-Api-Key': settings.sonarrApiKey },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            tvdbId?: number;
            title: string;
            year?: number;
            remotePoster?: string;
          }[];
          for (const item of data.slice(0, 12)) {
            results.push({
              id: String(item.tvdbId || item.title),
              title: item.title,
              subtitle: `TV Series (${item.year || 'N/A'}) • Sonarr TVDB #${item.tvdbId || ''}`,
              year: item.year,
              albumOrShow: item.title,
              season: 1,
              episode: 1,
              coverUrl: item.remotePoster,
              foreignId: String(item.tvdbId || ''),
            });
          }
          if (results.length > 0) return results;
        }
      }
      const res = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const list = (await res.json()) as {
          show: { id: number; name: string; premiered?: string; image?: { medium?: string } };
        }[];
        for (const item of list.slice(0, 10)) {
          const yr = item.show.premiered ? parseInt(item.show.premiered.slice(0, 4), 10) : undefined;
          results.push({
            id: String(item.show.id),
            title: item.show.name,
            subtitle: `TV Series (${yr || 'N/A'})`,
            year: yr,
            albumOrShow: item.show.name,
            season: 1,
            episode: 1,
            coverUrl: item.show.image?.medium,
          });
        }
      }
      return results;
    }

    if (mediaType === 'music' || mediaType === 'music_video') {
      if (settings.lidarrUrl && settings.lidarrApiKey) {
        const url = `${settings.lidarrUrl.replace(/\/+$/, '')}/api/v1/album/lookup?term=${encodeURIComponent(q)}`;
        const res = await fetch(url, {
          headers: { 'X-Api-Key': settings.lidarrApiKey },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            foreignAlbumId?: string;
            title: string;
            artist?: { artistName?: string };
            releaseDate?: string;
            remoteCover?: string;
          }[];
          for (const item of data.slice(0, 12)) {
            const artist = item.artist?.artistName || 'Unknown Artist';
            const yr = item.releaseDate ? parseInt(item.releaseDate.slice(0, 4), 10) : undefined;
            results.push({
              id: item.foreignAlbumId || `${artist}-${item.title}`,
              title: item.title,
              subtitle: `${artist} (${yr || 'N/A'}) • Lidarr`,
              year: yr,
              artistOrAuthor: artist,
              albumOrShow: item.title,
              coverUrl: item.remoteCover,
              foreignId: item.foreignAlbumId,
            });
          }
          if (results.length > 0) return results;
        }
      }
      // Fallback MusicBrainz release search
      const mbRes = await fetch(
        `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=10`,
        {
          headers: { 'User-Agent': 'RetroTunes/2.0.0 ( https://retrotunes.local )' },
        }
      );
      if (mbRes.ok) {
        const mbData = (await mbRes.json()) as {
          releases?: {
            id: string;
            title: string;
            date?: string;
            'artist-credit'?: { name: string }[];
          }[];
        };
        for (const rel of mbData.releases || []) {
          const artist = rel['artist-credit']?.[0]?.name || 'Unknown Artist';
          const yr = rel.date ? parseInt(rel.date.slice(0, 4), 10) : undefined;
          results.push({
            id: rel.id,
            title: rel.title,
            subtitle: `${artist} (${yr || 'N/A'}) • MusicBrainz`,
            year: yr,
            artistOrAuthor: artist,
            albumOrShow: rel.title,
            foreignId: rel.id,
          });
        }
      }
      return results;
    }

    if (mediaType === 'book' || mediaType === 'audiobook') {
      const olRes = await fetch(
        `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=10`
      );
      if (olRes.ok) {
        const olData = (await olRes.json()) as {
          docs?: {
            key: string;
            title: string;
            author_name?: string[];
            first_publish_year?: number;
            cover_i?: number;
          }[];
        };
        for (const doc of olData.docs || []) {
          const author = doc.author_name?.[0] || 'Unknown Author';
          results.push({
            id: doc.key,
            title: doc.title,
            subtitle: `${author} (${doc.first_publish_year || 'N/A'})`,
            year: doc.first_publish_year,
            artistOrAuthor: author,
            albumOrShow: doc.title,
            coverUrl: doc.cover_i
              ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
              : undefined,
          });
        }
      }
      return results;
    }

    // Photos
    results.push({
      id: q,
      title: q,
      subtitle: `Photo Album •Pictures/${q}`,
      albumOrShow: q,
    });
  } catch (err) {
    logger.warn('ARR_STORE', `Metadata search fallback for ${mediaType} "${q}"`, {
      error: String(err),
    });
  }

  return results;
}

/**
 * Step 3: Queries active *arr naming config & rootfolder (if configured) and builds the exact destination preview.
 */
export async function buildUploadPreviewPlan(params: {
  mediaType: UploadMediaType;
  filePaths: string[];
  match: UploadMetadataMatch;
  season?: number;
  episodeStart?: number;
}): Promise<UploadPreviewPlan> {
  const settings = getSettings();
  const { mediaType, filePaths, match } = params;

  let targetRootDir = '';
  let namingSchemeSummary = 'Standard Plex / *arr Hierarchy';

  const baseMusicOrNfs = settings.musicRootPath || settings.nfsSharePath || settings.localCachePath;

  if (mediaType === 'movie') {
    targetRootDir = settings.videoRootPath || path.join(baseMusicOrNfs, '..', 'Movies');
    if (settings.radarrUrl && settings.radarrApiKey) {
      try {
        const namingRes = await fetch(
          `${settings.radarrUrl.replace(/\/+$/, '')}/api/v3/config/naming`,
          { headers: { 'X-Api-Key': settings.radarrApiKey } }
        );
        if (namingRes.ok) {
          const naming = (await namingRes.json()) as {
            movieFolderFormat?: string;
            standardMovieFormat?: string;
          };
          if (naming.movieFolderFormat || naming.standardMovieFormat) {
            namingSchemeSummary = `Radarr: ${naming.movieFolderFormat || '{Movie Title} ({Release Year})'} / ${naming.standardMovieFormat || '{Movie Title} ({Release Year})'}`;
          }
        }
      } catch {
        // ignore
      }
    }
  } else if (mediaType === 'tv') {
    targetRootDir = settings.tvRootPath || path.join(baseMusicOrNfs, '..', 'TV Shows');
    if (settings.sonarrUrl && settings.sonarrApiKey) {
      try {
        const namingRes = await fetch(
          `${settings.sonarrUrl.replace(/\/+$/, '')}/api/v3/config/naming`,
          { headers: { 'X-Api-Key': settings.sonarrApiKey } }
        );
        if (namingRes.ok) {
          const naming = (await namingRes.json()) as {
            seriesFolderFormat?: string;
            seasonFolderFormat?: string;
            standardEpisodeFormat?: string;
          };
          if (naming.standardEpisodeFormat) {
            namingSchemeSummary = `Sonarr: ${naming.seriesFolderFormat || '{Series Title}'} / ${naming.seasonFolderFormat || 'Season {season:00}'} / ${naming.standardEpisodeFormat}`;
          }
        }
      } catch {
        // ignore
      }
    }
  } else if (mediaType === 'music') {
    targetRootDir = baseMusicOrNfs;
    if (settings.lidarrUrl && settings.lidarrApiKey) {
      try {
        const namingRes = await fetch(
          `${settings.lidarrUrl.replace(/\/+$/, '')}/api/v1/config/naming`,
          { headers: { 'X-Api-Key': settings.lidarrApiKey } }
        );
        if (namingRes.ok) {
          const naming = (await namingRes.json()) as {
            artistFolderFormat?: string;
            standardTrackFormat?: string;
          };
          if (naming.standardTrackFormat) {
            namingSchemeSummary = `Lidarr: ${naming.artistFolderFormat || '{Artist Name}'} / ${naming.standardTrackFormat}`;
          }
        }
      } catch {
        // ignore
      }
    }
  } else if (mediaType === 'music_video') {
    targetRootDir =
      settings.musicVideosRootPath || path.join(baseMusicOrNfs, '..', 'Music Videos');
  } else if (mediaType === 'book') {
    targetRootDir = settings.booksRootPath || path.join(baseMusicOrNfs, '..', 'Books');
  } else if (mediaType === 'audiobook') {
    targetRootDir =
      settings.audiobooksRootPath || path.join(baseMusicOrNfs, '..', 'Audiobooks');
  } else {
    targetRootDir = settings.photosRootPath || path.join(baseMusicOrNfs, '..', 'Photos');
  }

  const clean = (s: string) => s.replace(/[/\\?%*:|"<>]/g, '_').trim();
  const items: UploadPreviewPlan['items'] = [];

  filePaths.forEach((srcPath, idx) => {
    const ext = path.extname(srcPath);
    const baseNoExt = path.basename(srcPath, ext);
    let rel = '';

    if (mediaType === 'movie') {
      const folder = match.year
        ? `${clean(match.title)} (${match.year})`
        : clean(match.title);
      rel = path.join(folder, `${folder}${ext}`);
    } else if (mediaType === 'tv') {
      const showFolder = match.year
        ? `${clean(match.albumOrShow || match.title)} (${match.year})`
        : clean(match.albumOrShow || match.title);
      const seasonNum = params.season ?? match.season ?? 1;
      const epNum = (params.episodeStart ?? match.episode ?? 1) + idx;
      const seasonFolder = `Season ${String(seasonNum).padStart(2, '0')}`;
      const epCode = `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
      rel = path.join(
        showFolder,
        seasonFolder,
        `${clean(match.albumOrShow || match.title)} - ${epCode} - ${clean(baseNoExt)}${ext}`
      );
    } else if (mediaType === 'music') {
      const artistFolder = clean(match.artistOrAuthor || 'Unknown Artist');
      const albumFolder = match.year
        ? `${clean(match.albumOrShow || match.title)} (${match.year})`
        : clean(match.albumOrShow || match.title);
      const trackNum = String(idx + 1).padStart(2, '0');
      const cleanTrack = clean(baseNoExt.replace(/^\d{1,3}\s*[-._)\s]+\s*/, '') || baseNoExt);
      rel = path.join(artistFolder, albumFolder, `${trackNum} - ${cleanTrack}${ext}`);
    } else if (mediaType === 'music_video') {
      const artist = clean(match.artistOrAuthor || 'Unknown Artist');
      const title = clean(match.title || baseNoExt);
      rel = path.join(artist, `${artist} - ${title}${ext}`);
    } else if (mediaType === 'book') {
      const author = clean(match.artistOrAuthor || 'Unknown Author');
      const bookTitle = clean(match.title || baseNoExt);
      rel = path.join(author, bookTitle, `${bookTitle}${ext}`);
    } else if (mediaType === 'audiobook') {
      const author = clean(match.artistOrAuthor || 'Unknown Author');
      const bookTitle = clean(match.title || baseNoExt);
      rel = path.join(author, bookTitle, `${clean(baseNoExt)}${ext}`);
    } else {
      const album = clean(match.albumOrShow || match.title || 'Uploads');
      rel = path.join(album, `${clean(baseNoExt)}${ext}`);
    }

    items.push({
      sourcePath: srcPath,
      formattedRelativePath: rel,
      destinationPath: path.join(targetRootDir, rel),
    });
  });

  return {
    mediaType,
    targetRootDir,
    namingSchemeSummary,
    items,
  };
}

/**
 * Step 4: Copies files to the formatted destination folder on the share,
 * indexes them into local SQLite immediately, and triggers the *arr API check-off command.
 */
export async function executeUploadAndArrImport(params: {
  plan: UploadPreviewPlan;
  match: UploadMetadataMatch;
  season?: number;
  episodeStart?: number;
}): Promise<{
  ok: boolean;
  copiedCount: number;
  arrTriggered: boolean;
  arrMessage: string;
}> {
  const { plan, match } = params;
  const settings = getSettings();
  const db = getDb();
  let copiedCount = 0;

  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    if (!fs.existsSync(item.sourcePath)) continue;
    await fsp.mkdir(path.dirname(item.destinationPath), { recursive: true });
    await fsp.copyFile(item.sourcePath, item.destinationPath);
    copiedCount++;

    const ext = path.extname(item.destinationPath).replace('.', '').toUpperCase();
    const baseTitle = path
      .basename(item.destinationPath, path.extname(item.destinationPath))
      .replace(/^\d{1,3}\s*[-._)\s]+\s*/, '');

    if (plan.mediaType === 'music') {
      db.prepare(`
        INSERT INTO tracks (
          title, artist, album, album_artist, genre, track_num, disc_num, year, duration,
          format, bitrate, sample_rate, remote_nfs_path, metadata_parsed
        ) VALUES (?, ?, ?, ?, '', ?, 1, ?, 0, ?, 0, 0, ?, 0)
        ON CONFLICT(remote_nfs_path) DO UPDATE SET
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album
      `).run(
        baseTitle,
        match.artistOrAuthor || 'Unknown Artist',
        match.albumOrShow || match.title,
        match.artistOrAuthor || 'Unknown Artist',
        i + 1,
        match.year || 0,
        ext,
        item.destinationPath
      );
    } else if (plan.mediaType === 'movie' || plan.mediaType === 'tv' || plan.mediaType === 'music_video') {
      const seasonNum = params.season ?? match.season ?? 1;
      const epNum = (params.episodeStart ?? match.episode ?? 1) + i;
      db.prepare(`
        INSERT INTO videos (
          title, type, show_name, artist, season, episode, year, duration,
          format, remote_nfs_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(remote_nfs_path) DO UPDATE SET
          title = excluded.title,
          type = excluded.type
      `).run(
        plan.mediaType === 'movie' ? match.title : baseTitle,
        plan.mediaType,
        plan.mediaType === 'tv' ? match.albumOrShow || match.title : null,
        plan.mediaType === 'music_video' ? match.artistOrAuthor || 'Unknown Artist' : null,
        plan.mediaType === 'tv' ? seasonNum : null,
        plan.mediaType === 'tv' ? epNum : null,
        match.year || null,
        ext,
        item.destinationPath
      );
    } else if (plan.mediaType === 'book') {
      db.prepare(`
        INSERT INTO books (title, author, year, format, remote_nfs_path)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(remote_nfs_path) DO UPDATE SET title = excluded.title
      `).run(
        match.title || baseTitle,
        match.artistOrAuthor || 'Unknown Author',
        match.year || null,
        ext,
        item.destinationPath
      );
    } else if (plan.mediaType === 'audiobook') {
      db.prepare(`
        INSERT INTO audiobooks (title, author, remote_nfs_path)
        VALUES (?, ?, ?)
        ON CONFLICT(remote_nfs_path) DO UPDATE SET title = excluded.title
      `).run(
        match.title || baseTitle,
        match.artistOrAuthor || 'Unknown Author',
        item.destinationPath
      );
    } else if (plan.mediaType === 'photo') {
      db.prepare(`
        INSERT INTO photos (title, album_name, remote_nfs_path)
        VALUES (?, ?, ?)
        ON CONFLICT(remote_nfs_path) DO UPDATE SET title = excluded.title
      `).run(baseTitle, match.albumOrShow || match.title || 'Uploads', item.destinationPath);
    }
  }

  // Trigger *arr check-off scan command
  let arrTriggered = false;
  let arrMessage = 'Indexed in local rTunes database.';
  const firstDestDir =
    plan.items.length > 0 ? path.dirname(plan.items[0].destinationPath) : plan.targetRootDir;

  try {
    if (plan.mediaType === 'movie' && settings.radarrUrl && settings.radarrApiKey) {
      const res = await fetch(`${settings.radarrUrl.replace(/\/+$/, '')}/api/v3/command`, {
        method: 'POST',
        headers: {
          'X-Api-Key': settings.radarrApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'DownloadedMoviesScan',
          path: firstDestDir,
        }),
      });
      arrTriggered = res.ok;
      arrMessage = res.ok
        ? `Triggered Radarr DownloadedMoviesScan on ${firstDestDir}`
        : `Radarr scan returned HTTP ${res.status}`;
    } else if (plan.mediaType === 'tv' && settings.sonarrUrl && settings.sonarrApiKey) {
      const res = await fetch(`${settings.sonarrUrl.replace(/\/+$/, '')}/api/v3/command`, {
        method: 'POST',
        headers: {
          'X-Api-Key': settings.sonarrApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'DownloadedEpisodesScan',
          path: firstDestDir,
        }),
      });
      arrTriggered = res.ok;
      arrMessage = res.ok
        ? `Triggered Sonarr DownloadedEpisodesScan on ${firstDestDir}`
        : `Sonarr scan returned HTTP ${res.status}`;
    } else if (plan.mediaType === 'music' && settings.lidarrUrl && settings.lidarrApiKey) {
      const res = await fetch(`${settings.lidarrUrl.replace(/\/+$/, '')}/api/v1/command`, {
        method: 'POST',
        headers: {
          'X-Api-Key': settings.lidarrApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'DownloadedAlbumsScan',
          path: firstDestDir,
        }),
      });
      arrTriggered = res.ok;
      arrMessage = res.ok
        ? `Triggered Lidarr DownloadedAlbumsScan on ${firstDestDir}`
        : `Lidarr scan returned HTTP ${res.status}`;
    } else if (plan.mediaType === 'book' && settings.chaptarrUrl && settings.chaptarrApiKey) {
      const res = await fetch(`${settings.chaptarrUrl.replace(/\/+$/, '')}/api/v1/command`, {
        method: 'POST',
        headers: {
          'X-Api-Key': settings.chaptarrApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'RescanAuthor',
        }),
      });
      arrTriggered = res.ok;
      arrMessage = res.ok
        ? 'Triggered Chaptarr RescanAuthor'
        : `Chaptarr scan returned HTTP ${res.status}`;
    }
  } catch (err) {
    logger.warn('ARR_STORE', '*arr scan command failed', { error: String(err) });
  }

  logger.info(
    'ARR_STORE',
    `Completed Smart Upload (${plan.mediaType}): ${copiedCount} files copied, arrTriggered=${arrTriggered}`
  );

  return {
    ok: true,
    copiedCount,
    arrTriggered,
    arrMessage,
  };
}
