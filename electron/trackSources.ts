import fs from 'fs';
import path from 'path';

export interface TrackAlternateSource {
  path: string;
  format?: string;
  bitrate?: number;
  file_size?: number;
  duration?: number;
}

const LOSSLESS_FORMATS = new Set(['FLAC', 'ALAC', 'WAV', 'AIFF', 'AIF', 'APE', 'WV', 'DSF', 'DFF']);
const MODERN_LOSSY_FORMATS = new Set(['M4A', 'AAC', 'OPUS', 'OGG']);

/**
 * Deterministic audio quality ranker used to pick the preferred primary source
 * when multiple files/paths exist for the same track.
 * Lossless > high-bitrate modern lossy > MP3/WMA > unknown, tie-broken by bitrate & file size.
 */
export function scoreAudioQuality(
  format?: string | null,
  bitrate?: number | null,
  fileSize?: number | null
): number {
  const fmt = (format || '').trim().toUpperCase();
  const br = Math.max(0, Number(bitrate) || 0);
  const sizeTie = Math.min(999, Math.floor(Math.max(0, Number(fileSize) || 0) / 100_000));

  let base = 1000;
  if (LOSSLESS_FORMATS.has(fmt)) {
    base = fmt === 'FLAC' || fmt === 'ALAC' ? 10_500 : 10_200;
  } else if (MODERN_LOSSY_FORMATS.has(fmt)) {
    base = 5000 + Math.min(br, 2000);
  } else if (fmt === 'MP3' || fmt === 'WMA') {
    base = 4000 + Math.min(br, 2000);
  } else if (fmt) {
    base = 3000 + Math.min(br, 2000);
  }

  return base * 1000 + sizeTie;
}

export function parseAlternateSources(raw?: string | null): TrackAlternateSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: TrackAlternateSource[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim()) {
        if (!seen.has(item)) {
          seen.add(item);
          out.push({ path: item });
        }
      } else if (item && typeof item === 'object' && typeof item.path === 'string' && item.path.trim()) {
        if (!seen.has(item.path)) {
          seen.add(item.path);
          out.push({
            path: item.path,
            format: typeof item.format === 'string' ? item.format : undefined,
            bitrate: typeof item.bitrate === 'number' ? item.bitrate : undefined,
            file_size: typeof item.file_size === 'number' ? item.file_size : undefined,
            duration: typeof item.duration === 'number' ? item.duration : undefined,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeAlternateSources(
  sources: TrackAlternateSource[],
  excludePrimaryPath?: string
): string {
  const seen = new Set<string>();
  if (excludePrimaryPath) seen.add(excludePrimaryPath);
  const filtered: TrackAlternateSource[] = [];
  for (const s of sources) {
    if (!s.path || seen.has(s.path)) continue;
    seen.add(s.path);
    filtered.push(s);
  }
  return JSON.stringify(filtered);
}

/**
 * Strips OS/share mount prefixes (/Volumes/<share>/, .../RetroTunes/mounts/<share>/, X:/)
 * to detect when two paths refer to the exact same file on the same share mounted twice.
 */
export function extractCanonicalMediaSubpath(fullPath: string): string | null {
  if (!fullPath) return null;
  const posix = fullPath.replace(/\\/g, '/');

  const retrotunesMount = posix.match(/\/RetroTunes(?:\s*\(rTunes\))?\/mounts\/[^/]+\/(.+)$/i);
  if (retrotunesMount?.[1]) {
    return retrotunesMount[1].replace(/^\/+/, '').toLowerCase();
  }

  const volumesMatch = posix.match(/^\/Volumes\/[^/]+\/(.+)$/i);
  if (volumesMatch?.[1]) {
    return volumesMatch[1].replace(/^\/+/, '').toLowerCase();
  }

  const mntMatch = posix.match(/^\/(?:mnt|media)\/[^/]+\/(.+)$/i);
  if (mntMatch?.[1]) {
    return mntMatch[1].replace(/^\/+/, '').toLowerCase();
  }

  const winDriveMatch = posix.match(/^[A-Za-z]:\/(.+)$/);
  if (winDriveMatch?.[1]) {
    return winDriveMatch[1].replace(/^\/+/, '').toLowerCase();
  }

  return null;
}

function normalizeMatchToken(value?: string | null): string {
  return (value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalized (artist, album, title) key for matching different format/quality copies
 * of the same track (e.g., FLAC vs MP3) across libraries or folders.
 */
export function buildTrackMatchKey(
  artist?: string | null,
  album?: string | null,
  title?: string | null
): string | null {
  const a = normalizeMatchToken(artist);
  const al = normalizeMatchToken(album);
  const t = normalizeMatchToken(title);
  if (!a || !t) return null;
  return `${a}|||${al}|||${t}`;
}

/**
 * Resolves the best currently-reachable path on disk for a track:
 * 1. local_cache_path (if cached & exists)
 * 2. remote_nfs_path (if exists)
 * 3. Highest-quality reachable path in alternate_paths
 * 4. Fallback to remote_nfs_path
 */
export function resolveReachableTrackPath(track: {
  remote_nfs_path: string;
  local_cache_path?: string | null;
  alternate_paths?: string | null;
}): string {
  if (track.local_cache_path && fs.existsSync(track.local_cache_path)) {
    return track.local_cache_path;
  }
  if (track.remote_nfs_path && fs.existsSync(track.remote_nfs_path)) {
    return track.remote_nfs_path;
  }
  const alts = parseAlternateSources(track.alternate_paths).sort(
    (a, b) => scoreAudioQuality(b.format, b.bitrate, b.file_size) - scoreAudioQuality(a.format, a.bitrate, a.file_size)
  );
  for (const alt of alts) {
    if (alt.path && fs.existsSync(alt.path)) {
      return alt.path;
    }
  }
  return track.remote_nfs_path;
}

export function inferFormatFromPath(filePath: string): string {
  return path.extname(filePath).replace('.', '').toUpperCase();
}
