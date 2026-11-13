# RetroTunes (rTunes) — Open-Source Software & Community Credits

RetroTunes (`rTunes`) is built on the shoulders of open-source libraries, multimedia toolchains, open metadata APIs, and portable-device community projects. We gratefully acknowledge every project, maintainer, and contributor listed below.

> **Governance Note:** Any commit that adds an `npm` dependency, external CLI binary, protocol library, or community firmware integration **must** update both this `CREDITS.md` file and the in-app **About & Credits** modal (`src/components/AboutCreditsModal.tsx` and `src/components/PreferencesModal.tsx`).

---

## 1. Core Desktop Runtime, UI & Database
| Project | Role in rTunes | License | Attribution |
|---|---|---|---|
| **Electron** | Cross-platform desktop application shell (main/renderer IPC, `safeStorage`, native dialogs, `BrowserWindow`) | MIT | OpenJS Foundation & Electron Contributors |
| **React & React DOM (`react`, `react-dom` v19)** | Declarative UI rendering and state management | MIT | Meta Platforms, Inc. & React Contributors |
| **TypeScript** | Static type checking across frontend (`src/`) and backend (`electron/`) | Apache-2.0 | Microsoft Corporation |
| **Vite & `@vitejs/plugin-react`** | Frontend module bundler and HMR development server | MIT | Evan You & Vite Contributors |
| **better-sqlite3** | Synchronous embedded SQLite3 bindings powering the library index & FTS5 search | MIT | Joshua Wise |
| **node-llama-cpp** | Local GGUF model download, quantized LLM inference, and JSON-schema function calling for the AI Playlist Generator | MIT | Gilad Shoham & `node-llama-cpp` Contributors |
| **SQLite + FTS5** | High-performance relational storage and full-text search engine | Public Domain | SQLite Development Team |
| **lucide-react** | Crisp vector UI iconography | ISC | Lucide Contributors |
| **concurrently, wait-on & cross-env** | Development and cross-platform CLI orchestration scripts | MIT | Kent C. Dodds & Open-source Contributors |

---

## 2. Audio/Video Toolchains, Tagging & Device Protocols
| Project | Role in rTunes | License | Attribution |
|---|---|---|---|
| **FFmpeg & FFprobe (`ffmpeg-static`, `ffprobe-static`)** | Hardware-accelerated 360p H.264/AAC video transcoding, live MKV/AVI remuxing, and 500×500 baseline JPEG cover art sanitization | LGPL-2.1+ / GPL-2.0+ | FFmpeg Developers & Eugeneware |
| **HandBrakeCLI** *(optional sidecar)* | Alternative hardware/software video transcoding backend | GPL-2.0 | The HandBrake Team |
| **music-metadata** | Pure JavaScript ID3v2, Vorbis/FLAC, MP4/M4A, and embedded cover art parser | MIT | Borewit & Contributors |
| **libmtp** | Media Transfer Protocol (MTP) USB responder library used by the native `rtunes-mtp` sidecar (`native/rtunes_mtp.c`) | LGPL-2.1+ | Linus Walleij, Richard Low & `libmtp` Contributors |
| **libusb** | Cross-platform USB device enumeration and bulk transfer transport underlying `libmtp` | LGPL-2.1+ | `libusb` Project |

---

## 3. Portable Device Community & Custom Firmware Ecosystem
| Project | Role in rTunes | Attribution |
|---|---|---|
| **Y2 Reborn (Y2Linux)** | Custom Linux/MTP firmware for Innioasis Y2 portable players; target of rTunes' MTP directory layout, `.m3u8` relative-path playlists, and `.scrobbler.log` delta play-count sync | **SchulzCode** & the Y2 Reborn Community |
| **Innioasis Updater CE** | Community firmware tooling, partition safety practices (`PRELOADER` / `PMT` / `SEC_RO` write protection), and device recovery knowledge | Innioasis Updater CE Maintainers & Community |

---

## 4. Open Metadata, Lyrics, Charts & Scrobbling APIs
| Service / API | Role in rTunes | License / Terms |
|---|---|---|
| **MusicBrainz** | Artist, Release Group, and Recording MBID resolution | CC0 / MetaBrainz Foundation |
| **ListenBrainz** | Global listen counts, artist-relative median popularity normalization, and two-way Loved track & scrobble sync | AGPL-3.0 / MetaBrainz Foundation |
| **LRCLIB (`lrclib.net`)** | Crowd-sourced synchronized karaoke lyrics (`.lrc`) for desktop playback and portable device sync | Open API / Tran Xuan Thanh |
| **Deezer Public API** | Multi-source Top Charts, album catalog discovery, and artist recommendations | Deezer Public API |
| **Last.fm API** | Multi-source Top Charts and track/artist popularity enrichment | Last.fm API |
| **TheAudioDB** | Artist/album artwork enrichment and multi-source chart metadata | TheAudioDB Community |
| **TVMaze API (`tvmaze.com`)** | Television series discovery, episode metadata, and automatic show poster artwork hydration | CC BY-SA |
| **TMDB / TVDB / IMDb Catalog** | Movie and TV series metadata and poster artwork lookup | Respective API Terms |

---

## 5. Homelab Media, Request & SSO Ecosystem
| Project | Role in rTunes | License |
|---|---|---|
| **Lidarr, Radarr, Sonarr & Chaptarr (`*arr` Suite)** | Automated homelab music, movie, TV, and book PVR request management, naming-config preview, and live download queue monitoring | GPL-3.0 |
| **Plex Media Server** | On Deck / Continue Watching progress sync (`view_offset_ms`) and watch-state integration | Plex |
| **Audiobookshelf** | Audiobook library integration and playback resume-position synchronization | GPL-3.0 |
| **Immich** | Self-hosted photo library integration and album sync | AGPL-3.0 |
| **Authentik** | Self-hosted OIDC / OAuth2 PKCE Single Sign-On identity provider with OS Keychain credential persistence | MIT |
