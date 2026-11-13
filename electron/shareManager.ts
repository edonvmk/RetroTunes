import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { getDb, NetworkShareRow, TrackRow, VideoRow } from './db';
import { getSettings, saveSettings, getKeychainSecret, setKeychainSecret } from './settings';
import { getAuthState } from './authOidc';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

export interface ShareFolderMap {
  music?: string;
  movies?: string;
  tvShows?: string;
  musicVideos?: string;
  books?: string;
  audiobooks?: string;
  photos?: string;
  transcodeCache?: string;
}

export interface NetworkShareInput {
  id?: number;
  name: string;
  protocol: 'nfs' | 'smb';
  host: string;
  export_path?: string;
  base_path?: string;
  username?: string;
  password?: string;
  auto_connect: boolean;
  folder_map?: ShareFolderMap;
  music_subpath?: string;
  movies_subpath?: string;
  tv_subpath?: string;
  music_videos_subpath?: string;
  books_subpath?: string;
  audiobooks_subpath?: string;
  photos_subpath?: string;
  transcode_cache_subpath?: string;
}

function rowToFolderMap(r: NetworkShareRow): ShareFolderMap {
  return {
    music: r.music_subpath || undefined,
    movies: r.movies_subpath || undefined,
    tvShows: r.tv_subpath || undefined,
    musicVideos: r.music_videos_subpath || undefined,
    books: r.books_subpath || undefined,
    audiobooks: r.audiobooks_subpath || undefined,
    photos: r.photos_subpath || undefined,
    transcodeCache: r.transcode_cache_subpath || undefined,
  };
}

function updateShareSubpaths(db: ReturnType<typeof getDb>, id: number, fm: ShareFolderMap): void {
  db.prepare(`
    UPDATE network_shares
    SET music_subpath = ?, movies_subpath = ?, tv_subpath = ?, music_videos_subpath = ?,
        books_subpath = ?, audiobooks_subpath = ?, photos_subpath = ?, transcode_cache_subpath = ?
    WHERE id = ?
  `).run(
    fm.music ?? 'Music',
    fm.movies ?? 'Movies',
    fm.tvShows ?? 'TV Shows',
    fm.musicVideos ?? 'Music Videos',
    fm.books ?? 'Books',
    fm.audiobooks ?? 'Audiobooks',
    fm.photos ?? 'Photos',
    fm.transcodeCache ?? 'rTunesCache',
    id
  );
}

// ============================================================================
// PRIORITY 2: DIRECT NFS / SMB MOUNT MANAGER & PER-MEDIA FOLDER MAPPING
// ============================================================================

export function getMountsRootDir(): string {
  const userData = app?.isReady()
    ? app.getPath('userData')
    : path.join(process.env.HOME || '/tmp', 'Library/Application Support/RetroTunes');
  const dir = path.join(userData, 'mounts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listNetworkShares(): (NetworkShareRow & { folder_map: ShareFolderMap; is_mounted: number })[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM network_shares ORDER BY id ASC').all() as NetworkShareRow[];
  return rows.map((r) => {
    const folder_map = rowToFolderMap(r);
    const mounted = Boolean(
      r.status === 'mounted' ||
      (r.mount_point && fs.existsSync(r.mount_point) && isDirectoryNonEmpty(r.mount_point))
    );
    return {
      ...r,
      status: mounted ? 'mounted' : r.status === 'error' ? 'error' : 'unmounted',
      is_mounted: mounted ? 1 : 0,
      folder_map,
    };
  });
}

function isDirectoryNonEmpty(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export function saveNetworkShare(
  input: NetworkShareInput
): NetworkShareRow & { folder_map: ShareFolderMap } {
  const db = getDb();
  const safeName = input.name.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'share';
  const defaultMountPoint = path.join(getMountsRootDir(), safeName);
  const exportPath = (input.export_path ?? input.base_path ?? '').trim();
  const fm: ShareFolderMap = {
    music: input.folder_map?.music ?? input.music_subpath ?? 'Music',
    movies: input.folder_map?.movies ?? input.movies_subpath ?? 'Movies',
    tvShows: input.folder_map?.tvShows ?? input.tv_subpath ?? 'TV Shows',
    musicVideos: input.folder_map?.musicVideos ?? input.music_videos_subpath ?? 'Music Videos',
    books: input.folder_map?.books ?? input.books_subpath ?? 'Books',
    audiobooks: input.folder_map?.audiobooks ?? input.audiobooks_subpath ?? 'Audiobooks',
    photos: input.folder_map?.photos ?? input.photos_subpath ?? 'Photos',
    transcodeCache: input.folder_map?.transcodeCache ?? input.transcode_cache_subpath ?? 'rTunesCache',
  };

  let shareId = input.id;
  if (shareId) {
    db.prepare(`
      UPDATE network_shares
      SET name = ?, protocol = ?, host = ?, export_path = ?, username = ?, auto_connect = ?,
          music_subpath = ?, movies_subpath = ?, tv_subpath = ?, music_videos_subpath = ?,
          books_subpath = ?, audiobooks_subpath = ?, photos_subpath = ?, transcode_cache_subpath = ?
      WHERE id = ?
    `).run(
      input.name.trim(),
      input.protocol,
      input.host.trim(),
      exportPath,
      input.username?.trim() || '',
      input.auto_connect ? 1 : 0,
      fm.music || 'Music',
      fm.movies || 'Movies',
      fm.tvShows || 'TV Shows',
      fm.musicVideos || 'Music Videos',
      fm.books || 'Books',
      fm.audiobooks || 'Audiobooks',
      fm.photos || 'Photos',
      fm.transcodeCache || 'rTunesCache',
      shareId
    );
  } else {
    const res = db.prepare(`
      INSERT INTO network_shares (
        name, protocol, host, export_path, username, auto_connect, mount_point, status,
        music_subpath, movies_subpath, tv_subpath, music_videos_subpath,
        books_subpath, audiobooks_subpath, photos_subpath, transcode_cache_subpath
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unmounted', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name.trim(),
      input.protocol,
      input.host.trim(),
      exportPath,
      input.username?.trim() || '',
      input.auto_connect ? 1 : 0,
      defaultMountPoint,
      fm.music || 'Music',
      fm.movies || 'Movies',
      fm.tvShows || 'TV Shows',
      fm.musicVideos || 'Music Videos',
      fm.books || 'Books',
      fm.audiobooks || 'Audiobooks',
      fm.photos || 'Photos',
      fm.transcodeCache || 'rTunesCache'
    );
    shareId = Number(res.lastInsertRowid);
  }

  if (input.password) {
    setKeychainSecret(`smb_share_${shareId}`, input.password);
  }

  const row = db
    .prepare('SELECT * FROM network_shares WHERE id = ?')
    .get(shareId) as NetworkShareRow;

  applyShareFolderMappingToSettings(row.mount_point, fm);

  return {
    ...row,
    folder_map: fm,
  };
}

export function deleteNetworkShare(id: number): boolean {
  const db = getDb();
  db.prepare('DELETE FROM network_shares WHERE id = ?').run(id);
  return true;
}

export async function mountNetworkShare(
  id: number
): Promise<{ ok: boolean; mountPoint: string; message: string; folderMap: ShareFolderMap }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM network_shares WHERE id = ?').get(id) as
    | NetworkShareRow
    | undefined;
  if (!row) {
    return { ok: false, mountPoint: '', message: 'Network share not found.', folderMap: {} };
  }

  let folderMap = rowToFolderMap(row);

  // 1. Check if user specified a local /Volumes/... path in export_path that is already mounted by macOS
  if (row.export_path.startsWith('/Volumes/') && fs.existsSync(row.export_path)) {
    db.prepare("UPDATE network_shares SET mount_point = ?, status = 'mounted', last_error = NULL WHERE id = ?").run(
      row.export_path,
      id
    );
    const detected = autoDetectShareFolders(row.export_path);
    if (Object.values(detected).some(Boolean)) {
      folderMap = { ...folderMap, ...detected };
      updateShareSubpaths(db, id, folderMap);
    }
    applyShareFolderMappingToSettings(row.export_path, folderMap);
    return {
      ok: true,
      mountPoint: row.export_path,
      message: `Bound to mounted volume at ${row.export_path}`,
      folderMap,
    };
  }

  // Also check if the last segment of export_path is already mounted under /Volumes/<segment>
  const baseSegment = path.basename(row.export_path.replace(/\/+$/, ''));
  const candidateVol = path.join('/Volumes', baseSegment);
  if (baseSegment && fs.existsSync(candidateVol) && isDirectoryNonEmpty(candidateVol)) {
    db.prepare("UPDATE network_shares SET mount_point = ?, status = 'mounted', last_error = NULL WHERE id = ?").run(
      candidateVol,
      id
    );
    const detected = autoDetectShareFolders(candidateVol);
    if (Object.values(detected).some(Boolean)) {
      folderMap = { ...folderMap, ...detected };
      updateShareSubpaths(db, id, folderMap);
    }
    applyShareFolderMappingToSettings(candidateVol, folderMap);
    return {
      ok: true,
      mountPoint: candidateVol,
      message: `Connected to existing OS mount at ${candidateVol}`,
      folderMap,
    };
  }

  const safeName = row.name.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || `share_${id}`;
  const mountPoint = path.join(getMountsRootDir(), safeName);
  await fsp.mkdir(mountPoint, { recursive: true });

  if (isDirectoryNonEmpty(mountPoint)) {
    db.prepare("UPDATE network_shares SET mount_point = ?, status = 'mounted', last_error = NULL WHERE id = ?").run(
      mountPoint,
      id
    );
    applyShareFolderMappingToSettings(mountPoint, folderMap);
    return {
      ok: true,
      mountPoint,
      message: `Share "${row.name}" is already mounted at ${mountPoint}.`,
      folderMap,
    };
  }

  try {
    if (row.protocol === 'nfs') {
      const exportPath = row.export_path.startsWith('/') ? row.export_path : `/${row.export_path}`;
      await execFileAsync(
        '/sbin/mount_nfs',
        ['-o', 'resvport,nolocks,locallocks,soft,intr,rdirplus', `${row.host}:${exportPath}`, mountPoint],
        { timeout: 15000 }
      );
    } else {
      const password = getKeychainSecret(`smb_share_${row.id}`) || '';
      const cleanShare = row.export_path.replace(/^\/+/, '');
      const authPart = row.username
        ? password
          ? `${encodeURIComponent(row.username)}:${encodeURIComponent(password)}@`
          : `${encodeURIComponent(row.username)}@`
        : 'guest@';
      const smbUrl = `//${authPart}${row.host}/${cleanShare}`;
      await execFileAsync('/sbin/mount_smbfs', ['-N', smbUrl, mountPoint], { timeout: 15000 });
    }

    db.prepare("UPDATE network_shares SET mount_point = ?, status = 'mounted', last_error = NULL WHERE id = ?").run(
      mountPoint,
      id
    );

    const detected = autoDetectShareFolders(mountPoint);
    if (Object.values(detected).some(Boolean)) {
      folderMap = { ...folderMap, ...detected };
      updateShareSubpaths(db, id, folderMap);
    }
    applyShareFolderMappingToSettings(mountPoint, folderMap);
    logger.info('SYSTEM', `Mounted ${row.protocol.toUpperCase()} share "${row.name}" at ${mountPoint}`);
    return {
      ok: true,
      mountPoint,
      message: `Mounted ${row.protocol.toUpperCase()} share "${row.name}" at ${mountPoint}.`,
      folderMap,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE network_shares SET status = 'error', last_error = ? WHERE id = ?").run(msg, id);
    logger.warn('SYSTEM', `Failed to mount ${row.protocol} share "${row.name}"`, { error: msg });
    return {
      ok: false,
      mountPoint,
      message: `Mount failed: ${msg}`,
      folderMap,
    };
  }
}

export async function unmountNetworkShare(id: number): Promise<{ ok: boolean; message: string }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM network_shares WHERE id = ?').get(id) as
    | NetworkShareRow
    | undefined;
  if (!row || !row.mount_point) {
    return { ok: false, message: 'Share not found.' };
  }

  // Only unmount paths inside our managed mounts directory so we don't accidentally unmount user's /Volumes
  if (row.mount_point.startsWith(getMountsRootDir()) && fs.existsSync(row.mount_point)) {
    try {
      await execFileAsync('/sbin/umount', [row.mount_point], { timeout: 8000 });
    } catch {
      try {
        await execFileAsync('/usr/sbin/diskutil', ['unmount', row.mount_point], { timeout: 8000 });
      } catch {
        // ignore
      }
    }
  }
  db.prepare("UPDATE network_shares SET status = 'unmounted' WHERE id = ?").run(id);
  return { ok: true, message: `Unmounted share "${row.name}".` };
}

/**
 * Priority 2.1: Auto-Detects media subdirectories inside a mounted share root.
 */
export function autoDetectShareFolders(mountPoint: string): ShareFolderMap {
  const result: ShareFolderMap = {};
  if (!mountPoint || !fs.existsSync(mountPoint)) return result;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(mountPoint, { withFileTypes: true });
  } catch {
    return result;
  }

  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);

  const matchDir = (candidates: RegExp[]): string | undefined => {
    for (const rx of candidates) {
      const hit = dirs.find((d) => rx.test(d));
      if (hit) return hit;
    }
    return undefined;
  };

  result.music = matchDir([/^music$/i, /^audio$/i, /^songs$/i, /^flac$/i]);
  result.movies = matchDir([/^movies$/i, /^films$/i, /^cinema$/i, /^video$/i]);
  result.tvShows = matchDir([/^tv\s*shows?$/i, /^tv$/i, /^series$/i, /^shows$/i, /^television$/i]);
  result.musicVideos = matchDir([/^music\s*videos?$/i, /^music_videos$/i, /^mvs$/i, /^concerts$/i]);
  result.books = matchDir([/^books$/i, /^ebooks$/i, /^calibre$/i, /^literature$/i]);
  result.audiobooks = matchDir([/^audiobooks$/i, /^audio\s*books$/i, /^spoken$/i]);
  result.photos = matchDir([/^photos$/i, /^pictures$/i, /^immich$/i, /^images$/i]);
  result.transcodeCache = matchDir([/^cache$/i, /^transcode$/i, /^\.rtunes_cache$/i]);

  return result;
}

export function applyShareFolderMappingToSettings(
  mountPoint: string,
  folderMap: ShareFolderMap
): void {
  if (!mountPoint || !fs.existsSync(mountPoint)) return;
  const resolveSub = (sub?: string) => (sub ? path.join(mountPoint, sub) : undefined);

  const updates: Record<string, string> = {};
  const musicPath = resolveSub(folderMap.music);
  const moviesPath = resolveSub(folderMap.movies);
  const tvPath = resolveSub(folderMap.tvShows);
  const mvPath = resolveSub(folderMap.musicVideos);
  const booksPath = resolveSub(folderMap.books);
  const audiobooksPath = resolveSub(folderMap.audiobooks);
  const photosPath = resolveSub(folderMap.photos);

  updates.nfsSharePath = mountPoint;
  if (musicPath && fs.existsSync(musicPath)) updates.musicRootPath = musicPath;
  if (moviesPath && fs.existsSync(moviesPath)) updates.videoRootPath = moviesPath;
  if (tvPath && fs.existsSync(tvPath)) updates.tvRootPath = tvPath;
  if (mvPath && fs.existsSync(mvPath)) updates.musicVideosRootPath = mvPath;
  if (booksPath && fs.existsSync(booksPath)) updates.booksRootPath = booksPath;
  if (audiobooksPath && fs.existsSync(audiobooksPath)) updates.audiobooksRootPath = audiobooksPath;
  if (photosPath && fs.existsSync(photosPath)) updates.photosRootPath = photosPath;

  if (Object.keys(updates).length > 0) {
    saveSettings(updates);
  }
}

export async function autoMountSharesOnStartup(): Promise<void> {
  const shares = listNetworkShares();
  for (const sh of shares) {
    if (sh.auto_connect) {
      await mountNetworkShare(sh.id);
    }
  }
}

export async function unmountAllManagedSharesOnQuit(): Promise<void> {
  const shares = listNetworkShares();
  for (const sh of shares) {
    if (sh.status === 'mounted' && sh.mount_point.startsWith(getMountsRootDir())) {
      await unmountNetworkShare(sh.id);
    }
  }
}

// ============================================================================
// PRIORITY 3: DOCKER COMPANION SERVER ABSTRACTION & AUTHENTIK SSO
// ============================================================================

export interface MediaDatabaseProvider {
  mode: 'standalone' | 'docker_server';
  getTracks(): Promise<TrackRow[]>;
  getVideos(): Promise<VideoRow[]>;
}

export interface FileTransportProvider {
  mode: 'standalone' | 'docker_server';
  resolveStreamOrFileUrl(localOrNfsPath: string): string;
  getAuthHeaders(): Record<string, string>;
}

export function getActiveTransportProvider(): FileTransportProvider {
  const settings = getSettings();
  const auth = getAuthState();

  if (settings.backendMode === 'docker_server' && settings.dockerServerUrl) {
    const baseUrl = settings.dockerServerUrl.replace(/\/+$/, '');
    return {
      mode: 'docker_server',
      resolveStreamOrFileUrl(localOrNfsPath: string) {
        return `${baseUrl}/api/v1/stream?path=${encodeURIComponent(localOrNfsPath)}`;
      },
      getAuthHeaders() {
        const headers: Record<string, string> = {};
        if (auth.authenticated && auth.accessToken) {
          headers.Authorization = `Bearer ${auth.accessToken}`;
        }
        return headers;
      },
    };
  }

  return {
    mode: 'standalone',
    resolveStreamOrFileUrl(localOrNfsPath: string) {
      return `file://${encodeURI(localOrNfsPath)}`;
    },
    getAuthHeaders() {
      return {};
    },
  };
}
