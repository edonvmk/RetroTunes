import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logger } from './logger';
import { platformDriver } from './platform';

export interface TrackRow {
  id: number;
  remote_nfs_path: string;
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
  artist_median_listen_count: number;
  artist_relative_popularity_score: number;
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

let dbInstance: Database.Database | null = null;
let dbFilePath = '';

export function getDbPath(): string {
  if (dbFilePath) return dbFilePath;
  let dataDir = '';
  try {
    dataDir = app?.getPath ? app.getPath('userData') : platformDriver.getFallbackUserDataDir();
  } catch {
    dataDir = platformDriver.getFallbackUserDataDir();
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    dbFilePath = path.join(dataDir, 'rtunes.sqlite');
  } catch {
    const localDataDir = path.join(process.cwd(), '.data');
    fs.mkdirSync(localDataDir, { recursive: true });
    dbFilePath = path.join(localDataDir, 'rtunes.sqlite');
  }
  return dbFilePath;
}

export function initDatabase(customPath?: string): Database.Database {
  if (dbInstance) return dbInstance;
  const start = Date.now();
  const targetPath = customPath || getDbPath();
  dbFilePath = targetPath;

  logger.info('DB', `Initializing SQLite + FTS5 database at ${targetPath}`);
  const db = new Database(targetPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_nfs_path TEXT UNIQUE NOT NULL,
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

    CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, remote_nfs_path)
      VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre, old.remote_nfs_path);
      INSERT INTO tracks_fts(rowid, title, artist, album, genre, remote_nfs_path)
      VALUES (new.id, new.title, new.artist, new.album, new.genre, new.remote_nfs_path);
    END;

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
      show_name TEXT,
      season INTEGER,
      episode INTEGER,
      year INTEGER,
      tmdb_id TEXT,
      tvdb_id TEXT,
      poster_path TEXT,
      watched INTEGER DEFAULT 0,
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

    CREATE TRIGGER IF NOT EXISTS videos_au AFTER UPDATE ON videos BEGIN
      INSERT INTO videos_fts(videos_fts, rowid, title, show_name, remote_nfs_path)
      VALUES ('delete', old.id, old.title, COALESCE(old.show_name, ''), old.remote_nfs_path);
      INSERT INTO videos_fts(rowid, title, show_name, remote_nfs_path)
      VALUES (new.id, new.title, COALESCE(new.show_name, ''), new.remote_nfs_path);
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

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      position INTEGER DEFAULT 0,
      PRIMARY KEY (playlist_id, track_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS playlist_videos (
      playlist_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      position INTEGER DEFAULT 0,
      PRIMARY KEY (playlist_id, video_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS devices (
      uuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mount_path TEXT NOT NULL,
      device_type TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      last_connected TEXT,
      last_synced TEXT
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

    CREATE TABLE IF NOT EXISTS smart_playlist_exclusions (
      smart_playlist_id TEXT NOT NULL,
      track_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (smart_playlist_id, track_id)
    );
  `);

  // Safe migration for existing databases
  try {
    const cols = db.prepare("PRAGMA table_info('tracks')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'metadata_loaded')) {
      db.exec('ALTER TABLE tracks ADD COLUMN metadata_loaded INTEGER DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'exclude_from_smart_playlists')) {
      db.exec('ALTER TABLE tracks ADD COLUMN exclude_from_smart_playlists INTEGER DEFAULT 0');
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
        db.exec(`ALTER TABLE tracks ADD COLUMN ${col} TEXT`);
      }
    }
    const vCols = db.prepare("PRAGMA table_info('videos')").all() as { name: string }[];
    if (!vCols.some((c) => c.name === 'poster_path')) {
      db.exec('ALTER TABLE videos ADD COLUMN poster_path TEXT');
    }
    if (!vCols.some((c) => c.name === 'artist')) {
      db.exec('ALTER TABLE videos ADD COLUMN artist TEXT');
    }
    if (!vCols.some((c) => c.name === 'view_offset_ms')) {
      db.exec('ALTER TABLE videos ADD COLUMN view_offset_ms INTEGER DEFAULT 0');
    }
    for (const col of ['imdb_id', 'radarr_id', 'sonarr_id', 'plex_rating_key']) {
      if (!vCols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE videos ADD COLUMN ${col} TEXT`);
      }
    }
    // Partial indexes on external IDs (only index non-null rows — zero overhead for unpopulated rows)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tracks_mbid_rec ON tracks(mbid_recording) WHERE mbid_recording IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_mbid_art ON tracks(mbid_artist) WHERE mbid_artist IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_mbid_rel ON tracks(mbid_release) WHERE mbid_release IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc) WHERE isrc IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_lastfm ON tracks(lastfm_id) WHERE lastfm_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_deezer ON tracks(deezer_id) WHERE deezer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_videos_tmdb ON videos(tmdb_id) WHERE tmdb_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_videos_tvdb ON videos(tvdb_id) WHERE tvdb_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_videos_imdb ON videos(imdb_id) WHERE imdb_id IS NOT NULL;
    `);
    const pCols = db.prepare("PRAGMA table_info('playlists')").all() as { name: string }[];
    if (!pCols.some((c) => c.name === 'media_type')) {
      db.exec("ALTER TABLE playlists ADD COLUMN media_type TEXT DEFAULT 'music'");
    }
    const dCols = db.prepare("PRAGMA table_info('devices')").all() as { name: string }[];
    if (!dCols.some((c) => c.name === 'transport_mode')) {
      db.exec("ALTER TABLE devices ADD COLUMN transport_mode TEXT DEFAULT 'ums'");
    }
    if (!dCols.some((c) => c.name === 'mtp_serial')) {
      db.exec('ALTER TABLE devices ADD COLUMN mtp_serial TEXT');
    }
    if (!dCols.some((c) => c.name === 'last_processed_scrobble_ts')) {
      db.exec('ALTER TABLE devices ADD COLUMN last_processed_scrobble_ts INTEGER DEFAULT 0');
    }
  } catch {
    // ignore
  }

  // Ensure default Smart Playlist rule definitions exist (evaluates dynamically against real tracks)
  const playlistCount = (db.prepare('SELECT COUNT(*) as c FROM playlists').get() as { c: number }).c;
  if (playlistCount === 0) {
    const insertPlaylist = db.prepare(`
      INSERT INTO playlists (name, is_smart, smart_rules_json, track_limit, limit_type, limit_value, selection_method)
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `);

    insertPlaylist.run(
      'Artist Catalog Standouts (>= 1.5x Median)',
      JSON.stringify({
        match: 'ALL',
        conditions: [
          {
            id: 'c1',
            type: 'rule',
            field: 'artist_relative_popularity_score',
            operator: 'gte',
            value: 1.5,
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

  dbInstance = db;
  logger.info('DB', 'SQLite + FTS5 schema verified and ready.', { path: targetPath }, Date.now() - start);
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Recalculates artist_median_listen_count and artist_relative_popularity_score
 * across all artists in the database (Section 5: Median Popularity Normalization).
 * artist_relative_popularity_score = global_listen_count / MAX(artist_median_listen_count, 1)
 */
export function recalculateArtistPopularityScores(): { artistsUpdated: number; tracksUpdated: number } {
  const start = Date.now();
  const db = getDb();
  const artists = db
    .prepare("SELECT DISTINCT artist FROM tracks WHERE artist IS NOT NULL AND artist != ''")
    .all() as { artist: string }[];

  const getTracksForArtist = db.prepare(
    'SELECT id, global_listen_count, play_count FROM tracks WHERE artist = ? ORDER BY global_listen_count ASC'
  );
  const updateTrack = db.prepare(`
    UPDATE tracks
    SET artist_median_listen_count = ?,
        artist_relative_popularity_score = ROUND(CAST(MAX(global_listen_count, play_count) AS REAL) / MAX(?, 5.0), 3)
    WHERE id = ?
  `);

  let tracksUpdated = 0;
  const runTx = db.transaction(() => {
    for (const { artist } of artists) {
      const rows = getTracksForArtist.all(artist) as {
        id: number;
        global_listen_count: number;
        play_count: number;
      }[];
      if (rows.length === 0) continue;

      const counts = rows
        .map((r) => Math.max(r.global_listen_count || 0, r.play_count || 0))
        .sort((a, b) => a - b);
      const mid = Math.floor(counts.length / 2);
      const rawMedian =
        counts.length % 2 !== 0
          ? counts[mid]
          : (counts[mid - 1] + counts[mid]) / 2.0;
      const effectiveMedian = Math.max(rawMedian, 5.0);

      for (const r of rows) {
        updateTrack.run(effectiveMedian, effectiveMedian, r.id);
        tracksUpdated++;
      }
    }
  });

  runTx();
  logger.info(
    'DB',
    `Recalculated Artist-Normalized Median Popularity across ${artists.length} artists (${tracksUpdated} tracks).`,
    { artistsUpdated: artists.length, tracksUpdated },
    Date.now() - start
  );
  return { artistsUpdated: artists.length, tracksUpdated };
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
  const db = getDb();
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
  const db = getDb();
  const tracksCount = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;
  const cachedTracksCount = (db.prepare('SELECT COUNT(*) as c FROM tracks WHERE local_cache_path IS NOT NULL').get() as { c: number }).c;
  const videosCount = (db.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c;
  const transcodedVideosCount = (db.prepare('SELECT COUNT(*) as c FROM videos WHERE is_transcoded = 1').get() as { c: number }).c;
  const playlistsCount = (db.prepare('SELECT COUNT(*) as c FROM playlists').get() as { c: number }).c;
  const devicesCount = (db.prepare('SELECT COUNT(*) as c FROM devices').get() as { c: number }).c;
  const pendingJobsCount = (db.prepare("SELECT COUNT(*) as c FROM cache_jobs WHERE status IN ('queued', 'running')").get() as { c: number }).c;
  const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM tracks_fts').get() as { c: number }).c;

  let dbSizeBytes = 0;
  try {
    if (fs.existsSync(dbFilePath)) {
      dbSizeBytes = fs.statSync(dbFilePath).size;
    }
  } catch {
    // ignore
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
