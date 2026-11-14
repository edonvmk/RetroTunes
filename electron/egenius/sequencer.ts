import { TrackRow } from '../db';
import { normalizeArtistKey } from './affinityCache';
import { ScoredCandidate } from './types';

function weightedSampleFromPool(pool: ScoredCandidate[], count: number): ScoredCandidate[] {
  const remaining = [...pool];
  const sampled: ScoredCandidate[] = [];

  while (sampled.length < count && remaining.length > 0) {
    let totalWeight = 0;
    const weights = remaining.map((c) => {
      const heartBoost = c.track.is_loved ? 1.25 : (c.track.local_star_rating || 0) >= 5 ? 1.15 : 1.0;
      const w = Math.pow(Math.max(0.01, c.breakdown.compositeScore) * heartBoost, 1.8);
      totalWeight += w;
      return w;
    });

    let r = Math.random() * totalWeight;
    let pickedIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        pickedIdx = i;
        break;
      }
    }
    sampled.push(remaining.splice(pickedIdx, 1)[0]);
  }
  return sampled;
}

export function sequenceMix(
  seedTrack: TrackRow,
  scoredCandidates: ScoredCandidate[],
  limit: 25 | 50
): { tracks: TrackRow[]; scored: ScoredCandidate[] } {
  const seedArtistKey = normalizeArtistKey(seedTrack.artist);
  const maxOtherArtistTracks = limit === 25 ? 1 : 2;
  const maxSeedArtistTotal = 2; // Position #1 + at most 1 more
  const maxPerAlbumOther = limit === 50 ? 1 : 1;

  // Take top 120 scored candidates for temperature sampling, and keep the rest as overflow
  const topPool = scoredCandidates.slice(0, 120);
  const overflowPool = scoredCandidates.slice(120);
  const sampledOrder = [
    ...weightedSampleFromPool(topPool, topPool.length),
    ...overflowPool,
  ];

  // Enforce hard artist & album caps + deduplicate identical (artist, title)
  const artistCounts = new Map<string, number>([[seedArtistKey, 1]]);
  const albumCounts = new Map<string, number>();
  const seenSongKeys = new Set<string>([
    `${seedArtistKey}::${(seedTrack.title || '').trim().toLowerCase()}`,
  ]);
  const accepted: ScoredCandidate[] = [];

  const tryAccept = (list: ScoredCandidate[]) => {
    for (const cand of list) {
      if (accepted.length >= limit - 1) break;
      const aKey = normalizeArtistKey(cand.track.artist);
      const songKey = `${aKey}::${(cand.track.title || '').trim().toLowerCase()}`;
      if (seenSongKeys.has(songKey)) continue;

      const albKey = `${aKey}::${(cand.track.album || '').trim().toLowerCase()}`;
      const currentArtistCount = artistCounts.get(aKey) || 0;
      const artistCap = aKey === seedArtistKey ? maxSeedArtistTotal : maxOtherArtistTracks;

      if (currentArtistCount >= artistCap) continue;
      if (aKey !== seedArtistKey && (albumCounts.get(albKey) || 0) >= maxPerAlbumOther) continue;

      seenSongKeys.add(songKey);
      artistCounts.set(aKey, currentArtistCount + 1);
      albumCounts.set(albKey, (albumCounts.get(albKey) || 0) + 1);
      accepted.push(cand);
    }
  };

  tryAccept(sampledOrder);

  // Only relax artist caps if the entire candidate pool still couldn't fill the mix
  if (accepted.length < limit - 1 && scoredCandidates.length > accepted.length) {
    const usedIds = new Set<number>([seedTrack.id, ...accepted.map((a) => a.track.id)]);
    for (const cand of scoredCandidates) {
      if (accepted.length >= limit - 1) break;
      const songKey = `${normalizeArtistKey(cand.track.artist)}::${(cand.track.title || '').trim().toLowerCase()}`;
      if (!usedIds.has(cand.track.id) && !seenSongKeys.has(songKey)) {
        usedIds.add(cand.track.id);
        seenSongKeys.add(songKey);
        accepted.push(cand);
      }
    }
  }

  // 3-Act Arc + Sliding-Window Cooldown (min 8-track separation for any repeated artist)
  const hop1Bucket: ScoredCandidate[] = [];
  const hop2Bucket: ScoredCandidate[] = [];
  const finishBucket: ScoredCandidate[] = [];

  for (const cand of accepted) {
    const isFinishStar =
      cand.track.is_loved === 1 || (cand.track.artist_relative_popularity_score || 0) >= 1.35;
    if (cand.breakdown.hopLevel === 2) {
      hop2Bucket.push(cand);
    } else if (isFinishStar && finishBucket.length < Math.ceil(accepted.length * 0.25)) {
      finishBucket.push(cand);
    } else {
      hop1Bucket.push(cand);
    }
  }

  const orderedPool = [...hop1Bucket, ...hop2Bucket, ...finishBucket];
  const sequenced: ScoredCandidate[] = [];
  const recentArtists: string[] = [seedArtistKey];
  const COOLDOWN_WINDOW = 8;

  const pending = [...orderedPool];
  while (pending.length > 0 && sequenced.length < limit - 1) {
    const recentWindow = new Set(recentArtists.slice(-COOLDOWN_WINDOW));
    let pickIdx = pending.findIndex((c) => !recentWindow.has(normalizeArtistKey(c.track.artist)));
    if (pickIdx === -1) {
      // Fallback: pick farthest from last occurrence
      pickIdx = 0;
    }
    const [picked] = pending.splice(pickIdx, 1);
    sequenced.push(picked);
    recentArtists.push(normalizeArtistKey(picked.track.artist));
  }

  const tracks = [seedTrack, ...sequenced.map((s) => s.track)];
  return { tracks, scored: sequenced };
}
