import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getCoreDb, PlaybackDeltaUpdate, TrackRow } from '../db';
import { emitRendererEvent, getAppDataPath } from '../runtimeBus';
import {
  resolveEffectiveRemoteServerToken,
  resolveEffectiveRemoteServerUrl,
} from '../settings';
import { logger } from '../logger';

/**
 * Remote rTunes-Server provider (Docker companion API & desktop cache delta sync).
 */
export interface RemoteServerStatus {
  mode: 'docker_server';
  enabled: boolean;
  serverUrl: string;
  connected: boolean;
  message: string;
}

export interface RemoteDeltaSyncResult {
  ok: boolean;
  previousRev: number;
  currentRev: number;
  upsertedCount: number;
  deletedCount: number;
}

interface RemoteDeltaResponse {
  current_rev: number;
  upserted: TrackRow[];
  deleted_uids: string[];
  has_more: boolean;
}

export const remoteServerProvider = {
  mode: 'docker_server' as const,

  getStatus(isDev: boolean, serverUrl: string): RemoteServerStatus {
    if (!isDev) {
      return {
        mode: 'docker_server',
        enabled: false,
        serverUrl: '',
        connected: false,
        message: 'Coming soon — rTunes is currently focused on direct network shares, local media, and USB/MTP ePod syncing.',
      };
    }
    return {
      mode: 'docker_server',
      enabled: Boolean(serverUrl),
      serverUrl,
      connected: false,
      message: serverUrl
        ? `[DEV PREVIEW] Remote rTunes-Server endpoint configured: ${serverUrl}`
        : '[DEV PREVIEW] No rTunes-Server Companion URL configured.',
    };
  },

  async syncDeltaFromRemoteServer(
    serverUrl?: string,
    authToken?: string
  ): Promise<RemoteDeltaSyncResult> {
    const base = resolveEffectiveRemoteServerUrl(serverUrl);
    if (!base) {
      throw new Error('No remote rTunes-Server URL configured.');
    }
    const token = resolveEffectiveRemoteServerToken(authToken);
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    const db = getCoreDb();
    const revRow = db
      .prepare("SELECT CAST(value AS INTEGER) AS rev FROM settings WHERE key = 'remote_sync_rev'")
      .get() as { rev: number } | undefined;
    const previousRev = revRow?.rev || 0;
    let sinceRev = previousRev;
    let latestRev = previousRev;
    let upsertedCount = 0;
    let deletedCount = 0;

    const artDir = path.join(getAppDataPath(), 'cache', 'artwork');
    fs.mkdirSync(artDir, { recursive: true });

    const upsertTrack = db.prepare(`
      INSERT INTO tracks (
        track_uid, sync_rev, remote_nfs_path, alternate_paths,
        title, artist, album, genre, year, track_num, disc_num,
        duration, bitrate, file_size, format, cover_art_path, lrc_path,
        mbid_recording, mbid_artist, mbid_release, mbid_release_group,
        isrc, lastfm_id, deezer_id, theaudiodb_id, lidarr_id,
        global_listen_count, lastfm_plays, audiodb_plays, combined_global_plays,
        popularity_updated_at, artist_median_listen_count,
        artist_relative_popularity_score, artist_rarity_multiplier, discovery_score,
        local_star_rating, is_loved, play_count, last_played,
        metadata_loaded, exclude_from_smart_playlists
      ) VALUES (
        @track_uid, @sync_rev, @remote_nfs_path, COALESCE(@alternate_paths, '[]'),
        @title, @artist, @album, COALESCE(@genre, ''), @year, @track_num, @disc_num,
        COALESCE(@duration, 0), COALESCE(@bitrate, 0), COALESCE(@file_size, 0), COALESCE(@format, ''),
        @cover_art_path, @lrc_path,
        @mbid_recording, @mbid_artist, @mbid_release, @mbid_release_group,
        @isrc, @lastfm_id, @deezer_id, @theaudiodb_id, @lidarr_id,
        COALESCE(@global_listen_count, 0), COALESCE(@lastfm_plays, 0),
        COALESCE(@audiodb_plays, 0), COALESCE(@combined_global_plays, 0),
        COALESCE(@popularity_updated_at, 0), COALESCE(@artist_median_listen_count, 0),
        COALESCE(@artist_relative_popularity_score, 0), COALESCE(@artist_rarity_multiplier, 1.0),
        COALESCE(@discovery_score, 0),
        COALESCE(@local_star_rating, 0), COALESCE(@is_loved, 0), COALESCE(@play_count, 0),
        @last_played,
        COALESCE(@metadata_loaded, 0), COALESCE(@exclude_from_smart_playlists, 0)
      )
      ON CONFLICT(track_uid) WHERE track_uid IS NOT NULL DO UPDATE SET
        sync_rev = excluded.sync_rev,
        remote_nfs_path = excluded.remote_nfs_path,
        alternate_paths = excluded.alternate_paths,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        genre = excluded.genre,
        year = excluded.year,
        track_num = excluded.track_num,
        disc_num = excluded.disc_num,
        duration = excluded.duration,
        bitrate = excluded.bitrate,
        file_size = excluded.file_size,
        format = excluded.format,
        cover_art_path = COALESCE(excluded.cover_art_path, tracks.cover_art_path),
        lrc_path = COALESCE(excluded.lrc_path, tracks.lrc_path),
        mbid_recording = excluded.mbid_recording,
        mbid_artist = excluded.mbid_artist,
        global_listen_count = excluded.global_listen_count,
        lastfm_plays = excluded.lastfm_plays,
        audiodb_plays = excluded.audiodb_plays,
        combined_global_plays = excluded.combined_global_plays,
        artist_median_listen_count = excluded.artist_median_listen_count,
        artist_relative_popularity_score = excluded.artist_relative_popularity_score,
        artist_rarity_multiplier = excluded.artist_rarity_multiplier,
        discovery_score = excluded.discovery_score,
        local_star_rating = excluded.local_star_rating,
        is_loved = excluded.is_loved,
        play_count = MAX(COALESCE(tracks.play_count, 0), COALESCE(excluded.play_count, 0)),
        last_played = COALESCE(excluded.last_played, tracks.last_played)
    `);
    const deleteByUid = db.prepare('DELETE FROM tracks WHERE track_uid = ?');

    let hasMore = true;
    while (hasMore) {
      const res = await fetch(`${base}/api/sync/delta?since_rev=${sinceRev}&limit=2000`, {
        headers: authHeaders,
      });
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error(
            'Delta sync failed (HTTP 401: remote server authentication required — run "cli client login" or sign in).'
          );
        }
        throw new Error(`Delta sync failed (HTTP ${res.status})`);
      }
      const batch = (await res.json()) as RemoteDeltaResponse;
      latestRev = Math.max(latestRev, batch.current_rev || 0);

      let batchMaxRev = sinceRev;
      const pendingArtwork = new Map<string, string>();
      const applyTx = db.transaction(() => {
        for (const t of batch.upserted || []) {
          if (!t.track_uid) continue;
          let localArtPath: string | null = t.cover_art_path ?? null;
          if (t.cover_art_path) {
            const artHash = crypto.createHash('sha256').update(t.cover_art_path).digest('hex').slice(0, 24);
            const cachedArtFile = path.join(artDir, `${artHash}.jpg`);
            if (fs.existsSync(cachedArtFile)) {
              localArtPath = cachedArtFile;
            } else {
              pendingArtwork.set(t.track_uid, t.cover_art_path);
            }
          }
          upsertTrack.run({
            ...t,
            year: t.year ?? null,
            track_num: t.track_num ?? null,
            disc_num: t.disc_num ?? null,
            cover_art_path: localArtPath,
            lrc_path: t.lrc_path ?? null,
            mbid_recording: t.mbid_recording ?? null,
            mbid_artist: t.mbid_artist ?? null,
            mbid_release: t.mbid_release ?? null,
            mbid_release_group: t.mbid_release_group ?? null,
            isrc: t.isrc ?? null,
            lastfm_id: t.lastfm_id ?? null,
            deezer_id: t.deezer_id ?? null,
            theaudiodb_id: t.theaudiodb_id ?? null,
            lidarr_id: t.lidarr_id ?? null,
            last_played: t.last_played ?? null,
          });
          upsertedCount++;
          if ((t.sync_rev || 0) > batchMaxRev) {
            batchMaxRev = t.sync_rev || 0;
          }
        }
        for (const uid of batch.deleted_uids || []) {
          const info = deleteByUid.run(uid);
          deletedCount += info.changes;
        }
      });
      applyTx();

      // Best-effort deduplicated cover art cache for newly synced tracks
      if (pendingArtwork.size > 0) {
        const downloadedHashes = new Map<string, string>();
        const updArtStmt = db.prepare('UPDATE tracks SET cover_art_path = ? WHERE track_uid = ?');
        for (const [uid, remoteArt] of pendingArtwork.entries()) {
          const artHash = crypto.createHash('sha256').update(remoteArt).digest('hex').slice(0, 24);
          const cachedArtFile = path.join(artDir, `${artHash}.jpg`);
          if (!downloadedHashes.has(artHash) && !fs.existsSync(cachedArtFile)) {
            try {
              const artRes = await fetch(
                `${base}/artwork?path=${encodeURIComponent(remoteArt)}`,
                { headers: authHeaders }
              );
              if (artRes.ok) {
                fs.writeFileSync(cachedArtFile, Buffer.from(await artRes.arrayBuffer()));
                downloadedHashes.set(artHash, cachedArtFile);
              }
            } catch {
              // ignore offline artwork failure
            }
          }
          if (fs.existsSync(cachedArtFile)) {
            updArtStmt.run(cachedArtFile, uid);
          }
        }
      }

      hasMore = Boolean(batch.has_more) && batchMaxRev > sinceRev;
      sinceRev = hasMore ? batchMaxRev : latestRev;
    }

    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('remote_sync_rev', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(String(latestRev));

    if (upsertedCount > 0 || deletedCount > 0) {
      logger.info('SYSTEM', `Synced remote delta rev ${previousRev} -> ${latestRev}`, {
        upsertedCount,
        deletedCount,
      });
      emitRendererEvent('library:updated', { current_rev: latestRev });
    }

    return {
      ok: true,
      previousRev,
      currentRev: latestRev,
      upsertedCount,
      deletedCount,
    };
  },

  async pushPlaybackToRemoteServer(
    serverUrl: string,
    updates: PlaybackDeltaUpdate[],
    authToken?: string
  ): Promise<{ ok: boolean; current_rev: number; applied: number }> {
    const base = resolveEffectiveRemoteServerUrl(serverUrl);
    const token = resolveEffectiveRemoteServerToken(authToken);
    const res = await fetch(`${base}/api/sync/playback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ updates }),
    });
    if (!res.ok) {
      throw new Error(`Playback sync failed (HTTP ${res.status})`);
    }
    return (await res.json()) as { ok: boolean; current_rev: number; applied: number };
  },
};
