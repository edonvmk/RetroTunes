import { getDb } from '../db';
import { logger } from '../logger';
import { normalizeArtistKey } from './affinityCache';
import { SimilarArtistEntry, TagWeight } from './types';

export interface MatrixGenreSummary {
  genre: string;
  artistCount: number;
  totalWeight: number;
}

export interface MatrixCell {
  genreX: string;
  genreY: string;
  similarity: number;
  isUserLocked: boolean;
  updatedAt: number;
}

export interface GenreMatrixPayload {
  genres: MatrixGenreSummary[];
  cells: MatrixCell[];
  totalArtistsWeighted: number;
  totalCellsStored: number;
}

export interface ArtistSceneScoreResult {
  artistName: string;
  artistKey: string;
  targetGenre: string;
  score: number;
  topTags: { tag: string; weight: number; matrixSim: number; contribution: number }[];
}

export interface RebuildGenreMatrixResult {
  artistsWeighted: number;
  genresIndexed: number;
  cellsStored: number;
  lockedCellsPreserved: number;
  elapsedMs: number;
}

const NOISE_TAGS = new Set([
  'seen live',
  'favorite',
  'favorites',
  'favourite',
  'favourites',
  'my music',
  'awesome',
  'love',
  'loved',
  'cool',
  'best',
  'good',
  'great',
  'under 2000 listeners',
  'under 5000 listeners',
  'check out',
  'to listen',
  'female vocalists',
  'male vocalists',
  'american',
  'british',
  'canadian',
  'australian',
  'english',
  'swedish',
  'german',
  'japanese',
  'music',
  'unknown',
  'other',
  'various',
  'misc',
  'general',
  'spotify',
  'itunes',
  'album',
  'albums',
  'all',
]);

const TAG_ALIASES: Record<string, string> = {
  emocore: 'emo',
  'emo core': 'emo',
  'alt rock': 'alternative rock',
  'alt-rock': 'alternative rock',
  alternative: 'alternative rock',
  'alt metal': 'alternative metal',
  'alt-metal': 'alternative metal',
  'pop-punk': 'pop punk',
  poppunk: 'pop punk',
  'emo-pop': 'emo pop',
  emopop: 'emo pop',
  'post hardcore': 'post-hardcore',
  posthardcore: 'post-hardcore',
  'post grunge': 'post-grunge',
  postgrunge: 'post-grunge',
  'nu-metal': 'nu metal',
  numetal: 'nu metal',
  'hip-hop': 'hip hop',
  hiphop: 'hip hop',
  'rap rock': 'rap metal',
  'r&b': 'rnb',
  'r and b': 'rnb',
  'synth-pop': 'synthpop',
  'indie-rock': 'indie rock',
  'indie-pop': 'indie pop',
  'alt-country': 'alt country',
  'alternative country': 'alt country',
  'death-metal': 'death metal',
  'melodic death': 'melodic death metal',
  melodeath: 'melodic death metal',
  'melodic metalcore': 'metalcore',
  'nintendocore': 'electronicore',
};

/**
 * Curated artist-level scene priors used only when an artist has no online Last.fm
 * affinity tags and no informative non-generic local ID3 genre tags.
 * Anchored strictly to artist identity — never track titles.
 */
const ARTIST_SCENE_FALLBACKS: Record<string, Record<string, number>> = {
  'attack attack!': {
    'post-hardcore': 0.96,
    crabcore: 0.92,
    electronicore: 0.9,
    metalcore: 0.88,
    screamo: 0.82,
    emo: 0.62,
  },
  'a day to remember': {
    easycore: 0.95,
    'pop punk': 0.9,
    'post-hardcore': 0.88,
    metalcore: 0.85,
    'emo pop': 0.72,
    emo: 0.65,
  },
  silverstein: {
    'post-hardcore': 0.96,
    emo: 0.88,
    screamo: 0.84,
    'pop punk': 0.68,
    metalcore: 0.55,
  },
  'fall out boy': {
    'pop punk': 0.95,
    emo: 0.86,
    'emo pop': 0.88,
    'alternative rock': 0.72,
  },
  'my chemical romance': {
    emo: 0.96,
    'post-hardcore': 0.82,
    'pop punk': 0.84,
    'alternative rock': 0.76,
    'emo pop': 0.78,
  },
  'taking back sunday': {
    emo: 0.96,
    'post-hardcore': 0.78,
    'pop punk': 0.82,
    'emo pop': 0.84,
  },
  'the used': {
    emo: 0.92,
    'post-hardcore': 0.9,
    screamo: 0.84,
    'alternative rock': 0.7,
  },
  'senses fail': {
    'post-hardcore': 0.94,
    emo: 0.9,
    screamo: 0.85,
    'pop punk': 0.65,
  },
  'hawthorne heights': {
    emo: 0.94,
    'post-hardcore': 0.9,
    screamo: 0.86,
    'pop punk': 0.64,
  },
  underoath: {
    'post-hardcore': 0.95,
    metalcore: 0.9,
    screamo: 0.88,
    emo: 0.74,
  },
  chiodos: {
    'post-hardcore': 0.96,
    screamo: 0.9,
    emo: 0.85,
    metalcore: 0.62,
  },
  saosin: {
    'post-hardcore': 0.96,
    emo: 0.88,
    screamo: 0.82,
    'alternative rock': 0.62,
  },
  alexisonfire: {
    'post-hardcore': 0.96,
    screamo: 0.86,
    emo: 0.72,
    metalcore: 0.58,
  },
  'asking alexandria': {
    metalcore: 0.95,
    electronicore: 0.86,
    crabcore: 0.78,
    'post-hardcore': 0.84,
    screamo: 0.7,
  },
  'of mice & men': {
    metalcore: 0.95,
    'post-hardcore': 0.88,
    crabcore: 0.68,
    screamo: 0.72,
  },
  'pierce the veil': {
    'post-hardcore': 0.95,
    emo: 0.84,
    screamo: 0.82,
    metalcore: 0.66,
  },
  'sleeping with sirens': {
    'post-hardcore': 0.95,
    emo: 0.82,
    'emo pop': 0.8,
    'pop punk': 0.72,
  },
  'escape the fate': {
    'post-hardcore': 0.92,
    emo: 0.78,
    screamo: 0.8,
    'hard rock': 0.68,
  },
  paramore: {
    'pop punk': 0.9,
    'emo pop': 0.88,
    emo: 0.82,
    'alternative rock': 0.8,
  },
  'brand new': {
    emo: 0.95,
    'indie rock': 0.82,
    'post-hardcore': 0.74,
    'pop punk': 0.62,
  },
  'blink-182': {
    'pop punk': 0.98,
    'skate punk': 0.82,
    'alternative rock': 0.7,
    emo: 0.58,
  },
  'sum 41': {
    'pop punk': 0.94,
    'skate punk': 0.84,
    'alternative metal': 0.62,
    punk: 0.76,
  },
  seether: {
    'post-grunge': 0.96,
    'alternative metal': 0.88,
    'hard rock': 0.84,
    'alternative rock': 0.78,
    grunge: 0.72,
  },
  'three days grace': {
    'post-grunge': 0.95,
    'alternative metal': 0.9,
    'hard rock': 0.86,
    'alternative rock': 0.76,
  },
  'breaking benjamin': {
    'post-grunge': 0.94,
    'alternative metal': 0.92,
    'hard rock': 0.86,
    'nu metal': 0.62,
  },
  shinedown: {
    'post-grunge': 0.94,
    'hard rock': 0.9,
    'alternative metal': 0.82,
    'alternative rock': 0.72,
  },
  staind: {
    'post-grunge': 0.95,
    'nu metal': 0.82,
    'alternative metal': 0.84,
    'hard rock': 0.76,
  },
  creed: {
    'post-grunge': 0.96,
    'hard rock': 0.84,
    'alternative rock': 0.78,
    grunge: 0.66,
  },
  nickelback: {
    'post-grunge': 0.96,
    'hard rock': 0.88,
    'alternative rock': 0.72,
  },
  'puddle of mudd': {
    'post-grunge': 0.95,
    grunge: 0.76,
    'alternative rock': 0.78,
    'hard rock': 0.74,
  },
  'theory of a deadman': {
    'post-grunge': 0.95,
    'hard rock': 0.85,
    'alternative rock': 0.74,
  },
  chevelle: {
    'alternative metal': 0.94,
    'post-grunge': 0.82,
    'hard rock': 0.84,
    'nu metal': 0.64,
  },
  skillet: {
    'post-grunge': 0.88,
    'hard rock': 0.88,
    'alternative metal': 0.82,
    'christian rock': 0.85,
  },
  'avenged sevenfold': {
    'heavy metal': 0.92,
    metalcore: 0.76,
    'hard rock': 0.84,
    metal: 0.86,
  },
  'killswitch engage': {
    metalcore: 0.98,
    metal: 0.85,
    'heavy metal': 0.72,
  },
  'all that remains': {
    metalcore: 0.96,
    'melodic death metal': 0.7,
    metal: 0.82,
  },
  'august burns red': {
    metalcore: 0.98,
    'post-hardcore': 0.62,
    metal: 0.84,
  },
  'parkway drive': {
    metalcore: 0.98,
    metal: 0.86,
    'hardcore punk': 0.65,
  },
  'bring me the horizon': {
    metalcore: 0.86,
    'post-hardcore': 0.84,
    electronicore: 0.74,
    'alternative rock': 0.76,
  },
  'bullet for my valentine': {
    metalcore: 0.92,
    'heavy metal': 0.84,
    'hard rock': 0.72,
  },
  trivium: {
    metalcore: 0.92,
    'thrash metal': 0.82,
    'heavy metal': 0.85,
  },
  'johnny cash': {
    country: 0.98,
    'outlaw country': 0.92,
    americana: 0.86,
    folk: 0.7,
  },
  'morgan wallen': {
    country: 0.98,
    'country pop': 0.84,
  },
  'luke combs': {
    country: 0.98,
    'country rock': 0.74,
  },
  'chris stapleton': {
    country: 0.95,
    americana: 0.86,
    'southern rock': 0.78,
    blues: 0.68,
  },
  'zach bryan': {
    country: 0.92,
    americana: 0.9,
    'alt country': 0.85,
    folk: 0.74,
  },
};

/**
 * Symmetric musicological co-occurrence / co-listening priors (`0.000` - `1.000`)
 * representing scene bridges before/beyond sparse online Last.fm caches.
 */
const SCENE_CROSSOVER_PRIORS: [string, string, number][] = [
  // Emo / Post-Hardcore / Crabcore / Pop Punk / Metalcore constellation
  ['emo', 'post-hardcore', 0.805],
  ['emo', 'pop punk', 0.81],
  ['emo', 'emo pop', 0.86],
  ['emo', 'screamo', 0.825],
  ['emo', 'crabcore', 0.735],
  ['emo', 'easycore', 0.695],
  ['emo', 'electronicore', 0.62],
  ['emo', 'metalcore', 0.56],
  ['emo', 'indie rock', 0.64],
  ['emo', 'alternative rock', 0.61],
  ['emo', 'melodic hardcore', 0.65],
  ['emo', 'skate punk', 0.52],
  ['emo', 'punk', 0.54],
  ['emo', 'punk rock', 0.56],
  ['emo', 'post-grunge', 0.24],
  ['emo', 'country', 0.015],

  ['post-hardcore', 'crabcore', 0.89],
  ['post-hardcore', 'electronicore', 0.85],
  ['post-hardcore', 'screamo', 0.875],
  ['post-hardcore', 'metalcore', 0.795],
  ['post-hardcore', 'easycore', 0.81],
  ['post-hardcore', 'pop punk', 0.68],
  ['post-hardcore', 'emo pop', 0.64],
  ['post-hardcore', 'melodic hardcore', 0.76],
  ['post-hardcore', 'hardcore punk', 0.68],
  ['post-hardcore', 'alternative rock', 0.52],
  ['post-hardcore', 'alternative metal', 0.45],
  ['post-hardcore', 'post-grunge', 0.28],
  ['post-hardcore', 'country', 0.01],

  ['crabcore', 'electronicore', 0.91],
  ['crabcore', 'metalcore', 0.84],
  ['crabcore', 'screamo', 0.79],
  ['crabcore', 'easycore', 0.74],
  ['crabcore', 'pop punk', 0.54],
  ['crabcore', 'post-grunge', 0.16],
  ['crabcore', 'country', 0.0],

  ['electronicore', 'metalcore', 0.83],
  ['electronicore', 'screamo', 0.72],
  ['electronicore', 'easycore', 0.68],
  ['electronicore', 'electronic', 0.58],
  ['electronicore', 'country', 0.0],

  ['easycore', 'pop punk', 0.885],
  ['easycore', 'metalcore', 0.76],
  ['easycore', 'emo pop', 0.74],
  ['easycore', 'skate punk', 0.68],
  ['easycore', 'punk rock', 0.64],

  ['pop punk', 'emo pop', 0.875],
  ['pop punk', 'skate punk', 0.84],
  ['pop punk', 'punk rock', 0.81],
  ['pop punk', 'punk', 0.77],
  ['pop punk', 'alternative rock', 0.66],
  ['pop punk', 'pop rock', 0.68],
  ['pop punk', 'power pop', 0.71],

  ['metalcore', 'screamo', 0.74],
  ['metalcore', 'melodic death metal', 0.71],
  ['metalcore', 'hardcore punk', 0.69],
  ['metalcore', 'melodic hardcore', 0.75],
  ['metalcore', 'deathcore', 0.78],
  ['metalcore', 'alternative metal', 0.64],
  ['metalcore', 'heavy metal', 0.66],
  ['metalcore', 'metal', 0.74],
  ['metalcore', 'nu metal', 0.56],
  ['metalcore', 'post-grunge', 0.34],
  ['metalcore', 'country', 0.0],

  // Post-grunge / Alternative Metal / Hard Rock / Nu Metal / Grunge
  ['post-grunge', 'alternative metal', 0.82],
  ['post-grunge', 'hard rock', 0.845],
  ['post-grunge', 'alternative rock', 0.775],
  ['post-grunge', 'grunge', 0.745],
  ['post-grunge', 'nu metal', 0.69],
  ['post-grunge', 'rock', 0.72],
  ['post-grunge', 'heavy metal', 0.48],
  ['post-grunge', 'country', 0.004],

  ['alternative metal', 'hard rock', 0.81],
  ['alternative metal', 'nu metal', 0.83],
  ['alternative metal', 'heavy metal', 0.73],
  ['alternative metal', 'metal', 0.75],
  ['alternative metal', 'alternative rock', 0.71],
  ['alternative metal', 'grunge', 0.62],
  ['alternative metal', 'country', 0.0],

  ['hard rock', 'rock', 0.82],
  ['hard rock', 'heavy metal', 0.76],
  ['hard rock', 'classic rock', 0.78],
  ['hard rock', 'alternative rock', 0.69],
  ['hard rock', 'southern rock', 0.62],
  ['hard rock', 'grunge', 0.67],
  ['hard rock', 'nu metal', 0.61],
  ['hard rock', 'country', 0.012],

  ['alternative rock', 'rock', 0.81],
  ['alternative rock', 'indie rock', 0.78],
  ['alternative rock', 'grunge', 0.73],
  ['alternative rock', 'pop rock', 0.67],
  ['alternative rock', 'punk rock', 0.62],
  ['alternative rock', 'post-punk', 0.65],
  ['alternative rock', 'country', 0.01],

  ['grunge', 'rock', 0.72],
  ['grunge', 'punk', 0.58],
  ['grunge', 'country', 0.0],

  ['punk', 'punk rock', 0.92],
  ['punk', 'hardcore punk', 0.86],
  ['punk', 'skate punk', 0.88],
  ['punk', 'melodic hardcore', 0.82],
  ['punk', 'rock', 0.62],
  ['punk rock', 'skate punk', 0.87],
  ['punk rock', 'hardcore punk', 0.81],
  ['punk rock', 'melodic hardcore', 0.82],
  ['hardcore punk', 'melodic hardcore', 0.85],

  // Metal spectrum
  ['metal', 'heavy metal', 0.91],
  ['metal', 'thrash metal', 0.85],
  ['metal', 'death metal', 0.82],
  ['metal', 'melodic death metal', 0.83],
  ['metal', 'groove metal', 0.8],
  ['heavy metal', 'thrash metal', 0.84],
  ['heavy metal', 'classic rock', 0.58],
  ['death metal', 'melodic death metal', 0.84],
  ['death metal', 'deathcore', 0.78],

  // Country / Americana / Folk / Southern Rock
  ['country', 'outlaw country', 0.89],
  ['country', 'alt country', 0.84],
  ['country', 'country pop', 0.86],
  ['country', 'country rock', 0.83],
  ['country', 'americana', 0.81],
  ['country', 'southern rock', 0.66],
  ['country', 'folk', 0.62],
  ['country', 'bluegrass', 0.79],
  ['americana', 'folk', 0.82],
  ['americana', 'alt country', 0.89],
  ['americana', 'southern rock', 0.71],
  ['classic rock', 'southern rock', 0.74],
  ['classic rock', 'blues rock', 0.81],
  ['blues', 'blues rock', 0.86],

  // Hip Hop / Pop / Electronic / R&B
  ['hip hop', 'rap', 0.94],
  ['hip hop', 'trap', 0.85],
  ['hip hop', 'rnb', 0.71],
  ['pop', 'pop rock', 0.78],
  ['pop', 'synthpop', 0.79],
  ['pop', 'indie pop', 0.76],
  ['pop', 'rnb', 0.67],
  ['electronic', 'synthpop', 0.79],
  ['electronic', 'edm', 0.86],
  ['electronic', 'house', 0.84],
  ['electronic', 'techno', 0.83],
  ['electronic', 'electro', 0.85],
];

const PRIOR_LOOKUP = new Map<string, number>();
for (const [gx, gy, sim] of SCENE_CROSSOVER_PRIORS) {
  PRIOR_LOOKUP.set(`${gx}|||${gy}`, sim);
  PRIOR_LOOKUP.set(`${gy}|||${gx}`, sim);
}

function getScenePrior(gx: string, gy: string): number | null {
  if (gx === gy) return 1.0;
  return PRIOR_LOOKUP.get(`${gx}|||${gy}`) ?? null;
}

export function normalizeGenreTag(raw?: string | null): string | null {
  if (!raw) return null;
  let cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length < 2) return null;

  if (/^(19\d\d|20\d\d|'\d\d|\d{1,2}0s|\d{4}s)$/.test(cleaned)) {
    return null;
  }
  if (NOISE_TAGS.has(cleaned)) return null;

  cleaned = TAG_ALIASES[cleaned] || cleaned;
  if (NOISE_TAGS.has(cleaned)) return null;
  return cleaned;
}

function splitLocalGenreField(genreField?: string | null): string[] {
  if (!genreField) return [];
  const parts = genreField
    .split(/[;,/|&]+/)
    .map((p) => normalizeGenreTag(p))
    .filter((p): p is string => Boolean(p));
  return Array.from(new Set(parts));
}

function round3(val: number): number {
  return Math.round(Math.max(0, Math.min(1, val)) * 1000) / 1000;
}

function buildArtistFallbackTagMap(artistName: string, localGenreField?: string | null): Map<string, number> {
  const key = normalizeArtistKey(artistName);
  const out = new Map<string, number>();

  const curated = ARTIST_SCENE_FALLBACKS[key];
  const localTags = splitLocalGenreField(localGenreField);
  const nonGenericLocal = localTags.filter((t) => t !== 'rock' && t !== 'pop' && t !== 'music');

  if (nonGenericLocal.length > 0) {
    const step = 1 / Math.max(1, nonGenericLocal.length);
    nonGenericLocal.forEach((tag, idx) => {
      out.set(tag, Math.max(out.get(tag) || 0, round3(Math.max(0.45, 0.95 - idx * step * 0.45))));
    });
  } else if (curated) {
    for (const [tag, weight] of Object.entries(curated)) {
      const norm = normalizeGenreTag(tag);
      if (norm) out.set(norm, round3(weight));
    }
  } else if (localTags.length > 0) {
    for (const tag of localTags) {
      out.set(tag, 0.75);
    }
  }

  return out;
}

export function ensureGenreMatrixReady(): void {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM subgenre_affinity_matrix').get() as { c: number };
  if (!row || row.c === 0) {
    rebuildGenreMatrix();
  }
}

/**
 * Rebuilds `artist_genre_weights` and `subgenre_affinity_matrix` strictly from artist-level
 * folksonomy tags, local artist-majority ID3 genres, and co-listening graph edges.
 * Preserves any cells where `is_user_locked = 1`.
 */
export function rebuildGenreMatrix(): RebuildGenreMatrixResult {
  const start = Date.now();
  const db = getDb();

  // 1. Load locked matrix cells so user ECU trims are never overwritten
  const lockedRows = db
    .prepare(
      'SELECT genre_x, genre_y, similarity, updated_at FROM subgenre_affinity_matrix WHERE is_user_locked = 1'
    )
    .all() as { genre_x: string; genre_y: string; similarity: number; updated_at: number }[];
  const lockedKeys = new Set<string>();
  for (const r of lockedRows) {
    lockedKeys.add(`${r.genre_x}|||${r.genre_y}`);
  }

  // 2. Gather artist-level Last.fm tags + co-listening edges
  const affRows = db
    .prepare('SELECT artist_key, artist_name, similar_artists_json, top_tags_json FROM artist_affinity_cache')
    .all() as {
      artist_key: string;
      artist_name: string;
      similar_artists_json: string;
      top_tags_json: string;
    }[];

  const artistTagWeights = new Map<string, Map<string, number>>();
  const similarGraphEdges = new Map<string, SimilarArtistEntry[]>();

  for (const row of affRows) {
    const ak = normalizeArtistKey(row.artist_key || row.artist_name);
    if (!ak) continue;
    let map = artistTagWeights.get(ak);
    if (!map) {
      map = new Map<string, number>();
      artistTagWeights.set(ak, map);
    }
    try {
      const tags = JSON.parse(row.top_tags_json) as TagWeight[];
      if (Array.isArray(tags)) {
        for (const t of tags) {
          const norm = normalizeGenreTag(t?.name);
          if (!norm) continue;
          const w = Math.max(0.12, Math.min(1.0, (Number(t.count) || 50) / 100));
          map.set(norm, Math.max(map.get(norm) || 0, w));
        }
      }
    } catch {
      // ignore malformed JSON
    }
    try {
      const sims = JSON.parse(row.similar_artists_json) as SimilarArtistEntry[];
      if (Array.isArray(sims) && sims.length > 0) {
        similarGraphEdges.set(ak, sims);
      }
    } catch {
      // ignore
    }
  }

  // 3. Aggregate local artist-level majority ID3 genre tokens (never from track titles)
  const localGenreStats = db
    .prepare(
      `SELECT LOWER(TRIM(artist)) as akey, genre, COUNT(*) as cnt
       FROM tracks
       WHERE COALESCE(TRIM(artist), '') != ''
       GROUP BY LOWER(TRIM(artist)), genre`
    )
    .all() as { akey: string; genre: string | null; cnt: number }[];

  const localCountsByArtist = new Map<string, { counts: Map<string, number>; totalTagged: number }>();
  const allLibraryArtistKeys = new Set<string>();

  for (const r of localGenreStats) {
    const ak = normalizeArtistKey(r.akey);
    if (!ak) continue;
    allLibraryArtistKeys.add(ak);
    const tokens = splitLocalGenreField(r.genre);
    if (tokens.length === 0) continue;

    let entry = localCountsByArtist.get(ak);
    if (!entry) {
      entry = { counts: new Map<string, number>(), totalTagged: 0 };
      localCountsByArtist.set(ak, entry);
    }
    entry.totalTagged += r.cnt;
    for (const tok of tokens) {
      entry.counts.set(tok, (entry.counts.get(tok) || 0) + r.cnt);
    }
  }

  for (const [ak, entry] of localCountsByArtist.entries()) {
    let map = artistTagWeights.get(ak);
    if (!map) {
      map = new Map<string, number>();
      artistTagWeights.set(ak, map);
    }
    const maxCount = Math.max(1, ...entry.counts.values());
    for (const [tag, cnt] of entry.counts.entries()) {
      const ratio = cnt / maxCount;
      const localWeight = tag === 'rock' && entry.counts.size > 1 ? ratio * 0.45 : Math.max(0.25, ratio * 0.92);
      // Last.fm artist folksonomy retains slight precedence if both exist
      map.set(tag, Math.max(map.get(tag) || 0, localWeight));
    }
  }

  // Apply artist-level scene fallback for known scene artists lacking non-generic tags
  for (const ak of allLibraryArtistKeys) {
    const curated = ARTIST_SCENE_FALLBACKS[ak];
    if (!curated) continue;
    let map = artistTagWeights.get(ak);
    if (!map) {
      map = new Map<string, number>();
      artistTagWeights.set(ak, map);
    }
    const nonGenericCount = Array.from(map.keys()).filter((k) => k !== 'rock' && k !== 'pop').length;
    if (nonGenericCount === 0) {
      for (const [tag, weight] of Object.entries(curated)) {
        const norm = normalizeGenreTag(tag);
        if (norm) map.set(norm, Math.max(map.get(norm) || 0, weight));
      }
    }
  }

  // Also seed curated scene artists present in ARTIST_SCENE_FALLBACKS even if not yet tagged
  for (const [ak, curated] of Object.entries(ARTIST_SCENE_FALLBACKS)) {
    if (!artistTagWeights.has(ak)) {
      const m = new Map<string, number>();
      for (const [tag, w] of Object.entries(curated)) {
        const norm = normalizeGenreTag(tag);
        if (norm) m.set(norm, w);
      }
      if (m.size > 0) artistTagWeights.set(ak, m);
    }
  }

  // 4. Trim each artist to top 8 weighted tags (0.000 - 1.000) & compute genre popularity
  const finalArtistVectors = new Map<string, [string, number][]>();
  const genreTotalWeight = new Map<string, number>();
  const genreArtistVectors = new Map<string, Map<string, number>>();
  const genreNormSq = new Map<string, number>();

  for (const [ak, tagMap] of artistTagWeights.entries()) {
    const sorted = Array.from(tagMap.entries())
      .map(([tag, w]) => [tag, round3(w)] as [string, number])
      .filter(([, w]) => w >= 0.05)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    if (sorted.length === 0) continue;

    finalArtistVectors.set(ak, sorted);
    for (const [tag, w] of sorted) {
      genreTotalWeight.set(tag, (genreTotalWeight.get(tag) || 0) + w);
      let ga = genreArtistVectors.get(tag);
      if (!ga) {
        ga = new Map<string, number>();
        genreArtistVectors.set(tag, ga);
      }
      ga.set(ak, w);
      genreNormSq.set(tag, (genreNormSq.get(tag) || 0) + w * w);
    }
  }

  // Include canonical scene genres that appear in priors alongside top library subgenres (capped at 120 genres)
  for (const [gx, gy] of SCENE_CROSSOVER_PRIORS) {
    if (!genreTotalWeight.has(gx)) genreTotalWeight.set(gx, 0.25);
    if (!genreTotalWeight.has(gy)) genreTotalWeight.set(gy, 0.25);
  }

  const activeGenres = Array.from(genreTotalWeight.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120)
    .map(([g]) => g);
  const activeGenreSet = new Set(activeGenres);

  // 5. Compute Co-Listening Graph Bridges (35% signal) from `artist_affinity_cache`
  const edgeBridgeWeights = new Map<string, number>();
  const genreOutWeight = new Map<string, number>();
  for (const [ak, sims] of similarGraphEdges.entries()) {
    const srcTags = finalArtistVectors.get(ak);
    if (!srcTags || srcTags.length === 0) continue;
    for (const sim of sims.slice(0, 20)) {
      const dstKey = normalizeArtistKey(sim.name);
      const dstTags = finalArtistVectors.get(dstKey);
      if (!dstTags || dstTags.length === 0) continue;
      const edgeMatch = Math.max(0.1, Number(sim.match) || 0.5);
      for (const [gx, wx] of srcTags) {
        if (!activeGenreSet.has(gx)) continue;
        for (const [gy, wy] of dstTags) {
          if (!activeGenreSet.has(gy)) continue;
          const contrib = edgeMatch * wx * wy;
          const k = `${gx}|||${gy}`;
          edgeBridgeWeights.set(k, (edgeBridgeWeights.get(k) || 0) + contrib);
          genreOutWeight.set(gx, (genreOutWeight.get(gx) || 0) + contrib);
        }
      }
    }
  }

  // 6. Compute NxN subgenre similarity cells
  const nowSec = Math.floor(Date.now() / 1000);
  const cellsToWrite: [string, string, number][] = [];

  for (let i = 0; i < activeGenres.length; i++) {
    const gx = activeGenres[i];
    if (!lockedKeys.has(`${gx}|||${gx}`)) {
      cellsToWrite.push([gx, gx, 1.0]);
    }

    const vecX = genreArtistVectors.get(gx);
    const normX = Math.sqrt(genreNormSq.get(gx) || 0);

    for (let j = i + 1; j < activeGenres.length; j++) {
      const gy = activeGenres[j];

      // Same-Artist Co-Occurrence Cosine Similarity (65%)
      let dot = 0;
      const vecY = genreArtistVectors.get(gy);
      const normY = Math.sqrt(genreNormSq.get(gy) || 0);
      if (vecX && vecY && normX > 0 && normY > 0) {
        const [smaller, larger] = vecX.size <= vecY.size ? [vecX, vecY] : [vecY, vecX];
        for (const [ak, wx] of smaller.entries()) {
          const wy = larger.get(ak);
          if (wy) dot += wx * wy;
        }
      }
      const cosineSim = normX > 0 && normY > 0 ? dot / (normX * normY) : 0;

      // Co-Listening Graph Bridge (35%)
      const outX = genreOutWeight.get(gx) || 0;
      const outY = genreOutWeight.get(gy) || 0;
      const rawBridgeXY = outX > 0 ? (edgeBridgeWeights.get(`${gx}|||${gy}`) || 0) / outX : 0;
      const rawBridgeYX = outY > 0 ? (edgeBridgeWeights.get(`${gy}|||${gx}`) || 0) / outY : 0;
      const graphBridge = Math.min(1, (rawBridgeXY + rawBridgeYX) * 1.8);

      const empirical = cosineSim * 0.65 + graphBridge * 0.35;
      const prior = getScenePrior(gx, gy);

      let blended: number;
      if (prior !== null) {
        // Blend empirical library statistics with calibrated scene prior (stronger weight as empirical samples grow)
        const hasGraphData = outX > 0 || outY > 0;
        const empWeight = hasGraphData ? 0.55 : vecX && vecX.size >= 3 && vecY && vecY.size >= 3 ? 0.35 : 0.1;
        blended = empirical * empWeight + prior * (1 - empWeight);
      } else {
        blended = empirical;
      }

      const simRounded = round3(blended);
      if (simRounded < 0.01) continue;

      if (!lockedKeys.has(`${gx}|||${gy}`)) {
        cellsToWrite.push([gx, gy, simRounded]);
      }
      if (!lockedKeys.has(`${gy}|||${gx}`)) {
        cellsToWrite.push([gy, gx, simRounded]);
      }
    }
  }

  // 7. Persist in a single fast SQLite transaction
  const insertArtistWeight = db.prepare(
    'INSERT OR REPLACE INTO artist_genre_weights (artist_key, genre_tag, weight) VALUES (?, ?, ?)'
  );
  const insertMatrixCell = db.prepare(
    `INSERT OR REPLACE INTO subgenre_affinity_matrix (genre_x, genre_y, similarity, is_user_locked, updated_at)
     VALUES (?, ?, ?, 0, ?)`
  );

  const tx = db.transaction(() => {
    db.exec('DELETE FROM artist_genre_weights');
    for (const [ak, tags] of finalArtistVectors.entries()) {
      for (const [tag, weight] of tags) {
        insertArtistWeight.run(ak, tag, weight);
      }
    }

    db.exec('DELETE FROM subgenre_affinity_matrix WHERE COALESCE(is_user_locked, 0) = 0');
    for (const [gx, gy, sim] of cellsToWrite) {
      insertMatrixCell.run(gx, gy, sim, nowSec);
    }
  });
  tx();

  const elapsedMs = Date.now() - start;
  logger.info(
    'SMART_PLAYLIST',
    `Rebuilt 2D Genre Matrix: ${activeGenres.length} subgenres, ${cellsToWrite.length} cells across ${finalArtistVectors.size} artists.`,
    {
      artistsWeighted: finalArtistVectors.size,
      genresIndexed: activeGenres.length,
      cellsStored: cellsToWrite.length,
      lockedCellsPreserved: lockedRows.length,
    },
    elapsedMs
  );

  return {
    artistsWeighted: finalArtistVectors.size,
    genresIndexed: activeGenres.length,
    cellsStored: cellsToWrite.length,
    lockedCellsPreserved: lockedRows.length,
    elapsedMs,
  };
}

function getArtistTagVector(artistNameOrKey: string, fallbackGenre?: string | null): [string, number][] {
  const db = getDb();
  const ak = normalizeArtistKey(artistNameOrKey);
  if (!ak) return [];

  const rows = db
    .prepare('SELECT genre_tag, weight FROM artist_genre_weights WHERE artist_key = ? ORDER BY weight DESC')
    .all(ak) as { genre_tag: string; weight: number }[];
  if (rows.length > 0) {
    return rows.map((r) => [r.genre_tag, r.weight]);
  }

  const fallback = buildArtistFallbackTagMap(artistNameOrKey, fallbackGenre);
  return Array.from(fallback.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

function lookupMatrixSimilarityMap(targetGenre: string): Map<string, number> {
  const db = getDb();
  const map = new Map<string, number>();
  map.set(targetGenre, 1.0);
  const rows = db
    .prepare('SELECT genre_x, similarity FROM subgenre_affinity_matrix WHERE genre_y = ?')
    .all(targetGenre) as { genre_x: string; similarity: number }[];
  for (const r of rows) {
    map.set(r.genre_x, r.similarity);
  }
  return map;
}

/**
 * Resolves an artist's `0.000` - `1.000` affinity against a target subgenre
 * using strictly artist-level tags bridged through `subgenre_affinity_matrix`.
 */
export function getArtistSceneScore(
  artistNameOrKey: string,
  targetGenreRaw: string,
  fallbackGenre?: string | null
): ArtistSceneScoreResult {
  ensureGenreMatrixReady();
  const targetGenre = normalizeGenreTag(targetGenreRaw) || targetGenreRaw.trim().toLowerCase();
  const ak = normalizeArtistKey(artistNameOrKey);
  const vec = getArtistTagVector(artistNameOrKey, fallbackGenre);
  const simMap = lookupMatrixSimilarityMap(targetGenre);

  const breakdown = vec.map(([tag, weight]) => {
    const matrixSim = simMap.get(tag) ?? (tag === targetGenre ? 1.0 : getScenePrior(tag, targetGenre) ?? 0);
    return {
      tag,
      weight,
      matrixSim: round3(matrixSim),
      contribution: round3(weight * matrixSim),
    };
  });

  const sorted = [...breakdown].sort((a, b) => b.contribution - a.contribution);
  const c1 = sorted[0]?.contribution || 0;
  const c2 = sorted[1]?.contribution || 0;
  const c3 = sorted[2]?.contribution || 0;
  const score = round3(Math.min(1.0, c1 + c2 * 0.22 + c3 * 0.1));

  return {
    artistName: artistNameOrKey,
    artistKey: ak,
    targetGenre,
    score,
    topTags: sorted.slice(0, 5),
  };
}

/**
 * Pairwise artist-to-artist similarity (`0.000` - `1.000`) through `subgenre_affinity_matrix`,
 * replacing raw string-exact Jaccard overlap in eGenius Signal #2.
 */
export function computeArtistSceneSimilarity(
  artistA: string,
  artistB: string,
  fallbackGenreA?: string | null,
  fallbackGenreB?: string | null,
  matrixLookup?: Map<string, number>
): number {
  ensureGenreMatrixReady();
  const akA = normalizeArtistKey(artistA);
  const akB = normalizeArtistKey(artistB);
  if (akA && akB && akA === akB) return 1.0;

  const vecA = getArtistTagVector(artistA, fallbackGenreA);
  const vecB = getArtistTagVector(artistB, fallbackGenreB);
  if (vecA.length === 0 || vecB.length === 0) return 0;

  const simCache = matrixLookup || loadFullMatrixLookupMap();
  const getSim = (gx: string, gy: string): number => {
    if (gx === gy) return 1.0;
    return simCache.get(`${gx}|||${gy}`) ?? getScenePrior(gx, gy) ?? 0;
  };

  let weightedCrossSum = 0;
  let normA = 0;
  let normB = 0;
  for (const [, wa] of vecA) normA += wa * wa;
  for (const [, wb] of vecB) normB += wb * wb;

  for (const [ga, wa] of vecA) {
    for (const [gb, wb] of vecB) {
      const s = getSim(ga, gb);
      if (s > 0) {
        weightedCrossSum += wa * wb * s;
      }
    }
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 0) return 0;
  return round3(Math.min(1.0, weightedCrossSum / denom));
}

export function loadFullMatrixLookupMap(): Map<string, number> {
  ensureGenreMatrixReady();
  const db = getDb();
  const rows = db
    .prepare('SELECT genre_x, genre_y, similarity FROM subgenre_affinity_matrix')
    .all() as { genre_x: string; genre_y: string; similarity: number }[];
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.genre_x}|||${r.genre_y}`, r.similarity);
  }
  return map;
}

export function getGenreMatrixData(options: { search?: string; limit?: number } = {}): GenreMatrixPayload {
  ensureGenreMatrixReady();
  const db = getDb();
  const limit = Math.max(6, Math.min(60, options.limit ?? 22));
  const q = (options.search || '').trim().toLowerCase();

  const summaryRows = db
    .prepare(
      `SELECT genre_tag as genre, COUNT(DISTINCT artist_key) as artistCount, SUM(weight) as totalWeight
       FROM artist_genre_weights
       GROUP BY genre_tag
       ORDER BY totalWeight DESC, artistCount DESC`
    )
    .all() as MatrixGenreSummary[];

  const matrixGenresRows = db
    .prepare('SELECT DISTINCT genre_x as genre FROM subgenre_affinity_matrix ORDER BY genre_x ASC')
    .all() as { genre: string }[];

  const summaryByGenre = new Map(summaryRows.map((r) => [r.genre, r]));
  for (const mg of matrixGenresRows) {
    if (!summaryByGenre.has(mg.genre)) {
      summaryByGenre.set(mg.genre, { genre: mg.genre, artistCount: 0, totalWeight: 0.1 });
    }
  }

  let genres = Array.from(summaryByGenre.values()).sort(
    (a, b) => b.totalWeight - a.totalWeight || b.artistCount - a.artistCount
  );
  if (q) {
    genres = genres.filter((g) => g.genre.toLowerCase().includes(q));
  }
  genres = genres.slice(0, limit);

  const genreNames = genres.map((g) => g.genre);
  let cells: MatrixCell[] = [];
  if (genreNames.length > 0) {
    const placeholders = genreNames.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT genre_x, genre_y, similarity, is_user_locked, updated_at
         FROM subgenre_affinity_matrix
         WHERE genre_x IN (${placeholders}) AND genre_y IN (${placeholders})`
      )
      .all(...genreNames, ...genreNames) as {
      genre_x: string;
      genre_y: string;
      similarity: number;
      is_user_locked: number;
      updated_at: number;
    }[];
    cells = rows.map((r) => ({
      genreX: r.genre_x,
      genreY: r.genre_y,
      similarity: round3(r.similarity),
      isUserLocked: Boolean(r.is_user_locked),
      updatedAt: r.updated_at,
    }));
  }

  const stats = db
    .prepare(
      'SELECT (SELECT COUNT(DISTINCT artist_key) FROM artist_genre_weights) as aCount, (SELECT COUNT(*) FROM subgenre_affinity_matrix) as cCount'
    )
    .get() as { aCount: number; cCount: number };

  return {
    genres,
    cells,
    totalArtistsWeighted: stats.aCount || 0,
    totalCellsStored: stats.cCount || 0,
  };
}

export function setGenreMatrixCell(
  genreXRaw: string,
  genreYRaw: string,
  similarityRaw: number,
  isLocked: boolean
): MatrixCell {
  ensureGenreMatrixReady();
  const db = getDb();
  const gx = normalizeGenreTag(genreXRaw) || genreXRaw.trim().toLowerCase();
  const gy = normalizeGenreTag(genreYRaw) || genreYRaw.trim().toLowerCase();
  const similarity = gx === gy ? 1.0 : round3(similarityRaw);
  const lockedInt = gx === gy ? 1 : isLocked ? 1 : 0;
  const nowSec = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO subgenre_affinity_matrix (genre_x, genre_y, similarity, is_user_locked, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    stmt.run(gx, gy, similarity, lockedInt, nowSec);
    if (gx !== gy) {
      stmt.run(gy, gx, similarity, lockedInt, nowSec);
    }
  });
  tx();

  return {
    genreX: gx,
    genreY: gy,
    similarity,
    isUserLocked: Boolean(lockedInt),
    updatedAt: nowSec,
  };
}

export function resetGenreMatrixCell(genreXRaw: string, genreYRaw: string): RebuildGenreMatrixResult {
  const db = getDb();
  const gx = normalizeGenreTag(genreXRaw) || genreXRaw.trim().toLowerCase();
  const gy = normalizeGenreTag(genreYRaw) || genreYRaw.trim().toLowerCase();
  db.prepare(
    'UPDATE subgenre_affinity_matrix SET is_user_locked = 0 WHERE (genre_x = ? AND genre_y = ?) OR (genre_x = ? AND genre_y = ?)'
  ).run(gx, gy, gy, gx);
  return rebuildGenreMatrix();
}

export function listAllMatrixGenres(): string[] {
  ensureGenreMatrixReady();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT genre_x as g FROM subgenre_affinity_matrix
       UNION
       SELECT genre_tag as g FROM artist_genre_weights
       ORDER BY g ASC`
    )
    .all() as { g: string }[];
  return rows.map((r) => r.g).filter(Boolean);
}

export function testArtistsAgainstGenre(
  targetGenreRaw: string,
  options: { artistQuery?: string; minScore?: number; limit?: number } = {}
): ArtistSceneScoreResult[] {
  ensureGenreMatrixReady();
  const db = getDb();
  const targetGenre = normalizeGenreTag(targetGenreRaw) || targetGenreRaw.trim().toLowerCase();
  const q = (options.artistQuery || '').trim();
  const minScore = options.minScore ?? 0;
  const limit = Math.max(1, Math.min(200, options.limit ?? 40));

  const simMap = lookupMatrixSimilarityMap(targetGenre);

  // Pull candidate artists from library + artist_genre_weights
  let artistRows: { artist_name: string; artist_key: string }[];
  if (q) {
    artistRows = db
      .prepare(
        `SELECT MIN(artist) as artist_name, LOWER(TRIM(artist)) as artist_key
         FROM tracks
         WHERE LOWER(artist) LIKE ?
         GROUP BY LOWER(TRIM(artist))
         LIMIT 250`
      )
      .all(`%${q.toLowerCase()}%`) as { artist_name: string; artist_key: string }[];
  } else {
    artistRows = db
      .prepare(
        `SELECT COALESCE(MIN(t.artist), agw.artist_key) as artist_name, agw.artist_key as artist_key
         FROM artist_genre_weights agw
         LEFT JOIN tracks t ON LOWER(TRIM(t.artist)) = agw.artist_key
         GROUP BY agw.artist_key`
      )
      .all() as { artist_name: string; artist_key: string }[];
  }

  // Preload all artist_genre_weights into memory for sub-10ms scoring across 1,200+ artists
  const weightRows = db
    .prepare('SELECT artist_key, genre_tag, weight FROM artist_genre_weights ORDER BY weight DESC')
    .all() as { artist_key: string; genre_tag: string; weight: number }[];
  const weightsByArtist = new Map<string, [string, number][]>();
  for (const w of weightRows) {
    let arr = weightsByArtist.get(w.artist_key);
    if (!arr) {
      arr = [];
      weightsByArtist.set(w.artist_key, arr);
    }
    arr.push([w.genre_tag, w.weight]);
  }

  const results: ArtistSceneScoreResult[] = [];
  for (const art of artistRows) {
    const ak = normalizeArtistKey(art.artist_key || art.artist_name);
    let vec = weightsByArtist.get(ak);
    if (!vec || vec.length === 0) {
      vec = getArtistTagVector(art.artist_name);
    }
    const breakdown = vec.map(([tag, weight]) => {
      const matrixSim = simMap.get(tag) ?? (tag === targetGenre ? 1.0 : getScenePrior(tag, targetGenre) ?? 0);
      return {
        tag,
        weight,
        matrixSim: round3(matrixSim),
        contribution: round3(weight * matrixSim),
      };
    });
    const sorted = [...breakdown].sort((a, b) => b.contribution - a.contribution);
    const c1 = sorted[0]?.contribution || 0;
    const c2 = sorted[1]?.contribution || 0;
    const c3 = sorted[2]?.contribution || 0;
    const score = round3(Math.min(1.0, c1 + c2 * 0.22 + c3 * 0.1));

    if (score >= minScore || q) {
      results.push({
        artistName: art.artist_name,
        artistKey: ak,
        targetGenre,
        score,
        topTags: sorted.slice(0, 5),
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.artistName.localeCompare(b.artistName));
  return results.slice(0, limit);
}

/**
 * Resolves a Smart Playlist `artist_scene_affinity` filter into SQL-ready lowercase artist keys.
 */
export function getMatchingArtistsForSceneFilter(
  targetGenreRaw: string,
  operator: string,
  value: number,
  valueTo?: number
): { matchedArtistsLower: string[]; isNegated: boolean } {
  ensureGenreMatrixReady();
  const db = getDb();
  const targetGenre = normalizeGenreTag(targetGenreRaw) || targetGenreRaw.trim().toLowerCase();
  const simMap = lookupMatrixSimilarityMap(targetGenre);

  const artistKeysRows = db
    .prepare(
      `SELECT DISTINCT LOWER(TRIM(artist)) as ak FROM tracks WHERE COALESCE(TRIM(artist), '') != ''
       UNION
       SELECT DISTINCT artist_key as ak FROM artist_genre_weights`
    )
    .all() as { ak: string }[];

  const weightRows = db
    .prepare('SELECT artist_key, genre_tag, weight FROM artist_genre_weights ORDER BY weight DESC')
    .all() as { artist_key: string; genre_tag: string; weight: number }[];
  const weightsByArtist = new Map<string, [string, number][]>();
  for (const w of weightRows) {
    let arr = weightsByArtist.get(w.artist_key);
    if (!arr) {
      arr = [];
      weightsByArtist.set(w.artist_key, arr);
    }
    arr.push([w.genre_tag, w.weight]);
  }

  const threshold = Number.isFinite(value) ? value : 0.55;
  const thresholdHi = Number.isFinite(valueTo) ? Number(valueTo) : threshold;

  const evalOp = (score: number): boolean => {
    switch (operator) {
      case 'gt':
        return score > threshold;
      case 'gte':
        return score >= threshold;
      case 'lt':
        return score < threshold;
      case 'lte':
        return score <= threshold;
      case 'is':
        return Math.abs(score - threshold) <= 0.005;
      case 'is_not':
        return Math.abs(score - threshold) > 0.005;
      case 'between':
        return score >= Math.min(threshold, thresholdHi) && score <= Math.max(threshold, thresholdHi);
      default:
        return score >= threshold;
    }
  };

  // For upper-bound rules (`<= 0.050` / `< 0.050`), artists with 0 vector entries evaluate to 0.000
  // and match cleanly via NOT IN (artists whose score exceeds threshold).
  if ((operator === 'lte' || operator === 'lt') && threshold < 0.5) {
    const excluded: string[] = [];
    for (const { ak } of artistKeysRows) {
      const vec = weightsByArtist.get(ak) || getArtistTagVector(ak);
      const contribs = vec
        .map(([tag, weight]) => weight * (simMap.get(tag) ?? (tag === targetGenre ? 1.0 : getScenePrior(tag, targetGenre) ?? 0)))
        .sort((a, b) => b - a);
      const score = round3(Math.min(1.0, (contribs[0] || 0) + (contribs[1] || 0) * 0.22 + (contribs[2] || 0) * 0.1));
      if ((operator === 'lte' && score > threshold) || (operator === 'lt' && score >= threshold)) {
        excluded.push(ak);
      }
    }
    return { matchedArtistsLower: excluded, isNegated: true };
  }

  const matched: string[] = [];
  for (const { ak } of artistKeysRows) {
    const vec = weightsByArtist.get(ak) || getArtistTagVector(ak);
    const contribs = vec
      .map(([tag, weight]) => weight * (simMap.get(tag) ?? (tag === targetGenre ? 1.0 : getScenePrior(tag, targetGenre) ?? 0)))
      .sort((a, b) => b - a);
    const score = round3(Math.min(1.0, (contribs[0] || 0) + (contribs[1] || 0) * 0.22 + (contribs[2] || 0) * 0.1));
    if (evalOp(score)) {
      matched.push(ak);
    }
  }
  return { matchedArtistsLower: matched, isNegated: false };
}
