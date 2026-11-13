# RetroTunes (rTunes)

**RetroTunes (`rTunes` — Client Code: `ePod Suite`)** is a cross-platform desktop media player, homelab media gateway, and universal portable-device (**ePod / MTP / UMS**) sync engine built with **Electron**, **React 19**, **TypeScript**, and **SQLite (FTS5)**.

Designed around a late-2000s **Aqua & Brushed Metal** aesthetic, RetroTunes pairs classic desktop ergonomics with modern homelab and portable hardware workflows.

---

## Features

- **Classic Aqua & Brushed Metal UI**: Unified brushed-metal transport header, inset backlit LCD playback display with scrubbing, **3D Cover Flow** browser, glossy Aqua pill controls, and segmented device capacity bars.
- **High-Scale Media Library (100,000+ Tracks)**: Virtualized/windowed tables backed by synchronous `better-sqlite3` + FTS5 full-text search for instant filtering across Music, Videos, Books, Audiobooks, and Photos.
- **Universal ePod / MTP / UMS Sync Engine**:
  - Persistent device identity tracking via `uuid` and USB serial.
  - Unified MTP (`rtunes-mtp`) and USB Mass Storage (`UMS`) sync with `.m3u8` playlist export.
  - Timestamp-reconciled `.scrobbler.log` / `.retrotunes_plays.json` delta play-count syncing and safe eject.
- **Homelab & Network Share Integration**:
  - Direct **NFS / SMB** share mounting and management.
  - Local SSD LRU pre-cache and **FFmpeg / HandBrakeCLI** 360p H.264/AAC video transcoder.
  - **rTunes Store**, multi-source Top Charts (Deezer, Last.fm, TheAudioDB, Library Relative), and **Lidarr / Radarr / Sonarr** (`*arr`) queue & upload wizard integration.
  - **Plex / Audiobookshelf** progress sync and **Authentik OIDC (PKCE)** SSO support.
- **Cross-Platform OS Drivers**: Platform-specific volume, keychain/`safeStorage`, and share-mount logic isolated in `electron/platform/` (`darwin.ts`, `win32.ts`, `linux.ts`).
- **Diagnostics & Structured Logging**: Built-in `> Logs` viewer with subsystem filtering and JSON diagnostic export.

---

## Getting Started

### Prerequisites

- **Node.js** (LTS / current) and **npm**
- *(macOS optional)* `clang` / Xcode Command Line Tools if compiling the native `native/rtunes_mtp.c` helper

### Install & Run (Windows, macOS, Linux)

```bash
git clone https://github.com/edonvmk/RetroTunes.git
cd RetroTunes
npm install
npm run start
```

> `npm install` automatically runs `postinstall` (`scripts/electron-tasks.mjs rebuild-native`) to fetch the matching `better-sqlite3` prebuilt binary for Electron, so no local C++ compiler toolchain is required on Windows.

### Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run start` | Build Electron + Vite bundles and launch RetroTunes in production mode |
| `npm run dev` | Start Vite dev server (`localhost:5173`) and Electron in live development mode |
| `npm run build` | Compile native helper (macOS), Electron main process, and Vite renderer |
| `npm run typecheck` | Run TypeScript type checks for both renderer (`tsconfig.json`) and Electron (`tsconfig.electron.json`) |

On macOS/Linux, you can also use the convenience wrapper:

```bash
./rtunes.sh [start|dev|build|typecheck]
```

---

## Project Structure

- `src/` — React 19 + TypeScript + Vite renderer UI and Aqua stylesheet (`src/styles/rtunes.css`)
- `electron/` — Electron main process, SQLite database (`db.ts`), indexer, transcoder, device sync, share manager, store/`*arr`, and OS drivers (`electron/platform/`)
- `native/` — Native C helper (`rtunes_mtp.c`)
- `scripts/` — Cross-platform build, native prebuild, and launch helpers (`electron-tasks.mjs`)

---

## Credits & Architecture Docs

- See [`CREDITS.md`](CREDITS.md) for full open-source software, binary, and API attributions.
- See [`AGENTS.md`](AGENTS.md) for architecture details and development guidelines.
