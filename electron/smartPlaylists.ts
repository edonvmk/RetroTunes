import path from 'path';
import { getDb, PlaylistRow, TrackRow, VideoRow } from './db';
import { logger } from './logger';

export type SmartField =
  | 'title'
  | 'artist'
  | 'album'
  | 'genre'
  | 'year'
  | 'bitrate'
  | 'format'
  | 'play_count'
  | 'local_star_rating'
  | 'is_loved'
  | 'global_listen_count'
  | 'artist_median_listen_count'
  | 'artist_relative_popularity_score'
  | 'duration'
  | 'remote_nfs_path';

export type SmartOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between';

export interface SmartRule {
  id: string;
  type: 'rule';
  field: SmartField;
  operator: SmartOperator;
  value: string | number;
  valueTo?: string | number;
}

export interface SmartRuleGroup {
  id?: string;
  type?: 'group';
  match: 'ALL' | 'ANY';
  conditions: (SmartRule | SmartRuleGroup)[];
}

const ALLOWED_FIELDS: Record<SmartField, 'text' | 'number'> = {
  title: 'text',
  artist: 'text',
  album: 'text',
  genre: 'text',
  format: 'text',
  year: 'number',
  bitrate: 'number',
  play_count: 'number',
  local_star_rating: 'number',
  is_loved: 'number',
  global_listen_count: 'number',
  artist_median_listen_count: 'number',
  artist_relative_popularity_score: 'number',
  duration: 'number',
  remote_nfs_path: 'text',
};

function compileCondition(node: SmartRule | SmartRuleGroup, params: unknown[]): string {
  if ('conditions' in node && Array.isArray(node.conditions)) {
    if (node.conditions.length === 0) return '1=1';
    const joiner = node.match === 'ANY' ? ' OR ' : ' AND ';
    const parts = node.conditions
      .map((child) => compileCondition(child, params))
      .filter(Boolean);
    if (parts.length === 0) return '1=1';
    return `(${parts.join(joiner)})`;
  }

  const rule = node as SmartRule;
  const fieldType = ALLOWED_FIELDS[rule.field];
  if (!fieldType) return '1=1';

  const col = rule.field;
  const val = fieldType === 'number' ? Number(rule.value || 0) : String(rule.value ?? '');

  switch (rule.operator) {
    case 'is':
      if (fieldType === 'text') {
        params.push(val);
        return `LOWER(${col}) = LOWER(?)`;
      }
      params.push(val);
      return `${col} = ?`;

    case 'is_not':
      if (fieldType === 'text') {
        params.push(val);
        return `LOWER(${col}) != LOWER(?)`;
      }
      params.push(val);
      return `${col} != ?`;

    case 'contains':
      params.push(`%${val}%`);
      return `${col} LIKE ? COLLATE NOCASE`;

    case 'not_contains':
      params.push(`%${val}%`);
      return `${col} NOT LIKE ? COLLATE NOCASE`;

    case 'starts_with':
      params.push(`${val}%`);
      return `${col} LIKE ? COLLATE NOCASE`;

    case 'gt':
      params.push(val);
      return `${col} > ?`;

    case 'gte':
      params.push(val);
      return `${col} >= ?`;

    case 'lt':
      params.push(val);
      return `${col} < ?`;

    case 'lte':
      params.push(val);
      return `${col} <= ?`;

    case 'between': {
      const val2 = fieldType === 'number' ? Number(rule.valueTo ?? val) : String(rule.valueTo ?? val);
      params.push(val, val2);
      return `(${col} >= ? AND ${col} <= ?)`;
    }

    default:
      return '1=1';
  }
}

function getOrderByClause(selectionMethod: string): string {
  switch (selectionMethod) {
    case 'random':
      return 'RANDOM()';
    case 'popularity_desc':
      return 'artist_relative_popularity_score DESC, global_listen_count DESC';
    case 'rating_desc':
      return 'local_star_rating DESC, is_loved DESC, artist_relative_popularity_score DESC';
    case 'most_played':
      return 'play_count DESC, local_star_rating DESC';
    case 'recently_added':
      return 'date_added DESC, id DESC';
    case 'artist_asc':
    default:
      return 'artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC, disc_num ASC, track_num ASC';
  }
}

export function evaluateSmartPlaylist(
  rulesGroup: SmartRuleGroup,
  limitType = 'tracks',
  limitValue: number | null = null,
  selectionMethod = 'popularity_desc',
  smartPlaylistId?: number | string | null
): { tracks: TrackRow[]; compiledSql: string } {
  const start = Date.now();
  const db = getDb();
  const params: unknown[] = [];
  const whereClause = compileCondition(rulesGroup, params);
  const orderBy = getOrderByClause(selectionMethod);

  let exclusionClause = 'COALESCE(exclude_from_smart_playlists, 0) = 0';
  if (smartPlaylistId !== undefined && smartPlaylistId !== null) {
    exclusionClause += ' AND id NOT IN (SELECT track_id FROM smart_playlist_exclusions WHERE smart_playlist_id = ?)';
    params.push(String(smartPlaylistId));
  }

  let sql = `SELECT * FROM tracks WHERE (${whereClause}) AND ${exclusionClause} ORDER BY ${orderBy}`;
  if (limitType === 'tracks' && limitValue && limitValue > 0) {
    sql += ` LIMIT ${Math.floor(limitValue)}`;
  }

  let rows = db.prepare(sql).all(...params) as TrackRow[];

  // Apply cumulative size or duration constraints if selected (Section 5: File Size or Duration limits)
  if (limitValue && limitValue > 0 && limitType !== 'tracks') {
    const constrained: TrackRow[] = [];
    let runningTotal = 0;

    const maxBytes =
      limitType === 'size_gb'
        ? limitValue * 1024 * 1024 * 1024
        : limitType === 'size_mb'
        ? limitValue * 1024 * 1024
        : 0;
    const maxSeconds =
      limitType === 'duration_hours'
        ? limitValue * 3600
        : limitType === 'duration_mins'
        ? limitValue * 60
        : 0;

    for (const track of rows) {
      if (maxBytes > 0) {
        if (runningTotal + (track.file_size || 0) > maxBytes && constrained.length > 0) break;
        runningTotal += track.file_size || 0;
        constrained.push(track);
      } else if (maxSeconds > 0) {
        if (runningTotal + (track.duration || 0) > maxSeconds && constrained.length > 0) break;
        runningTotal += track.duration || 0;
        constrained.push(track);
      }
    }
    rows = constrained;
  }

  logger.debug(
    'SMART_PLAYLIST',
    `Evaluated Smart Playlist query (${rows.length} tracks matched)`,
    { sql, params, limitType, limitValue, selectionMethod },
    Date.now() - start
  );

  return { tracks: rows, compiledSql: sql };
}

export function getPlaylistTracks(playlistId: number): TrackRow[] {
  const db = getDb();
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
    | PlaylistRow
    | undefined;
  if (!playlist) return [];

  if (playlist.is_smart && playlist.smart_rules_json) {
    try {
      const rules = JSON.parse(playlist.smart_rules_json) as SmartRuleGroup;
      const limitVal = playlist.limit_value ?? playlist.track_limit ?? null;
      return evaluateSmartPlaylist(
        rules,
        playlist.limit_type || 'tracks',
        limitVal,
        playlist.selection_method || 'popularity_desc',
        playlist.id
      ).tracks;
    } catch (err) {
      logger.error('SMART_PLAYLIST', `Invalid smart_rules_json for playlist ${playlist.name}`, err);
      return [];
    }
  }

  return db
    .prepare(
      `SELECT t.*
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       WHERE pt.playlist_id = ?
       ORDER BY pt.position ASC`
    )
    .all(playlistId) as TrackRow[];
}

export function getPlaylistVideos(playlistId: number): VideoRow[] {
  const db = getDb();
  try {
    return db
      .prepare(
        `SELECT v.*
         FROM playlist_videos pv
         JOIN videos v ON v.id = pv.video_id
         WHERE pv.playlist_id = ?
         ORDER BY pv.position ASC`
      )
      .all(playlistId) as VideoRow[];
  } catch {
    return [];
  }
}

/**
 * Generates standard relative-path .m3u8 content for ePod sync (Section 5 & Section 6).
 */
export function generateRelativeM3u8(
  tracks: TrackRow[],
  deviceAudioFileMap: Map<number, string>,
  playlistDirOnDevice: string
): string {
  const lines: string[] = ['#EXTM3U'];
  for (const track of tracks) {
    const targetAudioPath = deviceAudioFileMap.get(track.id);
    if (!targetAudioPath) continue;
    const relPath = path.relative(playlistDirOnDevice, targetAudioPath).split(path.sep).join('/');
    const dur = Math.round(track.duration || 0);
    lines.push(`#EXTINF:${dur},${track.artist} - ${track.title}`);
    lines.push(relPath);
  }
  return lines.join('\n') + '\n';
}

export interface SmartPlaylistExcludedItem {
  track: TrackRow;
  scope: 'playlist' | 'global';
}

export function ignoreTrackInSmartPlaylist(
  smartPlaylistId: number | string,
  trackId: number
): { ok: boolean } {
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO smart_playlist_exclusions (smart_playlist_id, track_id) VALUES (?, ?)'
  ).run(String(smartPlaylistId), trackId);
  return { ok: true };
}

export function excludeTrackFromAllSmartPlaylists(
  trackId: number,
  excluded = true
): { ok: boolean } {
  const db = getDb();
  db.prepare('UPDATE tracks SET exclude_from_smart_playlists = ? WHERE id = ?').run(
    excluded ? 1 : 0,
    trackId
  );
  return { ok: true };
}

export function getSmartPlaylistExclusions(
  smartPlaylistId: number | string
): SmartPlaylistExcludedItem[] {
  const db = getDb();
  const perPlaylist = db
    .prepare(
      `SELECT t.* FROM smart_playlist_exclusions spe
       JOIN tracks t ON t.id = spe.track_id
       WHERE spe.smart_playlist_id = ?
       ORDER BY t.artist COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC`
    )
    .all(String(smartPlaylistId)) as TrackRow[];

  const globalExcluded = db
    .prepare(
      `SELECT * FROM tracks
       WHERE COALESCE(exclude_from_smart_playlists, 0) = 1
       ORDER BY artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC`
    )
    .all() as TrackRow[];

  const results: SmartPlaylistExcludedItem[] = [];
  const seenGlobal = new Set<number>();
  for (const t of globalExcluded) {
    seenGlobal.add(t.id);
    results.push({ track: t, scope: 'global' });
  }
  for (const t of perPlaylist) {
    if (!seenGlobal.has(t.id)) {
      results.push({ track: t, scope: 'playlist' });
    }
  }
  return results;
}

export function restoreSmartPlaylistExclusion(
  smartPlaylistId: number | string,
  trackId: number,
  scope: 'playlist' | 'global'
): { ok: boolean } {
  const db = getDb();
  if (scope === 'global') {
    db.prepare('UPDATE tracks SET exclude_from_smart_playlists = 0 WHERE id = ?').run(trackId);
  } else {
    db.prepare(
      'DELETE FROM smart_playlist_exclusions WHERE smart_playlist_id = ? AND track_id = ?'
    ).run(String(smartPlaylistId), trackId);
  }
  return { ok: true };
}
