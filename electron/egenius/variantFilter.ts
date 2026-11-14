import { TrackRow } from '../db';
import { VariantType } from './types';

const INSTRUMENTAL_RE = /(\((?:[^)]*\b)?instrumental(?:\b[^)]*)?\)|-\s*instrumental\b|\binstrumental\s+version\b|\[(?:[^\]]*\b)?instrumental(?:\b[^\]]*)?\])/i;
const ACOUSTIC_RE = /(\((?:[^)]*\b)?(?:acoustic|unplugged)(?:\b[^)]*)?\)|-\s*(?:acoustic|unplugged)\b|\bacoustic\s+version\b|\[(?:[^\]]*\b)?(?:acoustic|unplugged)(?:\b[^\]]*)?\])/i;
const LIVE_RE = /(\((?:[^)]*\b)?(?:live(?:\s+(?:at|from|in|on))?|bootleg)(?:\b[^)]*)?\)|-\s*live\b|\blive\s+(?:at|from)\b|\[(?:[^\]]*\b)?live(?:\b[^\]]*)?\])/i;
const REMIX_DEMO_RE = /(\((?:[^)]*\b)?(?:remix|demo|commentary|radio\s+edit|karaoke|a\s*cappella|acapella)(?:\b[^)]*)?\)|-\s*(?:remix|demo|commentary)\b|\[(?:[^\]]*\b)?(?:remix|demo|commentary)(?:\b[^\]]*)?\])/i;
const SKIT_TITLE_RE = /^(?:intro|outro|interlude|skit|prelude|reprise)\b|(?:\((?:intro|outro|interlude|skit)\))$/i;

export function classifyVariant(
  track: Pick<TrackRow, 'title' | 'album' | 'genre' | 'duration'>
): VariantType {
  const title = track.title || '';
  const album = track.album || '';
  const genre = track.genre || '';
  const combined = `${title} ${album}`;

  if (SKIT_TITLE_RE.test(title.trim())) {
    return 'skit';
  }
  if (INSTRUMENTAL_RE.test(combined) || /\binstrumental\b/i.test(genre)) {
    return 'instrumental';
  }
  if (ACOUSTIC_RE.test(combined)) {
    return 'acoustic';
  }
  if (LIVE_RE.test(combined)) {
    return 'live';
  }
  if (REMIX_DEMO_RE.test(combined)) {
    return 'remix_demo';
  }
  return 'studio_vocal';
}

export function isInterludeOrSkit(track: Pick<TrackRow, 'title' | 'duration'>): boolean {
  if (SKIT_TITLE_RE.test((track.title || '').trim())) return true;
  if (track.duration > 0 && track.duration < 90) return true;
  return false;
}

export function evaluateVariantParity(
  seedVariant: VariantType,
  seedDuration: number,
  candidate: TrackRow
): {
  candidateVariant: VariantType;
  variantScore: number;
  parityMultiplier: number;
  excluded: boolean;
  reason: string;
} {
  const candidateVariant = classifyVariant(candidate);
  const seedIsShort = seedDuration > 0 && seedDuration < 90;

  if (!seedIsShort && (candidateVariant === 'skit' || isInterludeOrSkit(candidate))) {
    return {
      candidateVariant,
      variantScore: 0,
      parityMultiplier: 0,
      excluded: true,
      reason: 'Excluded short interlude/skit (<90s)',
    };
  }

  if (seedVariant === 'studio_vocal') {
    if (candidateVariant === 'studio_vocal') {
      return {
        candidateVariant,
        variantScore: 1,
        parityMultiplier: 1,
        excluded: false,
        reason: 'Studio vocal parity match',
      };
    }
    return {
      candidateVariant,
      variantScore: 0.05,
      parityMultiplier: 0.05,
      excluded: true,
      reason: `Penalized ${candidateVariant} vs studio_vocal seed (-95%)`,
    };
  }

  if (candidateVariant === seedVariant) {
    return {
      candidateVariant,
      variantScore: 1,
      parityMultiplier: 1.15,
      excluded: false,
      reason: `Matched ${seedVariant} variant`,
    };
  }

  return {
    candidateVariant,
    variantScore: 0.35,
    parityMultiplier: 0.45,
    excluded: false,
    reason: `Variant mismatch (${candidateVariant} vs ${seedVariant})`,
  };
}
