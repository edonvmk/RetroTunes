import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { getDb, searchTracksFts, TrackRow } from '../db';
import { getSettings } from '../settings';
import { logger } from '../logger';
import { platformDriver } from '../platform';

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
      type: 'message';
      message: string;
    };

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T = any>(
  specifier: string
) => Promise<T>;

let activeLlama: any = null;
let activeModel: any = null;
let activeContext: any = null;
let activeSession: any = null;
let activeAbortController: AbortController | null = null;
let activeDownloader: any = null;
let activeModelId: string | null = null;

export function getAiModelsDir(): string {
  let userData = '';
  try {
    userData = app?.getPath ? app.getPath('userData') : platformDriver.getFallbackUserDataDir();
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
    if (!m.filename) {
      return { modelId: m.id, cached: false, filePath: '', sizeBytes: 0 };
    }
    const filePath = path.join(modelsDir, m.filename);
    try {
      if (fs.existsSync(filePath)) {
        const st = fs.statSync(filePath);
        if (st.isFile() && st.size > 1024 * 1024) {
          return { modelId: m.id, cached: true, filePath, sizeBytes: st.size };
        }
      }
    } catch {
      // ignore stat error
    }
    return { modelId: m.id, cached: false, filePath, sizeBytes: 0 };
  });
}

function broadcastPrepareProgress(progress: AiPrepareProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ai:prepare-progress', progress);
  }
}

export async function disposeAiModel(): Promise<{ ok: boolean }> {
  try {
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
    const llamaModule = await dynamicImport<any>('node-llama-cpp');
    const { getLlama, createModelDownloader } = llamaModule;

    // PHASE 1: 0% -> 50% (Download GGUF if missing; skip immediately to 50% if cached)
    const alreadyCached = fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1024 * 1024;
    if (alreadyCached) {
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

    broadcastPrepareProgress({
      modelId,
      percent: 98,
      phase: 'load',
      message: `Creating inference context (${contextWindow.toLocaleString()} tokens)...`,
    });

    activeContext = await model.createContext({
      contextSize: contextWindow,
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
    return compactTrackRows(filtered);
  }

  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

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
  const rows = db
    .prepare(
      `SELECT * FROM tracks
       WHERE ${conditions.join(' AND ')}
       ORDER BY is_loved DESC, local_star_rating DESC, artist_relative_popularity_score DESC
       LIMIT ?`
    )
    .all(...params) as TrackRow[];

  return compactTrackRows(rows);
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

export async function runAiAgentTurn(input: {
  prompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  excludedTrackIds?: number[];
}): Promise<AgentTurnResult> {
  if (!activeContext || !activeModel) {
    throw new Error('AI model is not loaded. Please prepare the model first.');
  }

  const llamaModule = await dynamicImport<any>('node-llama-cpp');
  const { LlamaChatSession, defineChatSessionFunction } = llamaModule;

  if (!activeSession) {
    activeSession = new LlamaChatSession({
      contextSequence: activeContext.getSequence(),
      systemPrompt: [
        'You are the RetroTunes AI Playlist Generator.',
        'Your sole job is interviewing the user and assembling playlists exclusively from owned tracks in their SQLite library.',
        'Never invent track IDs. Always use search_local_catalog, discover_via_lastfm, or lookup_musicbrainz to find owned track IDs.',
        'If the user prompt is broad or missing mood/energy/length, call ask_user_followup with 2-4 clickable options.',
        'Once you have enough owned tracks, call finalize_playlist with the validated track_ids.',
      ].join(' '),
    });
  }

  let pendingResult: AgentTurnResult | null = null;
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
      handler: async (args: any) =>
        queryLocalCatalogTool({ ...args, exclude_track_ids: globalExcluded }),
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
      handler: async (args: any) => discoverViaLastfmTool(args),
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
      handler: async (args: any) => lookupMusicbrainzTool(args),
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
        pendingResult = {
          type: 'finalized',
          name: args.name || 'AI Generated Playlist',
          description: args.description || '',
          tracks: ordered,
        };
        return { validatedCount: ordered.length };
      },
    }),
  };

  const responseText = await activeSession.prompt(input.prompt, {
    functions,
    maxTokens: 1024,
  });

  if (pendingResult) {
    return pendingResult;
  }

  return {
    type: 'message',
    message: responseText || 'Ready. Tell me more about the playlist you want to build.',
  };
}
