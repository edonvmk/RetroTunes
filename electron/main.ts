import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import http from 'http';
import fs from 'fs';
import {
  initDatabase,
  getDb,
  searchTracksFts,
  searchVideosFts,
  recalculateArtistPopularityScores,
  getDatabaseDiagnostics,
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
  startBackgroundMetadataTrickle,
  syncListenBrainzPopularity,
  cleanAndHydrateAllLibraryTitles,
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
  SmartRuleGroup,
} from './smartPlaylists';
import {
  listMountedVolumes,
  getRegisteredDevices,
  getRegisteredDevicesAsync,
  provisionDevice,
  updateDeviceProfile,
  syncDevice,
  cancelDeviceSync,
  getSyncProgress,
  ejectDevice,
  migrateDeviceToMtp,
  startMtpUsbPoller,
  DeviceProfile,
} from './deviceSync';
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
  autoMountSharesOnStartup,
  unmountAllManagedSharesOnQuit,
  NetworkShareInput,
} from './shareManager';
import {
  searchUploadMetadata,
  buildUploadPreviewPlan,
  executeUploadAndArrImport,
  UploadMediaType,
} from './uploadWizard';
import {
  initAuthFromKeychain,
  getPublicAuthState,
  startAuthentikPkceLogin,
  logoutAuthentikSso,
} from './authOidc';
import { startMediaServer, getMediaServerPort } from './mediaServer';
import { logger, LogLevel, LogSubsystem } from './logger';

type HandlerFn = (...args: any[]) => Promise<any> | any;
const handlerRegistry = new Map<string, HandlerFn>();

function registerChannel(channel: string, fn: HandlerFn) {
  handlerRegistry.set(channel, fn);
  ipcMain.handle(channel, async (_event, ...args) => {
    const start = Date.now();
    try {
      const result = await fn(...args);
      if (channel !== 'logs:get' && channel !== 'media:port' && channel !== 'arr:queue') {
        logger.debug('IPC', `Handled ${channel}`, { argsCount: args.length }, Date.now() - start);
      }
      return result;
    } catch (err) {
      logger.error('IPC', `IPC Handler error on ${channel}`, err, Date.now() - start);
      throw err;
    }
  });
}

function registerAllHandlers() {
  // --- System & Diagnostics ---
  registerChannel('media:port', () => getMediaServerPort());
  registerChannel('logs:get', (filter?: { level?: LogLevel; subsystem?: LogSubsystem; search?: string; limit?: number }) => {
    return {
      entries: logger.getEntries(filter),
      paths: logger.getLogPaths(),
      dbDiagnostics: getDatabaseDiagnostics(),
    };
  });
  registerChannel('logs:clear', () => {
    logger.clearEntries();
    return { ok: true };
  });
  registerChannel('logs:testEvent', (level: LogLevel, subsystem: LogSubsystem, message: string) => {
    return logger.log(level, subsystem, message, { triggeredBy: 'User Diagnostic Test' });
  });

  // --- OS Dialogs ---
  registerChannel('dialog:selectDirectory', async (title?: string) => {
    const res = await dialog.showOpenDialog({
      title: title || 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });
  registerChannel('dialog:selectFile', async (title?: string) => {
    const res = await dialog.showOpenDialog({
      title: title || 'Select Binary or File',
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });
  registerChannel('dialog:selectFiles', async (title?: string) => {
    const res = await dialog.showOpenDialog({
      title: title || 'Select Media Files to Upload',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths;
  });

  // --- Settings & Connection Testers ---
  registerChannel('settings:get', () => getSettings());
  registerChannel('settings:save', (partial: Partial<AppSettings>) => saveSettings(partial));
  registerChannel('settings:testConnection', (target: any, overrideConfig?: Partial<AppSettings>) =>
    testIntegrationConnection(target, overrideConfig)
  );

  // --- Library Tracks & Videos (SQLite + FTS5, Zero Live-Network Scanning) ---
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

    // Push feedback directly to ListenBrainz if token & mbid_recording exist (Section 6)
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
    db.prepare(
      "UPDATE tracks SET play_count = play_count + 1, last_played = datetime('now') WHERE id = ?"
    ).run(trackId);
    // Auto-cache played media locally to reduce NAS streaming
    if (getSettings().autoCachePlayback) {
      queueTrackCache(trackId, true);
    }
    // On-demand metadata & cover art hydration when a track is played
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

  // --- Regular & Smart Playlists ---
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
    }) => {
      const db = getDb();
      const rulesJson = payload.smartRules ? JSON.stringify(payload.smartRules) : null;
      const mediaType = payload.mediaType || 'music';
      if (payload.id) {
        db.prepare(`
          UPDATE playlists
          SET name = ?, is_smart = ?, media_type = ?, smart_rules_json = ?, limit_type = ?, limit_value = ?, track_limit = ?, selection_method = ?, keep_cached = ?
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
      } else {
        const res = db
          .prepare(`
            INSERT INTO playlists (name, is_smart, media_type, smart_rules_json, limit_type, limit_value, track_limit, selection_method, keep_cached)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            payload.keepCached ? 1 : 0
          );
        const newId = Number(res.lastInsertRowid);
        if (payload.keepCached) {
          for (const t of getPlaylistTracks(newId)) {
            queueTrackCache(t.id, true);
          }
        }
        return newId;
      }
    }
  );
  registerChannel('playlists:delete', (playlistId: number) => {
    const db = getDb();
    db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
    return { ok: true };
  });
  registerChannel('playlists:addTrack', (playlistId: number, trackId: number) => {
    const db = getDb();
    const maxPos = (
      db
        .prepare('SELECT COALESCE(MAX(position), 0) as m FROM playlist_tracks WHERE playlist_id = ?')
        .get(playlistId) as { m: number }
    ).m;
    db.prepare(
      'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
    ).run(playlistId, trackId, maxPos + 1);
    return { ok: true };
  });
  registerChannel('playlists:removeTrack', (playlistId: number, trackId: number) => {
    const db = getDb();
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(
      playlistId,
      trackId
    );
    return { ok: true };
  });
  registerChannel('playlists:addVideo', (playlistId: number, videoId: number) => {
    const db = getDb();
    const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as
      | PlaylistRow
      | undefined;
    if (pl && pl.media_type === 'music') {
      // Automatically upgrade playlist to 'mixed' if user drops a video onto a regular playlist
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
    const db = getDb();
    db.prepare('DELETE FROM playlist_videos WHERE playlist_id = ? AND video_id = ?').run(
      playlistId,
      videoId
    );
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

  // --- Universal ePod Device Manager & Sync (MTP + UMS) ---
  registerChannel('devices:volumes', () => listMountedVolumes());
  registerChannel('devices:list', () => getRegisteredDevicesAsync());
  registerChannel('devices:provision', (mountPath: string, profileInput: any) =>
    provisionDevice(mountPath, profileInput)
  );
  registerChannel('devices:updateProfile', async (uuid: string, profile: DeviceProfile) => {
    await updateDeviceProfile(uuid, profile);
    return getRegisteredDevicesAsync();
  });
  registerChannel('devices:migrateToMtp', (uuid: string, targetStorageId?: string) =>
    migrateDeviceToMtp(uuid, targetStorageId)
  );
  registerChannel('devices:sync', (uuid: string) => syncDevice(uuid));
  registerChannel('devices:cancelSync', () => {
    cancelDeviceSync();
    return { ok: true };
  });
  registerChannel('devices:syncProgress', () => getSyncProgress());
  registerChannel('devices:eject', (uuid: string) => ejectDevice(uuid));

  // --- Priority 2: Direct NFS / SMB Mount Manager ---
  registerChannel('shares:list', () => listNetworkShares());
  registerChannel('shares:save', (input: NetworkShareInput) => saveNetworkShare(input));
  registerChannel('shares:delete', (id: number) => deleteNetworkShare(id));
  registerChannel('shares:mount', (id: number) => mountNetworkShare(id));
  registerChannel('shares:unmount', (id: number) => unmountNetworkShare(id));
  registerChannel('shares:autoDetect', (mountPoint: string) => autoDetectShareFolders(mountPoint));

  // --- Priority 4: Smart Media Upload Wizard & *arr Auto-Import ---
  registerChannel('upload:searchMetadata', (mediaType: UploadMediaType, query: string) =>
    searchUploadMetadata(mediaType, query)
  );
  registerChannel('upload:previewPlan', (params: any) => buildUploadPreviewPlan(params));
  registerChannel('upload:execute', (params: any) => executeUploadAndArrImport(params));

  // --- rTunes Store (*arr Request Gateway, Multi-Source Charts & Live Queue) ---
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

  // --- Priority 6 & 7: Extended Media Sections & Resume Sync ---
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

  // --- Authentik OIDC SSO ---
  registerChannel('auth:getState', () => getPublicAuthState());
  registerChannel('auth:login', () => startAuthentikPkceLogin());
  registerChannel('auth:logout', () => logoutAuthentikSso());
}

function startHttpRpcFallbackServer(port = 42815) {
  const srv = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const { channel, args } = JSON.parse(body) as { channel: string; args?: unknown[] };
          const fn = handlerRegistry.get(channel);
          if (!fn) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown RPC channel: ${channel}` }));
            return;
          }
          const data = await fn(...(args || []));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  srv.on('error', () => {
    // Ignore if port already bound
  });
  srv.listen(port, '127.0.0.1', () => {
    logger.info('SYSTEM', `Diagnostic HTTP RPC bridge listening on http://127.0.0.1:${port}/rpc`);
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'RetroTunes (rTunes)',
    backgroundColor: '#d4dae2',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  logger.info('SYSTEM', 'Booting RetroTunes (rTunes) - Client Code: ePod Suite...');
  initDatabase();
  initAuthFromKeychain();
  await startMediaServer();
  registerAllHandlers();
  startHttpRpcFallbackServer(42815);
  createMainWindow();
  startMtpUsbPoller();
  void autoMountSharesOnStartup();
  // Resume gentle background metadata & video artwork hydration
  setTimeout(() => {
    void hydrateVideoArtwork();
    void syncPlexAndAudiobookshelfProgress();
    if (getSettings().metadataHydrationMode === 'hybrid') {
      void startBackgroundMetadataTrickle();
    }
  }, 2500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('will-quit', () => {
  void unmountAllManagedSharesOnQuit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
