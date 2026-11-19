# RetroTunes (`rTunes`) — AI Module Map

> **Mandatory for AI Assistants:** Consult this map **before** creating any new file, helper, or IPC channel so existing modules are reused instead of duplicated. Update this file whenever you add, delete, or wire new connections between modules.

---

## 1. Architecture & Dependency Flow

```
Renderer (src/)
  └── src/bridge.ts (invokeRpc, subscribeEvent, getMediaBaseUrl)
        ├── Electron IPC ──▶ electron/preload.ts ──▶ electron/main.ts ──▶ electron/rpcHandlers.ts
        └── HTTP / Web ────▶ electron/server.ts (/rpc, /events SSE, /api/upload-files, /api/health, dist/)
                                   │                                        ▲
                                   ▼                                        │
Shared Core (electron/, Electron-free via runtimeBus.ts) ───────────────────┘
  ├── electron/runtimeBus.ts (emitRendererEvent, onRendererEvent, getAppDataPath, getSafeStorage, openExternalUrl)
  ├── electron/db.ts (5-domain WAL split: core.sqlite, affinity_cache.sqlite, video.sqlite, store.sqlite, users.sqlite + track_uid delta sync)
  ├── electron/settings.ts (AppSettings + OS Keychain / safeStorage)
  ├── electron/logger.ts (ring buffer + rotating logs -> log:entry)
  ├── electron/platform/{index,types,darwin,win32,linux}.ts (OS drivers)
  └── Feature Services (indexer, trackSources, mediaServer, cacheTranscoder,
                        smartPlaylists, egenius/*, ai/llamaService, deviceSync,
                        shareManager, storeArr, uploadWizard, transcoder/binaryManager)
```

---

## 2. Renderer Modules (`src/`)

| Module | Owns / Exports | Connects To |
|---|---|---|
| `src/main.tsx` | React 19 root mount | `src/App.tsx`, `src/styles/rtunes.css` |
| `src/App.tsx` | Three-pane Aqua shell, Cover Flow, virtualized media tables, LCD transport, dual-buffer next-track preloader, context menus, sidebar device sub-tree & `ACCESS CONTROL` section, app-wide RBAC UI gating | `src/bridge.ts`, `src/types.ts`, `src/components/*` |
| `src/bridge.ts` | `invokeRpc` (incl. remote `uac:*` routing), `subscribeEvent` (IPC + remote SSE `/events`), `getRpcBaseUrl`, `getMediaBaseUrl`, `fetchSyncDelta`, `postPlaybackSync`, `probeRemoteServerAuth`, `loginWithPin`, `setupServerMasterAccount`, `loginWithPassword`, `resetPasswordWithCode`, `logoutServerSession`, `fetchAuthMe`, `getStoredAuthToken`, `setStoredAuthToken`, `setConfiguredRemoteServerUrl`, `appendAuthTokenParam`, `resetSharedEventSource`, `isDevMode`, `formatDuration`, `formatBytes` | `window.rtunesElectron`, `window.electronAPI`, `main.ts`, `server.ts` |
| `src/types.ts` | Shared renderer/IPC interfaces (`TrackRow`, `VideoRow`, `BookRow`, `AudiobookRow`, `PhotoRow`, `DeviceInfo`, `DeviceCatalog`, `AppSettings`, `RolePermissions`, `CallerMeResponse`, `PendingApprovalsPayload`, `DEFAULT_LOCAL_OWNER_PERMISSIONS`, etc.) | Consumed across `src/` |
| `src/styles/rtunes.css` | Late-2000s Snow Leopard Aqua & Brushed Metal CSS theme | `src/main.tsx` |

### Renderer AI & Modals (`src/ai/`, `src/components/`)
| Module | Owns / Exports | Connects To |
|---|---|---|
| `src/ai/modelRegistry.ts` | `AI_MODEL_CATALOG`, `getDefaultAiModel` | `AiPlaylistModal.tsx` |
| `src/ai/PlaylistAgent.ts` | `PlaylistProvider`, `LocalLlamaProvider`, `RemoteMcpServerProvider` stub, `PlaylistAgent`, `PLAYLIST_TOOL_DEFINITIONS` | `src/bridge.ts` (`ai:agent-turn`, `ai:dispose-model`) |
| `src/components/PreferencesModal.tsx` | Tabs: Profile & Paths (4-profile + remote auto-handshake + server UI customization), NFS/SMB Shares, Devices, Cache & Transcoder (`.present`, `vaapi`, scheduled updates, Role Cache Quota pill), Auth & Profile (My Account, ListenBrainz, Password Change, Sign Out & gated Server Auth Gate), Store & API Keys (`manageApiKeys` gated), Genre Map, Actions & Help, About & Credits | `GenreMapTab.tsx`, `AboutCreditsModal.tsx`, `bridge.ts`, `system:runtimeInfo`, `uac:*` |
| `src/components/UacWorkspaceView.tsx` | Brushed-metal split-pane Access Control workspace (3D Policy Card Flow & Category Browser for all 22 `RolePermissions`, striped Role Members table, All Users Effective Access Inspector & Direct Overrides grid, Pending Approvals Queue, `+ New User...`/`+ New Role...`/`Reset Code` modals) | `uac:*` RPCs, `App.tsx`, `src/types.ts` |
| `src/components/GenreMapTab.tsx` | 2D Subgenre Adjacency Matrix heatmap editor + Live Artist Scene Tester | `genreMatrix:*` IPC channels |
| `src/components/DeviceSummaryView.tsx` | Device summary, MTP storage pool selector, 1-click MTP migration, transcode settings, capacity bar | `devices:*` IPC channels |
| `src/components/AddDeviceWizardModal.tsx` | UMS/MTP provisioning wizard | `devices:volumes`, `devices:provision` |
| `src/components/SmartPlaylistModal.tsx` | Nested Smart Playlist rule builder + live SQL preview | `playlists:previewSmart`, `playlists:save` |
| `src/components/AiPlaylistModal.tsx` | Pre-Alpha AI Playlist Generator (model selector, `0–50%` / `50–100%` loader, chat, track preview) | `modelRegistry.ts`, `PlaylistAgent.ts`, `ai:*` IPC |
| `src/components/StorefrontView.tsx` | rTunes Storefront, multi-source Top Charts, `*arr` Downloads Queue (supports `approvalRequired` CTA) | `store:*`, `arr:queue` IPC |
| `src/components/UploadMediaWizardModal.tsx` | 4-step Smart Media Upload Wizard, browser `POST /api/upload-files` staging & `*arr` scan trigger (supports `approvalRequired` CTA) | `upload:*` IPC, `dialog:selectFiles`, `POST /api/upload-files` |
| `src/components/DiagnosticsModal.tsx` | Live `> Logs` viewer & diagnostic JSON export | `logs:get`, `logs:clear`, `logs:testEvent` |
| `src/components/AboutCreditsModal.tsx` | FOSS & community attribution modal (`FossCreditsContent`) | `CREDITS.md` (must stay in sync) |
| `src/components/OnboardingAuthModals.tsx` | Aqua `ServerSetupModal` (`Label` first-run), `UnifiedAuthModal` (Account/PIN/OIDC/Reset Code), and `ClientOnboardingModal` | `bridge.ts` (`/api/auth/*`), `App.tsx` |

---

## 3. Electron Shell & Entrypoints (`electron/`)

| Module | Owns / Exports | Connects To |
|---|---|---|
| `electron/main.ts` | `BrowserWindow`, app menu, `--headless*` handoff, desktop-only GUI/USB IPC overrides, HTTP `:42815` & `desktop-server` LAN `server.ts` listener | `rpcHandlers.ts`, `server.ts`, `runtimeBus.ts`, `preload.ts` |
| `electron/preload.ts` | `contextBridge` exposing `window.rtunesElectron` & `window.electronAPI` | `electron/main.ts`, `src/bridge.ts` |
| `electron/rpcHandlers.ts` | Shared Electron-free RPC handler registry (`registerCoreRpcHandlers`, `assertChannelPermission`, `uac:*` CRUD & approval handlers, `uac:permissions-updated` live SSE emits, `system:runtimeInfo`, `transcoder:checkUpdates`, `auth:*`, `auth:setRemoteToken`) | All shared backend services, `main.ts`, `server.ts`, `auth/rbac.ts` |
| `electron/server.ts` | Headless `rTunes-Server` / `--headless-client` HTTP/SSE/Media/Sync + multi-user auth/setup endpoints (`/api/auth/info`, `/api/auth/setup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/reset-with-code`, `/api/auth/me`, `/api/auth/pin-login`) + RBAC enforcement (`401`/`403`) + OIDC userinfo validation + CWD-independent `dist/` static resolution | `rpcHandlers.ts`, `auth/callerContext.ts`, `auth/rbac.ts`, `mediaServer.ts`, `runtimeBus.ts`, `db.ts`, `indexer.ts`, `transcoder/binaryManager.ts`, `dist/` |
| `electron/cli.ts` | Headless CLI (`npm run cli -- <command>`), `--help`, `--headless*` launcher, 5-DB `doctor`, `status`, `auth setup`, `client <login|logout|sync>`, `uac <users|roles|suspend|activate|approvals|approve|reject>`, and `reset-password` | `server.ts`, `auth/rbac.ts`, `providers/remoteServer.ts`, `transcoder/binaryManager.ts`, `uploadWizard.ts`, `storeArr.ts`, `db.ts`, `deviceSync.ts`, `indexer.ts`, `egenius/`, `platform/` |
| `electron/providers/standaloneLocal.ts` | Active local SQLite + direct NFS/SMB provider | `main.ts` |
| `electron/providers/remoteServer.ts` | Remote `rTunes-Server` delta cache sync (`syncDeltaFromRemoteServer`, `pushPlaybackToRemoteServer` with bearer token auth) | `db.ts`, `settings.ts`, `runtimeBus.ts`, `main.ts`, `rpcHandlers.ts`, `cli.ts` |

---

## 4. Shared Core Backend (`electron/` — Electron-Free)

> **Rule:** None of these modules may import `electron` directly. Always use `electron/runtimeBus.ts` for renderer events, paths, `openExternalUrl`, or `safeStorage`.

| Module | Owns / Exports | Connects To |
|---|---|---|
| `electron/runtimeBus.ts` | `isElectronGuiRuntime`, `emitRendererEvent`, `onRendererEvent`, `getAppDataPath`, `getAppPath` (CWD-independent `dist/` fallback), `isPackaged`, `getSafeStorage`, `openExternalUrl` | Used by all shared backend modules & `main.ts` |
| `electron/authOidc.ts` | Electron-free Authentik OIDC / OAuth2 PKCE flow & token refresh (uses `runtimeBus`) | `runtimeBus.ts`, `auth/authentik.ts`, `settings.ts`, `platform/` |
| `electron/auth/authentik.ts` | Authentik OIDC SSO gateway boundary | `authOidc.ts`, `main.ts` |
| `electron/auth/callerContext.ts` | Electron-free `AsyncLocalStorage<CallerContext>`, `RolePermissions` scales (`Roadie`/`Band`/`Label`), `ForbiddenError`/`UnauthorizedError`, `requirePermission` | Zero internal deps (used by `rbac.ts`, `server.ts`, `rpcHandlers.ts`, `main.ts`, `settings.ts`, `storeArr.ts`, `uploadWizard.ts`, `scrobbler.ts`) |
| `electron/auth/secretVault.ts` | Application-level `AES-256-GCM` credential vault (`encryptSecret`, `decryptSecret`, `isEncryptedSecret`) with external master key (`RTUNES_SECRET_KEY`, `.rtunes.key.enc`, or `0o600` `.rtunes.key`) | `runtimeBus.ts`, `settings.ts`, `rbac.ts`, `platform/win32.ts`, `platform/linux.ts` |
| `electron/auth/rbac.ts` | `users.sqlite` multi-user & role CRUD, `scrypt` password hashing, encrypted personal `listenbrainz_token` (`resolvePersonalListenBrainzCredentials`), persistent 30-day `sessions`, `Label`/`Band`/`Roadie` presets, `RTUNES_ADMIN_USER` bootstrap, reset codes | `db.ts`, `logger.ts`, `settings.ts`, `secretVault.ts`, `callerContext.ts` |
| `electron/scrobbler.ts` | Local play history logger (`users.sqlite -> user_play_history`) & deferred ListenBrainz scrobble queue (`recordUserPlay`, `submitNowPlaying`, `getScrobbleQueueStats`, `flushPendingScrobbles`) | `db.ts`, `logger.ts`, `auth/callerContext.ts`, `auth/rbac.ts`, `rpcHandlers.ts`, `deviceSync.ts` |
| `electron/db.ts` | 5-domain WAL split (`getCoreDb`, `getCacheDb`, `getVideoDb`, `getStoreDb`, `getUsersDb`, `getDomainDatabaseHealth`), fast-fail ABI guard in `openConfiguredDb`, legacy `rtunes.sqlite` migration, `computeTrackUid`, `getDeltaSyncBatch`, `applyPlaybackDeltaSync`, `recalculateArtistPopularityScores`, `emitPendingApprovalsUpdate`, `closeAllDatabases` | `better-sqlite3`, `platform/`, `runtimeBus.ts`, `logger.ts` |
| `electron/settings.ts` | 4-profile mode resolution (`resolveAppMode`), `normalizeConfiguredServerUrl`, `resolveEffectiveRemoteServerUrl`, `resolveEffectiveRemoteServerToken`, `redactSettingsForCaller`, salted `scryptSync` PIN helpers, `getSettings`, `saveSettings`, `testIntegrationConnection`, `getKeychainSecret`, `setKeychainSecret` | `db.ts`, `auth/callerContext.ts`, `auth/rbac.ts`, `platform/`, `logger.ts` |
| `electron/logger.ts` | `logger` (`debug`, `info`, `warn`, `error`), ring buffer, rotating log files under `RTUNES_DATA_DIR/logs` | `runtimeBus.ts` (`log:entry`) |
| `electron/indexer.ts` | Phased library scanner, ID3/Vorbis/artwork hydration, ListenBrainz/Last.fm/AudioDB popularity, TVMaze/IMDb posters, Plex/Audiobookshelf progress sync, `reconcileBackgroundWatchers`, `stopBackgroundWatchers` | `db.ts`, `settings.ts`, `trackSources.ts`, `egenius/genreMatrix.ts`, `runtimeBus.ts` |
| `electron/trackSources.ts` | `buildTrackMatchKey`, `extractCanonicalMediaSubpath`, `resolveReachableTrackPath`, `scoreAudioQuality`, `parseAlternateSources`, `serializeAlternateSources` | `indexer.ts`, `mediaServer.ts`, `cacheTranscoder.ts` |
| `electron/mediaServer.ts` | `handleMediaHttpRequest` & HTTP byte-range streaming (`/track`, `/video`, `/artwork`), dynamic FFmpeg live `.mkv`/`.avi` remuxing | `db.ts`, `settings.ts`, `trackSources.ts`, `transcoder/binaryManager.ts`, `server.ts` |
| `electron/cacheTranscoder.ts` | Local SSD LRU cache, 360p H.264/AAC video transcoder, 500×500 cover art sanitizer | `db.ts`, `settings.ts`, `trackSources.ts`, `transcoder/binaryManager.ts`, `runtimeBus.ts` |
| `electron/transcoder/binaryManager.ts` | Scheduled startup check (`runStartupTranscoderCheck`) & GitHub Releases auto-updater (`checkAndUpdateTranscoderBinaries`) for `FFmpeg` / `FFprobe` / `HandBrakeCLI` in `userData/bin`, `detectHardwareEncoder` (`vt_h264`/`nvenc`/`qsv`/`vaapi`/`libx264`) | `runtimeBus.ts`, `settings.ts` |
| `electron/smartPlaylists.ts` | `evaluateSmartPlaylist`, `getPlaylistTracks`, `getPlaylistVideos`, `generateRelativeM3u8`, Smart Playlist exclusion helpers | `db.ts`, `logger.ts` |
| `electron/egenius/*` | `index.ts`, `types.ts`, `affinityCache.ts`, `genreMatrix.ts`, `variantFilter.ts`, `scorer.ts`, `sequencer.ts` | `db.ts`, `settings.ts`, `logger.ts` |
| `electron/ai/llamaService.ts` | `node-llama-cpp` GGUF downloader/loader (`0–50%` / `50–100%`), `models-manifest.json` cache, 5-tool agent loop | `runtimeBus.ts`, `db.ts`, `settings.ts`, `egenius/affinityCache.ts`, `egenius/genreMatrix.ts` |
| `electron/deviceSync.ts` | Unified MTP (`rtunes-mtp`) & UMS sync, dynamic multi-drive placement, `.retrotunes_catalog.json` manifest & reconciliation, `.scrobbler.log` delta sync, `deleteRegisteredDevice`, `reexportSyncedPlaylistM3u8` | `db.ts`, `smartPlaylists.ts`, `platform/`, `runtimeBus.ts` |
| `electron/shareManager.ts` | Direct NFS/SMB share persistence, mount/unmount, auto-detect | `db.ts`, `settings.ts`, `platform/`, `authOidc.ts` |
| `electron/storeArr.ts` | rTunes Storefront catalog, multi-source Top Charts, Lidarr/Radarr/Sonarr queue & requests | `settings.ts`, `db.ts`, `logger.ts` |
| `electron/uploadWizard.ts` | Metadata lookup, `*arr` naming preview, file copy, scan trigger | `settings.ts`, `db.ts`, `logger.ts` |

---

## 5. Platform Drivers, Native Helpers & Scripts

| Module | Owns / Exports | Connects To |
|---|---|---|
| `electron/platform/types.ts` | `PlatformDriver` interface | `darwin.ts`, `win32.ts`, `linux.ts` |
| `electron/platform/index.ts` | Selects active `platformDriver` (`darwin` / `win32` / `linux`) | All backend modules needing OS ops |
| `electron/platform/darwin.ts` | macOS `diskutil`, Keychain, `mount_nfs`/`smbutil`, `rtunes-mtp` (`libmtp`) | `native/rtunes_mtp.c` |
| `electron/platform/win32.ts` | Windows WMI/PowerShell volumes, `safeStorage` via `runtimeBus`, AutoPlay registry, `rtunes-mtp.exe` (WPD) | `runtimeBus.ts`, `native/rtunes_wpd.cs` |
| `electron/platform/linux.ts` | Linux `udisksctl`, `secret-tool`/`safeStorage` via `runtimeBus`, `rtunes-mtp` | `runtimeBus.ts` |
| `native/rtunes_mtp.c` | macOS `libmtp` CLI helper -> `.toolchain/bin/rtunes-mtp` | `scripts/electron-tasks.mjs` |
| `native/rtunes_wpd.cs` | Windows WPD (`PortableDeviceApi`) CLI helper -> `.toolchain/bin/rtunes-mtp.exe` | `scripts/electron-tasks.mjs` |
| `scripts/electron-tasks.mjs` | Cross-platform MTP compiler, native module rebuilder, Electron launcher | `package.json` scripts |
