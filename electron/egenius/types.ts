import { TrackRow } from '../db';

export type VariantType =
  | 'studio_vocal'
  | 'instrumental'
  | 'acoustic'
  | 'live'
  | 'remix_demo'
  | 'skit';

export type MixDepthMode = 'hits' | 'balanced' | 'deep';

export interface SimilarArtistEntry {
  name: string;
  match: number; // 0..1
  mbid?: string;
}

export interface TagWeight {
  name: string;
  count: number; // 0..100 normalized
}

export interface SimilarTrackEntry {
  artist: string;
  title: string;
  match: number; // 0..1
  mbid?: string;
}

export interface ArtistAffinityRecord {
  artistKey: string;
  artistName: string;
  similarArtists: SimilarArtistEntry[];
  topTags: TagWeight[];
  updatedAt: number;
  fromCache: boolean;
}

export interface TrackAffinityRecord {
  trackKey: string;
  similarTracks: SimilarTrackEntry[];
  updatedAt: number;
  fromCache: boolean;
}

export interface MixRequest {
  seedTrackId: number;
  limit?: 25 | 50;
  mode?: MixDepthMode;
  sceneThreshold?: number;
  excludeTrackIds?: number[];
  offlineOnly?: boolean;
}

export interface ScoreBreakdown {
  graphScore: number;       // 0..1 (35% weight)
  tagScore: number;         // 0..1 (25% weight)
  eraScore: number;         // 0..1 (15% weight)
  relDepthScore: number;    // 0..1 (15% weight)
  variantScore: number;     // 0..1 (10% weight)
  compositeScore: number;   // weighted total after variant parity multiplier
  hopLevel: 0 | 1 | 2;      // 0 = local/era fallback, 1 = Hop-1 direct, 2 = Hop-2 bridge
  variantType: VariantType;
  reasons: string[];
}

export interface ScoredCandidate {
  track: TrackRow;
  breakdown: ScoreBreakdown;
}

export interface MixResult {
  seedTrack: TrackRow;
  seedVariant: VariantType;
  mode: MixDepthMode;
  sceneThreshold: number;
  limit: 25 | 50;
  tracks: TrackRow[];
  scored: ScoredCandidate[];
  distinctArtists: number;
  hop1Count: number;
  hop2Count: number;
  cacheHit: boolean;
  elapsedMs: number;
}

export interface TrackExplanation {
  seedTrack: TrackRow;
  candidateTrack: TrackRow;
  breakdown: ScoreBreakdown;
}
