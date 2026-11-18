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
  ├── electron/runtimeBus.ts (emitRendererEvent, onRendererEvent, getAppDataPath, getSafeStorage)
  ├── electron/db.ts (SQLite + FTS5 + WAL + busy_timeout)
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
| `src/App.tsx` | Three-pane Aqua shell, Cover Flow, virtualized media tables, LCD transport, context menus, sidebar device sub-tree | `src/bridge.ts`, `src/types.ts`, `src/components/*` |
| `src/bridge.ts` | `invokeRpc`, `subscribeEvent` (IPC or SSE `/events`), `getRpcBaseUrl`, `getMediaBaseUrl`, `isDevMode`, `formatDuration`, `formatBytes` | `window.rtunesElectron`, `window.electronAPI`, `main.ts` HTTP/SSE |
| `src/types.ts` | Shared renderer/IPC interfaces (`TrackRow`, `VideoRow`, `BookRow`, `AudiobookRow`, `PhotoRow`, `DeviceInfo`, `DeviceCatalog`, `AppSettings`, `SmartRuleGroup`, etc.) | Consumed across `src/` |
| `src/styles/rtunes.css` | Late-2000s Snow Leopard Aqua & Brushed Metal CSS theme | `src/main.tsx` |

### Renderer AI & Modals (`src/ai/`, `src/components/`)
| Module | Owns / Exports | Connects To |
|---|---|---|
| `src/ai/modelRegistry.ts` | `AI_MODEL_CATALOG`, `getDefaultAiModel` | `AiPlaylistModal.tsx` |
| `src/ai/PlaylistAgent.ts` | `PlaylistProvider`, `LocalLlamaProvider`, `RemoteMcpServerProvider` stub, `PlaylistAgent`, `PLAYLIST_TOOL_DEFINITIONS` | `src/bridge.ts` (`ai:agent-turn`, `ai:dispose-model`) |
| `src/components/PreferencesModal.tsx` | Tabs: Paths & Backend, NFS/SMB Shares, Devices, Cache & Transcoder, Authentik SSO, Store & API Keys, Genre Map, Actions & Help, About & Credits | `GenreMapTab.tsx`, `AboutCreditsModal.tsx`, `bridge.ts` |
| `src/components/GenreMapTab.tsx` | 2D Subgenre Adjacency Matrix heatmap editor + Live Artist Scene Tester | `genreMatrix:*` IPC channels |
| `src/components/DeviceSummaryView.tsx` | Device summary, MTP storage pool selector, 1-click MTP migration, transcode settings, capacity bar | `devices:*` IPC channels |
| `src/components/AddDeviceWizardModal.tsx` | UMS/MTP provisioning wizard | `devices:volumes`, `devices:provision` |
| `src/components/SmartPlaylistModal.tsx` | Nested Smart Playlist rule builder + live SQL preview | `playlists:previewSmart`, `playlists:save` |
| `src/components/AiPlaylistModal.tsx` | Pre-Alpha AI Playlist Generator (model selector, `0–50%` / `50–100%` loader, chat, track preview) | `modelRegistry.ts`, `PlaylistAgent.ts`, `ai:*` IPC |
| `src/components/StorefrontView.tsx` | rTunes Storefront, multi-source Top Charts, `*arr` Downloads Queue | `store:*`, `arr:queue` IPC |
| `src/components/UploadMediaWizardModal.tsx` | 4-step Smart Media Upload Wizard, browser `POST /api/upload-files` staging & `*arr` scan trigger | `upload:*` IPC, `dialog:selectFiles`, `POST /api/upload-files` |
| `src/components/DiagnosticsModal.tsx` | Live `> Logs` viewer & diagnostic JSON export | `logs:get`, `logs:clear`, `logs:testEvent` |
| `src/components/AboutCreditsModal.tsx` | FOSS & community attribution modal (`FossCreditsContent`) | `CREDITS.md` (must stay in sync) |

---

## 3. Electron Shell & Entrypoints (`electron/`)

| Module | Owns / Exports | Connects To |
|---|---|---|
| `electron/main.ts` | `BrowserWindow`, app menu, desktop-only GUI/USB IPC overrides, HTTP `:42815` & optional LAN `server.ts` listener | `rpcHandlers.ts`, `server.ts`, `runtimeBus.ts`, `preload.ts` |
| `electron/preload.ts` | `contextBridge` exposing `window.rtunesElectron` & `window.electronAPI` | `electron/main.ts`, `src/bridge.ts` |
| `electron/rpcHandlers.ts` | Shared Electron-free RPC handler registry (`registerCoreRpcHandlers`) & headless server stubs | All shared backend services, `main.ts`, `server.ts` |
| `electron/server.ts` | Headless `rTunes-Server` HTTP/SSE/Media/Static Web UI/Upload entrypoint (`PORT=3000`) & optional desktop LAN listener | `rpcHandlers.ts`, `mediaServer.ts`, `runtimeBus.ts`, `db.ts`, `dist/` |
| `electron/cli.ts` | Headless CLI (`npm run cli -- <command>` via `ELECTRON_RUN_AS_NODE=1`) | `db.ts`, `deviceSync.ts`, `indexer.ts`, `storeArr.ts`, `egenius/`, `platform/` |
| `electron/providers/standaloneLocal.ts` | Active local SQLite + direct NFS/SMB provider | `main.ts` |
| `electron/providers/remoteServer.ts` | Isolated `rTunes-Server` Docker stub (gated behind `isDev`) | `main.ts` |

---

## 4. Shared Core Backend (`electron/` — Electron-Free)

> **Rule:** None of these modules may import `electron` directly. Always use `electron/runtimeBus.ts` for renderer events, paths, `openExternalUrl`, or `safeStorage`.

| Module | Owns / Exports | Connects To |
|---|---|---|
| `electron/runtimeBus.ts` | `isElectronGuiRuntime`, `emitRendererEvent`, `onRendererEvent`, `getAppDataPath`, `getAppPath`, `isPackaged`, `getSafeStorage`, `openExternalUrl` | Used by all shared backend modules & `main.ts` |
| `electron/authOidc.ts` | Electron-free Authentik OIDC / OAuth2 PKCE flow & token refresh (uses `runtimeBus`) | `runtimeBus.ts`, `auth/authentik.ts`, `settings.ts`, `platform/` |
| `electron/auth/authentik.ts` | Dev-mode SSO boundary (returns standalone guest context when `isDev === false`) | `authOidc.ts`, `main.ts` |
| `electron/db.ts` | `initDatabase`, `getDb`, `getDbPath` (`RTUNES_DB_PATH` / `RTUNES_DATA_DIR`), WAL + `busy_timeout = 5000`, FTS5 (`searchTracksFts`, `searchVideosFts`), `recalculateArtistPopularityScores` | `better-sqlite3`, `platform/`, `logger.ts` |
| `electron/settings.ts` | `getSettings`, `saveSettings`, `testIntegrationConnection`, `getKeychainSecret`, `setKeychainSecret` | `db.ts`, `platform/`, `logger.ts` |
| `electron/logger.ts` | `logger` (`debug`, `info`, `warn`, `error`), ring buffer, rotating log files | `runtimeBus.ts` (`log:entry`) |
| `electron/indexer.ts` | Phased library scanner, ID3/Vorbis/artwork hydration, ListenBrainz/Last.fm/AudioDB popularity, TVMaze/IMDb posters, Plex/Audiobookshelf progress sync | `db.ts`, `settings.ts`, `trackSources.ts`, `egenius/genreMatrix.ts`, `runtimeBus.ts` |
| `electron/trackSources.ts` | `buildTrackMatchKey`, `extractCanonicalMediaSubpath`, `resolveReachableTrackPath`, `scoreAudioQuality`, `parseAlternateSources`, `serializeAlternateSources` | `indexer.ts`, `mediaServer.ts`, `cacheTranscoder.ts` |
| `electron/mediaServer.ts` | `handleMediaHttpRequest` & HTTP byte-range streaming (`/track`, `/video`, `/artwork`), dynamic FFmpeg live `.mkv`/`.avi` remuxing | `db.ts`, `settings.ts`, `trackSources.ts`, `transcoder/binaryManager.ts`, `server.ts` |
| `electron/cacheTranscoder.ts` | Local SSD LRU cache, 360p H.264/AAC video transcoder, 500×500 cover art sanitizer | `db.ts`, `settings.ts`, `trackSources.ts`, `transcoder/binaryManager.ts`, `runtimeBus.ts` |
| `electron/transcoder/binaryManager.ts` | Startup check & GitHub Releases auto-updater for `FFmpeg` / `HandBrakeCLI` in `userData/bin`, `detectHardwareEncoder` | `runtimeBus.ts`, `settings.ts` |
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
