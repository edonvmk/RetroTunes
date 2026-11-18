import fs from 'fs';
import {
  getDb,
  searchTracksFts,
  searchVideosFts,
  recalculateArtistPopularityScores,
  getDatabaseDiagnostics,
  rebuildMediaDatabase,
  TrackRow,
  PlaylistRow,
} from './db';
import {
  getSettings,
  saveSettings,
  testIntegrationConnection,
  AppSettings,
} from './settings';
import {
  runLibraryScan,
  getIndexProgress,
  cancelLibraryScan,
  hydrateTrackMetadata,
  hydrateAlbumMetadata,
  hydrateVideoArtwork,
  syncListenBrainzPopularity,
  cleanAndHydrateAllLibraryTitles,
  deduplicateLibraryTracks,
  syncPlexAndAudiobookshelfProgress,
  updateVideoPlaybackProgress,
  updateAudiobookPlaybackProgress,
  scanExtendedMediaSections,
} from './indexer';
import {
  getCacheStats,
  clearLocalCache,
  queueTrackCache,
  queueVideoTranscode,
} from './cacheTranscoder';
import {
  evaluateSmartPlaylist,
  getPlaylistTracks,
  getPlaylistVideos,
  regenerateSmartPlaylist,
  ignoreTrackInSmartPlaylist,
  excludeTrackFromAllSmartPlaylists,
  getSmartPlaylistExclusions,
  restoreSmartPlaylistExclusion,
  getDistinctSmartFieldValues,
  SmartField,
  SmartRuleGroup,
} from './smartPlaylists';
import {
  getTranscoderBinaryStatus,
  checkAndUpdateTranscoderBinaries,
} from './transcoder/binaryManager';
import {
  getAiModelCacheStatus,
  prepareAiModel,
  cancelPrepareAiModel,
  disposeAiModel,
  runAiAgentTurn,
  rerunAiStandardPlaylist,
} from './ai/llamaService';
import {
  generateMix as generateEGeniusMix,
  refreshMix as refreshEGeniusMix,
  explainTrack as explainEGeniusTrack,
  getGenreMatrixData,
  rebuildGenreMatrix,
  setGenreMatrixCell,
  resetGenreMatrixCell,
  testArtistsAgainstGenre,
  computeGenreArtistSlice,
  RebuildGenreMatrixOptions,
  MixDepthMode,
} from './egenius';
import {
  getStorefrontHome,
  searchStoreCatalog,
  requestStoreItem,
  getArrLiveQueue,
  getMultiSourceTopCharts,
  StoreCatalogItem,
} from './storeArr';
import {
  listNetworkShares,
  saveNetworkShare,
  deleteNetworkShare,
  mountNetworkShare,
  unmountNetworkShare,
  autoDetectShareFolders,
  discoverNetworkSharesOnHost,
  NetworkShareInput,
} from './shareManager';
import {
  searchUploadMetadata,
  buildUploadPreviewPlan,
  executeUploadAndArrImport,
  UploadMediaType,
} from './uploadWizard';
import { getMediaServerPort } from './mediaServer';
import { logger, LogLevel, LogSubsystem } from './logger';
import { platformDriver } from './platform';
import { reexportSyncedPlaylistM3u8 } from './deviceSync';

export type RpcHandlerFn = (...args: any[]) => Promise<any> | any;
export type RpcRegisterFn = (channel: string, fn: RpcHandlerFn) => void;

const UNSUPPORTED_SERVER_CHANNEL = () => ({ supported: false, mode: 'server' as const });

export function registerCoreRpcHandlers(
  registerChannel: RpcRegisterFn,
  options: { isDev?: boolean; mediaPortGetter?: () => number } = {}
): void {
  const isDev = Boolean(options.isDev);
  const getPort = options.mediaPortGetter || getMediaServerPort;

  // --- System & Diagnostics ---
  registerChannel('system:isDev', () => isDev);
  registerChannel('media:port', () => getPort());
  registerChannel(
    'logs:get',
    (filter?: { level?: LogLevel; subsystem?: LogSubsystem; search?: string; limit?: number }) => ({
      entries: logger.getEntries(filter),
      paths: logger.getLogPaths(),
      dbDiagnostics: getDatabaseDiagnostics(),
    })
  );
  registerChannel('logs:clear', () => {
    logger.clearEntries();
    return { ok: true };
  });
  registerChannel('logs:testEvent', (level: LogLevel, subsystem: LogSubsystem, message: string) =>
    logger.log(level, subsystem, message, { triggeredBy: 'User Diagnostic Test' })
  );
  registerChannel('system:credentialStoreLabel', () => platformDriver.credentialStoreLabel);

  // --- Desktop-only stubs in headless server mode (overridden by electron/main.ts in GUI) ---
  registerChannel('dialog:selectDirectory', UNSUPPORTED_SERVER_CHANNEL);
  registerChannel('dialog:selectFile', UNSUPPORTED_SERVER_CHANNEL);
  registerChannel('dialog:selectFiles', UNSUPPORTED_SERVER_CHANNEL);
  registerChannel('shell:showItemInFolder', UNSUPPORTED_SERVER_CHANNEL);

  // --- Settings & Connection Testers ---
  registerChannel('settings:get', () => getSettings());
  registerChannel('settings:save', (partial: Partial<AppSettings>) => saveSettings(partial));
  registerChannel('settings:testConnection', (target: any, overrideConfig?: Partial<AppSettings>) =>
    testIntegrationConnection(target, overrideConfig)
  );

  // --- Library Tracks & Videos (SQLite + FTS5) ---
  registerChannel('tracks:search', (query = '', limit = 200000) => searchTracksFts(query, limit));
  registerChannel('tracks:rate', async (trackId: number, rating: number, isLoved?: boolean) => {
    const db = getDb();
    const current = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as TrackRow | undefined;
    if (!current) return null;

    const newRating = Math.max(0, Math.min(5, Math.round(rating)));
    const newLoved = isLoved !== undefined ? (isLoved ? 1 : 0) : newRating === 5 ? 1 : current.is_loved;

    db.prepare('UPDATE tracks SET local_star_rating = ?, is_loved = ? WHERE id = ?').run(
      newRating,
      newLoved,
      trackId
    );

    const settings = getSettings();
    if (settings.listenbrainzToken && current.mbid_recording && (newLoved === 1 || isLoved !== undefined)) {
      try {
        await fetch('https://api.listenbrainz.org/1/feedback/recording-feedback', {
          method: 'POST',
          headers: {
            Authorization: `Token ${settings.listenbrainzToken.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recording_mbid: current.mbid_recording,
            score: newLoved ? 1 : 0,
          }),
        });
        logger.info('LISTENBRAINZ', `Synced rating/love feedback to ListenBrainz for "${current.title}"`, {
          mbid: current.mbid_recording,
          score: newLoved ? 1 : 0,
        });
      } catch (err) {
        logger.warn('LISTENBRAINZ', 'ListenBrainz feedback sync error', { error: String(err) });
      }
    }

    return db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
  });

  registerChannel('tracks:recordPlay', async (trackId: number) => {
    const db = getDb();
    db.prepare("UPDATE tracks SET play_count = play_count + 1, last_played = datetime('now') WHERE id = ?").run(
      trackId
    );
    if (getSettings().autoCachePlayback) {
      queueTrackCache(trackId, true);
    }
    return await hydrateTrackMetadata(trackId, true);
  });

  registerChannel('tracks:hydrate', (trackId: number) => hydrateTrackMetadata(trackId, true));
  registerChannel('tracks:hydrateAlbum', (artist: string, album: string) =>
    hydrateAlbumMetadata(artist, album)
  );
  registerChannel('videos:hydrateArtwork', () => hydrateVideoArtwork());

  registerChannel('tracks:getLyrics', (trackId: number) => {
    const db = getDb();
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as TrackRow | undefined;
    if (!track || !track.lrc_path || !fs.existsSync(track.lrc_path)) return null;
    return fs.readFileSync(track.lrc_path, 'utf8');
  });

  registerChannel('videos:search', (query = '', typeFilter?: 'movie' | 'tv') =>
    searchVideosFts(query, typeFilter)
  );
  registerChannel('videos:markWatched', (videoId: number, watched: boolean) => {
    const db = getDb();
    db.prepare('UPDATE videos SET watched = ? WHERE id = ?').run(watched ? 1 : 0, videoId);
    if (watched && getSettings().autoCachePlayback) {
      queueVideoTranscode(videoId, true);
    }
    return db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  });

  registerChannel('cache:toggleShow', (showName: string, keepCached: boolean) => {
    const db = getDb();
    const eps = db
      .prepare("SELECT id FROM videos WHERE type = 'tv' AND show_name = ?")
      .all(showName) as { id: number }[];
    for (const ep of eps) {
      queueVideoTranscode(ep.id, keepCached);
    }
    return getCacheStats();
  });

  // --- Indexer & ListenBrainz Popularity ---
  registerChannel('indexer:scan', (customPaths?: string[]) => runLibraryScan(customPaths));
  registerChannel('db:rebuild', () => {
    rebuildMediaDatabase();
    void runLibraryScan().then(() => scanExtendedMediaSections());
    return { ok: true, started: true };
  });
  registerChannel('indexer:cancel', () => {
    cancelLibraryScan();
    return { ok: true };
  });
  registerChannel('indexer:progress', () => getIndexProgress());
  registerChannel('indexer:syncPopularity', () => syncListenBrainzPopularity());
  registerChannel('indexer:recalculateMedians', () => recalculateArtistPopularityScores());
  registerChannel('indexer:cleanAllTitles', (triggerTagSweep = true) =>
    cleanAndHydrateAllLibraryTitles(triggerTagSweep)
  );
  registerChannel('indexer:deduplicate', () => deduplicateLibraryTracks());

  // --- Local Pre-Cache & 360p Video Transcoder ---
  registerChannel('cache:stats', () => getCacheStats());
  registerChannel('cache:clear', () => clearLocalCache());
  registerChannel('cache:toggleTrack', (trackId: number, keepCached: boolean) => {
    queueTrackCache(trackId, keepCached);
    return getCacheStats();
  });
  registerChannel('cache:toggleAlbum', (artist: string, album: string, keepCached: boolean) => {
    const db = getDb();
    const tracks = db
      .prepare('SELECT id FROM tracks WHERE artist = ? AND album = ?')
      .all(artist, album) as { id: number }[];
    for (const t of tracks) {
      queueTrackCache(t.id, keepCached);
    }
    return getCacheStats();
  });
  registerChannel('cache:toggleVideo', (videoId: number, keepCached: boolean) => {
    queueVideoTranscode(videoId, keepCached);
    return getCacheStats();
  });
  registerChannel('cache:precacheAllPlaylists', () => {
    const db = getDb();
    const playlists = db.prepare('SELECT id FROM playlists').all() as { id: number }[];
    let queued = 0;
    for (const pl of playlists) {
      const tracks = getPlaylistTracks(pl.id);
      for (const t of tracks) {
        queueTrackCache(t.id, true);
        queued++;
      }
    }
    logger.info('CACHE', `Queued ${queued} playlist tracks for proactive local SSD caching.`);
    return getCacheStats();
  });

  // --- Regular, Smart, eGenius, GenreMap & AI Playlists ---
  registerChannel('playlists:list', () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM playlists ORDER BY is_smart DESC, name ASC').all() as PlaylistRow[];
    return rows.map((pl) => {
      const tCount = getPlaylistTracks(pl.id).length;
      const vCount = getPlaylistVideos(pl.id).length;
      return {
        ...pl,
        media_type: pl.media_type || 'music',
        trackCount: tCount + vCount,
        audioCount: tCount,
        videoCount: vCount,
      };
    });
  });
  registerChannel('playlists:getTracks', (playlistId: number) => getPlaylistTracks(playlistId));
  registerChannel('playlists:getVideos', (playlistId: number) => getPlaylistVideos(playlistId));
  registerChannel(
    'playlists:previewSmart',
    (
      rulesGroup: SmartRuleGroup,
      limitType: string,
      limitValue: number | null,
      selectionMethod: string
    ) => evaluateSmartPlaylist(rulesGroup, limitType, limitValue, selectionMethod)
  );
  registerChannel(
    'playlists:save',
    (payload: {
      id?: number;
      name: string;
      isSmart: boolean;
      mediaType?: 'music' | 'video' | 'mixed';
      smartRules?: SmartRuleGroup;
      limitType?: string;
      limitValue?: number | null;
      selectionMethod?: string;
      keepCached?: boolean;
      aiPrompt?: string | null;
      aiMode?: 'standard' | 'smart' | null;
    }) => {
      const db = getDb();
      const rulesJson = payload.smartRules ? JSON.stringify(payload.smartRules) : null;
      const mediaType = payload.mediaType || 'music';
      if (payload.id) {
        db.prepare(`
          UPDATE playlists
          SET name = ?, is_smart = ?, media_type = ?, smart_rules_json = ?, limit_type = ?, limit_value = ?, track_limit = ?, selection_method = ?, keep_cached = ?, cached_track_ids_json = NULL, last_regenerated_at = NULL
          WHERE id = ?
        `).run(
          payload.name,
          payload.isSmart ? 1 : 0,
          mediaType,
          rulesJson,
          payload.limitType || 'tracks',
          payload.limitValue ?? null,
          payload.limitType === 'tracks' ? payload.limitValue ?? null : null,
          payload.selectionMethod || 'popularity_desc',
          payload.keepCached ? 1 : 0,
          payload.id
        );
        if (payload.keepCached) {
          for (const t of getPlaylistTracks(payload.id)) {
            queueTrackCache(t.id, true);
          }
        }
        return payload.id;
      }
      const res = db
        .prepare(`
          INSERT INTO playlists (name, is_smart, media_type, smart_rules_json, limit_type, limit_value, track_limit, selection_method, keep_cached, ai_prompt, ai_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          payload.name,
          payload.isSmart ? 1 : 0,
          mediaType,
          rulesJson,
          payload.limitType || 'tracks',
          payload.limitValue ?? null,
          payload.limitType === 'tracks' ? payload.limitValue ?? null : null,
          payload.selectionMethod || 'popularity_desc',
          payload.keepCached ? 1 : 0,
          payload.aiPrompt ?? null,
          payload.aiMode ?? null
        );
      const newId = Number(res.lastInsertRowid);
      if (payload.keepCached) {
        for (const t of getPlaylistTracks(newId)) {
          queueTrackCache(t.id, true);
        }
      }
      return newId;
    }
  );
  registerChannel('playlists:regenerate', (playlistId: number) => regenerateSmartPlaylist(playlistId));
  registerChannel('playlists:rerunAi', (playlistId: number) => {
    const db = getDb();
    const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as PlaylistRow | undefined;
    if (!pl) return [];
    if (pl.is_smart) {
      return regenerateSmartPlaylist(playlistId);
    }
    const existingRows = db
      .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?')
      .all(playlistId) as { track_id: number }[];
    const excludeIds = existingRows.map((r) => r.track_id);
    const prompt = pl.ai_prompt || pl.name;
    const nextTracks = rerunAiStandardPlaylist(prompt, excludeIds, Math.max(15, excludeIds.length || 25));
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
      const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
      nextTracks.forEach((t, idx) => ins.run(playlistId, t.id, idx + 1));
    });
    tx();
    logger.info('SYSTEM', `Reran AI playlist "${pl.name}" (${nextTracks.length} tracks)`, { playlistId });
    return nextTracks;
  });
  registerChannel(
    'egenius:createPlaylist',
    async (payload: { trackId: number; limit?: 25 | 50; mode?: MixDepthMode; sceneThreshold?: number }) => {
      const db = getDb();
      const mix = await generateEGeniusMix({
        seedTrackId: payload.trackId,
        limit: payload.limit === 50 ? 50 : 25,
        mode: payload.mode || 'balanced',
        sceneThreshold: payload.sceneThreshold ?? 0.55,
      });
      const plName = `eGenius: ${mix.seedTrack.title}`;
      const res = db
        .prepare(
          `INSERT INTO playlists (name, is_smart, media_type, limit_type, limit_value, track_limit, selection_method, egenius_seed_track_id, egenius_mode, egenius_scene_threshold)
           VALUES (?, 0, 'music', 'tracks', ?, ?, 'egenius', ?, ?, ?)`
        )
        .run(plName, mix.limit, mix.limit, mix.seedTrack.id, mix.mode, mix.sceneThreshold);
      const newId = Number(res.lastInsertRowid);
      const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
      const tx = db.transaction(() => {
        mix.tracks.forEach((t, idx) => ins.run(newId, t.id, idx + 1));
      });
      tx();
      return { playlistId: newId, mix };
    }
  );
  registerChannel(
    'egenius:refreshPlaylist',
    async (payload: { playlistId: number; limit?: 25 | 50; mode?: MixDepthMode; sceneThreshold?: number }) => {
      const mix = await refreshEGeniusMix(payload.playlistId, {
        limit: payload.limit,
        mode: payload.mode,
        sceneThreshold: payload.sceneThreshold,
      });
      return { playlistId: payload.playlistId, mix };
    }
  );
  registerChannel('egenius:convertToStandard', (playlistId: number) => {
    getDb()
      .prepare('UPDATE playlists SET egenius_seed_track_id = NULL, egenius_mode = NULL WHERE id = ?')
      .run(playlistId);
    return { ok: true };
  });
  registerChannel(
    'egenius:explainTrack',
    (payload: { seedTrackId: number; candidateTrackId: number; mode?: MixDepthMode }) =>
      explainEGeniusTrack(payload.seedTrackId, payload.candidateTrackId, payload.mode || 'balanced')
  );
  registerChannel('genreMatrix:get', (options?: { search?: string; limit?: number }) =>
    getGenreMatrixData(options || {})
  );
  registerChannel('genreMatrix:rebuild', (options?: RebuildGenreMatrixOptions) => {
    const currentSettings = getSettings();
    const hasKey = Boolean(currentSettings.lastfmApiKey && currentSettings.lastfmApiKey.trim().length > 0);
    if (options && (options.useLastfm !== undefined || options.lastfmWeight !== undefined)) {
      saveSettings({
        genreMapUseLastfm: hasKey ? Boolean(options.useLastfm) : false,
        genreMapLastfmWeight:
          typeof options.lastfmWeight === 'number'
            ? Math.max(0, Math.min(100, Math.round(options.lastfmWeight)))
            : currentSettings.genreMapLastfmWeight ?? 20,
      });
    }
    return rebuildGenreMatrix({
      useLastfm: hasKey ? options?.useLastfm : false,
      lastfmWeight: options?.lastfmWeight,
      resetStuckMetadata: options?.resetStuckMetadata,
    });
  });
  registerChannel(
    'genreMatrix:getArtistSlice',
    (payload: {
      targetGenre: string;
      minThreshold?: number;
      artistFilter?: string;
      useLastfm?: boolean;
      lastfmWeight?: number;
      maxArtists?: number;
    }) => computeGenreArtistSlice(payload)
  );
  registerChannel(
    'genreMatrix:setCell',
    (payload: { genreX: string; genreY: string; similarity: number; isLocked: boolean }) =>
      setGenreMatrixCell(payload.genreX, payload.genreY, payload.similarity, payload.isLocked)
  );
  registerChannel('genreMatrix:resetCell', (payload: { genreX: string; genreY: string }) =>
    resetGenreMatrixCell(payload.genreX, payload.genreY)
  );
  registerChannel(
    'genreMatrix:testArtists',
    (payload: { targetGenre: string; artistQuery?: string; minScore?: number; limit?: number }) =>
      testArtistsAgainstGenre(payload.targetGenre, {
        artistQuery: payload.artistQuery,
        minScore: payload.minScore,
        limit: payload.limit,
      })
  );
  registerChannel('playlists:delete', (playlistId: number) => {
    getDb().prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
    return { ok: true };
  });
  registerChannel('playlists:reorderTracks', (playlistId: number, trackIds: number[]) => {
    const db = getDb();
    const del = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?');
    const ins = db.prepare(
      'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
    );
    const tx = db.transaction(() => {
      del.run(playlistId);
      trackIds.forEach((tid, idx) => {
        ins.run(playlistId, tid, idx + 1);
      });
    });
    tx();
    return { ok: true };
  });
  registerChannel('playlists:addTrack', (playlistId: number, trackId: number) => {
    const db = getDb();
    const existingCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
        .get(playlistId, trackId) as { c: number }
    ).c;
    const maxPos = (
      db
        .prepare('SELECT COALESCE(MAX(position), 0) as m FROM playlist_tracks WHERE playlist_id = ?')
        .get(playlistId) as { m: number }
    ).m;
    db.prepare(
      'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
    ).run(playlistId, trackId, maxPos + 1);
    return { ok: true, duplicate: existingCount > 0, count: existingCount + 1 };
  });
  registerChannel('playlists:removeTrack', (playlistId: number, trackId: number) => {
    const db = getDb();
    const compactTx = db.transaction(() => {
      db.prepare(
        `DELETE FROM playlist_tracks
         WHERE id = (
           SELECT id FROM playlist_tracks
           WHERE playlist_id = ? AND track_id = ?
           ORDER BY position ASC, id ASC
           LIMIT 1
         )`
      ).run(playlistId, trackId);
      const remaining = db
        .prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC')
        .all(playlistId) as { id: number }[];
      const updatePos = db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?');
      remaining.forEach((row, idx) => {
        updatePos.run(idx + 1, row.id);
      });
    });
    compactTx();
    void reexportSyncedPlaylistM3u8(playlistId);
    return { ok: true };
  });
  registerChannel('playlists:getExclusions', (playlistId: number | string) =>
    getSmartPlaylistExclusions(playlistId)
  );
  registerChannel('playlists:ignoreTrack', (playlistId: number | string, trackId: number) =>
    ignoreTrackInSmartPlaylist(playlistId, trackId)
  );
  registerChannel('playlists:excludeTrackGlobally', (trackId: number) =>
    excludeTrackFromAllSmartPlaylists(trackId, true)
  );
  registerChannel(
    'playlists:restoreExclusion',
    (playlistId: number | string, trackId: number, scope: 'playlist' | 'global') =>
      restoreSmartPlaylistExclusion(playlistId, trackId, scope)
  );
  registerChannel('playlists:addVideo', (playlistId: number, videoId: number) => {
    const db = getDb();
    const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
      | PlaylistRow
      | undefined;
    if (pl && pl.media_type === 'music') {
      db.prepare("UPDATE playlists SET media_type = 'mixed' WHERE id = ?").run(playlistId);
    }
    const maxPos = (
      db
        .prepare('SELECT COALESCE(MAX(position), 0) as m FROM playlist_videos WHERE playlist_id = ?')
        .get(playlistId) as { m: number }
    ).m;
    db.prepare(
      'INSERT OR IGNORE INTO playlist_videos (playlist_id, video_id, position) VALUES (?, ?, ?)'
    ).run(playlistId, videoId, maxPos + 1);
    return { ok: true };
  });
  registerChannel('playlists:removeVideo', (playlistId: number, videoId: number) => {
    getDb()
      .prepare('DELETE FROM playlist_videos WHERE playlist_id = ? AND video_id = ?')
      .run(playlistId, videoId);
    return { ok: true };
  });
  registerChannel('playlists:addShow', (playlistId: number, showName: string) => {
    const db = getDb();
    db.prepare("UPDATE playlists SET media_type = 'mixed' WHERE id = ? AND media_type = 'music'").run(
      playlistId
    );
    const eps = db
      .prepare(
        "SELECT id FROM videos WHERE type = 'tv' AND show_name = ? ORDER BY season ASC, episode ASC"
      )
      .all(showName) as { id: number }[];
    let maxPos = (
      db
        .prepare('SELECT COALESCE(MAX(position), 0) as m FROM playlist_videos WHERE playlist_id = ?')
        .get(playlistId) as { m: number }
    ).m;
    const ins = db.prepare(
      'INSERT OR IGNORE INTO playlist_videos (playlist_id, video_id, position) VALUES (?, ?, ?)'
    );
    const tx = db.transaction(() => {
      for (const ep of eps) {
        maxPos++;
        ins.run(playlistId, ep.id, maxPos);
      }
    });
    tx();
    return { ok: true, added: eps.length };
  });
  registerChannel('playlists:getDistinctFieldValues', (field: SmartField, search?: string) =>
    getDistinctSmartFieldValues(field, search)
  );

  // --- Transcoder & AI Playlist Agent ---
  registerChannel('transcoder:getBinaryStatus', () => getTranscoderBinaryStatus());
  registerChannel(
    'transcoder:checkUpdateBinaries',
    (opts?: { forceDownload?: boolean; autoDownload?: boolean }) =>
      checkAndUpdateTranscoderBinaries(opts)
  );
  registerChannel('ai:model-cache-status', (models: { id: string; filename?: string }[]) =>
    getAiModelCacheStatus(models)
  );
  registerChannel(
    'ai:prepare-model',
    (params: { modelId: string; uri: string; filename: string; contextWindow?: number }) =>
      prepareAiModel(params)
  );
  registerChannel('ai:cancel-prepare', () => cancelPrepareAiModel());
  registerChannel('ai:dispose-model', () => disposeAiModel());
  registerChannel(
    'ai:agent-turn',
    (input: {
      prompt: string;
      history?: { role: 'user' | 'assistant'; content: string }[];
      excludedTrackIds?: number[];
    }) => runAiAgentTurn(input)
  );

  // --- Headless stubs for desktop-only hardware channels (overridden by electron/main.ts in GUI) ---
  for (const ch of [
    'devices:volumes',
    'devices:list',
    'devices:provision',
    'devices:updateProfile',
    'devices:migrateToMtp',
    'devices:sync',
    'devices:delete',
    'devices:getCatalog',
    'devices:removeItem',
    'devices:cancelSync',
    'devices:syncProgress',
    'devices:eject',
    'devices:getAutoOpenOnMtp',
    'devices:setAutoOpenOnMtp',
  ]) {
    registerChannel(ch, UNSUPPORTED_SERVER_CHANNEL);
  }

  // --- Network Shares, Upload Wizard & Storefront ---
  registerChannel('shares:list', () => listNetworkShares());
  registerChannel('shares:save', (input: NetworkShareInput) => saveNetworkShare(input));
  registerChannel('shares:delete', (id: number) => deleteNetworkShare(id));
  registerChannel('shares:mount', (id: number) => mountNetworkShare(id));
  registerChannel('shares:unmount', (id: number) => unmountNetworkShare(id));
  registerChannel('shares:autoDetect', (mountPoint: string) => autoDetectShareFolders(mountPoint));
  registerChannel(
    'shares:discover',
    (params: { protocol: 'nfs' | 'smb'; host: string; username?: string; password?: string }) =>
      discoverNetworkSharesOnHost(params)
  );
  registerChannel('upload:searchMetadata', (mediaType: UploadMediaType, query: string) =>
    searchUploadMetadata(mediaType, query)
  );
  registerChannel('upload:previewPlan', (params: any) => buildUploadPreviewPlan(params));
  registerChannel('upload:execute', (params: any) => executeUploadAndArrImport(params));
  registerChannel('store:home', (genreFilter?: string) => getStorefrontHome(genreFilter));
  registerChannel('store:search', (category: 'album' | 'movie' | 'series', query: string) =>
    searchStoreCatalog(category, query)
  );
  registerChannel('store:request', (item: StoreCatalogItem) => requestStoreItem(item));
  registerChannel(
    'store:charts',
    (source: 'deezer' | 'lastfm' | 'theaudiodb' | 'library_relative' = 'deezer') =>
      getMultiSourceTopCharts(source)
  );
  registerChannel('arr:queue', () => getArrLiveQueue());

  // --- Extended Media Sections & Resume Sync ---
  registerChannel(
    'videos:updateProgress',
    (videoId: number, viewOffsetMs: number, watched: boolean) =>
      updateVideoPlaybackProgress(videoId, viewOffsetMs, watched)
  );
  registerChannel(
    'audiobooks:updateProgress',
    (audiobookId: number, currentTimeSec: number, isFinished: boolean) =>
      updateAudiobookPlaybackProgress(audiobookId, currentTimeSec, isFinished)
  );
  registerChannel('media:syncPlexAndAbs', () => syncPlexAndAudiobookshelfProgress());
  registerChannel('books:list', () =>
    getDb().prepare('SELECT * FROM books ORDER BY author ASC, title ASC').all()
  );
  registerChannel('audiobooks:list', () =>
    getDb().prepare('SELECT * FROM audiobooks ORDER BY author ASC, title ASC').all()
  );
  registerChannel('photos:list', () =>
    getDb().prepare('SELECT * FROM photos ORDER BY album_name ASC, title ASC').all()
  );
  registerChannel('musicVideos:list', () =>
    getDb()
      .prepare("SELECT * FROM videos WHERE type = 'music_video' ORDER BY artist ASC, title ASC")
      .all()
  );
  registerChannel('indexer:scanExtended', () => scanExtendedMediaSections());

  // --- Standalone/Server auth default (overridden by electron/main.ts in GUI) ---
  const serverAuth = () => ({
    authenticated: false,
    mode: 'standalone' as const,
    user: null,
    accessToken: null,
    expiresAt: null,
    supported: false,
  });
  registerChannel('auth:getState', serverAuth);
  registerChannel('auth:login', serverAuth);
  registerChannel('auth:logout', serverAuth);
}
