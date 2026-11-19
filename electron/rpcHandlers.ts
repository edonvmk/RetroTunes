import fs from 'fs';
import os from 'os';
import { emitRendererEvent } from './runtimeBus';
import {
  getDb,
  getCoreDb,
  getStoreDb,
  getVideoDb,
  getDeltaSyncBatch,
  applyPlaybackDeltaSync,
  getLibraryRevision,
  PlaybackDeltaUpdate,
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
  redactSettingsForCaller,
  resolveAppMode,
  normalizeConfiguredServerUrl,
  resolveEffectiveRemoteServerUrl,
  verifyLocalPin,
  getStoredLocalPinHash,
  testIntegrationConnection,
  AppSettings,
} from './settings';
import {
  CallerContext,
  ForbiddenError,
  getCallerContext,
  RolePermissions,
} from './auth/callerContext';
import {
  changeUserPassword,
  computeEffectivePermissions,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  generateResetCode,
  getUserById,
  getUserPersonalSecrets,
  listRoles,
  listUsers,
  setUserOverrides,
  setUserRoles,
  updateRole,
  updateUser,
} from './auth/rbac';
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
  reconcileBackgroundWatchers,
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
  approvePendingStoreRequest,
  getStorefrontHome,
  searchStoreCatalog,
  requestStoreItem,
  rejectPendingStoreRequest,
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
  approvePendingUpload,
  searchUploadMetadata,
  buildUploadPreviewPlan,
  executeUploadAndArrImport,
  rejectPendingUpload,
  UploadMediaType,
} from './uploadWizard';
import { getMediaServerPort } from './mediaServer';
import { logger, LogLevel, LogSubsystem } from './logger';
import { platformDriver } from './platform';
import { reexportSyncedPlaylistM3u8 } from './deviceSync';
import { remoteServerProvider } from './providers/remoteServer';

export type RpcHandlerFn = (...args: any[]) => Promise<any> | any;
export type RpcRegisterFn = (channel: string, fn: RpcHandlerFn) => void;

const CHANNEL_MIN_PERMISSION: Record<string, { key: keyof RolePermissions; min: number }> = {
  'db:rebuild': { key: 'rebuildDb', min: 1 },
  'indexer:scan': { key: 'rescanLibrary', min: 1 },
  'indexer:cancel': { key: 'rescanLibrary', min: 1 },
  'indexer:syncPopularity': { key: 'rescanLibrary', min: 1 },
  'indexer:recalculateMedians': { key: 'rescanLibrary', min: 1 },
  'indexer:cleanAllTitles': { key: 'rescanLibrary', min: 1 },
  'indexer:deduplicate': { key: 'rescanLibrary', min: 1 },
  'indexer:scanExtended': { key: 'rescanLibrary', min: 1 },
  'logs:get': { key: 'viewServerLogs', min: 1 },
  'logs:clear': { key: 'viewServerLogs', min: 1 },
  'logs:testEvent': { key: 'viewServerLogs', min: 1 },
  'settings:save': { key: 'manageApiKeys', min: 1 },
  'settings:testConnection': { key: 'manageApiKeys', min: 1 },
  'transcoder:checkUpdateBinaries': { key: 'manageApiKeys', min: 1 },
  'transcoder:checkUpdates': { key: 'manageApiKeys', min: 1 },
  'cache:clear': { key: 'localCacheTier', min: 1 },
  'cache:precacheAllPlaylists': { key: 'localCacheTier', min: 1 },
  'cache:toggleTrack': { key: 'localCacheTier', min: 1 },
  'cache:toggleAlbum': { key: 'localCacheTier', min: 1 },
  'cache:toggleVideo': { key: 'localCacheTier', min: 1 },
  'cache:toggleShow': { key: 'localCacheTier', min: 1 },
  'tracks:hydrate': { key: 'libMusic', min: 2 },
  'tracks:hydrateAlbum': { key: 'libMusic', min: 2 },
  'books:list': { key: 'libBooks', min: 1 },
  'audiobooks:list': { key: 'libAudiobooks', min: 1 },
  'audiobooks:updateProgress': { key: 'libAudiobooks', min: 1 },
  'photos:list': { key: 'libPhotos', min: 1 },
  'musicVideos:list': { key: 'libMusicVideos', min: 1 },
  'egenius:createPlaylist': { key: 'featEgenius', min: 1 },
  'egenius:refreshPlaylist': { key: 'featEgenius', min: 1 },
  'egenius:convertToStandard': { key: 'featEgenius', min: 1 },
  'egenius:explainTrack': { key: 'featEgenius', min: 1 },
  'playlists:rerunAi': { key: 'featEgenius', min: 1 },
  'ai:prepare-model': { key: 'featEgenius', min: 1 },
  'ai:agent-turn': { key: 'featEgenius', min: 1 },
  'genreMatrix:get': { key: 'featGenreMap', min: 1 },
  'genreMatrix:testArtists': { key: 'featGenreMap', min: 1 },
  'genreMatrix:getArtistSlice': { key: 'featGenreMap', min: 1 },
  'genreMatrix:setCell': { key: 'featGenreMap', min: 2 },
  'genreMatrix:resetCell': { key: 'featGenreMap', min: 2 },
  'genreMatrix:rebuild': { key: 'featGenreMap', min: 2 },
  'upload:searchMetadata': { key: 'mediaUpload', min: 1 },
  'upload:previewPlan': { key: 'mediaUpload', min: 1 },
  'upload:execute': { key: 'mediaUpload', min: 1 },
  'store:request': { key: 'storeRequest', min: 1 },
  'playlists:save': { key: 'playlists', min: 1 },
  'playlists:delete': { key: 'playlists', min: 1 },
  'playlists:reorderTracks': { key: 'playlists', min: 1 },
  'playlists:addTrack': { key: 'playlists', min: 1 },
  'playlists:removeTrack': { key: 'playlists', min: 1 },
  'playlists:addVideo': { key: 'playlists', min: 1 },
  'playlists:removeVideo': { key: 'playlists', min: 1 },
  'playlists:addShow': { key: 'playlists', min: 1 },
  'playlists:regenerate': { key: 'playlists', min: 1 },
  'playlists:ignoreTrack': { key: 'playlists', min: 1 },
  'playlists:excludeTrackGlobally': { key: 'playlists', min: 1 },
  'playlists:restoreExclusion': { key: 'playlists', min: 1 },
  'uac:listUsers': { key: 'manageUac', min: 1 },
  'uac:createUser': { key: 'manageUac', min: 1 },
  'uac:updateUser': { key: 'manageUac', min: 1 },
  'uac:deleteUser': { key: 'manageUac', min: 1 },
  'uac:generateResetCode': { key: 'manageUac', min: 1 },
  'uac:listRoles': { key: 'manageUac', min: 1 },
  'uac:createRole': { key: 'manageUac', min: 1 },
  'uac:updateRole': { key: 'manageUac', min: 1 },
  'uac:deleteRole': { key: 'manageUac', min: 1 },
  'uac:setUserRoles': { key: 'manageUac', min: 1 },
  'uac:setUserOverrides': { key: 'manageUac', min: 1 },
};

export function assertChannelPermission(channel: string, caller: CallerContext): void {
  if (caller.isSuperAdmin) return;

  const exact = CHANNEL_MIN_PERMISSION[channel];
  if (exact) {
    const level = Number(caller.permissions[exact.key] ?? 0);
    if (level < exact.min) {
      throw new ForbiddenError(`Permission denied for ${channel} (requires ${exact.key} >= ${exact.min}).`);
    }
    return;
  }

  if (channel.startsWith('shares:') && caller.permissions.manageApiKeys < 1) {
    throw new ForbiddenError(`Permission denied for ${channel} (requires manageApiKeys).`);
  }
  if (channel.startsWith('devices:') && caller.permissions.featDevicesSync < 1) {
    throw new ForbiddenError(`Permission denied for ${channel} (requires featDevicesSync).`);
  }
  if (
    channel === 'videos:hydrateArtwork' &&
    Math.max(caller.permissions.libMovies, caller.permissions.libTvShows, caller.permissions.libMusicVideos) < 2
  ) {
    throw new ForbiddenError('Permission denied for video artwork editing.');
  }
  if (
    channel === 'uac:listPendingApprovals' &&
    caller.permissions.approveUploads < 1 &&
    caller.permissions.approveStore < 1 &&
    caller.permissions.manageUac < 1
  ) {
    throw new ForbiddenError('Permission denied for viewing approval queue.');
  }
}

function assertPlaylistWriteAccess(playlistId: number): void {
  const caller = getCallerContext();
  if (caller.isSuperAdmin) return;
  if (caller.permissions.playlists < 1) {
    throw new ForbiddenError('Your role has Read-Only playlist permissions.');
  }
  const pl = getDb()
    .prepare('SELECT owner_user_id FROM playlists WHERE id = ?')
    .get(playlistId) as { owner_user_id?: number | null } | undefined;
  if (!pl) return;
  if (pl.owner_user_id !== caller.userId && caller.permissions.playlists < 2) {
    throw new ForbiddenError('Your role can only modify your own personal playlists.');
  }
}

const UNSUPPORTED_SERVER_CHANNEL = () => ({ supported: false, mode: 'server' as const });

export function registerCoreRpcHandlers(
  registerChannel: RpcRegisterFn,
  options: { isDev?: boolean; mediaPortGetter?: () => number } = {}
): void {
  const isDev = Boolean(options.isDev);
  const getPort = options.mediaPortGetter || getMediaServerPort;

  // --- System & Diagnostics ---
  registerChannel('system:isDev', () => isDev);
  registerChannel('system:runtimeInfo', () => {
    const settings = getSettings();
    const runtime = resolveAppMode(settings.appMode);
    return {
      ...runtime,
      serverName: os.hostname(),
    };
  });
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
  registerChannel('settings:get', () => redactSettingsForCaller(getSettings(), getCallerContext()));
  registerChannel('settings:save', (partial: Partial<AppSettings>) => {
    const saved = saveSettings(partial);
    reconcileBackgroundWatchers(saved.appMode);
    return redactSettingsForCaller(saved, getCallerContext());
  });
  registerChannel('settings:testConnection', (target: any, overrideConfig?: Partial<AppSettings>) =>
    testIntegrationConnection(target, overrideConfig)
  );

  // --- Library Tracks & Videos (SQLite + FTS5) ---
  registerChannel('tracks:search', (query = '', limit = 200000) => {
    const caller = getCallerContext();
    if (!caller.isSuperAdmin && caller.permissions.libMusic < 1) return [];
    return searchTracksFts(query, limit);
  });
  registerChannel('tracks:rate', async (trackId: number, rating: number, isLoved?: boolean) => {
    const db = getDb();
    const caller = getCallerContext();
    if (!caller.isSuperAdmin && caller.permissions.libMusic < 1) {
      throw new ForbiddenError('Music library access is disabled for your role.');
    }
    const current = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as TrackRow | undefined;
    if (!current) return null;

    const newRating = Math.max(0, Math.min(5, Math.round(rating)));
    const newLoved = isLoved !== undefined ? (isLoved ? 1 : 0) : newRating === 5 ? 1 : current.is_loved;

    db.prepare('UPDATE tracks SET local_star_rating = ?, is_loved = ? WHERE id = ?').run(
      newRating,
      newLoved,
      trackId
    );
    if (caller.userId !== null && current.track_uid) {
      db.prepare(`
        INSERT INTO user_track_state (user_id, track_uid, loved, rating)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, track_uid) DO UPDATE SET loved = excluded.loved, rating = excluded.rating
      `).run(caller.userId, current.track_uid, newLoved, newRating);
    }

    const lbToken =
      caller.userId !== null
        ? getUserPersonalSecrets(caller.userId).listenbrainzToken
        : getSettings().listenbrainzToken;
    if (lbToken && current.mbid_recording && (newLoved === 1 || isLoved !== undefined)) {
      try {
        await fetch('https://api.listenbrainz.org/1/feedback/recording-feedback', {
          method: 'POST',
          headers: {
            Authorization: `Token ${lbToken.trim()}`,
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

    emitRendererEvent('library:updated', { current_rev: getLibraryRevision() });
    return db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
  });

  registerChannel('tracks:recordPlay', async (trackId: number) => {
    const db = getDb();
    const caller = getCallerContext();
    db.prepare("UPDATE tracks SET play_count = play_count + 1, last_played = datetime('now') WHERE id = ?").run(
      trackId
    );
    if (caller.userId !== null) {
      const tRow = db.prepare('SELECT track_uid FROM tracks WHERE id = ?').get(trackId) as
        | { track_uid?: string | null }
        | undefined;
      if (tRow?.track_uid) {
        db.prepare(`
          INSERT INTO user_track_state (user_id, track_uid, play_count, last_played_at)
          VALUES (?, ?, 1, datetime('now'))
          ON CONFLICT(user_id, track_uid) DO UPDATE SET
            play_count = user_track_state.play_count + 1,
            last_played_at = datetime('now')
        `).run(caller.userId, tRow.track_uid);
      }
    }
    if (getSettings().autoCachePlayback) {
      queueTrackCache(trackId, true);
    }
    emitRendererEvent('library:updated', { current_rev: getLibraryRevision() });
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

  registerChannel('videos:search', (query = '', typeFilter?: 'movie' | 'tv') => {
    const rows = searchVideosFts(query, typeFilter);
    const caller = getCallerContext();
    if (caller.isSuperAdmin) return rows;
    return rows.filter((v) => {
      if (v.type === 'movie') return caller.permissions.libMovies >= 1;
      if (v.type === 'tv') return caller.permissions.libTvShows >= 1;
      return caller.permissions.libMusicVideos >= 1;
    });
  });
  registerChannel('videos:markWatched', (videoId: number, watched: boolean) => {
    const db = getVideoDb();
    db.prepare('UPDATE videos SET watched = ? WHERE id = ?').run(watched ? 1 : 0, videoId);
    if (watched && getSettings().autoCachePlayback) {
      queueVideoTranscode(videoId, true);
    }
    return db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  });

  registerChannel('cache:toggleShow', (showName: string, keepCached: boolean) => {
    const db = getVideoDb();
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
    const caller = getCallerContext();
    const rows = (
      caller.isSuperAdmin || caller.userId === null
        ? db.prepare('SELECT * FROM playlists ORDER BY is_smart DESC, name ASC').all()
        : db
            .prepare(
              'SELECT * FROM playlists WHERE owner_user_id IS NULL OR owner_user_id = ? OR COALESCE(is_shared, 0) = 1 ORDER BY is_smart DESC, name ASC'
            )
            .all(caller.userId)
    ) as PlaylistRow[];
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
      isShared?: boolean;
      aiPrompt?: string | null;
      aiMode?: 'standard' | 'smart' | null;
    }) => {
      const db = getDb();
      const caller = getCallerContext();
      const rulesJson = payload.smartRules ? JSON.stringify(payload.smartRules) : null;
      const mediaType = payload.mediaType || 'music';
      const isShared = (caller.isSuperAdmin || caller.permissions.playlists >= 2) && Boolean(payload.isShared) ? 1 : 0;
      if (payload.id) {
        assertPlaylistWriteAccess(payload.id);
        db.prepare(`
          UPDATE playlists
          SET name = ?, is_smart = ?, media_type = ?, smart_rules_json = ?, limit_type = ?, limit_value = ?, track_limit = ?, selection_method = ?, keep_cached = ?, is_shared = COALESCE(?, is_shared), cached_track_ids_json = NULL, last_regenerated_at = NULL
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
          payload.isShared !== undefined ? isShared : null,
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
          INSERT INTO playlists (name, is_smart, media_type, smart_rules_json, limit_type, limit_value, track_limit, selection_method, keep_cached, owner_user, owner_user_id, is_shared, ai_prompt, ai_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          caller.username,
          caller.userId,
          isShared,
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
    assertPlaylistWriteAccess(playlistId);
    getDb().prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
    return { ok: true };
  });
  registerChannel('playlists:reorderTracks', (playlistId: number, trackIds: number[]) => {
    assertPlaylistWriteAccess(playlistId);
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
    assertPlaylistWriteAccess(playlistId);
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
    assertPlaylistWriteAccess(playlistId);
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
    assertPlaylistWriteAccess(playlistId);
    const coreDb = getCoreDb();
    const videoDb = getVideoDb();
    const pl = coreDb.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
      | PlaylistRow
      | undefined;
    if (pl && pl.media_type === 'music') {
      coreDb.prepare("UPDATE playlists SET media_type = 'mixed' WHERE id = ?").run(playlistId);
    }
    const maxPos = (
      videoDb
        .prepare('SELECT COALESCE(MAX(position), 0) as m FROM playlist_videos WHERE playlist_id = ?')
        .get(playlistId) as { m: number }
    ).m;
    videoDb
      .prepare('INSERT OR IGNORE INTO playlist_videos (playlist_id, video_id, position) VALUES (?, ?, ?)')
      .run(playlistId, videoId, maxPos + 1);
    return { ok: true };
  });
  registerChannel('playlists:removeVideo', (playlistId: number, videoId: number) => {
    assertPlaylistWriteAccess(playlistId);
    getVideoDb()
      .prepare('DELETE FROM playlist_videos WHERE playlist_id = ? AND video_id = ?')
      .run(playlistId, videoId);
    return { ok: true };
  });
  registerChannel('playlists:addShow', (playlistId: number, showName: string) => {
    assertPlaylistWriteAccess(playlistId);
    const coreDb = getCoreDb();
    const videoDb = getVideoDb();
    coreDb
      .prepare("UPDATE playlists SET media_type = 'mixed' WHERE id = ? AND media_type = 'music'")
      .run(playlistId);
    const eps = videoDb
      .prepare(
        "SELECT id FROM videos WHERE type = 'tv' AND show_name = ? ORDER BY season ASC, episode ASC"
      )
      .all(showName) as { id: number }[];
    let maxPos = (
      videoDb
        .prepare('SELECT COALESCE(MAX(position), 0) as m FROM playlist_videos WHERE playlist_id = ?')
        .get(playlistId) as { m: number }
    ).m;
    const ins = videoDb.prepare(
      'INSERT OR IGNORE INTO playlist_videos (playlist_id, video_id, position) VALUES (?, ?, ?)'
    );
    const tx = videoDb.transaction(() => {
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
  registerChannel('transcoder:checkUpdates', () =>
    checkAndUpdateTranscoderBinaries({ forceDownload: false, autoDownload: true })
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
    (videoId: number, viewOffsetMs: number, watched: boolean) => {
      const caller = getCallerContext();
      if (caller.userId !== null) {
        getVideoDb()
          .prepare(
            `INSERT INTO user_video_progress (user_id, video_id, view_offset_ms, watched, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(user_id, video_id) DO UPDATE SET
               view_offset_ms = excluded.view_offset_ms,
               watched = excluded.watched,
               updated_at = datetime('now')`
          )
          .run(caller.userId, videoId, viewOffsetMs, watched ? 1 : 0);
      }
      return updateVideoPlaybackProgress(videoId, viewOffsetMs, watched);
    }
  );
  registerChannel(
    'audiobooks:updateProgress',
    (audiobookId: number, currentTimeSec: number, isFinished: boolean) => {
      const caller = getCallerContext();
      if (caller.userId !== null) {
        getVideoDb()
          .prepare(
            `INSERT INTO user_audiobook_progress (user_id, audiobook_id, current_time_sec, is_finished, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(user_id, audiobook_id) DO UPDATE SET
               current_time_sec = excluded.current_time_sec,
               is_finished = excluded.is_finished,
               updated_at = datetime('now')`
          )
          .run(caller.userId, audiobookId, currentTimeSec, isFinished ? 1 : 0);
      }
      return updateAudiobookPlaybackProgress(audiobookId, currentTimeSec, isFinished);
    }
  );
  registerChannel('media:syncPlexAndAbs', () => syncPlexAndAudiobookshelfProgress());
  registerChannel('books:list', () =>
    getVideoDb().prepare('SELECT * FROM books ORDER BY author ASC, title ASC').all()
  );
  registerChannel('audiobooks:list', () =>
    getVideoDb().prepare('SELECT * FROM audiobooks ORDER BY author ASC, title ASC').all()
  );
  registerChannel('photos:list', () =>
    getVideoDb().prepare('SELECT * FROM photos ORDER BY album_name ASC, title ASC').all()
  );
  registerChannel('musicVideos:list', () =>
    getVideoDb()
      .prepare("SELECT * FROM videos WHERE type = 'music_video' ORDER BY artist ASC, title ASC")
      .all()
  );
  registerChannel('indexer:scanExtended', () => scanExtendedMediaSections());
  registerChannel('sync:delta', (sinceRev = 0, limit = 2000) =>
    getDeltaSyncBatch(Number(sinceRev) || 0, Number(limit) || 2000)
  );
  registerChannel('sync:playback', (updates: PlaybackDeltaUpdate[]) =>
    applyPlaybackDeltaSync(Array.isArray(updates) ? updates : [])
  );
  registerChannel('sync:remoteDelta', (serverUrl?: string, authToken?: string) => {
    const url = resolveEffectiveRemoteServerUrl(serverUrl);
    if (!url) return { ok: false, skipped: true };
    return remoteServerProvider.syncDeltaFromRemoteServer(url, authToken);
  });

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
  registerChannel('auth:setRemoteToken', (token: string | null, serverUrl?: string) => {
    const cleanedToken = (token || '').trim();
    const cleanedUrl = normalizeConfiguredServerUrl(serverUrl);
    saveSettings({
      remoteServerToken: cleanedToken,
      ...(cleanedUrl ? { dockerServerUrl: cleanedUrl, clientSource: 'remote' } : {}),
    });
    return { ok: true };
  });
  registerChannel('auth:probeRemoteServer', async (serverUrl: string) => {
    const base = String(serverUrl || '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'Missing server URL.' };
    const res = await fetch(`${base}/api/auth/info`);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const info = await res.json();
    return { ok: true, info };
  });
  registerChannel('auth:pinLogin', async (pin: string, serverUrl?: string) => {
    const base = String(serverUrl || '').trim().replace(/\/+$/, '');
    if (base) {
      const res = await fetch(`${base}/api/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      return res.json();
    }
    const storedHash = getStoredLocalPinHash();
    const ok = Boolean(storedHash && verifyLocalPin(String(pin || ''), storedHash));
    return ok ? { ok: true } : { ok: false, error: 'Invalid PIN.' };
  });

  // --- Multi-User Accounts, Scaled RBAC & Approval Queue ---
  registerChannel('uac:getMe', () => {
    const caller = getCallerContext();
    const user = caller.userId !== null ? getUserById(caller.userId) : null;
    const effective =
      caller.userId !== null
        ? computeEffectivePermissions(caller.userId)
        : { permissions: caller.permissions, isSuperAdmin: caller.isSuperAdmin };
    return {
      user,
      username: caller.username,
      displayName: caller.displayName,
      roles: caller.roles,
      isGuest: caller.isGuest,
      isSuperAdmin: effective.isSuperAdmin,
      authSource: caller.authSource,
      permissions: effective.permissions,
    };
  });

  registerChannel(
    'uac:updateMyProfile',
    async (patch: {
      displayName?: string;
      email?: string;
      phone?: string;
      listenbrainzToken?: string;
      listenbrainzUsername?: string;
    }) => {
      const caller = getCallerContext();
      if (caller.userId === null) {
        saveSettings({
          ...(patch.listenbrainzToken !== undefined ? { listenbrainzToken: patch.listenbrainzToken } : {}),
          ...(patch.listenbrainzUsername !== undefined ? { listenbrainzUsername: patch.listenbrainzUsername } : {}),
        });
        return { ok: true, user: null };
      }
      const user = await updateUser(caller.userId, patch);
      return { ok: true, user };
    }
  );

  registerChannel(
    'uac:changeMyPassword',
    (currentPassword: string, newPassword: string) => {
      const caller = getCallerContext();
      if (caller.userId === null) {
        throw new ForbiddenError('Password change is only supported for local server accounts.');
      }
      return changeUserPassword(caller.userId, currentPassword, newPassword);
    }
  );

  registerChannel('uac:listUsers', () => listUsers());
  registerChannel('uac:createUser', async (input: any) => {
    const res = await createUser(input);
    emitRendererEvent('uac:permissions-updated', { userId: res.id });
    return res;
  });
  registerChannel('uac:updateUser', async (userId: number, patch: any) => {
    const res = await updateUser(userId, patch);
    emitRendererEvent('uac:permissions-updated', { userId });
    return res;
  });
  registerChannel('uac:deleteUser', (userId: number) => {
    const res = deleteUser(userId);
    emitRendererEvent('uac:permissions-updated', { userId });
    return res;
  });
  registerChannel('uac:generateResetCode', (userId: number) => generateResetCode(userId));
  registerChannel('uac:listRoles', () => listRoles());
  registerChannel('uac:createRole', (input: any) => {
    const res = createRole(input);
    emitRendererEvent('uac:permissions-updated', { roleId: res.id });
    return res;
  });
  registerChannel('uac:updateRole', (roleId: number, patch: any) => {
    const res = updateRole(roleId, patch);
    emitRendererEvent('uac:permissions-updated', { roleId });
    return res;
  });
  registerChannel('uac:deleteRole', (roleId: number) => {
    const res = deleteRole(roleId);
    emitRendererEvent('uac:permissions-updated', { roleId });
    return res;
  });
  registerChannel('uac:setUserRoles', (userId: number, roleIds: number[]) => {
    const res = setUserRoles(userId, roleIds);
    emitRendererEvent('uac:permissions-updated', { userId });
    return res;
  });
  registerChannel('uac:setUserOverrides', (userId: number, overrides: Partial<RolePermissions> | null) => {
    const res = setUserOverrides(userId, overrides);
    emitRendererEvent('uac:permissions-updated', { userId });
    return res;
  });

  registerChannel('uac:listPendingApprovals', () => {
    const caller = getCallerContext();
    const storeDb = getStoreDb();
    const canUploads = caller.isSuperAdmin || caller.permissions.approveUploads >= 1 || caller.permissions.manageUac >= 1;
    const canStore = caller.isSuperAdmin || caller.permissions.approveStore >= 1 || caller.permissions.manageUac >= 1;
    const uploads = canUploads
      ? storeDb
          .prepare("SELECT * FROM upload_history WHERE approval_status = 'pending' ORDER BY id DESC")
          .all()
      : [];
    const storeRequests = canStore
      ? storeDb
          .prepare("SELECT * FROM store_requests WHERE approval_status = 'pending' ORDER BY id DESC")
          .all()
      : [];
    return { uploads, storeRequests };
  });

  registerChannel('uac:approvePendingItem', (kind: 'upload' | 'store', id: number) => {
    const caller = getCallerContext();
    if (kind === 'upload') {
      if (!caller.isSuperAdmin && caller.permissions.approveUploads < 1) {
        throw new ForbiddenError('Permission denied: requires approveUploads permission.');
      }
      return approvePendingUpload(id, { userId: caller.userId, username: caller.username });
    }
    if (!caller.isSuperAdmin && caller.permissions.approveStore < 1) {
      throw new ForbiddenError('Permission denied: requires approveStore permission.');
    }
    return approvePendingStoreRequest(id, { userId: caller.userId, username: caller.username });
  });

  registerChannel('uac:rejectPendingItem', (kind: 'upload' | 'store', id: number, reason?: string) => {
    const caller = getCallerContext();
    if (kind === 'upload') {
      if (!caller.isSuperAdmin && caller.permissions.approveUploads < 1) {
        throw new ForbiddenError('Permission denied: requires approveUploads permission.');
      }
      return rejectPendingUpload(id, { userId: caller.userId, username: caller.username }, reason);
    }
    if (!caller.isSuperAdmin && caller.permissions.approveStore < 1) {
      throw new ForbiddenError('Permission denied: requires approveStore permission.');
    }
    return rejectPendingStoreRequest(id, { userId: caller.userId, username: caller.username }, reason);
  });
}
