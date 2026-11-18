import { getCacheDb, TrackRow } from '../db';
import { getSettings } from '../settings';
import { logger } from '../logger';
import {
  ArtistAffinityRecord,
  SimilarArtistEntry,
  SimilarTrackEntry,
  TagWeight,
  TrackAffinityRecord,
} from './types';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FETCH_TIMEOUT_MS = 3500;

export function normalizeArtistKey(artist: string): string {
  return (artist || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeTrackKey(track: Pick<TrackRow, 'mbid_recording' | 'artist' | 'title'>): string {
  if (track.mbid_recording && track.mbid_recording.trim()) {
    return track.mbid_recording.trim().toLowerCase();
  }
  return `${normalizeArtistKey(track.artist)}::${(track.title || '').trim().toLowerCase()}`;
}

async function fetchJsonWithTimeout(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function readCachedArtistAffinity(artistName: string): ArtistAffinityRecord | null {
  const key = normalizeArtistKey(artistName);
  if (!key) return null;
  const db = getCacheDb();
  const row = db
    .prepare(
      'SELECT artist_key, artist_name, similar_artists_json, top_tags_json, updated_at FROM artist_affinity_cache WHERE artist_key = ?'
    )
    .get(key) as
    | {
        artist_key: string;
        artist_name: string;
        similar_artists_json: string;
        top_tags_json: string;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.updated_at > CACHE_TTL_MS) return null;

  try {
    return {
      artistKey: row.artist_key,
      artistName: row.artist_name,
      similarArtists: JSON.parse(row.similar_artists_json) as SimilarArtistEntry[],
      topTags: JSON.parse(row.top_tags_json) as TagWeight[],
      updatedAt: row.updated_at,
      fromCache: true,
    };
  } catch {
    return null;
  }
}

export function writeCachedArtistAffinity(record: Omit<ArtistAffinityRecord, 'fromCache'>): void {
  const db = getCacheDb();
  db.prepare(
    `INSERT OR REPLACE INTO artist_affinity_cache
       (artist_key, artist_name, similar_artists_json, top_tags_json, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    record.artistKey,
    record.artistName,
    JSON.stringify(record.similarArtists),
    JSON.stringify(record.topTags),
    record.updatedAt
  );
}

export async function resolveArtistAffinity(
  artistName: string,
  options: { offlineOnly?: boolean } = {}
): Promise<ArtistAffinityRecord> {
  const key = normalizeArtistKey(artistName);
  const cached = readCachedArtistAffinity(artistName);
  if (cached) return cached;

  const settings = getSettings();
  const apiKey = settings.lastfmApiKey?.trim();
  const similarArtists: SimilarArtistEntry[] = [];
  const topTags: TagWeight[] = [];

  if (!options.offlineOnly && apiKey && key) {
    const simUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&artist=${encodeURIComponent(
      artistName
    )}&limit=35&autocorrect=1&api_key=${encodeURIComponent(apiKey)}&format=json`;
    const tagUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopTags&artist=${encodeURIComponent(
      artistName
    )}&autocorrect=1&api_key=${encodeURIComponent(apiKey)}&format=json`;

    const [simData, tagData] = await Promise.all([
      fetchJsonWithTimeout(simUrl),
      fetchJsonWithTimeout(tagUrl),
    ]);

    for (const item of simData?.similarartists?.artist || []) {
      if (item?.name) {
        similarArtists.push({
          name: String(item.name),
          match: Math.max(0, Math.min(1, Number(item.match) || 0.5)),
          mbid: item.mbid ? String(item.mbid) : undefined,
        });
      }
    }

    for (const item of tagData?.toptags?.tag || []) {
      if (item?.name) {
        const tagName = String(item.name).trim().toLowerCase();
        if (tagName && tagName !== 'seen live') {
          topTags.push({
            name: tagName,
            count: Math.max(1, Math.min(100, Number(item.count) || 50)),
          });
        }
      }
      if (topTags.length >= 15) break;
    }

    if (similarArtists.length > 0 || topTags.length > 0) {
      const now = Date.now();
      writeCachedArtistAffinity({
        artistKey: key,
        artistName,
        similarArtists,
        topTags,
        updatedAt: now,
      });
      return {
        artistKey: key,
        artistName,
        similarArtists,
        topTags,
        updatedAt: now,
        fromCache: false,
      };
    }
  }

  return {
    artistKey: key,
    artistName,
    similarArtists,
    topTags,
    updatedAt: Date.now(),
    fromCache: false,
  };
}

export function readCachedTrackAffinity(
  track: Pick<TrackRow, 'mbid_recording' | 'artist' | 'title'>
): TrackAffinityRecord | null {
  const key = normalizeTrackKey(track);
  const db = getCacheDb();
  const row = db
    .prepare(
      'SELECT track_mbid_or_key, similar_tracks_json, updated_at FROM track_affinity_cache WHERE track_mbid_or_key = ?'
    )
    .get(key) as
    | {
        track_mbid_or_key: string;
        similar_tracks_json: string;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.updated_at > CACHE_TTL_MS) return null;

  try {
    return {
      trackKey: row.track_mbid_or_key,
      similarTracks: JSON.parse(row.similar_tracks_json) as SimilarTrackEntry[],
      updatedAt: row.updated_at,
      fromCache: true,
    };
  } catch {
    return null;
  }
}

export async function resolveTrackAffinity(
  track: Pick<TrackRow, 'mbid_recording' | 'artist' | 'title'>,
  options: { offlineOnly?: boolean } = {}
): Promise<TrackAffinityRecord> {
  const key = normalizeTrackKey(track);
  const cached = readCachedTrackAffinity(track);
  if (cached) return cached;

  const settings = getSettings();
  const apiKey = settings.lastfmApiKey?.trim();
  const similarTracks: SimilarTrackEntry[] = [];

  if (!options.offlineOnly && apiKey && track.artist && track.title) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getSimilar&artist=${encodeURIComponent(
      track.artist
    )}&track=${encodeURIComponent(track.title)}&limit=40&autocorrect=1&api_key=${encodeURIComponent(
      apiKey
    )}&format=json`;
    const data = await fetchJsonWithTimeout(url);
    for (const item of data?.similartracks?.track || []) {
      if (item?.name && item?.artist?.name) {
        similarTracks.push({
          artist: String(item.artist.name),
          title: String(item.name),
          match: Math.max(0, Math.min(1, Number(item.match) || 0.5)),
          mbid: item.mbid ? String(item.mbid) : undefined,
        });
      }
    }

    if (similarTracks.length > 0) {
      const now = Date.now();
      const db = getCacheDb();
      db.prepare(
        `INSERT OR REPLACE INTO track_affinity_cache
           (track_mbid_or_key, similar_tracks_json, updated_at)
         VALUES (?, ?, ?)`
      ).run(key, JSON.stringify(similarTracks), now);

      return {
        trackKey: key,
        similarTracks,
        updatedAt: now,
        fromCache: false,
      };
    }
  }

  return {
    trackKey: key,
    similarTracks,
    updatedAt: Date.now(),
    fromCache: false,
  };
}

export async function warmHop1Affinities(
  artistNames: string[],
  options: { offlineOnly?: boolean } = {}
): Promise<ArtistAffinityRecord[]> {
  if (options.offlineOnly) {
    return artistNames
      .map((a) => readCachedArtistAffinity(a))
      .filter((r): r is ArtistAffinityRecord => Boolean(r));
  }

  const results: ArtistAffinityRecord[] = [];
  const toFetch = artistNames.slice(0, 4);
  try {
    const settled = await Promise.all(
      toFetch.map((name) => resolveArtistAffinity(name, options))
    );
    results.push(...settled);
  } catch (err) {
    logger.debug('SYSTEM', 'eGenius Hop-1 affinity warm partial failure', { error: String(err) });
  }
  return results;
}
