# RetroTunes (rTunes) — AI Development Governance & Architecture Guide

> **Notice to all AI coding assistants:** Read this document completely before modifying any file in this repository. Both `AGENTS.md` and `AIreadme.txt` are authoritative and must remain identical.
>
> **Module Map Rule:** Before creating any new file, helper, or IPC channel, consult [`MODULE_MAP.md`](MODULE_MAP.md) to reuse existing modules and avoid duplicate code. Whenever you add, delete, or wire new connections between modules, **you MUST update [`MODULE_MAP.md`](MODULE_MAP.md)** in the same change.
>
> **Electron Isolation Rule (Node / Docker / CLI Safety):** Never import `electron` (`app`, `BrowserWindow`, `ipcMain`, `dialog`, `Menu`, `shell`, `safeStorage`) inside shared backend modules (`db.ts`, `indexer.ts`, `logger.ts`, `cacheTranscoder.ts`, `deviceSync.ts`, `shareManager.ts`, `smartPlaylists.ts`, `storeArr.ts`, `uploadWizard.ts`, `mediaServer.ts`, `rpcHandlers.ts`, `server.ts`, `authOidc.ts`, `egenius/*`, `ai/llamaService.ts`, `transcoder/*`, `platform/*`, `cli.ts`). Those modules must run in plain Node.js / Docker (`rTunes-Server`) and `ELECTRON_RUN_AS_NODE=1` CLI. Always use `electron/runtimeBus.ts` (`emitRendererEvent`, `getAppDataPath`, `getAppPath`, `isPackaged`, `getSafeStorage`, `openExternalUrl`) instead, keeping direct `electron` imports confined to `electron/main.ts` and `electron/preload.ts`.

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
    - `GenreMapTab.tsx` — ECU-style 2D Subgenre Adjacency Matrix heatmap editor, cell trim/lock controls, and Live Artist Scene Tester (hosted inside **Prefs -> Genre Map**).
    - `UploadMediaWizardModal.tsx` — 4-step Smart Media Upload Wizard & `*arr` auto-import / approval staging.
    - `OnboardingAuthModals.tsx` — First-run Server Setup (`Label` master account), Unified Login/PIN/Reset-Code modal, and Client First-Run Onboarding wizard.
    - `DiagnosticsModal.tsx` — Live `> Logs` viewer and JSON diagnostic export.
- `electron/` (compiles to `dist-electron/`) — **Electron Main Process & Headless Server (TypeScript)**
  - `electron/main.ts` — App lifecycle, `BrowserWindow`, native `Menu`, `--headless*` handoff, desktop GUI/USB IPC overrides (inside local-owner `CallerContext`), HTTP RPC fallback (`127.0.0.1:42815`), and `desktop-server` LAN HTTP server (`syncOptionalLanServer`).
  - `electron/preload.ts` — Context-isolated `rtunesElectron` bridge (`invoke`, `on`).
  - `electron/rpcHandlers.ts` — Shared Electron-free RPC handler registry (`registerCoreRpcHandlers`), `assertChannelPermission`, UAC/approval handlers (`uac:*`), and secret redaction.
  - `electron/server.ts` — Headless `rTunes-Server` / `--headless-client` unified HTTP + SSE (`/events`) + JSON-RPC (`/rpc`) + multi-user auth/setup endpoints (`/api/auth/info`, `/api/auth/setup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/reset-with-code`, `/api/auth/me`, `/api/auth/pin-login`) + RBAC enforcement (`401`/`403`) + multipart browser upload (`/api/upload-files`) + range media streaming (`/track`, `/video`, `/artwork`) + static `dist/` SPA server (`--no-web-ui` / `RTUNES_WEB_UI=false` opt-out, `PORT=3000`, `HOST=0.0.0.0` or `127.0.0.1`, `RTUNES_DATA_DIR=/config`, `RTUNES_MEDIA_DIR=/media`).
  - `electron/db.ts` — Synchronous `better-sqlite3` + FTS5 5-domain DB initialization (`getCoreDb`, `getCacheDb`, `getVideoDb`, `getStoreDb`, `getUsersDb`), migrations, and `recalculateArtistPopularityScores`.
  - `electron/settings.ts` — 4-profile runtime mode resolution (`resolveAppMode`), `redactSettingsForCaller`, salted `scryptSync` local PIN hashing, settings persistence in SQLite + OS Keychain / `safeStorage`.
  - `electron/logger.ts` — Ring-buffered, date/time-stamped structured logger + file rotation.
  - `electron/indexer.ts` — Phased background library scanner, on-demand/hybrid metadata hydration, ListenBrainz popularity, TVMaze/IMDb artwork, Plex/Audiobookshelf progress sync, and profile-aware `reconcileBackgroundWatchers` / `stopBackgroundWatchers`.
  - `electron/cacheTranscoder.ts` — Local SSD LRU pre-cache and FFmpeg/HandBrakeCLI 360p H.264/AAC transcoder + cover art sanitizer.
  - `electron/deviceSync.ts` — Unified MTP (`rtunes-mtp`) + UMS (`DeviceTransportProvider`) sync engine, USB poller, `.m3u8` exporter, `.scrobbler.log` delta sync, and safe eject.
  - `electron/shareManager.ts` — Direct NFS / SMB mount manager and remote `rTunes-Server` transport abstraction.
  - `electron/smartPlaylists.ts` — SQL/filter evaluator for Smart Playlists.
  - `electron/storeArr.ts` — rTunes Store catalog, multi-source Top Charts, Lidarr/Radarr/Sonarr requests with `storeRequest` approval staging (`approvePendingStoreRequest` / `rejectPendingStoreRequest`).
  - `electron/uploadWizard.ts` — Metadata lookup, `*arr` naming preview, staged approval queue (`approvePendingUpload` / `rejectPendingUpload`), file transfer, and `*arr` scan trigger.
  - `electron/authOidc.ts` — Underlying Authentik OIDC / OAuth2 PKCE flow and token management.
  - `electron/auth/authentik.ts` — Authentik SSO gateway boundary.
  - `electron/auth/callerContext.ts` — Electron-free `AsyncLocalStorage<CallerContext>`, `RolePermissions` scale definitions, and `requirePermission` / `ForbiddenError` / `UnauthorizedError`.
  - `electron/auth/rbac.ts` — Multi-user account CRUD, async `scrypt` password hashing, persistent `sessions` (`users.sqlite`), `Label`/`Band`/`Roadie` presets + custom roles ("Highest Access Wins"), reset codes, and `RTUNES_ADMIN_USER` bootstrap.
  - `electron/providers/standaloneLocal.ts` — Active default provider for local SQLite + direct NFS/SMB access.
  - `electron/providers/remoteServer.ts` — Remote `rTunes-Server` delta cache & playback sync provider (`syncDeltaFromRemoteServer`, `pushPlaybackToRemoteServer`).
  - `electron/cli.ts` — Headless CLI entrypoint (`ELECTRON_RUN_AS_NODE=1` via `npm run cli -- <command>`, `--headless*` flags, and `reset-password <username> [--password <newpass>]`).
  - `electron/runtimeBus.ts` — Electron-free event bus & path/keychain runtime abstraction for shared backend modules.
  - `electron/transcoder/binaryManager.ts` — Scheduled startup auto-check (`runStartupTranscoderCheck`) & updater for managed `FFmpeg`, `FFprobe`, and `HandBrakeCLI` binaries, plus hardware encoder detection (including Linux VA-API).
  - `electron/mediaServer.ts` — Local HTTP range-streaming server for audio/video playback.
  - `electron/platform/` — Cross-platform OS drivers: `darwin.ts`, `win32.ts`, `linux.ts`.
- `native/` — Native helpers (`native/rtunes_mtp.c` on macOS, `native/rtunes_wpd.cs` on Windows, compiled to `.toolchain/bin/rtunes-mtp`).

### Registered IPC Channels (`electron/main.ts`)
Do **not** duplicate existing handlers. Always reuse or extend the existing channels:
- **System & Logs:** `system:isDev`, `system:runtimeInfo`, `system:credentialStoreLabel`, `media:port`, `logs:get`, `logs:clear`, `logs:testEvent`
- **OS Dialogs & Settings:** `dialog:selectDirectory`, `dialog:selectFile`, `dialog:selectFiles`, `settings:get`, `settings:save`, `settings:testConnection`
- **Tracks & Videos:** `tracks:search`, `tracks:rate`, `tracks:recordPlay`, `tracks:hydrate`, `tracks:hydrateAlbum`, `tracks:getLyrics`, `videos:search`, `videos:markWatched`, `videos:hydrateArtwork`, `videos:updateProgress`, `audiobooks:updateProgress`
- **Extended Media & Sync:** `books:list`, `audiobooks:list`, `photos:list`, `musicVideos:list`, `media:syncPlexAndAbs`
- **Indexer:** `indexer:scan`, `indexer:cancel`, `indexer:progress`, `indexer:syncPopularity`, `indexer:recalculateMedians`, `indexer:cleanAllTitles`, `indexer:scanExtended`
- **Cache:** `cache:stats`, `cache:clear`, `cache:toggleTrack`, `cache:toggleAlbum`, `cache:toggleVideo`, `cache:toggleShow`, `cache:precacheAllPlaylists`, `transcoder:getBinaryStatus`, `transcoder:checkUpdateBinaries`, `transcoder:checkUpdates`
- **Playlists:** `playlists:list`, `playlists:getTracks`, `playlists:getVideos`, `playlists:create`, `playlists:update`, `playlists:delete`, `playlists:addTrack`, `playlists:removeTrack`, `playlists:addVideo`, `playlists:removeVideo`, `playlists:addShow`, `playlists:getExclusions`, `playlists:ignoreTrack`, `playlists:excludeTrackGlobally`, `playlists:restoreExclusion`, `egenius:createPlaylist`, `egenius:refreshPlaylist`, `egenius:convertToStandard`, `egenius:explainTrack`, `genreMatrix:get`, `genreMatrix:rebuild`, `genreMatrix:setCell`, `genreMatrix:resetCell`, `genreMatrix:testArtists`, `genreMatrix:getArtistSlice`
- **Devices (MTP & UMS):** `devices:volumes`, `devices:list`, `devices:provision`, `devices:updateProfile`, `devices:delete`, `devices:migrateToMtp`, `devices:sync`, `devices:cancelSync`, `devices:syncProgress`, `devices:eject`, `devices:getCatalog`, `devices:removeItem`
- **Shares & Upload:** `shares:list`, `shares:save`, `shares:delete`, `shares:mount`, `shares:unmount`, `shares:autoDetect`, `upload:searchMetadata`, `upload:previewPlan`, `upload:execute`
- **Store & Auth / UAC:** `store:home`, `store:search`, `store:request`, `store:charts`, `arr:queue`, `sync:delta`, `sync:playback`, `sync:remoteDelta`, `auth:getState`, `auth:login`, `auth:logout`, `auth:probeRemoteServer`, `auth:pinLogin`, `uac:getMe`, `uac:updateMyProfile`, `uac:changeMyPassword`, `uac:listUsers`, `uac:createUser`, `uac:updateUser`, `uac:deleteUser`, `uac:generateResetCode`, `uac:listRoles`, `uac:createRole`, `uac:updateRole`, `uac:deleteRole`, `uac:setUserRoles`, `uac:setUserOverrides`, `uac:listPendingApprovals`, `uac:approvePendingItem`, `uac:rejectPendingItem`

### SQLite Multi-DB Domain Split (`electron/db.ts`)
Five domain-isolated WAL databases inside `RTUNES_DATA_DIR` (with automatic idempotent migration from legacy `rtunes.sqlite`):
- **`core.sqlite` (`getCoreDb()` / `getDb()`):** `tracks` (with deterministic `track_uid` + `sync_rev`), `tracks_fts`, `playlists` (with `owner_user_id`, `is_shared`), `playlist_tracks`, `user_track_state`, `smart_playlists` view, `smart_playlist_exclusions`, `artist_genre_weights`, `subgenre_affinity_matrix`, `settings`, `network_shares`, `devices`, `device_play_state`, `sync_tombstones`.
- **`affinity_cache.sqlite` (`getCacheDb()`):** `artist_affinity_cache`, `track_affinity_cache`, `external_metadata_cache`.
- **`video.sqlite` (`getVideoDb()`):** `videos`, `videos_fts`, `playlist_videos`, `tv_episodes`, `books`, `audiobooks`, `photos`, `cache_jobs` (`transcode_jobs` view), `watch_progress`, `user_video_progress`, `user_audiobook_progress`.
- **`store.sqlite` (`getStoreDb()`):** `store_requests` (with approval staging columns), `arr_sync_cache`, `upload_history` (with approval staging columns).
- **`users.sqlite` (`getUsersDb()`):** `users`, `roles`, `user_roles`, `user_permission_overrides`, `sessions`, `password_reset_tokens`.

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

---

## 10. Pre-Alpha AI Playlist Generator Rules

- **Zero Install-Time or Startup Model Downloads:** Never add `postinstall` scripts, build-time fetches, or app-launch background downloads for LLM/GGUF weights. No model files may be downloaded until the user explicitly opens the **AI Playlist Generator**, chooses a model from the dropdown, and clicks **Continue**.
- **Pre-Alpha Model Selector:** Expose a model dropdown in the AI Playlist Generator UI with `Qwen 3.5 — 0.8B (Q4_K_M)` (`qwen3.5-0.8b-q4`) as the active default, plus disabled `Coming Soon` / `Future Docker` placeholders for larger local models (`qwen3.5-2b-q4`) and the remote `rTunes Companion Server (MCP)` (`rtunes-companion-mcp`).
- **Two-Phase Loading Bar (`0%–50%` / `50%–100%`):**
  - `0%` to `50%` is strictly for downloading the GGUF file to `app.getPath('userData')/models/` (if already cached on disk, skip immediately to `50%`).
  - `50%` to `100%` is strictly for loading the GGUF weights into RAM/VRAM and creating the inference context.
  - Provide a working **Cancel** button (`AbortController`) during download/load and always dispose of the model and context (`context.dispose()`, `model.dispose()`) when the modal closes or cancels.
- **Single-Purpose Scope:** The AI agent's sole job is interviewing the user and assembling playlists from owned tracks using structured tool calls (`search_local_catalog`, `query_by_scene_matrix`, `discover_via_lastfm`, `lookup_musicbrainz`, `ask_user_followup`, `finalize_playlist`)—never dump the entire 95k+ track library into the prompt context.

---

## 11. `eGenius` Similarity Playlist Engine (`electron/egenius/`)

- **Modular Headless Architecture:** `eGenius` lives in `electron/egenius/` (`index.ts`, `types.ts`, `affinityCache.ts`, `genreMatrix.ts`, `variantFilter.ts`, `scorer.ts`, `sequencer.ts`) with zero `BrowserWindow` dependencies, usable both via Electron IPC (`egenius:createPlaylist`, `egenius:refreshPlaylist`, `egenius:convertToStandard`, `egenius:explainTrack`) and via CLI (`npm run cli -- playlist egenius --track-id <id> [--limit 25|50] [--mode hits|balanced|deep]`).
- **30-Day SQLite Affinity Cache:** `artist_affinity_cache` and `track_affinity_cache` store Last.fm `artist.getSimilar`, `artist.getTopTags`, and `track.getSimilar` responses with a 30-day TTL so mixes generate in `<150ms` and fall back gracefully to local genre, release era, and `Rel. Score` when offline.
- **Five-Signal Scoring & Variant Parity:** Composite score weights Crowd Co-Listening Graph (35%, Hop-1 + Hop-2 bridges), Micro-Genre Folksonomy Tags (25%), Release Era Proximity (15%, $\pm 6$ yr Gaussian), `Rel. Score` Depth Matching (15%, `hits` / `balanced` / `deep`), and Strict Variant Parity & Interlude Filtering (10%, penalizing/excluding `instrumental`, `acoustic`, `live`, `remix_demo`, and `< 90s` skits for `studio_vocal` seeds).
- **Anti-Clumping Sequencing:** Enforces max 2 seed-artist tracks & max 1 track per other artist in 25-track mode (max 2 per artist & max 1 per album in 50-track mode), an 8-track sliding-window artist cooldown, and weighted temperature sampling from the top 120 scored candidates.

---

## 12. Multi-Source Global Plays & Bounded 3-Tier Popularity (`db.ts`, `indexer.ts`)

- **Multi-Source Play Counts (`tracks`):** Personal `play_count` (`User Plays`) is strictly separated from global popularity. Global plays sum three independent columns into `combined_global_plays` (`Global Plays`): `global_listen_count` (`LB Plays`, ListenBrainz), `lastfm_plays` (`LastFM Plays`, Last.fm `track.getInfo`), and `audiodb_plays` (`AudioDB Plays`, TheAudioDB `searchtrack.php` / `track-mb.php`), with a 30-day `popularity_updated_at` TTL.
- **Bayesian Studio Baseline:** `recalculateArtistPopularityScores()` computes each artist's median `combined_global_plays` using only `studio_vocal` tracks $\ge 90\text{s}$ (`variantFilter.ts`), smoothed with a 5-track Bayesian prior at `globalStudioMedian`.
- **Bounded 3-Tier Scores:**
  - `artist_relative_popularity_score` (`Rel. Score`, `0.0–100.0`): Logarithmic sigmoid mapping `combined_global_plays / smoothedMedian` (`50.0` at median, `70.0–100.0` for hits, `0.0–35.0` for deep cuts).
  - `artist_rarity_multiplier` (`Rarity Mult.`, `0.10x–10.00x`): Inverted logarithmic artist popularity multiplier.
  - `discovery_score` (`Final Score`, `0.0–1000.0`): `ROUND(artist_relative_popularity_score * artist_rarity_multiplier, 1)`.

---

## 13. Full-Library Self-Tuning Genre Map & On-the-Fly Artist Matrix (`electron/egenius/genreMatrix.ts`)

- **Full-Library Artist & Genre Indexing (`artist_genre_weights`):** Scans **100%** of unique artists and multi-value `genre` strings (`;` `,` `/` `|`) in SQLite `tracks` (no fixed artist or genre cap) alongside cached Last.fm `artist.getTopTags`, strictly anchored to artist-level weights—never track titles.
- **Two-Method Self-Tuning Matrix (`subgenre_affinity_matrix`):** Computes symmetric `0.000–1.000` genre cells (`ROUND(val, 3)`) using **Method 1** (local artist weighted Ochiai overlap $\times \frac{N_{\text{shared}}}{N_{\text{shared}} + 3.0}$ reinforcement) blended with optional **Method 2** (Last.fm `artist.getSimilar` graph weight $w \in [0, 1]$, default `20%`; forced `0%` when no `lastfmApiKey` is configured). Always preserves `is_user_locked = 1` cells and `1.000` self-pairs.
- **Lean On-the-Fly Artist Matrix & Unified `eGenius` Scorer:** Does **not** persist an artist-to-artist table in SQLite. Instead, `getArtistsForGenre()`, `computeGenreArtistSlice()`, and `createSharedArtistScorer()` evaluate bilinear genre-bridge similarity and optional Last.fm graph similarity in memory (`< 20ms`), powering the Read-Only Artist Map overlay, **Prefs → Genre Map** (`GenreMapTab.tsx` full-screen virtualized `100vw × 100vh` pop-out), `eGenius` Signals #1 & #2, Smart Playlists, AI `query_by_scene_matrix`, and CLI (`npm run cli -- db rebuild-genre-matrix`, `npm run cli -- artist-map --genre "<genre>"`, `npm run cli -- egenius --track-id <id> --explain`).

---

## Code Minimalism & Anti-Bloat Rules
1. **No Defensive Slop:** Trust internal types and contracts. Do not add redundant null checks, silent fallback defaults (`x || {}`), or `try/catch` blocks inside internal functions. Validate only at external I/O boundaries. Let internal bugs fail fast and loud.
2. **Flat Over Abstract:** Prefer pure functions and flat data structures over classes. Never create an interface, base class, factory, or wrapper for a single implementation.
3. **Inline Single-Use Logic:** Do not extract a helper function or intermediate variable if it is only used once and does not drastically improve readability.
4. **Max 2 Levels of Nesting:** Use guard clauses and early returns. Never write `else` after a `return`, `raise`, `break`, or `continue`.
5. **Refactor, Don't Wrap:** When modifying existing code, rewrite and simplify the core logic rather than bolting on extra `if/else` branches or boolean flags. Delete dead code immediately.
6. **Use the Standard Library:** Always prefer built-in language features and standard library modules over custom loops and hand-rolled utilities.
