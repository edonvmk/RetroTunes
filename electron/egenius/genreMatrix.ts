import { getDb } from '../db';
import { getSettings } from '../settings';
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
  totalLibraryArtists: number;
  totalGenresIndexed: number;
  totalCellsStored: number;
  hasLastfmApiKey: boolean;
  genreMapUseLastfm: boolean;
  genreMapLastfmWeight: number;
}

export interface ArtistSceneScoreResult {
  artistName: string;
  artistKey: string;
  targetGenre: string;
  score: number;
  topTags: { tag: string; weight: number; matrixSim: number; contribution: number }[];
}

export interface ArtistSliceEntry {
  artistKey: string;
  artistName: string;
  sceneScore: number;
  topTags: { tag: string; weight: number }[];
}

export interface ArtistSimilaritySlicePayload {
  targetGenre: string;
  minThreshold: number;
  effectiveLastfmWeight: number;
  hasLastfmApiKey: boolean;
  totalMatchedArtists: number;
  artists: ArtistSliceEntry[];
  localMatrix: number[][];
  lastfmMatrix: number[][];
  combinedMatrix: number[][];
  elapsedMs: number;
}

export interface RebuildGenreMatrixOptions {
  useLastfm?: boolean;
  lastfmWeight?: number; // 0..100
  resetStuckMetadata?: boolean;
}

export interface RebuildGenreMatrixResult {
  artistsWeighted: number;
  totalLibraryArtists: number;
  taggedArtists: number;
  genresIndexed: number;
  cellsStored: number;
  lockedCellsPreserved: number;
  effectiveLastfmWeight: number;
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
  'untagged',
]);

const ID3V1_GENRE_CODES: Record<string, string> = {
  '0': 'blues',
  '1': 'classic rock',
  '2': 'country',
  '3': 'dance',
  '4': 'disco',
  '5': 'funk',
  '6': 'grunge',
  '7': 'hip hop',
  '8': 'jazz',
  '9': 'metal',
  '13': 'pop',
  '14': 'r&b',
  '15': 'rap',
  '16': 'reggae',
  '17': 'rock',
  '18': 'techno',
  '19': 'industrial',
  '20': 'alternative rock',
  '21': 'ska',
  '22': 'death metal',
  '24': 'soundtrack',
  '26': 'ambient',
  '27': 'trip hop',
  '32': 'classical',
  '37': 'soundtrack',
  '40': 'alternative rock',
  '42': 'soul',
  '43': 'punk',
  '52': 'electronic',
  '79': 'hard rock',
  '80': 'folk',
  '81': 'folk rock',
  '91': 'gothic rock',
  '92': 'progressive rock',
  '93': 'psychedelic rock',
  '121': 'punk rock',
  '131': 'indie rock',
  '137': 'heavy metal',
  '138': 'black metal',
  '141': 'christian rock',
  '144': 'thrash metal',
};

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
  rnb: 'r&b',
  'r and b': 'r&b',
  'alternative rnb': 'alternative r&b',
  'melodic death': 'melodic death metal',
  melodeath: 'melodic death metal',
  nintendocore: 'electronicore',
  'alt-country': 'alt country',
  'alternative country': 'alt country',
  'synth-pop': 'synthpop',
  'indie-rock': 'indie rock',
  'indie-pop': 'indie pop',
  'death-metal': 'death metal',
};

/**
 * Curated artist-level scene priors used ONLY when an artist has neither
 * cached Last.fm tags nor informative local ID3 genre tags.
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
  'blink‐182': {
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
  'new found glory': {
    'pop punk': 0.96,
    easycore: 0.78,
    emo: 0.7,
    'skate punk': 0.75,
  },
  'the offspring': {
    'punk rock': 0.94,
    'skate punk': 0.86,
    'pop punk': 0.76,
    'alternative rock': 0.7,
  },
  nofx: {
    'punk rock': 0.96,
    'skate punk': 0.94,
    'melodic hardcore': 0.76,
    punk: 0.9,
  },
  'less than jake': {
    'ska punk': 0.95,
    ska: 0.88,
    'pop punk': 0.78,
    'punk rock': 0.82,
  },
  'the bouncing souls': {
    'punk rock': 0.95,
    punk: 0.92,
    'skate punk': 0.76,
  },
  ramones: {
    punk: 0.98,
    'punk rock': 0.96,
    rock: 0.65,
  },
  weezer: {
    'alternative rock': 0.94,
    'power pop': 0.86,
    'indie rock': 0.78,
    emo: 0.62,
  },
  'foo fighters': {
    'alternative rock': 0.95,
    'post-grunge': 0.82,
    'hard rock': 0.8,
    rock: 0.78,
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
  'bring me the horizon': {
    metalcore: 0.88,
    'post-hardcore': 0.84,
    electronicore: 0.74,
    'alternative rock': 0.76,
    'alternative metal': 0.82,
  },
  'bring me the horizon (2)': {
    metalcore: 0.88,
    'post-hardcore': 0.84,
    electronicore: 0.74,
    'alternative rock': 0.76,
    'alternative metal': 0.82,
  },
  'electric callboy (2)': {
    electronicore: 0.96,
    metalcore: 0.88,
    'post-hardcore': 0.74,
    crabcore: 0.72,
  },
  metallica: {
    'thrash metal': 0.96,
    'heavy metal': 0.95,
    metal: 0.94,
    'hard rock': 0.74,
  },
  'black sabbath': {
    'heavy metal': 0.98,
    metal: 0.95,
    'hard rock': 0.84,
    'classic rock': 0.76,
  },
  'ozzy osbourne': {
    'heavy metal': 0.96,
    'hard rock': 0.88,
    metal: 0.9,
    'classic rock': 0.72,
  },
  'judas priest': {
    'heavy metal': 0.98,
    metal: 0.94,
    'hard rock': 0.78,
  },
  sabaton: {
    'power metal': 0.98,
    'heavy metal': 0.9,
    metal: 0.88,
  },
  eminem: {
    'hip hop': 0.96,
    rap: 0.96,
    'hardcore hip hop': 0.82,
  },
  'johnny cash': {
    country: 0.98,
    'outlaw country': 0.94,
    americana: 0.86,
    folk: 0.72,
  },
  'morgan wallen': {
    country: 0.98,
    'country pop': 0.86,
  },
  'luke combs': {
    country: 0.98,
    'country rock': 0.76,
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
  'pink floyd': {
    'progressive rock': 0.98,
    'psychedelic rock': 0.92,
    'classic rock': 0.88,
    'art rock': 0.86,
  },
  'the beatles': {
    'classic rock': 0.96,
    rock: 0.9,
    pop: 0.82,
    'psychedelic rock': 0.76,
  },
  'the rolling stones': {
    'classic rock': 0.98,
    'blues rock': 0.86,
    rock: 0.92,
  },
  'led zeppelin': {
    'classic rock': 0.98,
    'hard rock': 0.94,
    'blues rock': 0.88,
  },
  'deep purple': {
    'hard rock': 0.96,
    'classic rock': 0.92,
    'heavy metal': 0.76,
  },
  'fleetwood mac': {
    'classic rock': 0.96,
    'soft rock': 0.88,
    'pop rock': 0.82,
  },
  'neil young': {
    'classic rock': 0.92,
    'folk rock': 0.9,
    folk: 0.82,
    country: 0.56,
  },
  'bob dylan': {
    folk: 0.95,
    'folk rock': 0.92,
    'classic rock': 0.86,
    americana: 0.78,
  },
  'the cure': {
    'post-punk': 0.94,
    'gothic rock': 0.9,
    'new wave': 0.86,
    'alternative rock': 0.78,
  },
  prince: {
    funk: 0.94,
    pop: 0.9,
    'r&b': 0.88,
    rock: 0.62,
  },
  'elton john': {
    'classic rock': 0.92,
    'pop rock': 0.88,
    'soft rock': 0.82,
    pop: 0.8,
  },
};

const SCENE_CROSSOVER_PRIORS: [string, string, number][] = [
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

  ['electronicore', 'metalcore', 0.83],
  ['electronicore', 'screamo', 0.72],
  ['electronicore', 'easycore', 0.68],
  ['electronicore', 'electronic', 0.58],

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
  ['pop punk', 'ska punk', 0.74],

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

  ['grunge', 'rock', 0.72],
  ['grunge', 'punk', 0.58],

  ['punk', 'punk rock', 0.92],
  ['punk', 'hardcore punk', 0.86],
  ['punk', 'skate punk', 0.88],
  ['punk', 'melodic hardcore', 0.82],
  ['punk', 'ska punk', 0.78],
  ['punk', 'rock', 0.62],
  ['punk rock', 'skate punk', 0.87],
  ['punk rock', 'hardcore punk', 0.81],
  ['punk rock', 'melodic hardcore', 0.82],
  ['punk rock', 'ska punk', 0.79],
  ['ska punk', 'ska', 0.88],
  ['hardcore punk', 'melodic hardcore', 0.85],

  ['metal', 'heavy metal', 0.91],
  ['metal', 'thrash metal', 0.85],
  ['metal', 'power metal', 0.82],
  ['metal', 'death metal', 0.82],
  ['metal', 'melodic death metal', 0.83],
  ['heavy metal', 'thrash metal', 0.84],
  ['heavy metal', 'power metal', 0.81],
  ['heavy metal', 'classic rock', 0.58],
  ['death metal', 'melodic death metal', 0.84],
  ['death metal', 'deathcore', 0.78],

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
  ['classic rock', 'folk rock', 0.76],
  ['classic rock', 'progressive rock', 0.72],
  ['classic rock', 'psychedelic rock', 0.74],
  ['classic rock', 'soft rock', 0.75],
  ['blues', 'blues rock', 0.86],

  ['hip hop', 'rap', 0.94],
  ['hip hop', 'gangsta rap', 0.88],
  ['hip hop', 'hardcore hip hop', 0.89],
  ['hip hop', 'boom bap', 0.87],
  ['hip hop', 'trap', 0.85],
  ['hip hop', 'r&b', 0.71],
  ['rap', 'gangsta rap', 0.9],
  ['rap', 'hardcore hip hop', 0.89],
  ['pop', 'pop rock', 0.78],
  ['pop', 'synthpop', 0.79],
  ['pop', 'indie pop', 0.76],
  ['pop', 'r&b', 0.67],
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

function round3(val: number): number {
  return Math.round(Math.max(0, Math.min(1, val)) * 1000) / 1000;
}

export function normalizeGenreTag(raw?: string | null): string | null {
  if (!raw) return null;
  let cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length < 2) return null;

  if (ID3V1_GENRE_CODES[cleaned]) {
    cleaned = ID3V1_GENRE_CODES[cleaned];
  } else if (/^\d+$/.test(cleaned)) {
    return null;
  }

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
    .split(/[;,/|]+/)
    .map((p) => normalizeGenreTag(p))
    .filter((p): p is string => Boolean(p));
  return Array.from(new Set(parts));
}

function resolveEffectiveLastfmWeight(options?: {
  useLastfm?: boolean;
  lastfmWeight?: number;
}): { effectiveWeight: number; hasApiKey: boolean } {
  const settings = getSettings();
  const hasApiKey = Boolean(settings.lastfmApiKey && settings.lastfmApiKey.trim().length > 0);
  const weightOverrideProvided = typeof options?.lastfmWeight === 'number' && Number.isFinite(options.lastfmWeight);

  if (!hasApiKey && !weightOverrideProvided) {
    return { effectiveWeight: 0, hasApiKey: false };
  }

  const useFlag =
    options?.useLastfm !== undefined
      ? options.useLastfm
      : weightOverrideProvided
      ? (options!.lastfmWeight as number) > 0
      : Boolean(settings.genreMapUseLastfm);

  if (!useFlag) {
    return { effectiveWeight: 0, hasApiKey };
  }

  const rawPct =
    weightOverrideProvided
      ? Number(options!.lastfmWeight)
      : Number(settings.genreMapLastfmWeight ?? 20);
  const clamped = Math.max(0, Math.min(1, (rawPct > 1 ? rawPct / 100 : rawPct) || 0));
  return { effectiveWeight: round3(clamped), hasApiKey };
}

export function ensureGenreMatrixReady(): void {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM subgenre_affinity_matrix').get() as { c: number };
  if (!row || row.c === 0) {
    rebuildGenreMatrix();
  }
}

/**
 * Indexes 100% of library artists and genres in `tracks` + `artist_affinity_cache` into
 * `artist_genre_weights`, then rebuilds the persistent N x N `subgenre_affinity_matrix`
 * using Method 1 (Ochiai + Multi-Artist Reinforcement) blended with Method 2 (Last.fm Graph).
 */
export function rebuildGenreMatrix(options: RebuildGenreMatrixOptions = {}): RebuildGenreMatrixResult {
  const start = Date.now();
  const db = getDb();

  if (options.resetStuckMetadata) {
    db.prepare('UPDATE tracks SET metadata_loaded = 0 WHERE metadata_loaded = -1').run();
  }

  const { effectiveWeight } = resolveEffectiveLastfmWeight({
    useLastfm: options.useLastfm,
    lastfmWeight: options.lastfmWeight,
  });

  // 1. Preserve user-locked matrix cells
  const lockedRows = db
    .prepare(
      'SELECT genre_x, genre_y FROM subgenre_affinity_matrix WHERE is_user_locked = 1'
    )
    .all() as { genre_x: string; genre_y: string }[];
  const lockedKeys = new Set<string>(lockedRows.map((r) => `${r.genre_x}|||${r.genre_y}`));

  // 2. Load Last.fm artist folksonomy tags & co-listening similarity edges
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
          const w = Math.max(0.15, Math.min(1.0, (Number(t.count) || 50) / 100));
          map.set(norm, Math.max(map.get(norm) || 0, w));
        }
      }
    } catch {
      // ignore
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

  // 3. Scan 100% of artists and genres across all tracks in SQLite (splitting ; , / |)
  const localRows = db
    .prepare(
      `SELECT LOWER(TRIM(artist)) as akey, genre, COUNT(*) as cnt
       FROM tracks
       WHERE COALESCE(TRIM(artist), '') != ''
       GROUP BY LOWER(TRIM(artist)), genre`
    )
    .all() as { akey: string; genre: string | null; cnt: number }[];

  const localCountsByArtist = new Map<string, { counts: Map<string, number>; taggedTracks: number }>();
  const allLibraryArtists = new Set<string>();

  for (const r of localRows) {
    const ak = normalizeArtistKey(r.akey);
    if (!ak) continue;
    allLibraryArtists.add(ak);
    const tokens = splitLocalGenreField(r.genre);
    if (tokens.length === 0) continue;

    let entry = localCountsByArtist.get(ak);
    if (!entry) {
      entry = { counts: new Map<string, number>(), taggedTracks: 0 };
      localCountsByArtist.set(ak, entry);
    }
    entry.taggedTracks += r.cnt;
    for (const tok of tokens) {
      entry.counts.set(tok, (entry.counts.get(tok) || 0) + r.cnt);
    }
  }

  // Weight ALL genres associated with each artist by share of tagged tracks
  for (const [ak, entry] of localCountsByArtist.entries()) {
    let map = artistTagWeights.get(ak);
    if (!map) {
      map = new Map<string, number>();
      artistTagWeights.set(ak, map);
    }
    const denom = Math.max(1, entry.taggedTracks);
    for (const [tag, cnt] of entry.counts.entries()) {
      const share = cnt / denom;
      const w = Math.max(0.15, Math.min(1.0, share));
      map.set(tag, Math.max(map.get(tag) || 0, w));
    }
  }

  // Ensure every library artist without hydrated tags checks artist-level fallback priors or is indexed as 'untagged'
  let taggedArtists = 0;
  for (const ak of allLibraryArtists) {
    let map = artistTagWeights.get(ak);
    if (!map) {
      map = new Map<string, number>();
      artistTagWeights.set(ak, map);
    }
    const nonGeneric = Array.from(map.keys()).filter((k) => k !== 'rock' && k !== 'pop' && k !== 'untagged');
    const curated = ARTIST_SCENE_FALLBACKS[ak] || ARTIST_SCENE_FALLBACKS[ak.replace(/\s*\(\d+\)$/, '')];
    if (nonGeneric.length === 0 && curated) {
      for (const [tag, weight] of Object.entries(curated)) {
        const norm = normalizeGenreTag(tag);
        if (norm) map.set(norm, Math.max(map.get(norm) || 0, weight));
      }
    }
    if (map.size === 0) {
      map.set('untagged', 0.1);
    } else {
      taggedArtists++;
    }
  }

  // Keep ALL normalized genres per artist (no fixed cap)
  const finalArtistVectors = new Map<string, [string, number][]>();
  const genreTotalWeight = new Map<string, number>();
  const genreArtistWeights = new Map<string, Map<string, number>>();
  const allRealGenresSet = new Set<string>();

  for (const [ak, tagMap] of artistTagWeights.entries()) {
    const entries = Array.from(tagMap.entries())
      .map(([tag, w]) => [tag, round3(w)] as [string, number])
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;

    finalArtistVectors.set(ak, entries);
    for (const [tag, w] of entries) {
      if (tag === 'untagged') continue;
      allRealGenresSet.add(tag);
      genreTotalWeight.set(tag, (genreTotalWeight.get(tag) || 0) + w);
      let ga = genreArtistWeights.get(tag);
      if (!ga) {
        ga = new Map<string, number>();
        genreArtistWeights.set(tag, ga);
      }
      ga.set(ak, w);
    }
  }

  const allGenres = Array.from(allRealGenresSet).sort((a, b) => a.localeCompare(b));

  // 4. Method 2 (Last.fm Graph): compute empirical genre-to-genre Last.fm transition density
  const edgeBridgeWeights = new Map<string, number>();
  const genreOutWeight = new Map<string, number>();
  for (const [ak, sims] of similarGraphEdges.entries()) {
    const srcTags = finalArtistVectors.get(ak)?.filter(([t]) => t !== 'untagged');
    if (!srcTags || srcTags.length === 0) continue;
    for (const sim of sims.slice(0, 25)) {
      const dstKey = normalizeArtistKey(sim.name);
      const dstTags = finalArtistVectors.get(dstKey)?.filter(([t]) => t !== 'untagged');
      if (!dstTags || dstTags.length === 0) continue;
      const edgeMatch = Math.max(0.1, Number(sim.match) || 0.5);
      for (const [gx, wx] of srcTags) {
        for (const [gy, wy] of dstTags) {
          const contrib = edgeMatch * wx * wy;
          const k = `${gx}|||${gy}`;
          edgeBridgeWeights.set(k, (edgeBridgeWeights.get(k) || 0) + contrib);
          genreOutWeight.set(gx, (genreOutWeight.get(gx) || 0) + contrib);
        }
      }
    }
  }

  // 5. Compute sparse NxN subgenre similarity cells using Method 1 + Method 2
  const nowSec = Math.floor(Date.now() / 1000);
  const cellsToWrite: [string, string, number][] = [];

  for (let i = 0; i < allGenres.length; i++) {
    const gx = allGenres[i];
    if (!lockedKeys.has(`${gx}|||${gx}`)) {
      cellsToWrite.push([gx, gx, 1.0]);
    }

    const vecX = genreArtistWeights.get(gx);
    const totalX = genreTotalWeight.get(gx) || 0;

    for (let j = i + 1; j < allGenres.length; j++) {
      const gy = allGenres[j];
      const vecY = genreArtistWeights.get(gy);
      const totalY = genreTotalWeight.get(gy) || 0;

      // Method 1: Weighted Ochiai Co-occurrence * Multi-Artist Reinforcement Curve
      let sharedWeightedSum = 0;
      let sharedArtistCount = 0;
      if (vecX && vecY && totalX > 0 && totalY > 0) {
        const [smaller, larger] = vecX.size <= vecY.size ? [vecX, vecY] : [vecY, vecX];
        for (const [ak, w1] of smaller.entries()) {
          const w2 = larger.get(ak);
          if (w2) {
            sharedArtistCount++;
            sharedWeightedSum += Math.sqrt(w1 * w2);
          }
        }
      }
      const ochiaiSim =
        totalX > 0 && totalY > 0 ? sharedWeightedSum / (Math.sqrt(totalX) * Math.sqrt(totalY)) : 0;
      const supportBoost =
        sharedArtistCount > 0 ? sharedArtistCount / (sharedArtistCount + 3.0) : 0;
      const empiricalLocal = Math.min(1.0, ochiaiSim * supportBoost * 1.45);
      const prior = getScenePrior(gx, gy);

      let localSim: number;
      if (sharedArtistCount >= 4) {
        localSim = prior !== null ? empiricalLocal * 0.72 + prior * 0.28 : empiricalLocal;
      } else if (sharedArtistCount > 0) {
        localSim = prior !== null ? empiricalLocal * 0.45 + prior * 0.55 : empiricalLocal;
      } else {
        localSim = prior !== null ? prior * 0.85 : 0;
      }

      // Method 2: Last.fm Graph Genre Bridge (0.000 - 1.000)
      const outX = genreOutWeight.get(gx) || 0;
      const outY = genreOutWeight.get(gy) || 0;
      const rawBridgeXY = outX > 0 ? (edgeBridgeWeights.get(`${gx}|||${gy}`) || 0) / outX : 0;
      const rawBridgeYX = outY > 0 ? (edgeBridgeWeights.get(`${gy}|||${gx}`) || 0) / outY : 0;
      const lastfmGenreSim =
        outX > 0 || outY > 0
          ? Math.min(1.0, Math.sqrt(Math.max(rawBridgeXY, rawBridgeYX)) * 1.2)
          : 0;

      const combined = round3((1 - effectiveWeight) * localSim + effectiveWeight * lastfmGenreSim);
      if (combined < 0.01) continue;

      if (!lockedKeys.has(`${gx}|||${gy}`)) {
        cellsToWrite.push([gx, gy, combined]);
      }
      if (!lockedKeys.has(`${gy}|||${gx}`)) {
        cellsToWrite.push([gy, gx, combined]);
      }
    }
  }

  // 6. Persist `artist_genre_weights` + `subgenre_affinity_matrix` in one fast SQLite transaction
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
    `Rebuilt Full-Library Genre Map: ${allGenres.length} genres, ${cellsToWrite.length} cells across ${finalArtistVectors.size} library artists (Last.fm weight ${Math.round(effectiveWeight * 100)}%).`,
    {
      artistsWeighted: finalArtistVectors.size,
      totalLibraryArtists: allLibraryArtists.size,
      taggedArtists,
      genresIndexed: allGenres.length,
      cellsStored: cellsToWrite.length,
      lockedCellsPreserved: lockedRows.length,
      effectiveLastfmWeight: effectiveWeight,
    },
    elapsedMs
  );

  return {
    artistsWeighted: finalArtistVectors.size,
    totalLibraryArtists: allLibraryArtists.size,
    taggedArtists,
    genresIndexed: allGenres.length,
    cellsStored: cellsToWrite.length,
    lockedCellsPreserved: lockedRows.length,
    effectiveLastfmWeight: effectiveWeight,
    elapsedMs,
  };
}

interface GenreComputationContext {
  displayNames: Map<string, string>;
  weightsByArtist: Map<string, { tag: string; weight: number }[]>;
  matrixLookup: Map<string, number>;
  artistNorms: Map<string, number>;
  lastfmSimLookup: Map<string, number>;
}

function buildGenreComputationContext(): GenreComputationContext {
  ensureGenreMatrixReady();
  const db = getDb();

  const artistNameRows = db
    .prepare(
      `SELECT LOWER(TRIM(artist)) as akey, MIN(artist) as displayName
       FROM tracks
       WHERE COALESCE(TRIM(artist), '') != ''
       GROUP BY LOWER(TRIM(artist))`
    )
    .all() as { akey: string; displayName: string }[];
  const displayNames = new Map<string, string>();
  for (const r of artistNameRows) {
    displayNames.set(normalizeArtistKey(r.akey), r.displayName);
  }

  const weightRows = db
    .prepare('SELECT artist_key, genre_tag, weight FROM artist_genre_weights ORDER BY weight DESC')
    .all() as { artist_key: string; genre_tag: string; weight: number }[];
  const weightsByArtist = new Map<string, { tag: string; weight: number }[]>();
  for (const w of weightRows) {
    let arr = weightsByArtist.get(w.artist_key);
    if (!arr) {
      arr = [];
      weightsByArtist.set(w.artist_key, arr);
    }
    if (w.genre_tag !== 'untagged') {
      arr.push({ tag: w.genre_tag, weight: w.weight });
    }
  }

  const matrixRows = db
    .prepare('SELECT genre_x, genre_y, similarity FROM subgenre_affinity_matrix')
    .all() as { genre_x: string; genre_y: string; similarity: number }[];
  const matrixLookup = new Map<string, number>();
  for (const m of matrixRows) {
    matrixLookup.set(`${m.genre_x}|||${m.genre_y}`, m.similarity);
  }

  const artistNorms = new Map<string, number>();

  const lastfmSimLookup = new Map<string, number>();
  const affRows = db
    .prepare('SELECT artist_key, similar_artists_json FROM artist_affinity_cache')
    .all() as { artist_key: string; similar_artists_json: string }[];
  for (const r of affRows) {
    try {
      const sims = JSON.parse(r.similar_artists_json) as SimilarArtistEntry[];
      for (const s of sims) {
        const dk = normalizeArtistKey(s.name);
        if (!dk) continue;
        const m = round3(Number(s.match) || 0);
        const k1 = `${r.artist_key}|||${dk}`;
        const k2 = `${dk}|||${r.artist_key}`;
        if ((lastfmSimLookup.get(k1) || 0) < m) lastfmSimLookup.set(k1, m);
        if ((lastfmSimLookup.get(k2) || 0) < m) lastfmSimLookup.set(k2, m);
      }
    } catch {
      // ignore
    }
  }

  return { displayNames, weightsByArtist, matrixLookup, artistNorms, lastfmSimLookup };
}

function scoreArtistAgainstTargetInContext(
  ctx: GenreComputationContext,
  artistKey: string,
  targetGenre: string
): {
  score: number;
  topTags: { tag: string; weight: number; matrixSim: number; contribution: number }[];
} {
  const vec = ctx.weightsByArtist.get(artistKey) || [];
  if (vec.length === 0) return { score: 0, topTags: [] };

  const breakdown = vec.map(({ tag, weight }) => {
    const matrixSim =
      tag === targetGenre
        ? 1.0
        : ctx.matrixLookup.get(`${tag}|||${targetGenre}`) ?? getScenePrior(tag, targetGenre) ?? 0;
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
  return { score, topTags: sorted };
}

function getArtistBilinearNorm(ctx: GenreComputationContext, ak: string): number {
  const cached = ctx.artistNorms.get(ak);
  if (cached !== undefined) return cached;
  const vec = ctx.weightsByArtist.get(ak);
  if (!vec || vec.length === 0) {
    ctx.artistNorms.set(ak, 0);
    return 0;
  }
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = vec[i];
    normSq += a.weight * a.weight;
    for (let j = i + 1; j < vec.length; j++) {
      const b = vec[j];
      const sim =
        a.tag === b.tag
          ? 1.0
          : ctx.matrixLookup.get(`${a.tag}|||${b.tag}`) ?? getScenePrior(a.tag, b.tag) ?? 0;
      normSq += 2 * a.weight * b.weight * sim;
    }
  }
  const norm = Math.sqrt(Math.max(0, normSq));
  ctx.artistNorms.set(ak, norm);
  return norm;
}

function computeLocalArtistPairwiseScore(
  ctx: GenreComputationContext,
  akA: string,
  akB: string
): number {
  if (akA === akB) return 1.0;
  const vecA = ctx.weightsByArtist.get(akA);
  const vecB = ctx.weightsByArtist.get(akB);
  const normA = getArtistBilinearNorm(ctx, akA);
  const normB = getArtistBilinearNorm(ctx, akB);
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || normA <= 0 || normB <= 0) {
    return 0;
  }

  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    for (let j = 0; j < vecB.length; j++) {
      const b = vecB[j];
      const sim =
        a.tag === b.tag
          ? 1.0
          : ctx.matrixLookup.get(`${a.tag}|||${b.tag}`) ?? getScenePrior(a.tag, b.tag) ?? 0;
      if (sim > 0) {
        dot += a.weight * b.weight * sim;
      }
    }
  }
  return round3(Math.min(1.0, dot / (normA * normB)));
}

/**
 * Shared artist-filtering engine used by both the Read-Only Artist Similarity Map UI
 * and `eGenius` candidate expansion.
 */
export function getArtistsForGenre(
  targetGenreRaw: string,
  minThreshold = 0.55,
  ctx?: GenreComputationContext
): ArtistSliceEntry[] {
  const c = ctx || buildGenreComputationContext();
  const targetGenre = normalizeGenreTag(targetGenreRaw) || targetGenreRaw.trim().toLowerCase();
  const results: ArtistSliceEntry[] = [];

  for (const [ak, displayName] of c.displayNames.entries()) {
    const { score, topTags } = scoreArtistAgainstTargetInContext(c, ak, targetGenre);
    if (score >= minThreshold) {
      results.push({
        artistKey: ak,
        artistName: displayName,
        sceneScore: score,
        topTags: topTags.slice(0, 6).map((t) => ({ tag: t.tag, weight: t.weight })),
      });
    }
  }

  results.sort((a, b) => b.sceneScore - a.sceneScore || a.artistName.localeCompare(b.artistName));
  return results;
}

/**
 * Computes a genre-scoped, read-only M x M Artist Similarity Matrix purely in memory (< 20ms)
 * without persisting an artist-to-artist table in SQLite.
 */
export function computeGenreArtistSlice(options: {
  targetGenre: string;
  minThreshold?: number;
  artistFilter?: string;
  useLastfm?: boolean;
  lastfmWeight?: number;
  maxArtists?: number;
}): ArtistSimilaritySlicePayload {
  const start = Date.now();
  const ctx = buildGenreComputationContext();
  const targetGenre = normalizeGenreTag(options.targetGenre) || options.targetGenre.trim().toLowerCase();
  const minThreshold =
    typeof options.minThreshold === 'number' && Number.isFinite(options.minThreshold)
      ? round3(options.minThreshold)
      : 0.55;
  const maxArtists = Math.max(5, Math.min(220, options.maxArtists ?? 140));
  const { effectiveWeight, hasApiKey } = resolveEffectiveLastfmWeight({
    useLastfm: options.useLastfm,
    lastfmWeight: options.lastfmWeight,
  });

  let matched = getArtistsForGenre(targetGenre, minThreshold, ctx);
  const filterQ = (options.artistFilter || '').trim().toLowerCase();
  if (filterQ) {
    matched = matched.filter((a) => a.artistName.toLowerCase().includes(filterQ));
  }

  const totalMatchedArtists = matched.length;
  const artists = matched.slice(0, maxArtists);
  const m = artists.length;

  const localMatrix: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const lastfmMatrix: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const combinedMatrix: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));

  for (let i = 0; i < m; i++) {
    localMatrix[i][i] = 1.0;
    lastfmMatrix[i][i] = 1.0;
    combinedMatrix[i][i] = 1.0;

    const akI = artists[i].artistKey;
    for (let j = i + 1; j < m; j++) {
      const akJ = artists[j].artistKey;
      const localSim = computeLocalArtistPairwiseScore(ctx, akI, akJ);
      const lfmSim = ctx.lastfmSimLookup.get(`${akI}|||${akJ}`) || 0;
      const combined = round3((1 - effectiveWeight) * localSim + effectiveWeight * lfmSim);

      localMatrix[i][j] = localSim;
      localMatrix[j][i] = localSim;
      lastfmMatrix[i][j] = lfmSim;
      lastfmMatrix[j][i] = lfmSim;
      combinedMatrix[i][j] = combined;
      combinedMatrix[j][i] = combined;
    }
  }

  return {
    targetGenre,
    minThreshold,
    effectiveLastfmWeight: effectiveWeight,
    hasLastfmApiKey: hasApiKey,
    totalMatchedArtists,
    artists,
    localMatrix,
    lastfmMatrix,
    combinedMatrix,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Shared pairwise artist scorer used by `eGenius` for both Signal #1 (Artist Affinity 35%)
 * and Signal #2 (Subgenre Matrix Scene Score 25%).
 */
export function createSharedArtistScorer(options?: { useLastfm?: boolean; lastfmWeight?: number }) {
  const ctx = buildGenreComputationContext();
  const { effectiveWeight } = resolveEffectiveLastfmWeight(options);

  return {
    effectiveLastfmWeight: effectiveWeight,
    getArtistGenres(artistName: string): { tag: string; weight: number }[] {
      return ctx.weightsByArtist.get(normalizeArtistKey(artistName)) || [];
    },
    getGenrePeers(targetGenre: string, minThreshold = 0.55): ArtistSliceEntry[] {
      return getArtistsForGenre(targetGenre, minThreshold, ctx);
    },
    scorePair(artistA: string, artistB: string): {
      localGenreSim: number;
      lastfmArtistSim: number;
      combinedArtistSim: number;
    } {
      const akA = normalizeArtistKey(artistA);
      const akB = normalizeArtistKey(artistB);
      if (akA && akB && akA === akB) {
        return { localGenreSim: 1.0, lastfmArtistSim: 1.0, combinedArtistSim: 1.0 };
      }
      const localGenreSim = computeLocalArtistPairwiseScore(ctx, akA, akB);
      const lastfmArtistSim = ctx.lastfmSimLookup.get(`${akA}|||${akB}`) || 0;
      const combinedArtistSim = round3(
        (1 - effectiveWeight) * localGenreSim + effectiveWeight * lastfmArtistSim
      );
      return { localGenreSim, lastfmArtistSim, combinedArtistSim };
    },
  };
}

export function getArtistSceneScore(
  artistNameOrKey: string,
  targetGenreRaw: string,
  _fallbackGenre?: string | null
): ArtistSceneScoreResult {
  const ctx = buildGenreComputationContext();
  const targetGenre = normalizeGenreTag(targetGenreRaw) || targetGenreRaw.trim().toLowerCase();
  const ak = normalizeArtistKey(artistNameOrKey);
  const { score, topTags } = scoreArtistAgainstTargetInContext(ctx, ak, targetGenre);
  return {
    artistName: ctx.displayNames.get(ak) || artistNameOrKey,
    artistKey: ak,
    targetGenre,
    score,
    topTags: topTags.slice(0, 5),
  };
}

export function computeArtistSceneSimilarity(artistA: string, artistB: string): number {
  const ctx = buildGenreComputationContext();
  return computeLocalArtistPairwiseScore(
    ctx,
    normalizeArtistKey(artistA),
    normalizeArtistKey(artistB)
  );
}

export function getGenreMatrixData(options: { search?: string; limit?: number } = {}): GenreMatrixPayload {
  ensureGenreMatrixReady();
  const db = getDb();
  const settings = getSettings();
  const hasLastfmApiKey = Boolean(settings.lastfmApiKey && settings.lastfmApiKey.trim().length > 0);
  const genreMapUseLastfm = hasLastfmApiKey ? Boolean(settings.genreMapUseLastfm) : false;
  const genreMapLastfmWeight = Number(settings.genreMapLastfmWeight ?? 20);

  const q = (options.search || '').trim().toLowerCase();

  const summaryRows = db
    .prepare(
      `SELECT genre_tag as genre, COUNT(DISTINCT artist_key) as artistCount, SUM(weight) as totalWeight
       FROM artist_genre_weights
       WHERE genre_tag != 'untagged'
       GROUP BY genre_tag
       ORDER BY totalWeight DESC, artistCount DESC`
    )
    .all() as MatrixGenreSummary[];

  const matrixGenresRows = db
    .prepare('SELECT DISTINCT genre_x as genre FROM subgenre_affinity_matrix ORDER BY genre_x ASC')
    .all() as { genre: string }[];

  const summaryByGenre = new Map(summaryRows.map((r) => [r.genre, r]));
  for (const mg of matrixGenresRows) {
    if (mg.genre === 'untagged') continue;
    if (!summaryByGenre.has(mg.genre)) {
      summaryByGenre.set(mg.genre, { genre: mg.genre, artistCount: 0, totalWeight: 0.1 });
    }
  }

  let genres = Array.from(summaryByGenre.values()).sort(
    (a, b) => b.totalWeight - a.totalWeight || b.artistCount - a.artistCount
  );
  const totalGenresIndexed = genres.length;
  if (q) {
    genres = genres.filter((g) => g.genre.toLowerCase().includes(q));
  }
  if (options.limit && options.limit > 0) {
    genres = genres.slice(0, options.limit);
  }

  const genreNames = genres.map((g) => g.genre);
  let cells: MatrixCell[] = [];
  if (genreNames.length > 0) {
    if (!q && (!options.limit || options.limit >= totalGenresIndexed)) {
      const rows = db
        .prepare(
          'SELECT genre_x, genre_y, similarity, is_user_locked, updated_at FROM subgenre_affinity_matrix'
        )
        .all() as {
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
    } else {
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
  }

  const stats = db
    .prepare(
      `SELECT
        (SELECT COUNT(DISTINCT artist_key) FROM artist_genre_weights) as aCount,
        (SELECT COUNT(DISTINCT LOWER(TRIM(artist))) FROM tracks WHERE COALESCE(TRIM(artist), '') != '') as libArtists,
        (SELECT COUNT(*) FROM subgenre_affinity_matrix) as cCount`
    )
    .get() as { aCount: number; libArtists: number; cCount: number };

  return {
    genres,
    cells,
    totalArtistsWeighted: stats.aCount || 0,
    totalLibraryArtists: stats.libArtists || 0,
    totalGenresIndexed,
    totalCellsStored: stats.cCount || 0,
    hasLastfmApiKey,
    genreMapUseLastfm,
    genreMapLastfmWeight,
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
       SELECT genre_tag as g FROM artist_genre_weights WHERE genre_tag != 'untagged'
       ORDER BY g ASC`
    )
    .all() as { g: string }[];
  return rows.map((r) => r.g).filter(Boolean);
}

export function testArtistsAgainstGenre(
  targetGenreRaw: string,
  options: { artistQuery?: string; minScore?: number; limit?: number } = {}
): ArtistSceneScoreResult[] {
  const ctx = buildGenreComputationContext();
  const targetGenre = normalizeGenreTag(targetGenreRaw) || targetGenreRaw.trim().toLowerCase();
  const q = (options.artistQuery || '').trim().toLowerCase();
  const minScore = options.minScore ?? 0;
  const limit = Math.max(1, Math.min(250, options.limit ?? 50));

  const results: ArtistSceneScoreResult[] = [];
  for (const [ak, displayName] of ctx.displayNames.entries()) {
    if (q && !displayName.toLowerCase().includes(q) && !ak.includes(q)) continue;
    const { score, topTags } = scoreArtistAgainstTargetInContext(ctx, ak, targetGenre);
    if (score >= minScore || q) {
      results.push({
        artistName: displayName,
        artistKey: ak,
        targetGenre,
        score,
        topTags: topTags.slice(0, 5),
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.artistName.localeCompare(b.artistName));
  return results.slice(0, limit);
}

export function getMatchingArtistsForSceneFilter(
  targetGenreRaw: string,
  operator: string,
  value: number,
  valueTo?: number
): { matchedArtistsLower: string[]; isNegated: boolean } {
  const ctx = buildGenreComputationContext();
  const targetGenre = normalizeGenreTag(targetGenreRaw) || targetGenreRaw.trim().toLowerCase();

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

  if ((operator === 'lte' || operator === 'lt') && threshold < 0.5) {
    const excluded: string[] = [];
    for (const ak of ctx.displayNames.keys()) {
      const { score } = scoreArtistAgainstTargetInContext(ctx, ak, targetGenre);
      if ((operator === 'lte' && score > threshold) || (operator === 'lt' && score >= threshold)) {
        excluded.push(ak);
      }
    }
    return { matchedArtistsLower: excluded, isNegated: true };
  }

  const matched: string[] = [];
  for (const ak of ctx.displayNames.keys()) {
    const { score } = scoreArtistAgainstTargetInContext(ctx, ak, targetGenre);
    if (evalOp(score)) {
      matched.push(ak);
    }
  }
  return { matchedArtistsLower: matched, isNegated: false };
}
