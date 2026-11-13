# RetroTunes (rTunes) — AI Development Governance & Architecture Guide

> **Notice to all AI coding assistants:** Read this document completely before modifying any file in this repository. Both `AGENTS.md` and `AIreadme.txt` are authoritative and must remain identical.

---

## 1. Architecture & Folder Map

RetroTunes (`rTunes` — Client Code: `ePod Suite`) is an Electron + React + TypeScript + SQLite desktop media player, homelab media gateway, and universal portable-device (ePod / MTP / UMS) sync engine.

### Directory Layout
- `src/` — **Renderer (React 19 + TypeScript + Vite)**
  - `src/App.tsx` — Main three-pane Aqua shell (Source Sidebar, 3D Cover Flow + virtualized Track/Video/Book/Audiobook/Photo views, inset LCD playback header, bottom segmented capacity/sync status bar).
  - `src/bridge.ts` — Typed IPC & HTTP fallback RPC client (`invokeRpc`, `subscribeEvent`).
  - `src/types.ts` — Shared TypeScript interfaces (`TrackRow`, `VideoRow`, `BookRow`, `AudiobookRow`, `PhotoRow`, `NetworkShareRow`, `DeviceProfile`, `DeviceInfo`, `AppSettings`, `LogEntry`, `LogSubsystem`).
  - `src/styles/rtunes.css` — Late-2000s Snow Leopard Aqua & Brushed Metal CSS theme.
  - `src/components/`:
    - `PreferencesModal.tsx` — Multi-tab Aqua Preferences (`Paths & Backend`, `NFS / SMB Shares`, `Devices`, `Cache & Transcoder`, `Authentik SSO`, `Store & API Keys`, `About & Credits`).
    - `AboutCreditsModal.tsx` — Dedicated **About RetroTunes & FOSS Credits** modal accessible from the app menu bar and toolbar.
    - `DeviceSummaryView.tsx` — Portable device summary, MTP storage pool selector, 1-click MTP migration, transcode settings, and segmented capacity bar.
    - `AddDeviceWizardModal.tsx` — Provisioning wizard for new UMS/MTP devices.
    - `SmartPlaylistModal.tsx` — Rule builder for dynamic Smart Playlists.
    - `StorefrontView.tsx` — **rTunes Store**, Multi-Source Top Charts, and live `*arr` Downloads Queue.
    - `UploadMediaWizardModal.tsx` — 4-step Smart Media Upload Wizard & `*arr` auto-import.
    - `DiagnosticsModal.tsx` — Live `> Logs` viewer and JSON diagnostic export.
- `electron/` (compiles to `dist-electron/`) — **Electron Main Process (TypeScript)**
  - `electron/main.ts` — App lifecycle, `BrowserWindow`, native `Menu`, HTTP RPC fallback (`127.0.0.1:42815`), and all `registerChannel(...)` IPC handlers.
  - `electron/preload.ts` — Context-isolated `rtunesElectron` bridge (`invoke`, `on`).
  - `electron/db.ts` — Synchronous `better-sqlite3` + FTS5 initialization, migrations, and `recalculateArtistPopularityScores`.
  - `electron/settings.ts` — Settings persistence in SQLite + OS Keychain / `safeStorage` secret storage.
  - `electron/logger.ts` — Ring-buffered, date/time-stamped structured logger + file rotation.
  - `electron/indexer.ts` — Phased background library scanner, on-demand/hybrid metadata hydration, ListenBrainz popularity, TVMaze/IMDb artwork, and Plex/Audiobookshelf progress sync.
  - `electron/cacheTranscoder.ts` — Local SSD LRU pre-cache and FFmpeg/HandBrakeCLI 360p H.264/AAC transcoder + cover art sanitizer.
  - `electron/deviceSync.ts` — Unified MTP (`rtunes-mtp`) + UMS (`DeviceTransportProvider`) sync engine, USB poller, `.m3u8` exporter, `.scrobbler.log` delta sync, and safe eject.
  - `electron/shareManager.ts` — Direct NFS / SMB mount manager and Docker Companion Server / Standalone DB abstraction.
  - `electron/smartPlaylists.ts` — SQL/filter evaluator for Smart Playlists.
  - `electron/storeArr.ts` — rTunes Store catalog, multi-source Top Charts (Deezer, Last.fm, TheAudioDB, Library Relative), and Lidarr/Radarr/Sonarr integration.
  - `electron/uploadWizard.ts` — Metadata lookup, `*arr` naming preview, file transfer, and `*arr` scan trigger.
  - `electron/authOidc.ts` — Underlying Authentik OIDC / OAuth2 PKCE flow and token management.
  - `electron/auth/authentik.ts` — Isolated SSO boundary (returns a guest/standalone context when `isDev === false`).
  - `electron/providers/standaloneLocal.ts` — Active default provider for local SQLite + direct NFS/SMB access (never modify for SSO or Docker server changes).
  - `electron/providers/remoteServer.ts` — Isolated stub/preview provider for future `rTunes-Server` Docker HTTPS/WebSocket API (gated behind `isDev === true`).
  - `electron/cli.ts` — Headless CLI entrypoint (`ELECTRON_RUN_AS_NODE=1` via `npm run cli -- <command>`).
  - `electron/transcoder/binaryManager.ts` — Startup auto-check & updater for managed `FFmpeg` and `HandBrakeCLI` binaries.
  - `electron/mediaServer.ts` — Local HTTP range-streaming server for audio/video playback.
  - `electron/platform/` — Cross-platform OS drivers: `darwin.ts`, `win32.ts`, `linux.ts`.
- `native/` — Native helpers (`native/rtunes_mtp.c` on macOS, `native/rtunes_wpd.cs` on Windows, compiled to `.toolchain/bin/rtunes-mtp`).

### Registered IPC Channels (`electron/main.ts`)
Do **not** duplicate existing handlers. Always reuse or extend the existing channels:
- **System & Logs:** `media:port`, `logs:get`, `logs:clear`, `logs:testEvent`
- **OS Dialogs & Settings:** `dialog:selectDirectory`, `dialog:selectFile`, `dialog:selectFiles`, `settings:get`, `settings:save`, `settings:testConnection`
- **Tracks & Videos:** `tracks:search`, `tracks:rate`, `tracks:recordPlay`, `tracks:hydrate`, `tracks:hydrateAlbum`, `tracks:getLyrics`, `videos:search`, `videos:markWatched`, `videos:hydrateArtwork`, `videos:updateProgress`, `audiobooks:updateProgress`
- **Extended Media & Sync:** `books:list`, `audiobooks:list`, `photos:list`, `musicVideos:list`, `media:syncPlexAndAbs`
- **Indexer:** `indexer:scan`, `indexer:cancel`, `indexer:progress`, `indexer:syncPopularity`, `indexer:recalculateMedians`, `indexer:cleanAllTitles`, `indexer:scanExtended`
- **Cache:** `cache:stats`, `cache:clear`, `cache:toggleTrack`, `cache:toggleAlbum`, `cache:toggleVideo`, `cache:toggleShow`, `cache:precacheAllPlaylists`, `transcoder:getBinaryStatus`, `transcoder:checkUpdateBinaries`
- **Playlists:** `playlists:list`, `playlists:getTracks`, `playlists:getVideos`, `playlists:create`, `playlists:update`, `playlists:delete`, `playlists:addTrack`, `playlists:removeTrack`, `playlists:addVideo`, `playlists:removeVideo`, `playlists:addShow`, `playlists:getExclusions`, `playlists:ignoreTrack`, `playlists:excludeTrackGlobally`, `playlists:restoreExclusion`
- **Devices (MTP & UMS):** `devices:volumes`, `devices:list`, `devices:provision`, `devices:updateProfile`, `devices:delete`, `devices:migrateToMtp`, `devices:sync`, `devices:cancelSync`, `devices:syncProgress`, `devices:eject`, `devices:getCatalog`, `devices:removeItem`
- **Shares & Upload:** `shares:list`, `shares:save`, `shares:delete`, `shares:mount`, `shares:unmount`, `shares:autoDetect`, `upload:searchMetadata`, `upload:previewPlan`, `upload:execute`
- **Store & Auth:** `store:home`, `store:search`, `store:request`, `store:charts`, `arr:queue`, `auth:getState`, `auth:login`, `auth:logout`

### SQLite Schema (`electron/db.ts`)
Core tables: `tracks`, `tracks_fts` (FTS5), `videos`, `videos_fts` (FTS5), `playlists`, `playlist_tracks`, `playlist_videos`, `smart_playlist_exclusions`, `devices`, `cache_jobs`, `settings`, `network_shares`, `device_play_state`, `books`, `audiobooks`, `photos`.

---

## 2. UI/UX Design System Lock

- **Mandatory Aesthetic:** Late-2000s (2009 Snow Leopard / classic desktop media player) skeuomorphic **Aqua & Brushed Metal** design language (`src/styles/rtunes.css`).
- **Required Visual Elements:**
  - Brushed-metal chrome titlebar and unified transport header.
  - Inset green-yellow backlit **LCD status display** with scrubbing, elapsed/remaining time, and track/sync status.
  - **3D Cover Flow** browser view.
  - Alternating **blue/white striped** virtualized media tables (`#edf3fe` / `#ffffff`).
  - Glossy **Aqua pill buttons** and **segmented bottom capacity bars** (Audio / Video / Other / Free).
- **Strictly Forbidden:** Modern flat dark-mode UI drift, Material/Tailwind generic dark cards, or replacing Aqua controls with minimalist flat wireframes.
- **Brand Purity:** Maintain **zero** mentions of forbidden legacy trademarked names in `src/`, `electron/`, `native/`, `index.html`, `package.json`, or `rtunes.sh`. Use **RetroTunes**, **rTunes**, **rTunes Store**, and **ePod**.

---

## 3. Mandatory FOSS & Contributor Credits Rule

Any commit that adds:
- an `npm` dependency in `package.json`,
- an external CLI binary or sidecar,
- a protocol library (`libmtp`, `libusb`, etc.), or
- a community firmware integration or external API

**MUST** update both:
1. [`CREDITS.md`](CREDITS.md) in the repository root (with project name, role, license, and attribution), and
2. The in-app **About & Credits** UI (`src/components/AboutCreditsModal.tsx` and the `About & Credits` tab in `src/components/PreferencesModal.tsx`).

---

## 4. Cross-Platform Driver Separation (`electron/platform/`)

- **Forbid** inline `process.platform === ...` branching in shared UI (`src/`), database (`electron/db.ts`), or sync business logic (`electron/deviceSync.ts`, `electron/shareManager.ts`).
- All OS-specific operations (USB volume enumeration, `diskutil`/WMI/`udisksctl` unmount & rename, Keychain/`safeStorage`/libsecret credentials, NFS/SMB mounting, and native MTP binary invocation) **must** live behind a clean `PlatformDriver` interface inside `electron/platform/`:
  - `electron/platform/darwin.ts` (macOS)
  - `electron/platform/win32.ts` (Windows)
  - `electron/platform/linux.ts` (Linux)

---

## 5. "Bi-Lingual" Path Discipline

- **Local Host OS Paths:** Always use Node's `path.join(...)` / `path.resolve(...)` for local filesystem access (`localCachePath`, staging directories, mounted `/Volumes/...` or drive letters).
- **Virtual / Remote / Device Paths:** Always use strict POSIX forward slashes (`path.posix`) for:
  - SQLite stored relative paths,
  - NFS/SMB share subpaths,
  - MTP device paths (`Root/Music/<Artist>/<Album>/<Track>`, `Root/Playlists/<Name>.m3u8`, `Root/Videos/Movies/...`, `Root/Videos/TV Shows/...`, `Root/Videos/Music Videos/...`, `Root/Pictures/...`, `Root/Books/...`, `Root/Audiobooks/...`),
  - Exported `.m3u8` playlist entries (`../Music/...`).
- Never allow Windows backslashes (`\`) to leak into SQLite keys, MTP commands, or `.m3u8` files.

---

## 6. Database Performance & Scale

- All media tables (`Tracks`, `Videos`, `Books`, `Audiobooks`, `Photos`) **must** use virtualized / windowed list rendering capable of smooth scrolling with **100,000+ tracks** (`tracks:search` default limit `200000` with SQLite FTS5).
- **Prohibit** live NFS, SMB, or MTP directory scans during UI typing/search or Smart Playlist evaluation. Search and Smart Playlists must query indexed SQLite tables exclusively.
- Library scanning and metadata hydration must run in background phases and yield to the event loop so the UI never freezes.

---

## 7. Zero Hardcoding & Git Hygiene

- **Zero Hardcoding:** Never hardcode LAN IPs, NAS hostnames, mount paths, user directories, or API keys in source code. Every configurable path, URL, and credential must live in `AppSettings` (`electron/settings.ts`) and **Prefs**, with secrets stored in OS Keychain / `safeStorage`.
- **Git Hygiene:** Never commit `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.db`, `logs/`, `*.log`, `node_modules/`, `dist/`, `dist-electron/`, `release/`, `out/`, `.toolchain/`, or `.env*`. Keep `.gitignore` enforced.

---

## 8. Device & Firmware Safety

- **Persistent Identity:** Track every ePod/MTP device by its persistent `uuid` and/or MTP USB `serial` in the SQLite `devices` table. Disconnected devices are hidden from the sidebar by default (unless `showOfflineDevices` is enabled in **Prefs -> Devices**) without deleting their profile or sync rules.
- **Delta Play Count Syncing:** Always reconcile `.scrobbler.log` and `.retrotunes_plays.json` using timestamps (`last_processed_scrobble_ts`) and `device_play_state` deltas. **Never** blindly overwrite or reset play counts.
- **Firmware Safety:** Any future device firmware update tooling must enforce **strict same-branch OS locking** and **block writes** to critical bootloader/partition regions (`PRELOADER`, `PMT`, `SEC_RO`) to prevent bricking portable hardware.

---

## 9. Structured Logging

- All background workers and services (`DEVICE_SYNC`, `INDEXER`, `TRANSCODE`, `CACHE`, `ARR_STORE`, `LISTENBRAINZ`, `LRCLIB`, `AUTH_OIDC`, `PLAYBACK`, `DB`, `SYSTEM`, `IPC`) **must** emit structured logs via `electron/logger.ts` (`logger.info`, `logger.warn`, `logger.error`, `logger.debug`) with subsystem tags, metadata objects, and optional duration in ms.
- All logs must remain compatible with the in-app **`> Logs`** Diagnostics modal (`DiagnosticsModal.tsx`) and JSON diagnostic export.
