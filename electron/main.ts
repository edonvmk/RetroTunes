import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { emitRendererEvent, getAppDataPath, openExternalUrl } from './runtimeBus';
import { initDatabase, closeAllDatabases } from './db';
import {
  getSettings,
  saveSettings,
  resolveAppMode,
  resolveEffectiveRemoteServerUrl,
} from './settings';
import {
  runLibraryScan,
  hasPendingIndexCheckpoint,
  hydrateVideoArtwork,
  startBackgroundMetadataTrickle,
  syncPlexAndAudiobookshelfProgress,
  reconcileBackgroundWatchers,
  stopBackgroundWatchers,
} from './indexer';
import {
  listMountedVolumes,
  getRegisteredDevicesAsync,
  provisionDevice,
  updateDeviceProfile,
  deleteRegisteredDevice,
  syncDevice,
  cancelDeviceSync,
  getSyncProgress,
  ejectDevice,
  migrateDeviceToMtp,
  startMtpUsbPoller,
  getDeviceCatalog,
  removeDeviceCatalogItem,
  DeviceProfile,
} from './deviceSync';
import { runStartupTranscoderCheck } from './transcoder/binaryManager';
import {
  autoMountSharesOnStartup,
  unmountAllManagedSharesOnQuit,
} from './shareManager';
import {
  initAuthentikAuth,
  getAuthentikAuthState,
  loginWithAuthentik,
  logoutAuthentik,
} from './auth/authentik';
import { startMediaServer } from './mediaServer';
import { registerCoreRpcHandlers, RpcHandlerFn } from './rpcHandlers';
import { startUnifiedHttpServer, bootHeadlessServer } from './server';
import { remoteServerProvider } from './providers/remoteServer';
import { createLocalOwnerCallerContext, runWithCallerContext } from './auth/callerContext';
import { ensureRbacSeeded } from './auth/rbac';
import { logger } from './logger';
import { platformDriver } from './platform';

try {
  app.setPath('userData', getAppDataPath());
} catch {
  // ignore if running outside Electron app context
}

export const isDev =
  (!app.isPackaged && process.env.NODE_ENV !== 'production') ||
  process.env.NODE_ENV === 'development' ||
  process.argv.includes('--dev');

const handlerRegistry = new Map<string, RpcHandlerFn>();

function registerChannel(channel: string, fn: RpcHandlerFn) {
  handlerRegistry.set(channel, fn);
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (_event, ...args) => {
    const start = Date.now();
    try {
      const result = await runWithCallerContext(createLocalOwnerCallerContext(), () =>
        fn(...args)
      );
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
  registerCoreRpcHandlers(registerChannel, { isDev });

  // --- Electron GUI Dialogs & Shell ---
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
  registerChannel('shell:showItemInFolder', (targetPath?: string) => {
    if (!targetPath || typeof targetPath !== 'string') {
      return { ok: false, error: 'No file path available for this item.' };
    }
    const resolved = path.resolve(targetPath);
    if (fs.existsSync(resolved)) {
      shell.showItemInFolder(resolved);
      return { ok: true, path: resolved };
    }
    return { ok: false, error: `File not accessible on this host: ${targetPath}` };
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
  registerChannel('devices:delete', (uuid: string) => deleteRegisteredDevice(uuid));
  registerChannel('devices:getCatalog', (uuid: string) => getDeviceCatalog(uuid));
  registerChannel('devices:removeItem', (uuid: string, devicePath: string, storageId?: string) =>
    removeDeviceCatalogItem(uuid, devicePath, storageId)
  );
  registerChannel('devices:cancelSync', () => {
    cancelDeviceSync();
    return { ok: true };
  });
  registerChannel('devices:syncProgress', () => getSyncProgress());
  registerChannel('devices:eject', (uuid: string) => ejectDevice(uuid));
  registerChannel('devices:getAutoOpenOnMtp', () => platformDriver.getAutoOpenOnMtp());
  registerChannel('devices:setAutoOpenOnMtp', (enabled: boolean) => {
    const launchCmd = app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${app.getAppPath()}"`;
    return platformDriver.setAutoOpenOnMtp(enabled, launchCmd);
  });

  // --- Settings save triggers live LAN host server start/stop + watcher reconciliation ---
  registerChannel('settings:save', (partial) => {
    const saved = saveSettings(partial);
    syncOptionalLanServer(saved);
    reconcileBackgroundWatchers(saved.appMode);
    return saved;
  });

  // --- Authentik OIDC SSO ---
  registerChannel('auth:getState', () => getAuthentikAuthState(true));
  registerChannel('auth:login', () => loginWithAuthentik(true));
  registerChannel('auth:logout', () => logoutAuthentik(true));
}

let activeLanServer: {
  server: import('http').Server;
  port: number;
  serveStaticDist: boolean;
} | null = null;

function syncOptionalLanServer(settings = getSettings(), options: { isInitialBoot?: boolean } = {}) {
  const shouldRun = settings.appMode === 'desktop-server';
  const desiredPort = Number(settings.lanServerPort) || 3000;
  const runtime = resolveAppMode(settings.appMode);
  const serveStaticDist = runtime.webUiEnabled && settings.desktopServerWebUiEnabled !== false;

  if (!shouldRun) {
    if (activeLanServer) {
      activeLanServer.server.close();
      activeLanServer = null;
      logger.info('SYSTEM', 'Stopped desktop LAN host HTTP server.');
    }
    return;
  }

  if (
    activeLanServer &&
    activeLanServer.port === desiredPort &&
    activeLanServer.serveStaticDist === serveStaticDist
  ) {
    return;
  }
  if (activeLanServer) {
    activeLanServer.server.close();
    activeLanServer = null;
  }

  void startUnifiedHttpServer({
    port: desiredPort,
    host: runtime.cliHost || '0.0.0.0',
    registry: handlerRegistry,
    serveStaticDist,
    mountMedia: true,
    appMode: settings.appMode,
    enforceAuthGate: true,
  })
    .then((started) => {
      activeLanServer = { ...started, serveStaticDist };
      if (options.isInitialBoot && serveStaticDist && settings.desktopServerAutoOpenWebUi) {
        const browserUrl = `http://127.0.0.1:${started.port}`;
        logger.info('SYSTEM', `Auto-launching Desktop Server Web UI in browser: ${browserUrl}`);
        openExternalUrl(browserUrl);
      }
    })
    .catch((err) => {
      logger.warn('SYSTEM', `Failed to start LAN server on port ${desiredPort}`, { error: String(err) });
    });
}

function startHttpFallbackAndOptionalLanServer() {
  void startUnifiedHttpServer({
    port: 42815,
    host: '127.0.0.1',
    registry: handlerRegistry,
    mountMedia: true,
  }).catch(() => {});

  syncOptionalLanServer(getSettings(), { isInitialBoot: true });
}

function sendUiEvent(channel: string) {
  emitRendererEvent(channel);
}

function setupApplicationMenu() {
  const isMac = platformDriver.isMacOsStyleMenu;
  if (!isMac) {
    // Remove the native File/Edit/View/Help bar on Windows & Linux so the brushed-metal bar sits flush.
    Menu.setApplicationMenu(null);
    return;
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'RetroTunes',
            submenu: [
              {
                label: 'About RetroTunes (rTunes) & Credits',
                click: () => sendUiEvent('ui:openAbout'),
              },
              { type: 'separator' as const },
              {
                label: 'Preferences...',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendUiEvent('ui:openPreferences'),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        ...(!isMac
          ? [
              {
                label: 'Preferences...',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendUiEvent('ui:openPreferences'),
              },
              { type: 'separator' as const },
            ]
          : []),
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About RetroTunes (rTunes) & FOSS Credits',
          click: () => sendUiEvent('ui:openAbout'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'RetroTunes (rTunes)',
    backgroundColor: '#d4dae2',
    autoHideMenuBar: !platformDriver.isMacOsStyleMenu,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: isDev ? ['--rtunes-dev'] : [],
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  const runtimeBoot = resolveAppMode(undefined, process.argv);
  if (runtimeBoot.isHeadless) {
    logger.info('SYSTEM', `Booting RetroTunes in ${runtimeBoot.appMode} mode...`, {
      lockReason: runtimeBoot.lockReason,
      webUiEnabled: runtimeBoot.webUiEnabled,
    });
    await bootHeadlessServer();
    return;
  }

  logger.info('SYSTEM', `Booting RetroTunes (rTunes) - Client Code: ePod Suite...`, { isDev });
  initDatabase();
  ensureRbacSeeded();
  const currentSettings = getSettings();
  initAuthentikAuth(true);
  await startMediaServer();
  registerAllHandlers();
  startHttpFallbackAndOptionalLanServer();
  setupApplicationMenu();
  createMainWindow();
  startMtpUsbPoller();
  reconcileBackgroundWatchers(currentSettings.appMode);
  const autoMountPromise = autoMountSharesOnStartup().catch(() => {});
  // Resume gentle background metadata & video artwork hydration
  setTimeout(async () => {
    await autoMountPromise;
    const activeSettings = getSettings();
    const isRemoteClient =
      activeSettings.appMode === 'client' && activeSettings.clientSource === 'remote';
    const remoteUrl = isRemoteClient
      ? resolveEffectiveRemoteServerUrl(activeSettings.dockerServerUrl)
      : resolveEffectiveRemoteServerUrl(process.env.RTUNES_SERVER_URL);
    if (remoteUrl) {
      void remoteServerProvider.syncDeltaFromRemoteServer(remoteUrl).catch((err) => {
        logger.warn('SYSTEM', 'Initial remote delta sync skipped', { error: String(err) });
      });
    }
    if (hasPendingIndexCheckpoint() && !isRemoteClient) {
      logger.info('INDEXER', 'Detected interrupted library scan/rebuild checkpoint; resuming automatically...');
      void runLibraryScan(undefined, { resume: true });
    }
    if (!isRemoteClient) {
      void hydrateVideoArtwork();
      void syncPlexAndAudiobookshelfProgress();
      if (activeSettings.metadataHydrationMode === 'hybrid') {
        void startBackgroundMetadataTrickle();
      }
    }
  }, 2500);

  // Non-blocking startup check & auto-update for FFmpeg / HandBrakeCLI
  setTimeout(() => {
    void runStartupTranscoderCheck(currentSettings.appMode);
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('will-quit', () => {
  stopBackgroundWatchers();
  if (activeLanServer) {
    try {
      activeLanServer.server.close();
    } catch {
      // ignore
    }
    activeLanServer = null;
  }
  void unmountAllManagedSharesOnQuit();
  closeAllDatabases();
});

app.on('window-all-closed', () => {
  if (platformDriver.quitOnAllWindowsClosed) {
    app.quit();
  }
});
