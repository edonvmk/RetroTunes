import { getDb, TrackRow } from '../db';
import { logger } from '../logger';
import { normalizeArtistKey, resolveArtistAffinity, resolveTrackAffinity } from './affinityCache';
import { gatherAndScoreCandidates } from './scorer';
import { sequenceMix } from './sequencer';
import { MixDepthMode, MixRequest, MixResult, TrackExplanation } from './types';

export * from './types';
export { classifyVariant, isInterludeOrSkit } from './variantFilter';

export async function generateMix(req: MixRequest): Promise<MixResult> {
  const start = Date.now();
  const db = getDb();
  const seedTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.seedTrackId) as
    | TrackRow
    | undefined;
  if (!seedTrack) {
    throw new Error(`Seed track ${req.seedTrackId} not found in SQLite library.`);
  }

  const limit: 25 | 50 = req.limit === 50 ? 50 : 25;
  const mode: MixDepthMode =
    req.mode === 'hits' || req.mode === 'deep' ? req.mode : 'balanced';

  const gathered = await gatherAndScoreCandidates(
    seedTrack,
    mode,
    req.excludeTrackIds || [],
    Boolean(req.offlineOnly)
  );

  const { tracks, scored } = sequenceMix(seedTrack, gathered.candidates, limit);
  const distinctArtists = new Set(tracks.map((t) => normalizeArtistKey(t.artist))).size;
  const elapsedMs = Date.now() - start;

  logger.info(
    'SMART_PLAYLIST',
    `eGenius generated ${tracks.length}-track mix from "${seedTrack.title}" by ${seedTrack.artist}`,
    {
      seedTrackId: seedTrack.id,
      mode,
      limit,
      distinctArtists,
      hop1Count: gathered.hop1Count,
      hop2Count: gathered.hop2Count,
      cacheHit: gathered.cacheHit,
    },
    elapsedMs
  );

  return {
    seedTrack,
    seedVariant: gathered.seedVariant,
    mode,
    limit,
    tracks,
    scored,
    distinctArtists,
    hop1Count: gathered.hop1Count,
    hop2Count: gathered.hop2Count,
    cacheHit: gathered.cacheHit,
    elapsedMs,
  };
}

export async function refreshMix(
  playlistId: number,
  overrides: { limit?: 25 | 50; mode?: MixDepthMode } = {}
): Promise<MixResult> {
  const db = getDb();
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
    | {
        id: number;
        name: string;
        limit_value: number | null;
        egenius_seed_track_id: number | null;
        egenius_mode: MixDepthMode | null;
      }
    | undefined;

  if (!pl || !pl.egenius_seed_track_id) {
    throw new Error(`Playlist ${playlistId} is not an eGenius playlist.`);
  }

  const limit: 25 | 50 =
    overrides.limit === 50 || (!overrides.limit && pl.limit_value === 50) ? 50 : 25;
  const mode: MixDepthMode =
    overrides.mode || (pl.egenius_mode === 'hits' || pl.egenius_mode === 'deep' ? pl.egenius_mode : 'balanced');

  const mix = await generateMix({
    seedTrackId: pl.egenius_seed_track_id,
    limit,
    mode,
  });

  const tx = db.transaction(() => {
    db.prepare('UPDATE playlists SET limit_value = ?, track_limit = ?, egenius_mode = ? WHERE id = ?').run(
      limit,
      limit,
      mode,
      playlistId
    );
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
    const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
    mix.tracks.forEach((t, idx) => ins.run(playlistId, t.id, idx + 1));
  });
  tx();

  return mix;
}

export async function explainTrack(
  seedTrackId: number,
  candidateTrackId: number,
  mode: MixDepthMode = 'balanced'
): Promise<TrackExplanation | null> {
  const db = getDb();
  const seedTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(seedTrackId) as
    | TrackRow
    | undefined;
  const candidateTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(candidateTrackId) as
    | TrackRow
    | undefined;
  if (!seedTrack || !candidateTrack) return null;

  const gathered = await gatherAndScoreCandidates(seedTrack, mode, [], true);
  const match = gathered.candidates.find((c) => c.track.id === candidateTrackId);
  if (!match) return null;
  return {
    seedTrack,
    candidateTrack,
    breakdown: match.breakdown,
  };
}

export async function warmCache(seedTrackId: number): Promise<{ ok: boolean }> {
  const db = getDb();
  const seedTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(seedTrackId) as
    | TrackRow
    | undefined;
  if (!seedTrack) return { ok: false };
  await Promise.all([
    resolveArtistAffinity(seedTrack.artist, { offlineOnly: false }),
    resolveTrackAffinity(seedTrack, { offlineOnly: false }),
  ]);
  return { ok: true };
}
