import path from 'path';
import { getCoreDb, getVideoDb, PlaylistRow, TrackRow, VideoRow } from './db';
import { logger } from './logger';
import { getMatchingArtistsForSceneFilter, listAllMatrixGenres } from './egenius/genreMatrix';

export type SmartField =
  | 'title'
  | 'artist'
  | 'album'
  | 'album_artist'
  | 'genre'
  | 'year'
  | 'bitrate'
  | 'format'
  | 'play_count'
  | 'local_star_rating'
  | 'is_loved'
  | 'keep_cached'
  | 'global_listen_count'
  | 'lastfm_plays'
  | 'audiodb_plays'
  | 'combined_global_plays'
  | 'artist_median_listen_count'
  | 'artist_relative_popularity_score'
  | 'artist_rarity_multiplier'
  | 'discovery_score'
  | 'duration'
  | 'track_num'
  | 'disc_num'
  | 'file_size'
  | 'date_added'
  | 'last_played'
  | 'remote_nfs_path'
  | 'has_lyrics'
  | 'has_artwork'
  | 'is_unplayed'
  | 'is_hd_audio'
  | 'artist_scene_affinity';

export type SmartOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in_last'
  | 'not_in_last'
  | 'in_list'
  | 'not_in_list'
  | 'is_empty'
  | 'not_empty';

export type RegenerateInterval =
  | 'live'
  | 'minutely'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'manual';

export interface SmartRule {
  id: string;
  type: 'rule';
  field: SmartField;
  operator: SmartOperator;
  value: string | number;
  valueTo?: string | number;
  sceneGenre?: string;
}

export interface SmartRuleGroup {
  id?: string;
  type?: 'group';
  match: 'ALL' | 'ANY';
  conditions: (SmartRule | SmartRuleGroup)[];
  maxPerArtist?: number | null;
  maxPerAlbum?: number | null;
  avoidBackToBackArtist?: boolean;
  regenerateInterval?: RegenerateInterval;
}

const ALLOWED_FIELDS: Record<SmartField, 'text' | 'number' | 'date'> = {
  title: 'text',
  artist: 'text',
  album: 'text',
  album_artist: 'text',
  genre: 'text',
  format: 'text',
  year: 'number',
  bitrate: 'number',
  play_count: 'number',
  local_star_rating: 'number',
  is_loved: 'number',
  keep_cached: 'number',
  global_listen_count: 'number',
  lastfm_plays: 'number',
  audiodb_plays: 'number',
  combined_global_plays: 'number',
  artist_median_listen_count: 'number',
  artist_relative_popularity_score: 'number',
  artist_rarity_multiplier: 'number',
  discovery_score: 'number',
  duration: 'number',
  track_num: 'number',
  disc_num: 'number',
  file_size: 'number',
  date_added: 'date',
  last_played: 'date',
  remote_nfs_path: 'text',
  has_lyrics: 'number',
  has_artwork: 'number',
  is_unplayed: 'number',
  is_hd_audio: 'number',
  artist_scene_affinity: 'number',
};

export function getDistinctSmartFieldValues(field: SmartField, search = ''): string[] {
  if (field === 'artist_scene_affinity') {
    const q = search.trim().toLowerCase();
    const all = listAllMatrixGenres();
    return (q ? all.filter((g) => g.toLowerCase().includes(q)) : all).slice(0, 200);
  }
  const allowedCols = new Set<SmartField>([
    'genre',
    'artist',
    'album',
    'album_artist',
    'format',
    'title',
    'year',
  ]);
  if (!allowedCols.has(field)) return [];
  const db = getCoreDb();
  const q = search.trim();
  try {
    if (q) {
      const rows = db
        .prepare(
          `SELECT DISTINCT CAST(${field} AS TEXT) as val FROM tracks
           WHERE ${field} IS NOT NULL AND CAST(${field} AS TEXT) != ''
             AND CAST(${field} AS TEXT) LIKE ? COLLATE NOCASE
           ORDER BY val COLLATE NOCASE ASC
           LIMIT 200`
        )
        .all(`%${q}%`) as { val: string }[];
      return rows.map((r) => r.val).filter(Boolean);
    }
    const rows = db
      .prepare(
        `SELECT DISTINCT CAST(${field} AS TEXT) as val FROM tracks
         WHERE ${field} IS NOT NULL AND CAST(${field} AS TEXT) != ''
         ORDER BY val COLLATE NOCASE ASC
         LIMIT 500`
      )
      .all() as { val: string }[];
    return rows.map((r) => r.val).filter(Boolean);
  } catch {
    return [];
  }
}

function getColumnExpr(field: SmartField): string {
  switch (field) {
    case 'has_lyrics':
      return "(CASE WHEN lrc_path IS NOT NULL AND lrc_path != '' THEN 1 ELSE 0 END)";
    case 'has_artwork':
      return "(CASE WHEN cover_art_path IS NOT NULL AND cover_art_path != '' THEN 1 ELSE 0 END)";
    case 'is_unplayed':
      return '(CASE WHEN COALESCE(play_count, 0) = 0 THEN 1 ELSE 0 END)';
    case 'is_hd_audio':
      return "(CASE WHEN LOWER(COALESCE(format, '')) IN ('flac','alac','wav','aiff','dsf') OR COALESCE(bitrate, 0) >= 900 THEN 1 ELSE 0 END)";
    default:
      return field;
  }
}

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

  if (rule.field === 'artist_scene_affinity') {
    let targetGenre = (rule.sceneGenre || '').trim();
    let numericThreshold = Number(rule.value ?? 0.55);
    if (!targetGenre && typeof rule.value === 'string' && rule.value.includes(':')) {
      const [gPart, vPart] = rule.value.split(':');
      targetGenre = gPart.trim();
      numericThreshold = Number(vPart ?? 0.55);
    }
    if (!targetGenre) targetGenre = 'emo';
    if (!Number.isFinite(numericThreshold)) numericThreshold = 0.55;
    const numericHi = rule.valueTo !== undefined ? Number(rule.valueTo) : undefined;
    const { matchedArtistsLower, isNegated } = getMatchingArtistsForSceneFilter(
      targetGenre,
      rule.operator,
      numericThreshold,
      Number.isFinite(numericHi) ? numericHi : undefined
    );
    if (matchedArtistsLower.length === 0) {
      return isNegated ? '1=1' : '1=0';
    }
    const placeholders = matchedArtistsLower.map(() => '?').join(',');
    for (const a of matchedArtistsLower) params.push(a);
    return isNegated ? `LOWER(TRIM(artist)) NOT IN (${placeholders})` : `LOWER(TRIM(artist)) IN (${placeholders})`;
  }

  const col = getColumnExpr(rule.field);
  const val = fieldType === 'number' ? Number(rule.value || 0) : String(rule.value ?? '');

  if (fieldType === 'date') {
    const days = Math.max(1, Number(rule.value || 30));
    if (rule.operator === 'in_last') {
      params.push(`-${days} days`);
      return `(${col} IS NOT NULL AND datetime(${col}) >= datetime('now', ?))`;
    }
    if (rule.operator === 'not_in_last') {
      params.push(`-${days} days`);
      return `(${col} IS NULL OR datetime(${col}) < datetime('now', ?))`;
    }
    if (rule.operator === 'gt') {
      params.push(String(rule.value || '1970-01-01'));
      return `(${col} IS NOT NULL AND date(${col}) > date(?))`;
    }
    if (rule.operator === 'lt') {
      params.push(String(rule.value || '2099-01-01'));
      return `(${col} IS NOT NULL AND date(${col}) < date(?))`;
    }
  }

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

    case 'ends_with':
      params.push(`%${val}`);
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

    case 'is_empty':
      return `(${col} IS NULL OR TRIM(CAST(${col} AS TEXT)) = '')`;

    case 'not_empty':
      return `(${col} IS NOT NULL AND TRIM(CAST(${col} AS TEXT)) != '')`;

    case 'in_list':
    case 'not_in_list': {
      const items = String(rule.value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length === 0) return '1=1';
      const placeholders = items.map(() => '?').join(',');
      if (fieldType === 'number') {
        for (const it of items) params.push(Number(it) || 0);
        return rule.operator === 'in_list' ? `${col} IN (${placeholders})` : `${col} NOT IN (${placeholders})`;
      }
      for (const it of items) params.push(it.toLowerCase());
      return rule.operator === 'in_list'
        ? `LOWER(${col}) IN (${placeholders})`
        : `LOWER(${col}) NOT IN (${placeholders})`;
    }

    default:
      return '1=1';
  }
}

function getOrderByClause(selectionMethod: string): string {
  switch (selectionMethod) {
    case 'random':
      return 'RANDOM()';
    case 'random_weighted':
      return '((COALESCE(local_star_rating, 2.5) + COALESCE(is_loved, 0) * 2.0 + COALESCE(discovery_score, 50.0) / 100.0) * (ABS(RANDOM()) % 1000 + 1)) DESC';
    case 'least_played':
      return 'COALESCE(play_count, 0) ASC, RANDOM()';
    case 'least_recently_played':
      return "COALESCE(last_played, '1970-01-01') ASC, RANDOM()";
    case 'most_recently_played':
      return "COALESCE(last_played, '1970-01-01') DESC";
    case 'deep_cuts':
      return 'COALESCE(combined_global_plays, 0) ASC, COALESCE(artist_relative_popularity_score, 0) DESC, RANDOM()';
    case 'discovery_desc':
      return 'COALESCE(discovery_score, 0) DESC, artist_relative_popularity_score DESC';
    case 'popularity_desc':
      return 'artist_relative_popularity_score DESC, combined_global_plays DESC';
    case 'rating_desc':
      return 'local_star_rating DESC, is_loved DESC, artist_relative_popularity_score DESC';
    case 'most_played':
      return 'play_count DESC, local_star_rating DESC';
    case 'recently_added':
      return 'date_added DESC, id DESC';
    case 'oldest_added':
      return 'date_added ASC, id ASC';
    case 'year_desc':
      return 'COALESCE(year, 0) DESC, artist COLLATE NOCASE ASC';
    case 'year_asc':
      return 'COALESCE(year, 9999) ASC, artist COLLATE NOCASE ASC';
    case 'artist_asc':
    default:
      return 'artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC, disc_num ASC, track_num ASC';
  }
}

function applyDiversityConstraints(rows: TrackRow[], rulesGroup: SmartRuleGroup): TrackRow[] {
  const maxPerArtist =
    rulesGroup.maxPerArtist && rulesGroup.maxPerArtist > 0 ? Math.floor(rulesGroup.maxPerArtist) : 0;
  const maxPerAlbum =
    rulesGroup.maxPerAlbum && rulesGroup.maxPerAlbum > 0 ? Math.floor(rulesGroup.maxPerAlbum) : 0;
  const avoidBackToBack = Boolean(rulesGroup.avoidBackToBackArtist);

  let filtered = rows;
  if (maxPerArtist > 0 || maxPerAlbum > 0) {
    const artistCounts = new Map<string, number>();
    const albumCounts = new Map<string, number>();
    const kept: TrackRow[] = [];
    for (const t of rows) {
      const aKey = (t.artist || 'Unknown').trim().toLowerCase();
      const albKey = `${aKey}::${(t.album || 'Unknown').trim().toLowerCase()}`;
      if (maxPerArtist > 0 && (artistCounts.get(aKey) || 0) >= maxPerArtist) continue;
      if (maxPerAlbum > 0 && (albumCounts.get(albKey) || 0) >= maxPerAlbum) continue;
      artistCounts.set(aKey, (artistCounts.get(aKey) || 0) + 1);
      albumCounts.set(albKey, (albumCounts.get(albKey) || 0) + 1);
      kept.push(t);
    }
    filtered = kept;
  }

  if (!avoidBackToBack || filtered.length <= 2) {
    return filtered;
  }

  // Greedy non-adjacent artist interleaver
  const remaining = [...filtered];
  const result: TrackRow[] = [];
  let lastArtist = '';
  while (remaining.length > 0) {
    let pickIdx = remaining.findIndex((t) => (t.artist || '').trim().toLowerCase() !== lastArtist);
    if (pickIdx === -1) pickIdx = 0;
    const [picked] = remaining.splice(pickIdx, 1);
    result.push(picked);
    lastArtist = (picked.artist || '').trim().toLowerCase();
  }
  return result;
}

export function evaluateSmartPlaylist(
  rulesGroup: SmartRuleGroup,
  limitType = 'tracks',
  limitValue: number | null = null,
  selectionMethod = 'popularity_desc',
  smartPlaylistId?: number | string | null
): { tracks: TrackRow[]; compiledSql: string } {
  const start = Date.now();
  const db = getCoreDb();
  const params: unknown[] = [];
  const whereClause = compileCondition(rulesGroup, params);
  const orderBy = getOrderByClause(selectionMethod);

  let exclusionClause = 'COALESCE(exclude_from_smart_playlists, 0) = 0';
  if (smartPlaylistId !== undefined && smartPlaylistId !== null) {
    exclusionClause += ' AND id NOT IN (SELECT track_id FROM smart_playlist_exclusions WHERE smart_playlist_id = ?)';
    params.push(String(smartPlaylistId));
  }

  const hasDiversity =
    (rulesGroup.maxPerArtist && rulesGroup.maxPerArtist > 0) ||
    (rulesGroup.maxPerAlbum && rulesGroup.maxPerAlbum > 0) ||
    Boolean(rulesGroup.avoidBackToBackArtist);

  let sql = `SELECT * FROM tracks WHERE (${whereClause}) AND ${exclusionClause} ORDER BY ${orderBy}`;
  if (limitType === 'tracks' && limitValue && limitValue > 0) {
    const fetchLimit = hasDiversity ? Math.max(Math.floor(limitValue) * 10, 600) : Math.floor(limitValue);
    sql += ` LIMIT ${fetchLimit}`;
  }

  let rows = db.prepare(sql).all(...params) as TrackRow[];

  if (hasDiversity) {
    rows = applyDiversityConstraints(rows, rulesGroup);
    if (limitType === 'tracks' && limitValue && limitValue > 0) {
      rows = rows.slice(0, Math.floor(limitValue));
    }
  }

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

function getIntervalMs(interval?: RegenerateInterval): number | null {
  switch (interval) {
    case 'minutely':
      return 60 * 1000;
    case 'hourly':
      return 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
    case 'monthly':
      return 30 * 24 * 60 * 60 * 1000;
    case 'yearly':
      return 365 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

export function regenerateSmartPlaylist(playlistId: number): TrackRow[] {
  const db = getCoreDb();
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
    | PlaylistRow
    | undefined;
  if (!playlist || !playlist.is_smart || !playlist.smart_rules_json) return [];
  try {
    const rules = JSON.parse(playlist.smart_rules_json) as SmartRuleGroup;
    const limitVal = playlist.limit_value ?? playlist.track_limit ?? null;
    const tracks = evaluateSmartPlaylist(
      rules,
      playlist.limit_type || 'tracks',
      limitVal,
      playlist.selection_method || 'popularity_desc',
      playlist.id
    ).tracks;
    db.prepare(
      "UPDATE playlists SET cached_track_ids_json = ?, last_regenerated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(tracks.map((t) => t.id)), playlist.id);
    return tracks;
  } catch (err) {
    logger.error('SMART_PLAYLIST', `Failed to regenerate smart playlist ${playlistId}`, err);
    return [];
  }
}

export function getPlaylistTracks(playlistId: number): TrackRow[] {
  const db = getCoreDb();
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
    | PlaylistRow
    | undefined;
  if (!playlist) return [];

  if (playlist.is_smart && playlist.smart_rules_json) {
    try {
      const rules = JSON.parse(playlist.smart_rules_json) as SmartRuleGroup;
      const interval = rules.regenerateInterval || 'live';

      if (interval !== 'live') {
        const intervalMs = getIntervalMs(interval);
        const lastMs = playlist.last_regenerated_at
          ? Date.parse(playlist.last_regenerated_at.replace(' ', 'T') + 'Z')
          : 0;
        const isExpired =
          !playlist.cached_track_ids_json ||
          !lastMs ||
          (intervalMs !== null && Date.now() - lastMs >= intervalMs);

        if (!isExpired && playlist.cached_track_ids_json) {
          const cachedIds = JSON.parse(playlist.cached_track_ids_json) as number[];
          if (Array.isArray(cachedIds) && cachedIds.length > 0) {
            const placeholders = cachedIds.map(() => '?').join(',');
            const rows = db
              .prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`)
              .all(...cachedIds) as TrackRow[];
            const byId = new Map(rows.map((r) => [r.id, r]));
            const ordered = cachedIds.map((id) => byId.get(id)).filter(Boolean) as TrackRow[];
            if (ordered.length > 0) return ordered;
          }
        }
        return regenerateSmartPlaylist(playlist.id);
      }

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
  const db = getVideoDb();
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
  const db = getCoreDb();
  db.prepare(
    'INSERT OR IGNORE INTO smart_playlist_exclusions (smart_playlist_id, track_id) VALUES (?, ?)'
  ).run(String(smartPlaylistId), trackId);
  return { ok: true };
}

export function excludeTrackFromAllSmartPlaylists(
  trackId: number,
  excluded = true
): { ok: boolean } {
  const db = getCoreDb();
  db.prepare('UPDATE tracks SET exclude_from_smart_playlists = ? WHERE id = ?').run(
    excluded ? 1 : 0,
    trackId
  );
  return { ok: true };
}

export function getSmartPlaylistExclusions(
  smartPlaylistId: number | string
): SmartPlaylistExcludedItem[] {
  const db = getCoreDb();
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
  const db = getCoreDb();
  if (scope === 'global') {
    db.prepare('UPDATE tracks SET exclude_from_smart_playlists = 0 WHERE id = ?').run(trackId);
  } else {
    db.prepare(
      'DELETE FROM smart_playlist_exclusions WHERE smart_playlist_id = ? AND track_id = ?'
    ).run(String(smartPlaylistId), trackId);
  }
  return { ok: true };
}
