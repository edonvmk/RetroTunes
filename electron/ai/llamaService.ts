import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { emitRendererEvent, getAppDataPath } from '../runtimeBus';
import { getDb, searchTracksFts, TrackRow } from '../db';
import { getSettings } from '../settings';
import { logger } from '../logger';
import { platformDriver } from '../platform';
import { evaluateSmartPlaylist, SmartRule, SmartRuleGroup } from '../smartPlaylists';
import {
  listAllMatrixGenres,
  normalizeGenreTag,
  testArtistsAgainstGenre,
} from '../egenius/genreMatrix';

export interface AiPrepareProgress {
  modelId: string;
  percent: number;
  phase: 'download' | 'load' | 'ready' | 'cancelled' | 'error';
  message: string;
}

export interface AiModelCacheStatus {
  modelId: string;
  cached: boolean;
  filePath: string;
  sizeBytes: number;
}

export type AgentTurnResult =
  | {
      type: 'followup';
      question: string;
      options: string[];
      assistantMessage?: string;
    }
  | {
      type: 'finalized';
      name: string;
      description: string;
      tracks: TrackRow[];
      assistantMessage?: string;
    }
  | {
      type: 'finalized_smart';
      name: string;
      description: string;
      smartRules: SmartRuleGroup;
      limitType: 'tracks' | 'minutes' | 'gb';
      limitValue: number | null;
      selectionMethod: string;
      previewTracks: TrackRow[];
      assistantMessage?: string;
    }
  | {
      type: 'message';
      message: string;
    };

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = any>(
  specifier: string
) => Promise<T>;

async function loadLlamaModule(): Promise<any> {
  try {
    const resolved = require.resolve('node-llama-cpp');
    return await dynamicImport(pathToFileURL(resolved).href);
  } catch {
    return await dynamicImport('node-llama-cpp');
  }
}

function getModelsManifestPath(): string {
  return path.join(getAiModelsDir(), 'models-manifest.json');
}

function readModelsManifest(): Record<string, string> {
  try {
    const p = getModelsManifestPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return {};
}

function saveModelManifestEntry(modelId: string, modelPath: string) {
  try {
    const manifest = readModelsManifest();
    manifest[modelId] = modelPath;
    fs.writeFileSync(getModelsManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

function resolveCachedModelPath(modelId: string, filename?: string): string | null {
  const manifest = readModelsManifest();
  const fromManifest = manifest[modelId];
  if (fromManifest && fs.existsSync(fromManifest)) {
    try {
      if (fs.statSync(fromManifest).size > 1024 * 1024) {
        return fromManifest;
      }
    } catch {
      // ignore
    }
  }
  if (filename) {
    const defaultPath = path.join(getAiModelsDir(), filename);
    if (fs.existsSync(defaultPath)) {
      try {
        if (fs.statSync(defaultPath).size > 1024 * 1024) {
          saveModelManifestEntry(modelId, defaultPath);
          return defaultPath;
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

let activeLlama: any = null;
let activeModel: any = null;
let activeContext: any = null;
let activeSession: any = null;
let activeAbortController: AbortController | null = null;
let activeDownloader: any = null;
let activeModelId: string | null = null;
let sessionCollectedTracks = new Map<number, TrackRow>();

export function getAiModelsDir(): string {
  let userData = '';
  try {
    userData = getAppDataPath();
  } catch {
    userData = platformDriver.getFallbackUserDataDir();
  }
  const modelsDir = path.join(userData, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  return modelsDir;
}

export function getAiModelCacheStatus(
  models: { id: string; filename?: string }[]
): AiModelCacheStatus[] {
  const modelsDir = getAiModelsDir();
  return models.map((m) => {
    const cachedPath = resolveCachedModelPath(m.id, m.filename);
    if (cachedPath) {
      try {
        const st = fs.statSync(cachedPath);
        return { modelId: m.id, cached: true, filePath: cachedPath, sizeBytes: st.size };
      } catch {
        // ignore
      }
    }
    const filePath = m.filename ? path.join(modelsDir, m.filename) : '';
    return { modelId: m.id, cached: false, filePath, sizeBytes: 0 };
  });
}

function broadcastPrepareProgress(progress: AiPrepareProgress) {
  emitRendererEvent('ai:prepare-progress', progress);
}

export async function disposeAiModel(): Promise<{ ok: boolean }> {
  try {
    sessionCollectedTracks.clear();
    if (activeSession) {
      activeSession = null;
    }
    if (activeContext) {
      await activeContext.dispose();
      activeContext = null;
    }
    if (activeModel) {
      await activeModel.dispose();
      activeModel = null;
    }
    activeModelId = null;
    logger.info('SYSTEM', 'Disposed AI Playlist Generator model & context.');
  } catch (err) {
    logger.warn('SYSTEM', 'Error disposing AI model/context', { error: String(err) });
  }
  return { ok: true };
}

export async function cancelPrepareAiModel(): Promise<{ ok: boolean }> {
  if (activeAbortController) {
    activeAbortController.abort();
  }
  try {
    if (activeDownloader && typeof activeDownloader.cancel === 'function') {
      await activeDownloader.cancel();
    }
  } catch {
    // ignore
  }
  await disposeAiModel();
  broadcastPrepareProgress({
    modelId: activeModelId || '',
    percent: 0,
    phase: 'cancelled',
    message: 'Cancelled by user.',
  });
  return { ok: true };
}

export async function prepareAiModel(params: {
  modelId: string;
  uri: string;
  filename: string;
  contextWindow?: number;
}): Promise<{ ok: boolean; modelPath: string }> {
  const { modelId, uri, filename, contextWindow = 32768 } = params;
  await disposeAiModel();

  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;
  activeModelId = modelId;

  const modelsDir = getAiModelsDir();
  let modelPath = path.join(modelsDir, filename);

  try {
    const llamaModule = await loadLlamaModule();
    const { getLlama, createModelDownloader } = llamaModule;

    // PHASE 1: 0% -> 50% (Download GGUF if missing; skip immediately to 50% if cached)
    const cachedPath = resolveCachedModelPath(modelId, filename);
    if (cachedPath) {
      modelPath = cachedPath;
      broadcastPrepareProgress({
        modelId,
        percent: 50,
        phase: 'load',
        message: 'Model found in local cache. Loading into memory...',
      });
    } else {
      broadcastPrepareProgress({
        modelId,
        percent: 1,
        phase: 'download',
        message: `Downloading ${filename} to ${modelsDir}...`,
      });

      const downloader = await createModelDownloader({
        modelUri: uri,
        dirPath: modelsDir,
        fileName: filename,
        skipExisting: true,
        deleteTempFileOnCancel: true,
        onProgress: ({ totalSize, downloadedSize }: { totalSize: number; downloadedSize: number }) => {
          if (signal.aborted) return;
          const ratio = totalSize > 0 ? Math.min(1, downloadedSize / totalSize) : 0;
          const pct = Math.max(1, Math.min(50, Math.round(ratio * 50)));
          const dlMb = (downloadedSize / (1024 * 1024)).toFixed(0);
          const totMb = totalSize > 0 ? (totalSize / (1024 * 1024)).toFixed(0) : '?';
          broadcastPrepareProgress({
            modelId,
            percent: pct,
            phase: 'download',
            message: `Downloading model weights (${dlMb} MB / ${totMb} MB)...`,
          });
        },
      });
      activeDownloader = downloader;
      modelPath = await downloader.download({ signal });
      activeDownloader = null;

      if (signal.aborted) {
        throw new Error('Download aborted');
      }

      saveModelManifestEntry(modelId, modelPath);

      broadcastPrepareProgress({
        modelId,
        percent: 50,
        phase: 'load',
        message: 'Download complete. Loading weights into RAM/VRAM...',
      });
    }

    // PHASE 2: 50% -> 100% (Load GGUF weights + create inference context)
    if (!activeLlama) {
      activeLlama = await getLlama();
    }

    const model = await activeLlama.loadModel({
      modelPath,
      loadSignal: signal,
      onLoadProgress: (loadRatio: number) => {
        if (signal.aborted) return;
        const pct = Math.max(50, Math.min(96, 50 + Math.round(loadRatio * 46)));
        broadcastPrepareProgress({
          modelId,
          percent: pct,
          phase: 'load',
          message: `Loading GGUF tensors into memory (${Math.round(loadRatio * 100)}%)...`,
        });
      },
    });

    if (signal.aborted) {
      await model.dispose();
      throw new Error('Model load aborted');
    }
    activeModel = model;

    const effectiveContextSize = Math.min(contextWindow || 8192, 8192);
    broadcastPrepareProgress({
      modelId,
      percent: 98,
      phase: 'load',
      message: `Creating inference context (${effectiveContextSize.toLocaleString()} tokens)...`,
    });

    activeContext = await model.createContext({
      contextSize: effectiveContextSize,
    });

    broadcastPrepareProgress({
      modelId,
      percent: 100,
      phase: 'ready',
      message: 'Model ready.',
    });

    logger.info('SYSTEM', `AI Playlist Generator model ready: ${filename}`, {
      modelId,
      contextWindow,
      modelPath,
    });
    return { ok: true, modelPath };
  } catch (err) {
    activeDownloader = null;
    if (signal.aborted || String(err).toLowerCase().includes('abort')) {
      await disposeAiModel();
      broadcastPrepareProgress({
        modelId,
        percent: 0,
        phase: 'cancelled',
        message: 'Cancelled.',
      });
      throw new Error('Cancelled');
    }
    await disposeAiModel();
    broadcastPrepareProgress({
      modelId,
      percent: 0,
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    activeAbortController = null;
  }
}

function compactTrackRows(rows: TrackRow[]) {
  return rows.map((t) => ({
    id: t.id,
    artist: t.artist,
    title: t.title,
    album: t.album,
    year: t.year,
    genre: t.genre,
    rel_score: Number((t.artist_relative_popularity_score || 0).toFixed(2)),
    rating: t.local_star_rating || 0,
    loved: Boolean(t.is_loved),
  }));
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'best', 'build', 'by', 'chill', 'create',
  'deep', 'energy', 'fast', 'for', 'from', 'good', 'great', 'high', 'in', 'into',
  'like', 'make', 'me', 'mix', 'more', 'music', 'my', 'new', 'of', 'on', 'or',
  'playlist', 'playlists', 'relaxing', 'slow', 'some', 'song', 'songs', 'that',
  'the', 'this', 'to', 'top', 'track', 'tracks', 'upbeat', 'vibe', 'vibes',
  'with', 'workout', 'anthologies', 'now', 'yes', 'no', 'please',
]);

function extractDecadeRange(text: string): [number, number] | null {
  const m4 = text.match(/\b(19[5-9]0|20[0-2]0)s\b/i);
  if (m4) {
    const start = Number(m4[1]);
    return [start, start + 9];
  }
  const m2 = text.match(/\b([5-9]0)s\b/i);
  if (m2) {
    const start = 1900 + Number(m2[1]);
    return [start, start + 9];
  }
  if (/\b00s\b/i.test(text)) {
    return [2000, 2009];
  }
  return null;
}

function queryLocalCatalogTool(args: {
  query?: string;
  artist?: string;
  genre?: string;
  min_rating?: number;
  loved_only?: boolean;
  exclude_track_ids?: number[];
  limit?: number;
}) {
  const db = getDb();
  const limit = Math.max(1, Math.min(60, Number(args.limit) || 25));
  const excludeSet = new Set<number>(args.exclude_track_ids || []);

  if (args.query && args.query.trim()) {
    const ftsRows = searchTracksFts(args.query.trim(), limit * 3);
    const filtered = ftsRows
      .filter((t) => !excludeSet.has(t.id))
      .filter((t) => (!args.artist ? true : t.artist.toLowerCase().includes(args.artist.toLowerCase())))
      .filter((t) => (!args.genre ? true : (t.genre || '').toLowerCase().includes(args.genre.toLowerCase())))
      .filter((t) => (args.min_rating ? (t.local_star_rating || 0) >= args.min_rating : true))
      .filter((t) => (args.loved_only ? Boolean(t.is_loved) : true))
      .slice(0, limit);
    if (filtered.length > 0) {
      for (const r of filtered) sessionCollectedTracks.set(r.id, r);
      return compactTrackRows(filtered);
    }
  }

  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (args.query && args.query.trim()) {
    const decade = extractDecadeRange(args.query);
    if (decade) {
      conditions.push('year BETWEEN ? AND ?');
      params.push(decade[0], decade[1]);
    }
    const keywords = args.query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^(19|20)?[0-9]0s$/.test(w))
      .slice(0, 5);
    if (keywords.length > 0) {
      const kwClauses = keywords.map(
        () => '(title LIKE ? COLLATE NOCASE OR artist LIKE ? COLLATE NOCASE OR album LIKE ? COLLATE NOCASE OR genre LIKE ? COLLATE NOCASE)'
      );
      conditions.push(`(${kwClauses.join(' OR ')})`);
      for (const kw of keywords) {
        const pat = `%${kw}%`;
        params.push(pat, pat, pat, pat);
      }
    }
  }

  if (args.artist) {
    conditions.push('artist LIKE ? COLLATE NOCASE');
    params.push(`%${args.artist}%`);
  }
  if (args.genre) {
    conditions.push('genre LIKE ? COLLATE NOCASE');
    params.push(`%${args.genre}%`);
  }
  if (args.min_rating && args.min_rating > 0) {
    conditions.push('local_star_rating >= ?');
    params.push(args.min_rating);
  }
  if (args.loved_only) {
    conditions.push('is_loved = 1');
  }
  if (excludeSet.size > 0) {
    const placeholders = Array.from(excludeSet).map(() => '?').join(',');
    conditions.push(`id NOT IN (${placeholders})`);
    params.push(...Array.from(excludeSet));
  }

  params.push(limit);
  let rows = db
    .prepare(
      `SELECT * FROM tracks
       WHERE ${conditions.join(' AND ')}
       ORDER BY is_loved DESC, local_star_rating DESC, artist_relative_popularity_score DESC
       LIMIT ?`
    )
    .all(...params) as TrackRow[];

  if (rows.length === 0) {
    rows = db
      .prepare(
        `SELECT * FROM tracks
         ORDER BY is_loved DESC, local_star_rating DESC, artist_relative_popularity_score DESC
         LIMIT ?`
      )
      .all(limit) as TrackRow[];
  }

  for (const r of rows) sessionCollectedTracks.set(r.id, r);
  return compactTrackRows(rows);
}

function queryBySceneMatrixTool(args: {
  target_genre: string;
  min_affinity?: number;
  max_exclude_genre?: string;
  max_exclude_affinity?: number;
  exclude_track_ids?: number[];
  limit?: number;
}) {
  const db = getDb();
  const limit = Math.max(1, Math.min(60, Number(args.limit) || 25));
  const minAffinity = Number.isFinite(Number(args.min_affinity)) ? Number(args.min_affinity) : 0.55;
  const excludeSet = new Set<number>(args.exclude_track_ids || []);

  const candidates = testArtistsAgainstGenre(args.target_genre, {
    minScore: minAffinity,
    limit: 120,
  });

  let blockedArtists = new Set<string>();
  if (args.max_exclude_genre && args.max_exclude_genre.trim()) {
    const maxEx = Number.isFinite(Number(args.max_exclude_affinity))
      ? Number(args.max_exclude_affinity)
      : 0.25;
    const exScored = testArtistsAgainstGenre(args.max_exclude_genre, {
      minScore: maxEx,
      limit: 200,
    });
    blockedArtists = new Set(exScored.map((a) => a.artistKey));
  }

  const allowedArtists = candidates
    .filter((a) => !blockedArtists.has(a.artistKey))
    .map((a) => a.artistKey);

  if (allowedArtists.length === 0) {
    return [];
  }

  const placeholders = allowedArtists.slice(0, 80).map(() => '?').join(',');
  const rawRows = db
    .prepare(
      `SELECT * FROM tracks
       WHERE LOWER(TRIM(artist)) IN (${placeholders})
         AND COALESCE(exclude_from_smart_playlists, 0) = 0
       ORDER BY is_loved DESC, discovery_score DESC, artist_relative_popularity_score DESC
       LIMIT ?`
    )
    .all(...allowedArtists.slice(0, 80), limit * 4) as TrackRow[];

  // Cap tracks per artist to ensure diverse scene coverage
  const picked: TrackRow[] = [];
  const perArtist = new Map<string, number>();
  for (const r of rawRows) {
    if (excludeSet.has(r.id)) continue;
    const ak = r.artist.trim().toLowerCase();
    const c = perArtist.get(ak) || 0;
    if (c >= 2) continue;
    perArtist.set(ak, c + 1);
    picked.push(r);
    sessionCollectedTracks.set(r.id, r);
    if (picked.length >= limit) break;
  }

  return compactTrackRows(picked);
}

export function rerunAiStandardPlaylist(prompt: string, excludeTrackIds: number[] = [], limit = 25): TrackRow[] {
  const db = getDb();
  sessionCollectedTracks.clear();
  queryLocalCatalogTool({
    query: prompt,
    exclude_track_ids: excludeTrackIds,
    limit,
  });
  let tracks = Array.from(sessionCollectedTracks.values()).slice(0, limit);
  if (tracks.length === 0 && excludeTrackIds.length > 0) {
    // If all matching tracks were in the previous mix, allow re-selecting with fresh random order
    sessionCollectedTracks.clear();
    queryLocalCatalogTool({ query: prompt, limit });
    tracks = Array.from(sessionCollectedTracks.values()).slice(0, limit);
  }
  if (tracks.length === 0) {
    tracks = db
      .prepare('SELECT * FROM tracks ORDER BY RANDOM() LIMIT ?')
      .all(limit) as TrackRow[];
  }
  return tracks;
}

async function discoverViaLastfmTool(args: {
  seed_artist: string;
  seed_track?: string;
  tag?: string;
  limit?: number;
}) {
  const settings = getSettings();
  const apiKey = settings.lastfmApiKey?.trim();
  const limit = Math.max(1, Math.min(40, Number(args.limit) || 20));
  const db = getDb();

  if (!apiKey) {
    return {
      note: 'Last.fm API key not configured in Preferences; falling back to local catalog artist match.',
      tracks: queryLocalCatalogTool({ artist: args.seed_artist, genre: args.tag, limit }),
    };
  }

  const candidates: { artist: string; title?: string }[] = [];
  try {
    if (args.seed_track) {
      const url = `https://ws.audioscrobbler.com/2.0/?method=track.getSimilar&artist=${encodeURIComponent(
        args.seed_artist
      )}&track=${encodeURIComponent(args.seed_track)}&limit=40&api_key=${encodeURIComponent(apiKey)}&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as any;
        for (const item of data?.similartracks?.track || []) {
          if (item?.name && item?.artist?.name) {
            candidates.push({ artist: String(item.artist.name), title: String(item.name) });
          }
        }
      }
    } else if (args.tag) {
      const url = `https://ws.audioscrobbler.com/2.0/?method=tag.getTopTracks&tag=${encodeURIComponent(
        args.tag
      )}&limit=40&api_key=${encodeURIComponent(apiKey)}&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as any;
        for (const item of data?.tracks?.track || []) {
          if (item?.name && item?.artist?.name) {
            candidates.push({ artist: String(item.artist.name), title: String(item.name) });
          }
        }
      }
    } else {
      const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&artist=${encodeURIComponent(
        args.seed_artist
      )}&limit=25&api_key=${encodeURIComponent(apiKey)}&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as any;
        for (const item of data?.similarartists?.artist || []) {
          if (item?.name) {
            candidates.push({ artist: String(item.name) });
          }
        }
      }
    }
  } catch (err) {
    logger.warn('SYSTEM', 'Last.fm discovery failed', { error: String(err) });
  }

  // Inner-join candidates against local SQLite tracks
  const owned: TrackRow[] = [];
  const seenIds = new Set<number>();
  const findExact = db.prepare(
    'SELECT * FROM tracks WHERE LOWER(artist) = LOWER(?) AND LOWER(title) LIKE LOWER(?) LIMIT 2'
  );
  const findArtistTop = db.prepare(
    `SELECT * FROM tracks WHERE LOWER(artist) = LOWER(?)
     ORDER BY is_loved DESC, artist_relative_popularity_score DESC LIMIT 3`
  );

  for (const cand of candidates) {
    if (owned.length >= limit) break;
    const rows = cand.title
      ? (findExact.all(cand.artist, `%${cand.title}%`) as TrackRow[])
      : (findArtistTop.all(cand.artist) as TrackRow[]);
    for (const r of rows) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        owned.push(r);
        if (owned.length >= limit) break;
      }
    }
  }

  return { tracks: compactTrackRows(owned) };
}

async function lookupMusicbrainzTool(args: {
  query: string;
  entity_type: 'recording' | 'release-group' | 'artist';
}) {
  const db = getDb();
  const owned: TrackRow[] = [];
  const seen = new Set<number>();

  try {
    const url = `https://musicbrainz.org/ws/2/${args.entity_type}?query=${encodeURIComponent(
      args.query
    )}&limit=10&fmt=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RetroTunes/1.0.0 (https://github.com/edonvmk/RetroTunes)' },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (args.entity_type === 'recording') {
        for (const rec of data?.recordings || []) {
          const mbid = rec.id as string | undefined;
          const byMbid = mbid
            ? (db.prepare('SELECT * FROM tracks WHERE mbid_recording = ? LIMIT 3').all(mbid) as TrackRow[])
            : [];
          const byTitle =
            byMbid.length > 0
              ? byMbid
              : (db
                  .prepare('SELECT * FROM tracks WHERE LOWER(title) LIKE LOWER(?) LIMIT 2')
                  .all(`%${rec.title || ''}%`) as TrackRow[]);
          for (const t of byTitle) {
            if (!seen.has(t.id)) {
              seen.add(t.id);
              owned.push(t);
            }
          }
        }
      } else if (args.entity_type === 'artist') {
        for (const art of data?.artists || []) {
          const mbid = art.id as string | undefined;
          const rows = mbid
            ? (db.prepare('SELECT * FROM tracks WHERE mbid_artist = ? LIMIT 5').all(mbid) as TrackRow[])
            : [];
          const fallback =
            rows.length > 0
              ? rows
              : (db
                  .prepare('SELECT * FROM tracks WHERE LOWER(artist) LIKE LOWER(?) LIMIT 5')
                  .all(`%${art.name || ''}%`) as TrackRow[]);
          for (const t of fallback) {
            if (!seen.has(t.id)) {
              seen.add(t.id);
              owned.push(t);
            }
          }
        }
      } else {
        for (const rg of data?.['release-groups'] || []) {
          const rows = db
            .prepare('SELECT * FROM tracks WHERE LOWER(album) LIKE LOWER(?) LIMIT 5')
            .all(`%${rg.title || ''}%`) as TrackRow[];
          for (const t of rows) {
            if (!seen.has(t.id)) {
              seen.add(t.id);
              owned.push(t);
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn('SYSTEM', 'MusicBrainz lookup failed', { error: String(err) });
  }

  return { tracks: compactTrackRows(owned.slice(0, 25)) };
}

function derivePlaylistTitle(prompt: string, history?: { role: 'user' | 'assistant'; content: string }[]): string {
  const firstUser = history?.find((m) => m.role === 'user')?.content || prompt;
  const cleaned = firstUser
    .replace(/^(make|create|build|generate)\s+(me\s+)?(a|an)?\s*/i, '')
    .replace(/\s+playlist.*$/i, '')
    .trim();
  if (!cleaned) return 'AI Mix';
  const words = cleaned.split(/\s+/).slice(0, 5).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ');
}

function buildSmartRulesFromPrompt(
  prompt: string,
  history?: { role: 'user' | 'assistant'; content: string }[]
): {
  smartRules: SmartRuleGroup;
  limitType: 'tracks' | 'minutes' | 'gb';
  limitValue: number | null;
  selectionMethod: string;
} {
  const combined = [
    ...(history || []).filter((m) => m.role === 'user').map((m) => m.content),
    prompt,
  ].join(' ');

  const conditions: (SmartRule | SmartRuleGroup)[] = [];
  const decade = extractDecadeRange(combined);
  if (decade) {
    conditions.push({
      id: `ai-year-${Date.now()}`,
      type: 'rule',
      field: 'year',
      operator: 'between',
      value: decade[0],
      valueTo: decade[1],
    });
  }

  if (/\b(loved|favorite|favourites|favorites|heart)\b/i.test(combined)) {
    conditions.push({
      id: `ai-loved-${Date.now()}`,
      type: 'rule',
      field: 'is_loved',
      operator: 'is',
      value: '1',
    });
  }

  if (/\b(lossless|flac|alac|wav|hifi|hi-res)\b/i.test(combined)) {
    conditions.push({
      id: `ai-fmt-${Date.now()}`,
      type: 'rule',
      field: 'format',
      operator: 'contains',
      value: 'FLAC',
    });
  }

  const ratingMatch = combined.match(/\b([3-5])\s*\+?\s*stars?\b/i);
  if (ratingMatch) {
    conditions.push({
      id: `ai-rating-${Date.now()}`,
      type: 'rule',
      field: 'local_star_rating',
      operator: 'gte',
      value: ratingMatch[1],
    });
  }

  const matrixGenres = listAllMatrixGenres().sort((a, b) => b.length - a.length);
  const excludeClauseMatch = combined.match(/\b(?:without|no|exclude|excluding|not)\s+([a-z0-9\-\s]{3,40})/i);
  const excludeSegment = excludeClauseMatch ? excludeClauseMatch[1].toLowerCase() : '';
  const includeSegment = excludeClauseMatch
    ? combined.slice(0, excludeClauseMatch.index).toLowerCase()
    : combined.toLowerCase();

  const matchedIncludeGenres: string[] = [];
  let scanInc = includeSegment;
  for (const g of matrixGenres) {
    const escaped = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(scanInc)) {
      matchedIncludeGenres.push(g);
      scanInc = scanInc.replace(re, ' ');
    }
  }

  const matchedExcludeGenres: string[] = [];
  if (excludeSegment) {
    let scanExc = excludeSegment;
    for (const g of matrixGenres) {
      const escaped = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(scanExc)) {
        matchedExcludeGenres.push(g);
        scanExc = scanExc.replace(re, ' ');
      }
    }
  }

  if (matchedIncludeGenres.length === 1) {
    conditions.push({
      id: `ai-scene-inc-0`,
      type: 'rule',
      field: 'artist_scene_affinity',
      operator: 'gte',
      sceneGenre: normalizeGenreTag(matchedIncludeGenres[0]) || matchedIncludeGenres[0],
      value: 0.55,
    });
  } else if (matchedIncludeGenres.length > 1) {
    conditions.push({
      id: `ai-scene-inc-group`,
      type: 'group',
      match: 'ANY',
      conditions: matchedIncludeGenres.slice(0, 4).map((g, i) => ({
        id: `ai-scene-inc-${i}`,
        type: 'rule' as const,
        field: 'artist_scene_affinity' as const,
        operator: 'gte' as const,
        sceneGenre: normalizeGenreTag(g) || g,
        value: 0.55,
      })),
    });
  } else {
    const keywords = combined
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^(19|20)?[0-9]0s$/.test(w))
      .filter((w) => !['smart', 'loved', 'favorite', 'favorites', 'lossless', 'flac', 'stars', 'star'].includes(w));

    const uniqueKeywords = Array.from(new Set(keywords)).slice(0, 3);
    if (uniqueKeywords.length > 0) {
      if (uniqueKeywords.length === 1) {
        conditions.push({
          id: `ai-kw-0`,
          type: 'rule',
          field: 'genre',
          operator: 'contains',
          value: uniqueKeywords[0],
        });
      } else {
        conditions.push({
          id: `ai-kw-group`,
          type: 'group',
          match: 'ANY',
          conditions: uniqueKeywords.map((kw, i) => ({
            id: `ai-kw-${i}`,
            type: 'rule' as const,
            field: 'genre',
            operator: 'contains' as const,
            value: kw,
          })),
        });
      }
    }
  }

  for (const [i, exGenre] of matchedExcludeGenres.slice(0, 3).entries()) {
    conditions.push({
      id: `ai-scene-exc-${i}`,
      type: 'rule',
      field: 'artist_scene_affinity',
      operator: 'lte',
      sceneGenre: normalizeGenreTag(exGenre) || exGenre,
      value: 0.15,
    });
  }

  if (/\b(with\s+lyrics|has\s+lyrics|karaoke)\b/i.test(combined)) {
    conditions.push({
      id: `ai-lyrics-${Date.now()}`,
      type: 'rule',
      field: 'has_lyrics',
      operator: 'is',
      value: '1',
    });
  }

  if (/\b(unplayed|never\s+played|fresh|new\s+to\s+me)\b/i.test(combined)) {
    conditions.push({
      id: `ai-unplayed-${Date.now()}`,
      type: 'rule',
      field: 'is_unplayed',
      operator: 'is',
      value: '1',
    });
  }

  if (conditions.length === 0) {
    conditions.push({
      id: 'ai-default-pop',
      type: 'rule',
      field: 'artist_relative_popularity_score',
      operator: 'gte',
      value: '1.0',
    });
  }

  const countMatch = combined.match(/\b(\d{2,3})\s*(tracks?|songs?)\b/i);
  const limitValue = countMatch ? Math.min(200, Math.max(10, Number(countMatch[1]))) : 50;

  const maxArtistMatch = combined.match(/\b(?:max|limit)\s*(\d+)\s*(?:songs?|tracks?)?\s*per\s*artist\b/i);
  const maxPerArtist = maxArtistMatch ? Math.max(1, Number(maxArtistMatch[1])) : 2;

  let regenerateInterval: SmartRuleGroup['regenerateInterval'] = 'live';
  if (/\bminutely|every\s+minute\b/i.test(combined)) regenerateInterval = 'minutely';
  else if (/\bhourly|every\s+hour\b/i.test(combined)) regenerateInterval = 'hourly';
  else if (/\bdaily|every\s+day\b/i.test(combined)) regenerateInterval = 'daily';
  else if (/\bweekly|every\s+week\b/i.test(combined)) regenerateInterval = 'weekly';
  else if (/\bmonthly|every\s+month\b/i.test(combined)) regenerateInterval = 'monthly';
  else if (/\byearly|every\s+year|annually\b/i.test(combined)) regenerateInterval = 'yearly';

  let selectionMethod = 'random_weighted';
  if (/\bdeep\s+cuts?\b/i.test(combined)) selectionMethod = 'deep_cuts';
  else if (/\bleast\s+played\b/i.test(combined)) selectionMethod = 'least_played';
  else if (/\bmost\s+played\b/i.test(combined)) selectionMethod = 'most_played';
  else if (/\bhighest\s+rat(?:ed|ing)\b/i.test(combined)) selectionMethod = 'rating_desc';
  else if (/\brecently\s+added\b/i.test(combined)) selectionMethod = 'recently_added';
  else if (/\brandom\b/i.test(combined)) selectionMethod = 'random';

  return {
    smartRules: {
      id: 'ai-root',
      type: 'group',
      match: 'ALL',
      conditions,
      maxPerArtist,
      avoidBackToBackArtist: true,
      regenerateInterval,
    },
    limitType: 'tracks',
    limitValue,
    selectionMethod,
  };
}

export async function runAiAgentTurn(input: {
  prompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  excludedTrackIds?: number[];
  mode?: 'standard' | 'smart';
}): Promise<AgentTurnResult> {
  if (!activeContext || !activeModel) {
    throw new Error('AI model is not loaded. Please prepare the model first.');
  }

  const isFirstTurn = (input.history?.length ?? 0) <= 1;
  if (isFirstTurn) {
    sessionCollectedTracks.clear();
  }

  logger.info('SYSTEM', 'AI Playlist turn started', {
    prompt: input.prompt,
    historyLength: input.history?.length ?? 0,
  });

  const llamaModule = await loadLlamaModule();
  const { LlamaChatSession, defineChatSessionFunction } = llamaModule;

  if (!activeSession) {
    activeSession = new LlamaChatSession({
      contextSequence: activeContext.getSequence(),
      systemPrompt: [
        'You are the RetroTunes AI Playlist Generator.',
        'Your sole job is interviewing the user and assembling playlists exclusively from owned tracks in their SQLite library.',
        'Never invent track IDs. Always use query_by_scene_matrix, search_local_catalog, discover_via_lastfm, or lookup_musicbrainz to find owned track IDs.',
        'If the user prompt is broad or missing mood/energy/length, call ask_user_followup with 2-4 clickable options.',
        'Once you have enough owned tracks, call finalize_playlist with the validated track_ids.',
      ].join(' '),
    });
  }

  let pendingResult: AgentTurnResult | null = null;
  let searchCallsThisTurn = 0;
  const globalExcluded = input.excludedTrackIds || [];

  const functions = {
    search_local_catalog: defineChatSessionFunction({
      description:
        'Search the owned local SQLite tracks catalog by FTS5 query, artist, genre, rating, or loved status.',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          artist: { type: 'string' },
          genre: { type: 'string' },
          min_rating: { type: 'number' },
          loved_only: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
      handler: async (args: any) => {
        searchCallsThisTurn += 1;
        logger.info('SYSTEM', 'AI tool: search_local_catalog', { args, callNum: searchCallsThisTurn });
        if (searchCallsThisTurn > 3 && sessionCollectedTracks.size > 0) {
          return {
            note: 'Enough tracks found. Call finalize_playlist with these track_ids or ask_user_followup now.',
            tracks: [],
          };
        }
        return queryLocalCatalogTool({ ...args, exclude_track_ids: globalExcluded });
      },
    }),
    query_by_scene_matrix: defineChatSessionFunction({
      description:
        'Query owned artists & tracks using the 2D Subgenre Adjacency Matrix (0.000-1.000 scene affinity) with optional excluded subgenre.',
      params: {
        type: 'object',
        properties: {
          target_genre: { type: 'string' },
          min_affinity: { type: 'number' },
          max_exclude_genre: { type: 'string' },
          max_exclude_affinity: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['target_genre'],
      },
      handler: async (args: any) => {
        logger.info('SYSTEM', 'AI tool: query_by_scene_matrix', { args });
        return queryBySceneMatrixTool({ ...args, exclude_track_ids: globalExcluded });
      },
    }),
    discover_via_lastfm: defineChatSessionFunction({
      description:
        'Discover similar tracks/artists via Last.fm and inner-join against owned local SQLite tracks.',
      params: {
        type: 'object',
        properties: {
          seed_artist: { type: 'string' },
          seed_track: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['seed_artist'],
      },
      handler: async (args: any) => {
        logger.info('SYSTEM', 'AI tool: discover_via_lastfm', { args });
        return discoverViaLastfmTool(args);
      },
    }),
    lookup_musicbrainz: defineChatSessionFunction({
      description: 'Lookup recordings, release-groups, or artists on MusicBrainz and resolve owned tracks.',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          entity_type: { enum: ['recording', 'release-group', 'artist'] },
        },
        required: ['query', 'entity_type'],
      },
      handler: async (args: any) => {
        logger.info('SYSTEM', 'AI tool: lookup_musicbrainz', { args });
        return lookupMusicbrainzTool(args);
      },
    }),
    ask_user_followup: defineChatSessionFunction({
      description: 'Ask the user 1 concise clarifying question with clickable quick-reply options.',
      params: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'options'],
      },
      handler: async (args: { question: string; options: string[] }) => {
        logger.info('SYSTEM', 'AI tool: ask_user_followup', { question: args.question });
        pendingResult = {
          type: 'followup',
          question: args.question,
          options: Array.isArray(args.options) ? args.options.slice(0, 5) : [],
        };
        return { pausedForUserReply: true };
      },
    }),
    finalize_playlist: defineChatSessionFunction({
      description: 'Validate owned SQLite track_ids and finalize the generated playlist preview.',
      params: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          track_ids: { type: 'array', items: { type: 'number' } },
        },
        required: ['name', 'description', 'track_ids'],
      },
      handler: async (args: { name: string; description: string; track_ids: number[] }) => {
        const db = getDb();
        const ids = Array.from(new Set((args.track_ids || []).map((id) => Number(id)).filter((id) => id > 0)));
        if (ids.length === 0) {
          return { error: 'No valid track_ids supplied. Search local catalog first.' };
        }
        const placeholders = ids.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`)
          .all(...ids) as TrackRow[];
        const byId = new Map(rows.map((r) => [r.id, r]));
        const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as TrackRow[];
        logger.info('SYSTEM', 'AI tool: finalize_playlist', { name: args.name, count: ordered.length });
        pendingResult = {
          type: 'finalized',
          name: args.name || 'AI Generated Playlist',
          description: args.description || '',
          tracks: ordered,
        };
        return { validatedCount: ordered.length };
      },
    }),
    finalize_smart_playlist: defineChatSessionFunction({
      description: 'Create an auto-updating Smart Playlist using structured rules evaluated against SQLite.',
      params: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          match_mode: { enum: ['ALL', 'ANY'] },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                operator: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['field', 'operator', 'value'],
            },
          },
          limit_count: { type: 'number' },
        },
        required: ['name', 'rules'],
      },
      handler: async (args: {
        name: string;
        description?: string;
        match_mode?: 'ALL' | 'ANY';
        rules: { field: string; operator: string; value: string }[];
        limit_count?: number;
      }) => {
        const smartRules: SmartRuleGroup = {
          id: 'ai-smart-root',
          type: 'group',
          match: args.match_mode === 'ANY' ? 'ANY' : 'ALL',
          conditions: (args.rules || []).map((r, idx) => ({
            id: `ai-r-${idx}`,
            type: 'rule',
            field: r.field as any,
            operator: (r.operator || 'contains') as any,
            value: String(r.value ?? ''),
          })),
        };
        const limitVal = args.limit_count && args.limit_count > 0 ? Math.min(500, args.limit_count) : 50;
        const { tracks: previewTracks } = evaluateSmartPlaylist(smartRules, 'tracks', limitVal, 'popularity_desc');
        logger.info('SYSTEM', 'AI tool: finalize_smart_playlist', {
          name: args.name,
          rules: smartRules.conditions.length,
          previewCount: previewTracks.length,
        });
        pendingResult = {
          type: 'finalized_smart',
          name: args.name || 'AI Smart Playlist',
          description: args.description || 'Auto-updating Smart Playlist generated by rTunes AI.',
          smartRules,
          limitType: 'tracks',
          limitValue: limitVal,
          selectionMethod: 'popularity_desc',
          previewTracks: previewTracks.slice(0, 50),
        };
        return { matchedCount: previewTracks.length };
      },
    }),
  };

  const wantSmart = input.mode === 'smart' || /\bsmart\s+playlist\b/i.test(input.prompt);
  const promptForModel = wantSmart
    ? `${input.prompt}\n[Mode: Smart Playlist — prefer calling finalize_smart_playlist with rules.]`
    : input.prompt;

  let responseText = '';
  try {
    responseText = await activeSession.prompt(promptForModel, {
      functions,
      maxTokens: 640,
    });
  } catch (err) {
    logger.error('SYSTEM', 'AI Playlist prompt failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Reset session if context sequence got into a bad state
    activeSession = null;
  }

  const cleanText = (responseText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if (pendingResult) {
    return pendingResult;
  }

  // Fallback for 0.8B models that answer with plain text or whitespace instead of calling tools
  if (isFirstTurn && cleanText.includes('?') && !/\b(build|make|finalize|now)\b/i.test(input.prompt)) {
    return {
      type: 'followup',
      question: cleanText,
      options: ['Build playlist now', 'Upbeat & energetic', 'Chill & mellow', 'Include deep cuts'],
    };
  }

  if (wantSmart) {
    const built = buildSmartRulesFromPrompt(input.prompt, input.history);
    const { tracks: previewTracks } = evaluateSmartPlaylist(
      built.smartRules,
      built.limitType,
      built.limitValue,
      built.selectionMethod
    );
    const title = derivePlaylistTitle(input.prompt, input.history);
    logger.info('SYSTEM', 'AI Smart Playlist auto-finalized from prompt', {
      title,
      ruleCount: built.smartRules.conditions.length,
      previewCount: previewTracks.length,
    });
    return {
      type: 'finalized_smart',
      name: title,
      description: cleanText || `Auto-updating Smart Playlist (${previewTracks.length} matching tracks).`,
      smartRules: built.smartRules,
      limitType: built.limitType,
      limitValue: built.limitValue,
      selectionMethod: built.selectionMethod,
      previewTracks: previewTracks.slice(0, 50),
    };
  }

  if (sessionCollectedTracks.size === 0) {
    queryLocalCatalogTool({
      query: input.prompt,
      exclude_track_ids: globalExcluded,
      limit: 25,
    });
  }

  const collected = Array.from(sessionCollectedTracks.values()).slice(0, 25);
  if (collected.length > 0) {
    const title = derivePlaylistTitle(input.prompt, input.history);
    logger.info('SYSTEM', 'AI Playlist auto-finalized from collected tracks', {
      title,
      count: collected.length,
    });
    return {
      type: 'finalized',
      name: title,
      description: cleanText || `Generated from ${collected.length} owned tracks in your library.`,
      tracks: collected,
    };
  }

  return {
    type: 'message',
    message: cleanText || 'Tell me a genre, artist, or mood and I will build a playlist from your library.',
  };
}
