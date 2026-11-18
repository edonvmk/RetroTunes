import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { logger } from './logger';
import { emitRendererEvent, getAppDataPath } from './runtimeBus';
import { classifyVariant, isInterludeOrSkit } from './egenius/variantFilter';

export interface TrackRow {
  id: number;
  track_uid?: string | null;
  sync_rev?: number;
  remote_nfs_path: string;
  alternate_paths?: string | null;
  local_cache_path: string | null;
  keep_cached: number;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number | null;
  track_num: number | null;
  disc_num: number | null;
  duration: number;
  bitrate: number;
  file_size: number;
  format: string;
  cover_art_path: string | null;
  lrc_path: string | null;
  mbid_recording: string | null;
  mbid_artist: string | null;
  mbid_release?: string | null;
  mbid_release_group?: string | null;
  isrc?: string | null;
  lastfm_id?: string | null;
  deezer_id?: string | null;
  theaudiodb_id?: string | null;
  lidarr_id?: string | null;
  global_listen_count: number;
  lastfm_plays?: number;
  audiodb_plays?: number;
  combined_global_plays?: number;
  popularity_updated_at?: number;
  artist_median_listen_count: number;
  artist_relative_popularity_score: number;
  artist_rarity_multiplier?: number;
  discovery_score?: number;
  local_star_rating: number;
  is_loved: number;
  play_count: number;
  last_played: string | null;
  date_added: string;
  metadata_loaded?: number;
  exclude_from_smart_playlists?: number;
}

export interface VideoRow {
  id: number;
  remote_nfs_path: string;
  local_cache_path: string | null;
  keep_cached: number;
  is_transcoded: number;
  transcode_status: string;
  transcode_progress: number;
  title: string;
  type: 'movie' | 'tv' | 'music_video';
  artist?: string | null;
  show_name: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
  imdb_id?: string | null;
  radarr_id?: string | null;
  sonarr_id?: string | null;
  plex_rating_key?: string | null;
  poster_path: string | null;
  watched: number;
  view_offset_ms?: number;
  duration: number;
  width: number | null;
  height: number | null;
  file_size: number;
  format: string;
  date_added: string;
}

export interface BookRow {
  id: number;
  remote_nfs_path: string;
  title: string;
  author: string;
  series: string | null;
  year: number | null;
  format: string;
  file_size: number;
  cover_path: string | null;
  chaptarr_id: string | null;
  date_added: string;
}

export interface AudiobookRow {
  id: number;
  remote_nfs_path: string;
  title: string;
  author: string;
  narrator: string | null;
  duration: number;
  resume_position_ms: number;
  chapters_json: string | null;
  format: string;
  file_size: number;
  cover_path: string | null;
  abs_item_id: string | null;
  date_added: string;
}

export interface PhotoRow {
  id: number;
  remote_nfs_path: string;
  album_name: string;
  title: string;
  width: number | null;
  height: number | null;
  file_size: number;
  immich_asset_id: string | null;
  taken_at: string | null;
  date_added: string;
}

export interface NetworkShareRow {
  id: number;
  name: string;
  host: string;
  protocol: 'nfs' | 'smb';
  export_path: string;
  username: string;
  auto_connect: number;
  mount_point: string;
  status: 'mounted' | 'unmounted' | 'error';
  last_error?: string | null;
  music_subpath: string;
  movies_subpath: string;
  tv_subpath: string;
  music_videos_subpath: string;
  books_subpath: string;
  audiobooks_subpath: string;
  photos_subpath: string;
  transcode_cache_subpath: string;
}

export interface PlaylistRow {
  id: number;
  name: string;
  is_smart: number;
  media_type?: 'music' | 'video' | 'mixed';
  smart_rules_json: string | null;
  track_limit: number | null;
  limit_type: string;
  limit_value: number | null;
  selection_method: string;
  keep_cached: number;
  last_synced_hash: string | null;
  owner_user: string | null;
  cached_track_ids_json?: string | null;
  last_regenerated_at?: string | null;
  ai_prompt?: string | null;
  ai_mode?: 'standard' | 'smart' | null;
  egenius_seed_track_id?: number | null;
  egenius_mode?: 'hits' | 'balanced' | 'deep' | null;
  egenius_scene_threshold?: number | null;
  created_at: string;
}

export interface DeviceRow {
  uuid: string;
  name: string;
  mount_path: string;
  device_type: 'epod_y2' | 'classic_dap' | 'phone' | 'custom';
  transport_mode?: 'mtp' | 'ums';
  mtp_serial?: string | null;
  last_processed_scrobble_ts?: number;
  profile_json: string;
  last_connected: string | null;
  last_synced: string | null;
}

export interface CacheJobRow {
  id: number;
  item_type: 'audio' | 'video';
  item_id: number;
  title: string;
  source_path: string;
  target_path: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  encoder_used: string | null;
  size_bytes: number;
  error_message: string | null;
  last_accessed: string;
  created_at: string;
  updated_at: string;
}

let coreDbInstance: Database.Database | null = null;
let cacheDbInstance: Database.Database | null = null;
let videoDbInstance: Database.Database | null = null;
let storeDbInstance: Database.Database | null = null;

let dbFilePath = '';
let cacheDbFilePath = '';
let videoDbFilePath = '';
let storeDbFilePath = '';
let shutdownHooksRegistered = false;

export interface PlaybackDeltaUpdate {
  track_uid: string;
  play_count_delta?: number;
  rating?: number;
  loved?: boolean | number;
  last_played_at?: string;
}

function resolveWritableDataDir(customPath?: string): { dataDir: string; corePath: string } {
  const explicit = customPath || process.env.RTUNES_DB_PATH?.trim();
  if (explicit) {
    const customFile = path.resolve(explicit);
    const dir = path.dirname(customFile);
    fs.mkdirSync(dir, { recursive: true });
    const corePath =
      path.basename(customFile).toLowerCase() === 'rtunes.sqlite'
        ? path.join(dir, 'core.sqlite')
        : customFile;
    return { dataDir: dir, corePath };
  }

  const candidates = [
    getAppDataPath(),
    path.join(process.cwd(), '.data'),
    path.join(os.tmpdir(), 'retrotunes-data'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return { dataDir: dir, corePath: path.join(dir, 'core.sqlite') };
    } catch {
      // try next writable candidate
    }
  }
  const fallbackDir = path.join(os.tmpdir(), 'retrotunes-data');
  fs.mkdirSync(fallbackDir, { recursive: true });
  return { dataDir: fallbackDir, corePath: path.join(fallbackDir, 'core.sqlite') };
}

function openConfiguredDb(targetPath: string, fallbackName: string): { db: Database.Database; actualPath: string } {
  let db: Database.Database;
  let actualPath = targetPath;
  try {
    db = new Database(targetPath);
  } catch (err) {
    const fallbackDir = path.join(os.tmpdir(), 'retrotunes-data');
    fs.mkdirSync(fallbackDir, { recursive: true });
    actualPath = path.join(fallbackDir, fallbackName);
    logger.warn(
      'DB',
      `Primary DB path ${targetPath} was not writable (${String(err)}); using fallback ${actualPath}`
    );
    db = new Database(actualPath);
  }

  try {
    db.pragma('journal_mode = WAL');
  } catch {
    db.pragma('journal_mode = DELETE');
  }
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  return { db, actualPath };
}

export function closeAllDatabases(): void {
  for (const [label, conn] of [
    ['core', coreDbInstance],
    ['affinity_cache', cacheDbInstance],
    ['video', videoDbInstance],
    ['store', storeDbInstance],
  ] as const) {
    if (!conn) continue;
    try {
      conn.close();
    } catch (err) {
      logger.debug('DB', `Error closing ${label} database`, { error: String(err) });
    }
  }
  coreDbInstance = null;
  cacheDbInstance = null;
  videoDbInstance = null;
  storeDbInstance = null;
}

function registerDbShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  const onSignal = (signal: NodeJS.Signals) => {
    closeAllDatabases();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

function copyLegacyTable(targetDb: Database.Database, legacyPath: string, tableName: string): void {
  const escaped = legacyPath.replace(/'/g, "''");
  try {
    targetDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`);
    const exists = targetDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    if (!exists) return;

    const targetCols = (
      targetDb.prepare(`PRAGMA main.table_info("${tableName}")`).all() as { name: string }[]
    ).map((c) => c.name);
    const legacyCols = new Set(
      (targetDb.prepare(`PRAGMA legacy.table_info("${tableName}")`).all() as { name: string }[]).map(
        (c) => c.name
      )
    );
    const common = targetCols.filter((c) => legacyCols.has(c));
    if (common.length === 0) return;

    const colList = common.map((c) => `"${c}"`).join(', ');
    targetDb.exec(`INSERT OR IGNORE INTO main."${tableName}" (${colList}) SELECT ${colList} FROM legacy."${tableName}"`);
  } catch (err) {
    logger.warn('DB', `Legacy migration skipped for ${tableName}`, { error: String(err) });
  } finally {
    try {
      targetDb.exec('DETACH DATABASE legacy');
    } catch {
      // ignore if not attached
    }
  }
}

export function getDbPath(): string {
  if (dbFilePath) return dbFilePath;
  const { corePath } = resolveWritableDataDir();
  dbFilePath = corePath;
  return dbFilePath;
}

export function computeTrackUid(track: {
  mbid_recording?: string | null;
  artist?: string | null;
  album?: string | null;
  disc_num?: number | null;
  track_num?: number | null;
  title?: string | null;
  duration?: number | null;
}): string {
  const mbid = (track.mbid_recording || '').trim().toLowerCase();
  if (mbid) {
    return crypto.createHash('sha256').update(`mbid:${mbid}`).digest('hex').slice(0, 32);
  }
  const norm = (s?: string | null) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const disc = track.disc_num ?? 1;
  const trk = track.track_num ?? 0;
  const dur = Math.round(track.duration || 0);
  const raw = `${norm(track.artist)}|${norm(track.album)}|${disc}:${trk}|${norm(track.title)}|${dur}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function initDatabase(customPath?: string): Database.Database {
  if (coreDbInstance && cacheDbInstance && videoDbInstance && storeDbInstance) {
    return coreDbInstance;
  }
  const start = Date.now();
  const { dataDir, corePath } = resolveWritableDataDir(customPath);
  const legacyDbPath = path.join(dataDir, 'rtunes.sqlite');

  // Preserve full music, playlists, genre locks, settings, shares, and devices from legacy monolithic DB
  if (corePath !== legacyDbPath && !fs.existsSync(corePath) && fs.existsSync(legacyDbPath)) {
    try {
      const legacyTmp = new Database(legacyDbPath);
      try {
        legacyTmp.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // ignore if WAL is absent
      }
      legacyTmp.close();
      fs.copyFileSync(legacyDbPath, corePath);
      logger.info('DB', `Migrated legacy rtunes.sqlite into domain core.sqlite at ${corePath}`);
    } catch (err) {
      logger.warn('DB', 'Failed copying legacy rtunes.sqlite into core.sqlite; initializing fresh core.sqlite', {
        error: String(err),
      });
    }
  }

  logger.info('DB', `Initializing domain-split SQLite + FTS5 databases under ${dataDir}`);
  const coreOpened = openConfiguredDb(corePath, 'core.sqlite');
  const coreDb = coreOpened.db;
  dbFilePath = coreOpened.actualPath;

  const cacheOpened = openConfiguredDb(path.join(dataDir, 'affinity_cache.sqlite'), 'affinity_cache.sqlite');
  const cacheDb = cacheOpened.db;
  cacheDbFilePath = cacheOpened.actualPath;

  const videoOpened = openConfiguredDb(path.join(dataDir, 'video.sqlite'), 'video.sqlite');
  const videoDb = videoOpened.db;
  videoDbFilePath = videoOpened.actualPath;

  const storeOpened = openConfiguredDb(path.join(dataDir, 'store.sqlite'), 'store.sqlite');
  const storeDb = storeOpened.db;
  storeDbFilePath = storeOpened.actualPath;

  // 1. Initialize core.sqlite schema (Music, Playlists, Smart Playlists, Genre Matrix, Settings, Sync)
  coreDb.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_uid TEXT,
      sync_rev INTEGER DEFAULT 0,
      remote_nfs_path TEXT UNIQUE NOT NULL,
      alternate_paths TEXT DEFAULT '[]',
      local_cache_path TEXT,
      keep_cached INTEGER DEFAULT 0,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      genre TEXT DEFAULT '',
      year INTEGER,
      track_num INTEGER,
      disc_num INTEGER,
      duration REAL DEFAULT 0,
      bitrate INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      format TEXT DEFAULT '',
      cover_art_path TEXT,
      lrc_path TEXT,
      mbid_recording TEXT,
      mbid_artist TEXT,
      global_listen_count INTEGER DEFAULT 0,
      artist_median_listen_count REAL DEFAULT 0,
      artist_relative_popularity_score REAL DEFAULT 0,
      local_star_rating INTEGER DEFAULT 0,
      is_loved INTEGER DEFAULT 0,
      play_count INTEGER DEFAULT 0,
      last_played TEXT,
      date_added TEXT DEFAULT (datetime('now')),
      metadata_loaded INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
    CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
    CREATE INDEX IF NOT EXISTS idx_tracks_popularity ON tracks(artist_relative_popularity_score DESC);
    CREATE INDEX IF NOT EXISTS idx_tracks_rating ON tracks(local_star_rating DESC);
    CREATE INDEX IF NOT EXISTS idx_tracks_loved ON tracks(is_loved);
    CREATE INDEX IF NOT EXISTS idx_tracks_sort_artist_album ON tracks(artist COLLATE NOCASE, album COLLATE NOCASE, disc_num, track_num);

    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      title,
      artist,
      album,
      genre,
      remote_nfs_path,
      content='tracks',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
      INSERT INTO tracks_fts(rowid, title, artist, album, genre, remote_nfs_path)
      VALUES (new.id, new.title, new.artist, new.album, new.genre, new.remote_nfs_path);
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, remote_nfs_path)
      VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre, old.remote_nfs_path);
    END;

    DROP TRIGGER IF EXISTS tracks_au;
    CREATE TRIGGER tracks_au AFTER UPDATE OF title, artist, album, genre, remote_nfs_path ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, remote_nfs_path)
      VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre, old.remote_nfs_path);
      INSERT INTO tracks_fts(rowid, title, artist, album, genre, remote_nfs_path)
      VALUES (new.id, new.title, new.artist, new.album, new.genre, new.remote_nfs_path);
    END;

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_smart INTEGER DEFAULT 0,
      media_type TEXT DEFAULT 'music',
      smart_rules_json TEXT,
      track_limit INTEGER,
      limit_type TEXT DEFAULT 'tracks',
      limit_value REAL,
      selection_method TEXT DEFAULT 'popularity_desc',
      keep_cached INTEGER DEFAULT 0,
      last_synced_hash TEXT,
      owner_user TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIEW IF NOT EXISTS smart_playlists AS
      SELECT * FROM playlists WHERE is_smart = 1;

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      position INTEGER DEFAULT 0,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pid ON playlist_tracks(playlist_id, position);

    CREATE TABLE IF NOT EXISTS devices (
      uuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mount_path TEXT NOT NULL,
      device_type TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      last_connected TEXT,
      last_synced TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS network_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      protocol TEXT DEFAULT 'nfs',
      export_path TEXT NOT NULL,
      username TEXT DEFAULT '',
      auto_connect INTEGER DEFAULT 1,
      mount_point TEXT DEFAULT '',
      status TEXT DEFAULT 'unmounted',
      last_error TEXT,
      music_subpath TEXT DEFAULT 'Music',
      movies_subpath TEXT DEFAULT 'Movies',
      tv_subpath TEXT DEFAULT 'TV Shows',
      music_videos_subpath TEXT DEFAULT 'Music Videos',
      books_subpath TEXT DEFAULT 'Books',
      audiobooks_subpath TEXT DEFAULT 'Audiobooks',
      photos_subpath TEXT DEFAULT 'Photos',
      transcode_cache_subpath TEXT DEFAULT 'rTunesCache',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_play_state (
      device_uuid TEXT NOT NULL,
      track_id INTEGER NOT NULL,
      last_synced_device_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (device_uuid, track_id)
    );

    CREATE TABLE IF NOT EXISTS artist_genre_weights (
      artist_key TEXT NOT NULL,
      genre_tag TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (artist_key, genre_tag)
    );
    CREATE INDEX IF NOT EXISTS idx_artist_genre_tag ON artist_genre_weights(genre_tag);
    CREATE INDEX IF NOT EXISTS idx_artist_genre_key ON artist_genre_weights(artist_key);

    CREATE TABLE IF NOT EXISTS subgenre_affinity_matrix (
      genre_x TEXT NOT NULL,
      genre_y TEXT NOT NULL,
      similarity REAL NOT NULL,
      is_user_locked INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      PRIMARY KEY (genre_x, genre_y)
    );
    CREATE INDEX IF NOT EXISTS idx_subgenre_matrix_x ON subgenre_affinity_matrix(genre_x);
    CREATE INDEX IF NOT EXISTS idx_subgenre_matrix_y ON subgenre_affinity_matrix(genre_y);

    CREATE TABLE IF NOT EXISTS smart_playlist_exclusions (
      smart_playlist_id TEXT NOT NULL,
      track_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (smart_playlist_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS sync_tombstones (
      track_uid TEXT PRIMARY KEY,
      deleted_rev INTEGER NOT NULL,
      deleted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_tombstones_rev ON sync_tombstones(deleted_rev);
  `);

  // Safe migration for existing core.sqlite databases
  try {
    const cols = coreDb.prepare("PRAGMA table_info('tracks')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'track_uid')) {
      coreDb.exec('ALTER TABLE tracks ADD COLUMN track_uid TEXT');
    }
    if (!cols.some((c) => c.name === 'sync_rev')) {
      coreDb.exec('ALTER TABLE tracks ADD COLUMN sync_rev INTEGER DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'metadata_loaded')) {
      coreDb.exec('ALTER TABLE tracks ADD COLUMN metadata_loaded INTEGER DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'exclude_from_smart_playlists')) {
      coreDb.exec('ALTER TABLE tracks ADD COLUMN exclude_from_smart_playlists INTEGER DEFAULT 0');
    }
    for (const col of [
      'mbid_release',
      'mbid_release_group',
      'isrc',
      'lastfm_id',
      'deezer_id',
      'theaudiodb_id',
      'lidarr_id',
    ]) {
      if (!cols.some((c) => c.name === col)) {
        coreDb.exec(`ALTER TABLE tracks ADD COLUMN ${col} TEXT`);
      }
    }
    for (const [col, sqlType] of [
      ['lastfm_plays', 'INTEGER DEFAULT 0'],
      ['audiodb_plays', 'INTEGER DEFAULT 0'],
      ['combined_global_plays', 'INTEGER DEFAULT 0'],
      ['popularity_updated_at', 'INTEGER DEFAULT 0'],
      ['artist_rarity_multiplier', 'REAL DEFAULT 1.0'],
      ['discovery_score', 'REAL DEFAULT 0'],
      ['alternate_paths', "TEXT DEFAULT '[]'"],
    ] as const) {
      if (!cols.some((c) => c.name === col)) {
        coreDb.exec(`ALTER TABLE tracks ADD COLUMN ${col} ${sqlType}`);
      }
    }
    coreDb.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_uid ON tracks(track_uid) WHERE track_uid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_sync_rev ON tracks(sync_rev);
      CREATE INDEX IF NOT EXISTS idx_tracks_combined_global ON tracks(combined_global_plays DESC);
      CREATE INDEX IF NOT EXISTS idx_tracks_discovery_score ON tracks(discovery_score DESC);
      CREATE INDEX IF NOT EXISTS idx_tracks_mbid_rec ON tracks(mbid_recording) WHERE mbid_recording IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_mbid_art ON tracks(mbid_artist) WHERE mbid_artist IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_mbid_rel ON tracks(mbid_release) WHERE mbid_release IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc) WHERE isrc IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_lastfm ON tracks(lastfm_id) WHERE lastfm_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_deezer ON tracks(deezer_id) WHERE deezer_id IS NOT NULL;
    `);
    coreDb.exec(`
      UPDATE tracks
      SET combined_global_plays = COALESCE(global_listen_count, 0) + COALESCE(lastfm_plays, 0) + COALESCE(audiodb_plays, 0)
      WHERE COALESCE(combined_global_plays, 0) != COALESCE(global_listen_count, 0) + COALESCE(lastfm_plays, 0) + COALESCE(audiodb_plays, 0)
    `);
    const pCols = coreDb.prepare("PRAGMA table_info('playlists')").all() as { name: string }[];
    if (!pCols.some((c) => c.name === 'media_type')) {
      coreDb.exec("ALTER TABLE playlists ADD COLUMN media_type TEXT DEFAULT 'music'");
    }
    if (!pCols.some((c) => c.name === 'cached_track_ids_json')) {
      coreDb.exec('ALTER TABLE playlists ADD COLUMN cached_track_ids_json TEXT');
    }
    if (!pCols.some((c) => c.name === 'last_regenerated_at')) {
      coreDb.exec('ALTER TABLE playlists ADD COLUMN last_regenerated_at TEXT');
    }
    if (!pCols.some((c) => c.name === 'ai_prompt')) {
      coreDb.exec('ALTER TABLE playlists ADD COLUMN ai_prompt TEXT');
    }
    if (!pCols.some((c) => c.name === 'ai_mode')) {
      coreDb.exec('ALTER TABLE playlists ADD COLUMN ai_mode TEXT');
    }
    if (!pCols.some((c) => c.name === 'egenius_seed_track_id')) {
      coreDb.exec('ALTER TABLE playlists ADD COLUMN egenius_seed_track_id INTEGER');
    }
    if (!pCols.some((c) => c.name === 'egenius_mode')) {
      coreDb.exec('ALTER TABLE playlists ADD COLUMN egenius_mode TEXT');
    }
    if (!pCols.some((c) => c.name === 'egenius_scene_threshold')) {
      coreDb.exec('ALTER TABLE playlists ADD COLUMN egenius_scene_threshold REAL DEFAULT 0.55');
    }
    const ptCols = coreDb.prepare("PRAGMA table_info('playlist_tracks')").all() as { name: string }[];
    if (ptCols.length > 0 && !ptCols.some((c) => c.name === 'id')) {
      coreDb.exec(`
        ALTER TABLE playlist_tracks RENAME TO playlist_tracks_old;
        CREATE TABLE playlist_tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          playlist_id INTEGER NOT NULL,
          track_id INTEGER NOT NULL,
          position INTEGER DEFAULT 0,
          FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
          FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
        );
        INSERT INTO playlist_tracks (playlist_id, track_id, position)
        SELECT playlist_id, track_id, position FROM playlist_tracks_old ORDER BY playlist_id ASC, position ASC;
        DROP TABLE playlist_tracks_old;
        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pid ON playlist_tracks(playlist_id, position);
      `);
    }
    const dCols = coreDb.prepare("PRAGMA table_info('devices')").all() as { name: string }[];
    if (!dCols.some((c) => c.name === 'transport_mode')) {
      coreDb.exec("ALTER TABLE devices ADD COLUMN transport_mode TEXT DEFAULT 'ums'");
    }
    if (!dCols.some((c) => c.name === 'mtp_serial')) {
      coreDb.exec('ALTER TABLE devices ADD COLUMN mtp_serial TEXT');
    }
    if (!dCols.some((c) => c.name === 'last_processed_scrobble_ts')) {
      coreDb.exec('ALTER TABLE devices ADD COLUMN last_processed_scrobble_ts INTEGER DEFAULT 0');
    }
  } catch {
    // ignore
  }

  // Delta sync revision triggers in core.sqlite
  const bumpRevSql = `
    INSERT INTO settings (key, value, updated_at)
    VALUES ('library_revision', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(COALESCE(CAST(settings.value AS INTEGER), 0) + 1 AS TEXT),
      updated_at = datetime('now');
  `;
  coreDb.exec(`
    CREATE TRIGGER IF NOT EXISTS tracks_sync_ai AFTER INSERT ON tracks BEGIN
      ${bumpRevSql}
      UPDATE tracks
      SET sync_rev = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'library_revision')
      WHERE id = new.id;
      DELETE FROM sync_tombstones WHERE track_uid = new.track_uid AND new.track_uid IS NOT NULL;
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_sync_au AFTER UPDATE OF
      remote_nfs_path, alternate_paths, local_cache_path, keep_cached,
      title, artist, album, genre, year, track_num, disc_num, duration,
      bitrate, file_size, format, cover_art_path, lrc_path,
      mbid_recording, mbid_artist, mbid_release, mbid_release_group, isrc,
      global_listen_count, lastfm_plays, audiodb_plays, combined_global_plays,
      artist_median_listen_count, artist_relative_popularity_score,
      artist_rarity_multiplier, discovery_score,
      local_star_rating, is_loved, play_count, last_played,
      exclude_from_smart_playlists, track_uid
    ON tracks BEGIN
      ${bumpRevSql}
      UPDATE tracks
      SET sync_rev = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'library_revision')
      WHERE id = new.id;
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_tombstone_ad AFTER DELETE ON tracks
    WHEN old.track_uid IS NOT NULL AND old.track_uid != ''
    BEGIN
      ${bumpRevSql}
      INSERT INTO sync_tombstones (track_uid, deleted_rev, deleted_at)
      VALUES (
        old.track_uid,
        (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'library_revision'),
        datetime('now')
      )
      ON CONFLICT(track_uid) DO UPDATE SET
        deleted_rev = excluded.deleted_rev,
        deleted_at = excluded.deleted_at;
    END;

    CREATE TRIGGER IF NOT EXISTS playlists_rev_ai AFTER INSERT ON playlists BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS playlists_rev_au AFTER UPDATE ON playlists BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS playlists_rev_ad AFTER DELETE ON playlists BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS playlist_tracks_rev_ai AFTER INSERT ON playlist_tracks BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS playlist_tracks_rev_au AFTER UPDATE ON playlist_tracks BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS playlist_tracks_rev_ad AFTER DELETE ON playlist_tracks BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS subgenre_matrix_rev_ai AFTER INSERT ON subgenre_affinity_matrix BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS subgenre_matrix_rev_au AFTER UPDATE ON subgenre_affinity_matrix BEGIN ${bumpRevSql} END;
    CREATE TRIGGER IF NOT EXISTS subgenre_matrix_rev_ad AFTER DELETE ON subgenre_affinity_matrix BEGIN ${bumpRevSql} END;
  `);

  // Migrate legacy Smart Playlist rules from old 0.35x-5x Rel. Score scale to 0-100
  try {
    const legacyPls = coreDb
      .prepare(
        "SELECT id, smart_rules_json FROM playlists WHERE is_smart = 1 AND smart_rules_json LIKE '%artist_relative_popularity_score%'"
      )
      .all() as { id: number; smart_rules_json: string }[];

    const convertLegacyRatio = (ratio: number): number => {
      if (ratio <= 0) return 0;
      const sigmoid = 1 / (1 + Math.exp(-1.15 * Math.log2(ratio)));
      return Math.round(Math.max(0, Math.min(100, sigmoid * 100)) * 10) / 10;
    };

    const migrateNode = (node: any): boolean => {
      if (!node || typeof node !== 'object') return false;
      if (Array.isArray(node.conditions)) {
        let changed = false;
        for (const c of node.conditions) {
          if (migrateNode(c)) changed = true;
        }
        return changed;
      }
      if (node.field === 'artist_relative_popularity_score') {
        const v = Number(node.value);
        if (Number.isFinite(v) && v > 0 && v <= 10) {
          node.value = convertLegacyRatio(v);
          if (node.valueTo !== undefined) {
            const v2 = Number(node.valueTo);
            if (Number.isFinite(v2) && v2 > 0 && v2 <= 10) {
              node.valueTo = convertLegacyRatio(v2);
            }
          }
          return true;
        }
      }
      return false;
    };

    const updatePlStmt = coreDb.prepare('UPDATE playlists SET smart_rules_json = ? WHERE id = ?');
    for (const pl of legacyPls) {
      const parsed = JSON.parse(pl.smart_rules_json);
      if (migrateNode(parsed)) {
        updatePlStmt.run(JSON.stringify(parsed), pl.id);
      }
    }
  } catch {
    // ignore
  }

  // Ensure default Smart Playlist rule definitions exist
  const playlistCount = (coreDb.prepare('SELECT COUNT(*) as c FROM playlists').get() as { c: number }).c;
  if (playlistCount === 0) {
    const insertPlaylist = coreDb.prepare(`
      INSERT INTO playlists (name, is_smart, smart_rules_json, track_limit, limit_type, limit_value, selection_method)
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `);

    insertPlaylist.run(
      'Artist Catalog Standouts (Rel. Score >= 66)',
      JSON.stringify({
        match: 'ALL',
        conditions: [
          {
            id: 'c1',
            type: 'rule',
            field: 'artist_relative_popularity_score',
            operator: 'gte',
            value: 66,
          },
        ],
      }),
      100,
      'tracks',
      100,
      'popularity_desc'
    );

    insertPlaylist.run(
      'Loved & 5-Star Favorites',
      JSON.stringify({
        match: 'ANY',
        conditions: [
          {
            id: 'c1',
            type: 'rule',
            field: 'is_loved',
            operator: 'is',
            value: 1,
          },
          {
            id: 'c2',
            type: 'rule',
            field: 'local_star_rating',
            operator: 'gte',
            value: 5,
          },
        ],
      }),
      null,
      'tracks',
      null,
      'rating_desc'
    );

    insertPlaylist.run(
      'Recently Added Lossless',
      JSON.stringify({
        match: 'ALL',
        conditions: [
          {
            id: 'c1',
            type: 'rule',
            field: 'format',
            operator: 'contains',
            value: 'FLAC',
          },
        ],
      }),
      50,
      'tracks',
      50,
      'recently_added'
    );
  }

  // 2. Initialize affinity_cache.sqlite schema
  cacheDb.exec(`
    CREATE TABLE IF NOT EXISTS artist_affinity_cache (
      artist_key TEXT PRIMARY KEY,
      artist_name TEXT NOT NULL,
      similar_artists_json TEXT NOT NULL,
      top_tags_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS track_affinity_cache (
      track_mbid_or_key TEXT PRIMARY KEY,
      similar_tracks_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_metadata_cache (
      cache_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 3. Initialize video.sqlite schema
  videoDb.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_nfs_path TEXT UNIQUE NOT NULL,
      local_cache_path TEXT,
      keep_cached INTEGER DEFAULT 0,
      is_transcoded INTEGER DEFAULT 0,
      transcode_status TEXT DEFAULT 'none',
      transcode_progress REAL DEFAULT 0,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'movie',
      artist TEXT,
      show_name TEXT,
      season INTEGER,
      episode INTEGER,
      year INTEGER,
      tmdb_id TEXT,
      tvdb_id TEXT,
      imdb_id TEXT,
      radarr_id TEXT,
      sonarr_id TEXT,
      plex_rating_key TEXT,
      poster_path TEXT,
      watched INTEGER DEFAULT 0,
      view_offset_ms INTEGER DEFAULT 0,
      play_count INTEGER DEFAULT 0,
      duration REAL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      file_size INTEGER DEFAULT 0,
      format TEXT DEFAULT '',
      date_added TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
      title,
      show_name,
      remote_nfs_path,
      content='videos',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS videos_ai AFTER INSERT ON videos BEGIN
      INSERT INTO videos_fts(rowid, title, show_name, remote_nfs_path)
      VALUES (new.id, new.title, COALESCE(new.show_name, ''), new.remote_nfs_path);
    END;

    CREATE TRIGGER IF NOT EXISTS videos_ad AFTER DELETE ON videos BEGIN
      INSERT INTO videos_fts(videos_fts, rowid, title, show_name, remote_nfs_path)
      VALUES ('delete', old.id, old.title, COALESCE(old.show_name, ''), old.remote_nfs_path);
    END;

    DROP TRIGGER IF EXISTS videos_au;
    CREATE TRIGGER videos_au AFTER UPDATE OF title, show_name, remote_nfs_path ON videos BEGIN
      INSERT INTO videos_fts(videos_fts, rowid, title, show_name, remote_nfs_path)
      VALUES ('delete', old.id, old.title, COALESCE(old.show_name, ''), old.remote_nfs_path);
      INSERT INTO videos_fts(rowid, title, show_name, remote_nfs_path)
      VALUES (new.id, new.title, COALESCE(new.show_name, ''), new.remote_nfs_path);
    END;

    CREATE INDEX IF NOT EXISTS idx_videos_tmdb ON videos(tmdb_id) WHERE tmdb_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_videos_tvdb ON videos(tvdb_id) WHERE tvdb_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_videos_imdb ON videos(imdb_id) WHERE imdb_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS playlist_videos (
      playlist_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      position INTEGER DEFAULT 0,
      PRIMARY KEY (playlist_id, video_id),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tv_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER UNIQUE,
      show_name TEXT NOT NULL,
      season INTEGER DEFAULT 1,
      episode INTEGER DEFAULT 1,
      title TEXT NOT NULL,
      tvdb_id TEXT,
      air_date TEXT
    );

    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_nfs_path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      author TEXT DEFAULT 'Unknown Author',
      series TEXT,
      year INTEGER,
      format TEXT DEFAULT 'EPUB',
      file_size INTEGER DEFAULT 0,
      cover_path TEXT,
      chaptarr_id TEXT,
      date_added TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audiobooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_nfs_path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      author TEXT DEFAULT 'Unknown Author',
      narrator TEXT,
      duration REAL DEFAULT 0,
      current_time_sec REAL DEFAULT 0,
      is_finished INTEGER DEFAULT 0,
      resume_position_ms INTEGER DEFAULT 0,
      chapters_json TEXT,
      format TEXT DEFAULT 'M4B',
      file_size INTEGER DEFAULT 0,
      cover_path TEXT,
      abs_item_id TEXT,
      date_added TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_nfs_path TEXT UNIQUE NOT NULL,
      album_name TEXT DEFAULT 'Library',
      title TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      file_size INTEGER DEFAULT 0,
      immich_asset_id TEXT,
      taken_at TEXT,
      date_added TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cache_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      progress REAL DEFAULT 0,
      encoder_used TEXT,
      size_bytes INTEGER DEFAULT 0,
      error_message TEXT,
      last_accessed TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIEW IF NOT EXISTS transcode_jobs AS
      SELECT * FROM cache_jobs;

    CREATE TABLE IF NOT EXISTS watch_progress (
      video_id INTEGER PRIMARY KEY,
      view_offset_ms INTEGER DEFAULT 0,
      watched INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 4. Initialize store.sqlite schema
  storeDb.exec(`
    CREATE TABLE IF NOT EXISTS store_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      foreign_id TEXT,
      service TEXT NOT NULL,
      status TEXT DEFAULT 'requested',
      payload_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS arr_sync_cache (
      cache_key TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upload_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      file_count INTEGER DEFAULT 1,
      arr_triggered INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  coreDbInstance = coreDb;
  cacheDbInstance = cacheDb;
  videoDbInstance = videoDb;
  storeDbInstance = storeDb;

  // Idempotent one-time migration of cache & video tables from legacy rtunes.sqlite / core.sqlite
  const splitMigrated = coreDb
    .prepare("SELECT value FROM settings WHERE key = 'domain_split_v3_migrated'")
    .get() as { value: string } | undefined;
  if (!splitMigrated) {
    const sourceLegacyPath = fs.existsSync(legacyDbPath)
      ? legacyDbPath
      : dbFilePath !== legacyDbPath
      ? dbFilePath
      : '';
    if (sourceLegacyPath && fs.existsSync(sourceLegacyPath)) {
      copyLegacyTable(cacheDb, sourceLegacyPath, 'artist_affinity_cache');
      copyLegacyTable(cacheDb, sourceLegacyPath, 'track_affinity_cache');
      copyLegacyTable(videoDb, sourceLegacyPath, 'videos');
      copyLegacyTable(videoDb, sourceLegacyPath, 'playlist_videos');
      copyLegacyTable(videoDb, sourceLegacyPath, 'books');
      copyLegacyTable(videoDb, sourceLegacyPath, 'audiobooks');
      copyLegacyTable(videoDb, sourceLegacyPath, 'photos');
      copyLegacyTable(videoDb, sourceLegacyPath, 'cache_jobs');
      try {
        videoDb.exec("INSERT INTO videos_fts(videos_fts) VALUES('rebuild')");
      } catch {
        // ignore
      }
    }
    try {
      coreDb.exec("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')");
    } catch {
      // ignore
    }
    coreDb
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('domain_split_v3_migrated', '1', datetime('now'))"
      )
      .run();
  }

  backfillTrackUids();
  registerDbShutdownHooks();
  logger.info(
    'DB',
    'Domain-split SQLite + FTS5 schemas verified and ready.',
    { corePath: dbFilePath, cachePath: cacheDbFilePath, videoPath: videoDbFilePath, storePath: storeDbFilePath },
    Date.now() - start
  );
  return coreDb;
}

export function getCoreDb(): Database.Database {
  if (!coreDbInstance) {
    initDatabase();
  }
  return coreDbInstance!;
}

export function getCacheDb(): Database.Database {
  if (!cacheDbInstance) {
    initDatabase();
  }
  return cacheDbInstance!;
}

export function getVideoDb(): Database.Database {
  if (!videoDbInstance) {
    initDatabase();
  }
  return videoDbInstance!;
}

export function getStoreDb(): Database.Database {
  if (!storeDbInstance) {
    initDatabase();
  }
  return storeDbInstance!;
}

export function getDb(): Database.Database {
  return getCoreDb();
}

export function getLibraryRevision(): number {
  const row = getCoreDb()
    .prepare("SELECT CAST(value AS INTEGER) AS rev FROM settings WHERE key = 'library_revision'")
    .get() as { rev: number } | undefined;
  return row?.rev || 0;
}

export function bumpLibraryRevision(): number {
  getCoreDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('library_revision', '1', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(COALESCE(CAST(settings.value AS INTEGER), 0) + 1 AS TEXT),
         updated_at = datetime('now')`
    )
    .run();
  return getLibraryRevision();
}

export function backfillTrackUids(): number {
  const db = getCoreDb();
  const missing = db
    .prepare(
      `SELECT id, remote_nfs_path, mbid_recording, artist, album, disc_num, track_num, title, duration
       FROM tracks
       WHERE track_uid IS NULL OR track_uid = '' OR COALESCE(sync_rev, 0) = 0`
    )
    .all() as {
    id: number;
    remote_nfs_path: string;
    mbid_recording: string | null;
    artist: string;
    album: string;
    disc_num: number | null;
    track_num: number | null;
    title: string;
    duration: number | null;
  }[];
  if (missing.length === 0) return 0;

  const usedRows = db
    .prepare("SELECT track_uid FROM tracks WHERE track_uid IS NOT NULL AND track_uid != ''")
    .all() as { track_uid: string }[];
  const usedUids = new Set(usedRows.map((r) => r.track_uid));
  const updStmt = db.prepare('UPDATE tracks SET track_uid = ? WHERE id = ?');

  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of missing) {
      let uid = computeTrackUid(r);
      if (usedUids.has(uid)) {
        uid = crypto
          .createHash('sha256')
          .update(`${uid}|${r.remote_nfs_path || r.id}`)
          .digest('hex')
          .slice(0, 32);
      }
      usedUids.add(uid);
      updStmt.run(uid, r.id);
      updated++;
    }
  });
  tx();
  return updated;
}

export function getDeltaSyncBatch(
  sinceRev = 0,
  limit = 2000
): {
  current_rev: number;
  upserted: TrackRow[];
  deleted_uids: string[];
  has_more: boolean;
} {
  const db = getCoreDb();
  const current_rev = getLibraryRevision();
  const safeSince = Math.max(0, Math.floor(sinceRev));
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
  const rows = db
    .prepare(
      'SELECT * FROM tracks WHERE COALESCE(sync_rev, 0) > ? ORDER BY sync_rev ASC, id ASC LIMIT ?'
    )
    .all(safeSince, safeLimit + 1) as TrackRow[];
  const has_more = rows.length > safeLimit;
  const upserted = has_more ? rows.slice(0, safeLimit) : rows;
  const deletedRows = db
    .prepare('SELECT track_uid FROM sync_tombstones WHERE deleted_rev > ? ORDER BY deleted_rev ASC')
    .all(safeSince) as { track_uid: string }[];
  return {
    current_rev,
    upserted,
    deleted_uids: deletedRows.map((r) => r.track_uid),
    has_more,
  };
}

export function applyPlaybackDeltaSync(updates: PlaybackDeltaUpdate[]): {
  ok: boolean;
  current_rev: number;
  applied: number;
} {
  const db = getCoreDb();
  let applied = 0;
  const findStmt = db.prepare(
    'SELECT id, play_count, local_star_rating, is_loved, last_played FROM tracks WHERE track_uid = ?'
  );
  const updateStmt = db.prepare(
    `UPDATE tracks
     SET play_count = COALESCE(play_count, 0) + ?,
         local_star_rating = ?,
         is_loved = ?,
         last_played = ?
     WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const u of updates) {
      const uid = (u.track_uid || '').trim();
      if (!uid) continue;
      const row = findStmt.get(uid) as
        | {
            id: number;
            play_count: number;
            local_star_rating: number;
            is_loved: number;
            last_played: string | null;
          }
        | undefined;
      if (!row) continue;
      const delta = Math.max(0, Math.round(Number(u.play_count_delta || 0)));
      const nextRating =
        u.rating !== undefined && Number.isFinite(Number(u.rating))
          ? Math.max(0, Math.min(5, Math.round(Number(u.rating))))
          : row.local_star_rating || 0;
      const nextLoved =
        u.loved !== undefined
          ? u.loved === true || u.loved === 1
            ? 1
            : 0
          : u.rating !== undefined && nextRating === 5
          ? 1
          : row.is_loved || 0;
      const nextLastPlayed = u.last_played_at || row.last_played || new Date().toISOString();
      updateStmt.run(delta, nextRating, nextLoved, nextLastPlayed, row.id);
      applied++;
    }
  });
  tx();
  const current_rev = getLibraryRevision();
  if (applied > 0) {
    emitRendererEvent('library:updated', { current_rev });
  }
  return { ok: true, current_rev, applied };
}

/**
 * Recalculates artist_median_listen_count, artist_relative_popularity_score (0.0-100.0),
 * artist_rarity_multiplier (0.10x-10.00x), and discovery_score (0.0-1000.0)
 * strictly from combined_global_plays (LB + Last.fm + AudioDB), excluding personal play_count.
 */
export function recalculateArtistPopularityScores(): { artistsUpdated: number; tracksUpdated: number } {
  const start = Date.now();
  const db = getDb();

  // Keep combined_global_plays in sync first
  db.exec(`
    UPDATE tracks
    SET combined_global_plays = COALESCE(global_listen_count, 0) + COALESCE(lastfm_plays, 0) + COALESCE(audiodb_plays, 0)
  `);

  const allTracks = db
    .prepare(
      `SELECT id, artist, title, album, genre, duration, combined_global_plays
       FROM tracks
       WHERE artist IS NOT NULL AND artist != ''`
    )
    .all() as {
      id: number;
      artist: string;
      title: string;
      album: string;
      genre: string;
      duration: number;
      combined_global_plays: number;
    }[];

  const byArtist = new Map<string, typeof allTracks>();
  const globalStudioCounts: number[] = [];

  for (const t of allTracks) {
    const list = byArtist.get(t.artist) || [];
    list.push(t);
    byArtist.set(t.artist, list);

    const variant = classifyVariant(t);
    if (variant === 'studio_vocal' && !isInterludeOrSkit(t) && (t.combined_global_plays || 0) > 0) {
      globalStudioCounts.push(t.combined_global_plays);
    }
  }

  let globalStudioMedian = 100;
  if (globalStudioCounts.length > 0) {
    globalStudioCounts.sort((a, b) => a - b);
    const gm = Math.floor(globalStudioCounts.length / 2);
    globalStudioMedian =
      globalStudioCounts.length % 2 !== 0
        ? globalStudioCounts[gm]
        : (globalStudioCounts[gm - 1] + globalStudioCounts[gm]) / 2.0;
    globalStudioMedian = Math.max(globalStudioMedian, 10);
  }

  // Compute each artist's studio baseline + peak/total global popularity for rarity ranking
  const artistStats = new Map<
    string,
    { smoothedMedian: number; peakOrTotalLog: number; hasGlobal: boolean }
  >();
  let minLogPop = Infinity;
  let maxLogPop = -Infinity;

  for (const [artist, rows] of byArtist.entries()) {
    const studioRows = rows.filter(
      (r) => classifyVariant(r) === 'studio_vocal' && !isInterludeOrSkit(r)
    );
    const baselinePool = (studioRows.length > 0 ? studioRows : rows)
      .map((r) => r.combined_global_plays || 0)
      .sort((a, b) => a - b);

    const nonZeroPool = baselinePool.filter((c) => c > 0);
    const medianPool = nonZeroPool.length > 0 ? nonZeroPool : baselinePool;
    const mid = Math.floor(medianPool.length / 2);
    const rawMedian =
      medianPool.length === 0
        ? 0
        : medianPool.length % 2 !== 0
          ? medianPool[mid]
          : (medianPool[mid - 1] + medianPool[mid]) / 2.0;

    // Bayesian smoothing (prior weight = 5 tracks at globalStudioMedian)
    const n = nonZeroPool.length;
    const smoothedMedian = Math.max(
      1.0,
      (n * rawMedian + 5 * globalStudioMedian) / (n + 5)
    );

    const peakPlays = rows.reduce((mx, r) => Math.max(mx, r.combined_global_plays || 0), 0);
    const hasGlobal = peakPlays > 0;
    const peakOrTotalLog = hasGlobal ? Math.log10(Math.max(1, peakPlays)) : 0;

    if (hasGlobal) {
      if (peakOrTotalLog < minLogPop) minLogPop = peakOrTotalLog;
      if (peakOrTotalLog > maxLogPop) maxLogPop = peakOrTotalLog;
    }

    artistStats.set(artist, { smoothedMedian, peakOrTotalLog, hasGlobal });
  }

  const logSpan = Number.isFinite(minLogPop) && maxLogPop > minLogPop ? maxLogPop - minLogPop : 1;

  const updateTrack = db.prepare(`
    UPDATE tracks
    SET artist_median_listen_count = ?,
        artist_relative_popularity_score = ?,
        artist_rarity_multiplier = ?,
        discovery_score = ?
    WHERE id = ?
  `);

  let tracksUpdated = 0;
  const runTx = db.transaction(() => {
    for (const [artist, rows] of byArtist.entries()) {
      const st = artistStats.get(artist)!;
      let rarityMult = 1.0;
      if (st.hasGlobal) {
        const norm = Math.max(0, Math.min(1, (st.peakOrTotalLog - minLogPop) / logSpan));
        // 10.00x (least popular) -> 0.10x (most popular) on logarithmic curve
        rarityMult = Math.round(Math.max(0.1, Math.min(10.0, 10.0 * Math.pow(0.01, norm))) * 100) / 100;
      }

      for (const r of rows) {
        const plays = r.combined_global_plays || 0;
        let relScore = 0.0;
        if (plays > 0) {
          const ratio = plays / st.smoothedMedian;
          const sigmoid = 1 / (1 + Math.exp(-1.15 * Math.log2(ratio)));
          relScore = Math.round(Math.max(0, Math.min(100, sigmoid * 100)) * 10) / 10;
        }
        const discoveryScore = Math.round(Math.min(1000, relScore * rarityMult) * 10) / 10;

        updateTrack.run(
          Math.round(st.smoothedMedian * 10) / 10,
          relScore,
          rarityMult,
          discoveryScore,
          r.id
        );
        tracksUpdated++;
      }
    }
  });

  runTx();
  logger.info(
    'DB',
    `Recalculated Bounded 3-Tier Popularity across ${byArtist.size} artists (${tracksUpdated} tracks).`,
    { artistsUpdated: byArtist.size, tracksUpdated, globalStudioMedian },
    Date.now() - start
  );
  return { artistsUpdated: byArtist.size, tracksUpdated };
}

export function searchTracksFts(query: string, limit = 200000): TrackRow[] {
  const db = getDb();
  const trimmed = query.trim();
  const safeLimit = limit && limit > 0 ? limit : 200000;
  if (!trimmed) {
    return db
      .prepare('SELECT * FROM tracks ORDER BY artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC, disc_num ASC, track_num ASC LIMIT ?')
      .all(safeLimit) as TrackRow[];
  }

  const isExternalIdQuery =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ||
    /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(trimmed) ||
    /^(mbid|isrc|lastfm|deezer):/i.test(trimmed);

  if (isExternalIdQuery) {
    const rawId = trimmed.replace(/^(mbid|isrc|lastfm|deezer):/i, '').trim();
    const idMatches = db
      .prepare(
        `SELECT * FROM tracks
         WHERE mbid_recording = ? OR mbid_artist = ? OR mbid_release = ? OR mbid_release_group = ?
            OR isrc = ? OR lastfm_id = ? OR deezer_id = ?
         LIMIT ?`
      )
      .all(rawId, rawId, rawId, rawId, rawId, rawId, rawId, safeLimit) as TrackRow[];
    if (idMatches.length > 0) return idMatches;
  }

  // Sanitize FTS5 query tokens into prefix matches
  const sanitizedTokens = trimmed
    .replace(/["'*^():-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok}"*`)
    .join(' AND ');

  try {
    return db
      .prepare(
        `SELECT t.*
         FROM tracks_fts f
         JOIN tracks t ON t.id = f.rowid
         WHERE tracks_fts MATCH ?
         ORDER BY bm25(tracks_fts) ASC
         LIMIT ?`
      )
      .all(sanitizedTokens, safeLimit) as TrackRow[];
  } catch (err) {
    logger.warn('DB', 'FTS5 query fallback to LIKE due to syntax token', { query, error: String(err) });
    const likePattern = `%${trimmed}%`;
    return db
      .prepare(
        `SELECT * FROM tracks
         WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? OR genre LIKE ?
         ORDER BY artist ASC, album ASC, track_num ASC
         LIMIT ?`
      )
      .all(likePattern, likePattern, likePattern, likePattern, safeLimit) as TrackRow[];
  }
}

export function searchVideosFts(query: string, typeFilter?: 'movie' | 'tv'): VideoRow[] {
  const db = getVideoDb();
  const trimmed = query.trim();
  if (!trimmed) {
    if (typeFilter) {
      return db
        .prepare('SELECT * FROM videos WHERE type = ? ORDER BY title COLLATE NOCASE ASC, season ASC, episode ASC')
        .all(typeFilter) as VideoRow[];
    }
    return db
      .prepare('SELECT * FROM videos ORDER BY title COLLATE NOCASE ASC, season ASC, episode ASC')
      .all() as VideoRow[];
  }

  const isVideoIdQuery =
    /^tt\d{5,}$/i.test(trimmed) ||
    /^\d{4,}$/.test(trimmed) ||
    /^(tmdb|tvdb|imdb):/i.test(trimmed);

  if (isVideoIdQuery) {
    const rawId = trimmed.replace(/^(tmdb|tvdb|imdb):/i, '').trim();
    const sql = typeFilter
      ? `SELECT * FROM videos WHERE type = ? AND (tmdb_id = ? OR tvdb_id = ? OR imdb_id = ?)`
      : `SELECT * FROM videos WHERE tmdb_id = ? OR tvdb_id = ? OR imdb_id = ?`;
    const idMatches = (
      typeFilter
        ? db.prepare(sql).all(typeFilter, rawId, rawId, rawId)
        : db.prepare(sql).all(rawId, rawId, rawId)
    ) as VideoRow[];
    if (idMatches.length > 0) return idMatches;
  }

  const sanitizedTokens = trimmed
    .replace(/["'*^():-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok}"*`)
    .join(' AND ');

  try {
    if (typeFilter) {
      return db
        .prepare(
          `SELECT v.*
           FROM videos_fts f
           JOIN videos v ON v.id = f.rowid
           WHERE videos_fts MATCH ? AND v.type = ?
           ORDER BY bm25(videos_fts) ASC`
        )
        .all(sanitizedTokens, typeFilter) as VideoRow[];
    }
    return db
      .prepare(
        `SELECT v.*
         FROM videos_fts f
         JOIN videos v ON v.id = f.rowid
         WHERE videos_fts MATCH ?
         ORDER BY bm25(videos_fts) ASC`
      )
      .all(sanitizedTokens) as VideoRow[];
  } catch {
    const likePattern = `%${trimmed}%`;
    return db
      .prepare('SELECT * FROM videos WHERE title LIKE ? OR show_name LIKE ? ORDER BY title ASC')
      .all(likePattern, likePattern) as VideoRow[];
  }
}

export function getDatabaseDiagnostics() {
  const coreDb = getCoreDb();
  const videoDb = getVideoDb();
  const tracksCount = (coreDb.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;
  const cachedTracksCount = (coreDb.prepare('SELECT COUNT(*) as c FROM tracks WHERE local_cache_path IS NOT NULL').get() as { c: number }).c;
  const videosCount = (videoDb.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c;
  const transcodedVideosCount = (videoDb.prepare('SELECT COUNT(*) as c FROM videos WHERE is_transcoded = 1').get() as { c: number }).c;
  const playlistsCount = (coreDb.prepare('SELECT COUNT(*) as c FROM playlists').get() as { c: number }).c;
  const devicesCount = (coreDb.prepare('SELECT COUNT(*) as c FROM devices').get() as { c: number }).c;
  const pendingJobsCount = (videoDb.prepare("SELECT COUNT(*) as c FROM cache_jobs WHERE status IN ('queued', 'running')").get() as { c: number }).c;
  const ftsCount = (coreDb.prepare('SELECT COUNT(*) as c FROM tracks_fts').get() as { c: number }).c;

  let dbSizeBytes = 0;
  for (const p of [dbFilePath, cacheDbFilePath, videoDbFilePath, storeDbFilePath]) {
    try {
      if (p && fs.existsSync(p)) {
        dbSizeBytes += fs.statSync(p).size;
      }
    } catch {
      // ignore
    }
  }

  return {
    dbFilePath,
    dbSizeBytes,
    tracksCount,
    ftsCount,
    cachedTracksCount,
    videosCount,
    transcodedVideosCount,
    playlistsCount,
    devicesCount,
    pendingJobsCount,
  };
}

export function rebuildMediaDatabase(): { ok: boolean } {
  const coreDb = getCoreDb();
  const videoDb = getVideoDb();
  const cacheDb = getCacheDb();
  logger.info('DB', 'Rebuilding domain media databases (preserving settings, shares, devices, and playlists)...');
  const coreTx = coreDb.transaction(() => {
    coreDb.exec(`
      DELETE FROM playlist_tracks;
      DELETE FROM tracks;
      DELETE FROM artist_genre_weights;
      DELETE FROM subgenre_affinity_matrix;
      INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild');
    `);
    const checkpoint = JSON.stringify({
      inProgress: true,
      isRebuild: true,
      completedDirs: [],
      totalDirs: 0,
      audioAdded: 0,
      videoAdded: 0,
      albumsFound: 0,
      updatedAt: Date.now(),
    });
    coreDb.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('indexer_scan_checkpoint', ?, datetime('now'))"
    ).run(checkpoint);
  });
  coreTx();

  videoDb.transaction(() => {
    videoDb.exec(`
      DELETE FROM playlist_videos;
      DELETE FROM tv_episodes;
      DELETE FROM watch_progress;
      DELETE FROM videos;
      DELETE FROM books;
      DELETE FROM audiobooks;
      DELETE FROM photos;
      DELETE FROM cache_jobs;
      INSERT INTO videos_fts(videos_fts) VALUES('rebuild');
    `);
  })();

  cacheDb.transaction(() => {
    cacheDb.exec(`
      DELETE FROM artist_affinity_cache;
      DELETE FROM track_affinity_cache;
      DELETE FROM external_metadata_cache;
    `);
  })();

  logger.info('DB', 'Media databases cleared and FTS5 indexes rebuilt.');
  return { ok: true };
}
