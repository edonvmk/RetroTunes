import { getDb, TrackRow } from '../db';
import {
  normalizeArtistKey,
  readCachedArtistAffinity,
  resolveArtistAffinity,
  resolveTrackAffinity,
  warmHop1Affinities,
} from './affinityCache';
import {
  ArtistAffinityRecord,
  MixDepthMode,
  ScoredCandidate,
  TagWeight,
  VariantType,
} from './types';
import { classifyVariant, evaluateVariantParity } from './variantFilter';
import { createSharedArtistScorer } from './genreMatrix';

const WEIGHT_GRAPH = 0.35;
const WEIGHT_TAGS = 0.25;
const WEIGHT_ERA = 0.15;
const WEIGHT_REL_DEPTH = 0.15;
const WEIGHT_VARIANT = 0.1;

function tokenizeGenre(genre: string | null | undefined): string[] {
  if (!genre) return [];
  return genre
    .toLowerCase()
    .split(/[,;/|&]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function buildTagMap(tags: TagWeight[], fallbackGenre?: string | null): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tags) {
    const k = t.name.trim().toLowerCase();
    if (k) map.set(k, Math.max(0.1, (t.count || 50) / 100));
  }
  if (map.size === 0 && fallbackGenre) {
    for (const tok of tokenizeGenre(fallbackGenre)) {
      map.set(tok, 0.7);
    }
  }
  return map;
}

function computeWeightedJaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  let union = 0;
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const k of allKeys) {
    const wa = a.get(k) || 0;
    const wb = b.get(k) || 0;
    intersection += Math.min(wa, wb);
    union += Math.max(wa, wb);
  }
  return union > 0 ? intersection / union : 0;
}

function computeEraScore(seedYear: number | null, candYear: number | null): number {
  if (!seedYear || !candYear || seedYear <= 1900 || candYear <= 1900) {
    return 0.45;
  }
  const diff = Math.abs(seedYear - candYear);
  const sigma = 6;
  return Math.exp(-(diff * diff) / (2 * sigma * sigma));
}

function computeRelDepthScore(
  seedRel: number,
  candRel: number,
  candCombinedGlobalPlays: number,
  mode: MixDepthMode
): number {
  const rel = Number.isFinite(candRel) ? candRel : 0;
  if (mode === 'hits') {
    if (rel >= 75.0) return 1.0;
    if (rel >= 70.0) return 0.9;
    if (rel >= 50.0) return 0.55;
    return 0.25;
  }
  if (mode === 'deep') {
    if (rel >= 15.0 && rel <= 55.0) {
      const lowGlobalBonus = candCombinedGlobalPlays > 0 && candCombinedGlobalPlays < 50000 ? 0.15 : 0;
      return Math.min(1, 0.84 + lowGlobalBonus);
    }
    if (rel > 55.0 && rel <= 70.0) return 0.45;
    return 0.35;
  }
  // balanced
  const tierDiff = Math.abs((seedRel || 50.0) - rel);
  const tierProximity = Math.exp(-(tierDiff * tierDiff) / (2 * 22.0 * 22.0));
  const standoutLift = rel >= 60.0 ? 0.15 : 0;
  return Math.min(1, tierProximity * 0.85 + standoutLift);
}

export interface GatherAndScoreResult {
  seedTrack: TrackRow;
  seedVariant: VariantType;
  candidates: ScoredCandidate[];
  cacheHit: boolean;
  hop1Count: number;
  hop2Count: number;
}

export async function gatherAndScoreCandidates(
  seedTrack: TrackRow,
  mode: MixDepthMode,
  excludeTrackIds: number[] = [],
  offlineOnly = false,
  sceneThreshold = 0.55
): Promise<GatherAndScoreResult> {
  const db = getDb();
  const seedVariant = classifyVariant(seedTrack);
  const seedArtistKey = normalizeArtistKey(seedTrack.artist);

  const [seedArtistAff, seedTrackAff] = await Promise.all([
    resolveArtistAffinity(seedTrack.artist, { offlineOnly }),
    resolveTrackAffinity(seedTrack, { offlineOnly }),
  ]);
  const cacheHit = seedArtistAff.fromCache || seedTrackAff.fromCache;

  const seedTagMap = buildTagMap(seedArtistAff.topTags, seedTrack.genre);

  // Hop-1: direct similar tracks + top 20 similar artists
  const hop1ArtistScores = new Map<string, number>();
  const hop1ArtistNames: string[] = [];
  for (const sim of seedArtistAff.similarArtists.slice(0, 20)) {
    const k = normalizeArtistKey(sim.name);
    if (!k || k === seedArtistKey) continue;
    hop1ArtistScores.set(k, Math.max(hop1ArtistScores.get(k) || 0, sim.match));
    hop1ArtistNames.push(sim.name);
  }

  const similarTrackLookup = new Map<string, number>();
  for (const st of seedTrackAff.similarTracks) {
    const tk = `${normalizeArtistKey(st.artist)}::${st.title.trim().toLowerCase()}`;
    similarTrackLookup.set(tk, st.match);
    const ak = normalizeArtistKey(st.artist);
    if (ak && ak !== seedArtistKey && !hop1ArtistScores.has(ak)) {
      hop1ArtistScores.set(ak, st.match * 0.9);
      hop1ArtistNames.push(st.artist);
    }
  }

  // Hop-2: warm top 4 Hop-1 artists and extract scene bridges filtered by shared micro-genre tags
  const hop1Records: ArtistAffinityRecord[] = await warmHop1Affinities(hop1ArtistNames.slice(0, 4), {
    offlineOnly,
  });
  const hop2ArtistScores = new Map<string, number>();
  for (const h1 of hop1Records) {
    const h1TagMap = buildTagMap(h1.topTags, seedTrack.genre);
    const sharedWithSeed = seedTagMap.size > 0 ? computeWeightedJaccard(seedTagMap, h1TagMap) : 0.5;
    if (seedTagMap.size > 0 && sharedWithSeed < 0.05) continue;

    for (const sim2 of h1.similarArtists.slice(0, 18)) {
      const k2 = normalizeArtistKey(sim2.name);
      if (!k2 || k2 === seedArtistKey || hop1ArtistScores.has(k2)) continue;
      const bridgeScore = Math.min(0.75, sim2.match * 0.72 + sharedWithSeed * 0.2);
      hop2ArtistScores.set(k2, Math.max(hop2ArtistScores.get(k2) || 0, bridgeScore));
    }
  }

  // Shared in-memory Genre Map + Artist Matrix scorer (used identically by Prefs Artist Map & eGenius)
  const sharedScorer = createSharedArtistScorer();
  const seedGenres = sharedScorer.getArtistGenres(seedTrack.artist);
  const primarySeedGenre = seedGenres[0]?.tag || tokenizeGenre(seedTrack.genre)[0] || '';
  const scenePeerArtists = primarySeedGenre
    ? sharedScorer
        .getGenrePeers(primarySeedGenre, Math.min(0.45, sceneThreshold * 0.8))
        .slice(0, 45)
        .map((a) => a.artistName)
    : [];

  // Pull candidate tracks from local SQLite
  const candidateMap = new Map<number, TrackRow>();
  const excludeSet = new Set<number>([seedTrack.id, ...excludeTrackIds]);

  const targetArtists = Array.from(
    new Set([
      seedTrack.artist,
      ...hop1ArtistNames.slice(0, 20),
      ...Array.from(hop2ArtistScores.keys()).slice(0, 35),
      ...scenePeerArtists,
    ])
  ).filter(Boolean);

  if (targetArtists.length > 0) {
    const placeholders = targetArtists.map(() => '?').join(',');
    const graphRows = db
      .prepare(
        `SELECT * FROM tracks
         WHERE LOWER(artist) IN (${placeholders})
           AND COALESCE(exclude_from_smart_playlists, 0) = 0
         ORDER BY is_loved DESC, artist_relative_popularity_score DESC
         LIMIT 1500`
      )
      .all(...targetArtists.map((a) => a.toLowerCase())) as TrackRow[];
    for (const r of graphRows) {
      if (!excludeSet.has(r.id)) candidateMap.set(r.id, r);
    }
  }

  // Offline / local genre + era fallback pool so we always reach 30-50+ distinct artists
  if (candidateMap.size < 250) {
    const genreTokens = tokenizeGenre(seedTrack.genre);
    if (genreTokens.length > 0) {
      const genreClauses = genreTokens.slice(0, 3).map(() => 'genre LIKE ? COLLATE NOCASE');
      const genreParams = genreTokens.slice(0, 3).map((g) => `%${g}%`);
      const localGenreRows = db
        .prepare(
          `SELECT * FROM tracks
           WHERE (${genreClauses.join(' OR ')})
             AND COALESCE(exclude_from_smart_playlists, 0) = 0
           ORDER BY is_loved DESC, artist_relative_popularity_score DESC
           LIMIT 700`
        )
        .all(...genreParams) as TrackRow[];
      for (const r of localGenreRows) {
        if (!excludeSet.has(r.id)) candidateMap.set(r.id, r);
      }
    }
  }

  if (candidateMap.size < 120 && seedTrack.year) {
    const eraRows = db
      .prepare(
        `SELECT * FROM tracks
         WHERE year BETWEEN ? AND ?
           AND COALESCE(exclude_from_smart_playlists, 0) = 0
         ORDER BY is_loved DESC, artist_relative_popularity_score DESC
         LIMIT 400`
      )
      .all(seedTrack.year - 6, seedTrack.year + 6) as TrackRow[];
    for (const r of eraRows) {
      if (!excludeSet.has(r.id)) candidateMap.set(r.id, r);
    }
  }

  // Score all candidates using the unified pairwise artist + subgenre matrix helpers
  const pairScoreCache = new Map<
    string,
    { localGenreSim: number; lastfmArtistSim: number; combinedArtistSim: number }
  >();
  const scored: ScoredCandidate[] = [];
  let hop1Count = 0;
  let hop2Count = 0;

  for (const cand of candidateMap.values()) {
    const parity = evaluateVariantParity(seedVariant, seedTrack.duration, cand);
    if (parity.excluded) continue;

    const candArtistKey = normalizeArtistKey(cand.artist);
    const candTrackKey = `${candArtistKey}::${(cand.title || '').trim().toLowerCase()}`;
    const directTrackMatch = similarTrackLookup.get(candTrackKey) || 0;
    const h1ArtistMatch = hop1ArtistScores.get(candArtistKey) || 0;
    const h2ArtistMatch = hop2ArtistScores.get(candArtistKey) || 0;

    let pair = pairScoreCache.get(candArtistKey);
    if (!pair) {
      pair = sharedScorer.scorePair(seedTrack.artist, cand.artist);
      if (pair.localGenreSim <= 0) {
        const candAff = readCachedArtistAffinity(cand.artist);
        const candTagMap = buildTagMap(candAff?.topTags || [], cand.genre);
        const jac = computeWeightedJaccard(seedTagMap, candTagMap);
        if (jac > 0) {
          pair = {
            ...pair,
            localGenreSim: jac,
            combinedArtistSim: Math.max(pair.combinedArtistSim, jac * 0.8),
          };
        }
      }
      pairScoreCache.set(candArtistKey, pair);
    }

    let hopLevel: 0 | 1 | 2 = 0;
    let graphScore = Math.max(0.18, pair.combinedArtistSim);
    if (candArtistKey === seedArtistKey) {
      hopLevel = 1;
      graphScore = 0.85;
    } else if (directTrackMatch > 0 || h1ArtistMatch > 0) {
      hopLevel = 1;
      graphScore = Math.max(directTrackMatch, h1ArtistMatch, pair.combinedArtistSim);
      hop1Count++;
    } else if (h2ArtistMatch > 0 || pair.combinedArtistSim >= sceneThreshold) {
      hopLevel = 2;
      graphScore = Math.max(h2ArtistMatch, pair.combinedArtistSim);
      hop2Count++;
    }

    const tagScore = pair.localGenreSim;

    // Scene Crossover Threshold enforcement: penalize or gate out-of-scene cross-genre drift
    const minGate = Math.max(0.1, sceneThreshold * 0.65);
    const sceneCohesionMult =
      candArtistKey === seedArtistKey || directTrackMatch > 0
        ? 1.0
        : tagScore >= sceneThreshold
        ? 1.1
        : tagScore >= minGate
        ? 0.85
        : 0.35;

    const eraScore = computeEraScore(seedTrack.year, cand.year);
    const relDepthScore = computeRelDepthScore(
      seedTrack.artist_relative_popularity_score || 50.0,
      cand.artist_relative_popularity_score || 0,
      cand.combined_global_plays ?? cand.global_listen_count ?? 0,
      mode
    );

    const rawComposite =
      graphScore * WEIGHT_GRAPH +
      tagScore * WEIGHT_TAGS +
      eraScore * WEIGHT_ERA +
      relDepthScore * WEIGHT_REL_DEPTH +
      parity.variantScore * WEIGHT_VARIANT;

    const rarityBonus =
      hopLevel === 2
        ? Math.min(1.18, 1.0 + Math.max(0, (cand.artist_rarity_multiplier || 1.0) - 1.0) * 0.025 + ((cand.discovery_score || 0) / 1000) * 0.08)
        : 1.0;
    const loveBoost = cand.is_loved ? 1.08 : (cand.local_star_rating || 0) >= 4 ? 1.04 : 1.0;
    const compositeScore = rawComposite * parity.parityMultiplier * loveBoost * rarityBonus * sceneCohesionMult;

    const reasons: string[] = [];
    if (directTrackMatch > 0) reasons.push(`Direct track affinity (${Math.round(directTrackMatch * 100)}%)`);
    else if (hopLevel === 1) reasons.push('Hop-1 similar artist');
    else if (hopLevel === 2) reasons.push('Hop-2 scene bridge');
    else reasons.push('Local genre/era match');
    if (tagScore >= 0.25) reasons.push(`Scene matrix (${tagScore.toFixed(3)})`);
    if (eraScore >= 0.75 && cand.year) reasons.push(`Era match (${cand.year})`);
    reasons.push(parity.reason);

    scored.push({
      track: cand,
      breakdown: {
        graphScore,
        tagScore,
        eraScore,
        relDepthScore,
        variantScore: parity.variantScore,
        compositeScore,
        hopLevel,
        variantType: parity.candidateVariant,
        reasons,
      },
    });
  }

  scored.sort((a, b) => b.breakdown.compositeScore - a.breakdown.compositeScore);

  return {
    seedTrack,
    seedVariant,
    candidates: scored,
    cacheHit,
    hop1Count,
    hop2Count,
  };
}
