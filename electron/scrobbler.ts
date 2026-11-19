import { getUsersDb, TrackRow } from './db';
import { logger } from './logger';
import { CallerContext } from './auth/callerContext';
import { resolvePersonalListenBrainzCredentials } from './auth/rbac';

export interface PlayableTrackInput {
  track_uid?: string | null;
  artist: string;
  title: string;
  album?: string | null;
  mbid_recording?: string | null;
  duration?: number | null;
}

export interface ScrobbleQueueStats {
  pendingCount: number;
  oldestPendingAt: number | null;
  totalLogged: number;
}

export interface ScrobbleFlushResult {
  ok: boolean;
  submitted: number;
  remaining: number;
  errors: string[];
}

function buildListenTrackMetadata(track: PlayableTrackInput): Record<string, unknown> {
  const additionalInfo: Record<string, unknown> = {
    media_player: 'RetroTunes',
    submission_client: 'RetroTunes ePod Suite',
    submission_client_version: '0.2.0',
  };
  if (track.mbid_recording && track.mbid_recording.trim()) {
    additionalInfo.recording_mbid = track.mbid_recording.trim();
  }
  const durationMs =
    typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0
      ? Math.round(track.duration * 1000)
      : 0;
  if (durationMs > 0) {
    additionalInfo.duration_ms = durationMs;
  }

  const meta: Record<string, unknown> = {
    artist_name: track.artist || 'Unknown Artist',
    track_name: track.title || 'Unknown Track',
    additional_info: additionalInfo,
  };
  if (track.album && track.album.trim()) {
    meta.release_name = track.album.trim();
  }
  return meta;
}

export async function recordUserPlay(
  caller: CallerContext | null | undefined,
  track: PlayableTrackInput | TrackRow,
  playedAtSec?: number
): Promise<{ historyId: number; scrobbled: boolean }> {
  const usersDb = getUsersDb();
  const userId = caller?.userId ?? 0;
  const effectivePlayedAt =
    typeof playedAtSec === 'number' && Number.isFinite(playedAtSec) && playedAtSec > 0
      ? Math.floor(playedAtSec)
      : Math.floor(Date.now() / 1000);
  const durationMs =
    typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0
      ? Math.round(track.duration * 1000)
      : 0;

  const info = usersDb
    .prepare(
      `INSERT INTO user_play_history (
         user_id, track_uid, artist, title, album, recording_mbid, duration_ms, played_at, scrobbled_at, scrobble_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '')`
    )
    .run(
      userId,
      (track.track_uid || '').trim(),
      (track.artist || 'Unknown Artist').trim(),
      (track.title || 'Unknown Track').trim(),
      (track.album || '').trim(),
      (track.mbid_recording || '').trim(),
      durationMs,
      effectivePlayedAt
    );

  const historyId = Number(info.lastInsertRowid);
  const personal = resolvePersonalListenBrainzCredentials(caller);
  if (!personal.token) {
    return { historyId, scrobbled: false };
  }

  try {
    const res = await fetch('https://api.listenbrainz.org/1/submit-listens', {
      method: 'POST',
      headers: {
        Authorization: `Token ${personal.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        listen_type: 'single',
        payload: [
          {
            listened_at: effectivePlayedAt,
            track_metadata: buildListenTrackMetadata(track),
          },
        ],
      }),
    });

    if (res.ok) {
      const nowSec = Math.floor(Date.now() / 1000);
      usersDb
        .prepare("UPDATE user_play_history SET scrobbled_at = ?, scrobble_error = '' WHERE id = ?")
        .run(nowSec, historyId);
      logger.info('LISTENBRAINZ', `Scrobbled play for "${track.artist} - ${track.title}"`, {
        userId,
        historyId,
      });
      return { historyId, scrobbled: true };
    }

    const errText = await res.text().catch(() => `HTTP ${res.status}`);
    usersDb
      .prepare('UPDATE user_play_history SET scrobble_error = ? WHERE id = ?')
      .run(`HTTP ${res.status}: ${errText.slice(0, 240)}`, historyId);
    logger.warn('LISTENBRAINZ', `Deferred scrobble after HTTP ${res.status}`, {
      userId,
      historyId,
      error: errText.slice(0, 240),
    });
    return { historyId, scrobbled: false };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    usersDb
      .prepare('UPDATE user_play_history SET scrobble_error = ? WHERE id = ?')
      .run(errMsg.slice(0, 240), historyId);
    logger.debug('LISTENBRAINZ', `Queued play offline for deferred scrobble: ${errMsg}`, {
      userId,
      historyId,
    });
    return { historyId, scrobbled: false };
  }
}

export async function submitNowPlaying(
  caller: CallerContext | null | undefined,
  track: PlayableTrackInput | TrackRow
): Promise<{ ok: boolean; sent: boolean }> {
  const personal = resolvePersonalListenBrainzCredentials(caller);
  if (!personal.token) {
    return { ok: true, sent: false };
  }
  try {
    const res = await fetch('https://api.listenbrainz.org/1/submit-listens', {
      method: 'POST',
      headers: {
        Authorization: `Token ${personal.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        listen_type: 'playing_now',
        payload: [
          {
            track_metadata: buildListenTrackMetadata(track),
          },
        ],
      }),
    });
    return { ok: res.ok, sent: res.ok };
  } catch {
    return { ok: false, sent: false };
  }
}

export function getScrobbleQueueStats(caller: CallerContext | null | undefined): ScrobbleQueueStats {
  const usersDb = getUsersDb();
  const userId = caller?.userId ?? 0;
  const pendingRow = usersDb
    .prepare(
      `SELECT COUNT(*) as pendingCount, MIN(played_at) as oldestPendingAt
       FROM user_play_history
       WHERE user_id = ? AND scrobbled_at IS NULL`
    )
    .get(userId) as { pendingCount?: number; oldestPendingAt?: number | null } | undefined;

  const totalRow = usersDb
    .prepare('SELECT COUNT(*) as totalLogged FROM user_play_history WHERE user_id = ?')
    .get(userId) as { totalLogged?: number } | undefined;

  return {
    pendingCount: Number(pendingRow?.pendingCount || 0),
    oldestPendingAt:
      pendingRow?.oldestPendingAt !== null && pendingRow?.oldestPendingAt !== undefined
        ? Number(pendingRow.oldestPendingAt)
        : null,
    totalLogged: Number(totalRow?.totalLogged || 0),
  };
}

export async function flushPendingScrobbles(
  caller: CallerContext | null | undefined
): Promise<ScrobbleFlushResult> {
  const personal = resolvePersonalListenBrainzCredentials(caller);
  if (!personal.token) {
    return {
      ok: false,
      submitted: 0,
      remaining: getScrobbleQueueStats(caller).pendingCount,
      errors: ['No personal ListenBrainz token configured for this account.'],
    };
  }

  const usersDb = getUsersDb();
  const userId = caller?.userId ?? 0;
  const pendingRows = usersDb
    .prepare(
      `SELECT id, artist, title, album, recording_mbid, duration_ms, played_at
       FROM user_play_history
       WHERE user_id = ? AND scrobbled_at IS NULL
       ORDER BY played_at ASC, id ASC`
    )
    .all(userId) as {
    id: number;
    artist: string;
    title: string;
    album: string;
    recording_mbid: string;
    duration_ms: number;
    played_at: number;
  }[];

  if (pendingRows.length === 0) {
    return { ok: true, submitted: 0, remaining: 0, errors: [] };
  }

  let submitted = 0;
  const errors: string[] = [];
  const batchSize = 100;

  for (let i = 0; i < pendingRows.length; i += batchSize) {
    const chunk = pendingRows.slice(i, i + batchSize);
    const payload = chunk.map((row) => ({
      listened_at: row.played_at,
      track_metadata: buildListenTrackMetadata({
        artist: row.artist,
        title: row.title,
        album: row.album,
        mbid_recording: row.recording_mbid,
        duration: row.duration_ms > 0 ? row.duration_ms / 1000 : 0,
      }),
    }));

    try {
      const res = await fetch('https://api.listenbrainz.org/1/submit-listens', {
        method: 'POST',
        headers: {
          Authorization: `Token ${personal.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          listen_type: 'import',
          payload,
        }),
      });

      if (res.ok) {
        const nowSec = Math.floor(Date.now() / 1000);
        const upd = usersDb.prepare(
          "UPDATE user_play_history SET scrobbled_at = ?, scrobble_error = '' WHERE id = ?"
        );
        usersDb.transaction(() => {
          for (const row of chunk) {
            upd.run(nowSec, row.id);
          }
        })();
        submitted += chunk.length;
      } else {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        const msg = `HTTP ${res.status}: ${errText.slice(0, 200)}`;
        errors.push(msg);
        const updErr = usersDb.prepare(
          'UPDATE user_play_history SET scrobble_error = ? WHERE id = ?'
        );
        usersDb.transaction(() => {
          for (const row of chunk) {
            updErr.run(msg, row.id);
          }
        })();
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      const updErr = usersDb.prepare(
        'UPDATE user_play_history SET scrobble_error = ? WHERE id = ?'
      );
      usersDb.transaction(() => {
        for (const row of chunk) {
          updErr.run(msg.slice(0, 240), row.id);
        }
      })();
      break;
    }
  }

  const remaining = getScrobbleQueueStats(caller).pendingCount;
  return {
    ok: errors.length === 0,
    submitted,
    remaining,
    errors,
  };
}
