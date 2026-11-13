import React from 'react';
import { Info, X } from 'lucide-react';

interface AboutCreditsModalProps {
  onClose: () => void;
}

export const FossCreditsContent: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div className="epod-capacity-card">
      <h3 style={{ margin: '0 0 6px 0', fontSize: 16 }}>
        RetroTunes (rTunes) — Client Code: ePod Suite v1.0.0
      </h3>
      <p style={{ margin: 0, fontSize: 11.5, color: '#334155', lineHeight: 1.5 }}>
        RetroTunes is a classic late-2000s brushed-metal desktop media player, local library manager, homelab request storefront, and universal portable device synchronization suite.
      </p>
    </div>

    <div className="epod-capacity-card">
      <strong style={{ display: 'block', marginBottom: 8 }}>
        Core Desktop Runtime, UI & Database
      </strong>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: '#334155', lineHeight: 1.6 }}>
        <li>
          <strong>Electron & Chromium</strong> — Cross-platform desktop application shell, IPC, and OS keychain integration (MIT License).
        </li>
        <li>
          <strong>React 19, React DOM & Vite</strong> — Declarative UI rendering and fast module bundling (MIT License).
        </li>
        <li>
          <strong>TypeScript</strong> — Static type system across renderer and Electron main process (Apache-2.0 License).
        </li>
        <li>
          <strong>better-sqlite3 & SQLite FTS5</strong> — High-performance embedded relational database and Full-Text Search indexing engine by Joshua Wise & SQLite Team (MIT / Public Domain).
        </li>
        <li>
          <strong>Lucide Icons (lucide-react)</strong> — Clean vector iconography (ISC License).
        </li>
        <li>
          <strong>concurrently, wait-on &amp; cross-env</strong> — Cross-platform development and headless CLI orchestration scripts (MIT License).
        </li>
      </ul>
    </div>

    <div className="epod-capacity-card">
      <strong style={{ display: 'block', marginBottom: 8 }}>
        Audio/Video Toolchains, Tagging & Device Protocols
      </strong>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: '#334155', lineHeight: 1.6 }}>
        <li>
          <strong>FFmpeg & FFprobe (ffmpeg-static / ffprobe-static)</strong> — Hardware-accelerated 360p H.264/AAC video transcoding, live MKV/AVI remuxing, and 500×500 baseline JPEG cover art sanitization (LGPL-2.1+ / GPL-2.0+).
        </li>
        <li>
          <strong>HandBrakeCLI</strong> — Optional high-compatibility hardware/software video transcoding sidecar (GPL-2.0).
        </li>
        <li>
          <strong>music-metadata</strong> — Pure JavaScript ID3v2, Vorbis, FLAC, and MP4/M4A audio tag and cover art parser by Borewit (MIT License).
        </li>
        <li>
          <strong>libmtp & libusb</strong> — Media Transfer Protocol (MTP) USB responder and transport libraries powering the native <code>rtunes-mtp</code> sidecar (LGPL-2.1+).
        </li>
      </ul>
    </div>

    <div className="epod-capacity-card">
      <strong style={{ display: 'block', marginBottom: 8 }}>
        Portable Device Community & Custom Firmware Ecosystem
      </strong>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: '#334155', lineHeight: 1.6 }}>
        <li>
          <strong>Y2 Reborn (Y2Linux) — SchulzCode & Community</strong> — Custom Linux/MTP firmware for Innioasis Y2 portable players; inspiration for rTunes&apos; MTP hierarchy, relative-path <code>.m3u8</code> playlists, and <code>.scrobbler.log</code> delta play-count sync.
        </li>
        <li>
          <strong>Innioasis Updater CE</strong> — Community firmware tooling, partition safety practices (<code>PRELOADER</code> / <code>PMT</code> / <code>SEC_RO</code> protection), and device recovery knowledge.
        </li>
      </ul>
    </div>

    <div className="epod-capacity-card">
      <strong style={{ display: 'block', marginBottom: 8 }}>
        Open Metadata, Charts, Lyrics & Homelab Ecosystem
      </strong>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: '#334155', lineHeight: 1.6 }}>
        <li>
          <strong>MusicBrainz & ListenBrainz (MetaBrainz Foundation)</strong> — Artist/Recording MBID resolution, global listen counts, artist-relative median popularity normalization, and two-way Loved track feedback (CC0 / AGPL-3.0).
        </li>
        <li>
          <strong>LRCLIB (lrclib.net)</strong> — Crowd-sourced synchronized karaoke lyrics (<code>.lrc</code>) API for desktop playback and portable device sync.
        </li>
        <li>
          <strong>Deezer, Last.fm, TheAudioDB, TVMaze & TMDB/TVDB</strong> — Multi-source Top Charts, album discovery, and automatic show/movie artwork hydration.
        </li>
        <li>
          <strong>Lidarr, Radarr, Sonarr & Chaptarr (*arr Suite)</strong> — Automated homelab music, movie, TV, and book PVR request management and live download queue monitoring (GPL-3.0).
        </li>
        <li>
          <strong>Plex, Audiobookshelf, Immich & Authentik OIDC</strong> — Watch/resume-position synchronization, self-hosted photo library sync, and OAuth2 PKCE Single Sign-On.
        </li>
      </ul>
    </div>
  </div>
);

export const AboutCreditsModal: React.FC<AboutCreditsModalProps> = ({ onClose }) => {
  return (
    <div className="aqua-modal-backdrop" onClick={onClose}>
      <div
        className="aqua-window"
        style={{ width: 680, maxWidth: '94vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aqua-window-titlebar">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Info size={14} /> About RetroTunes (rTunes) & FOSS Credits
          </span>
          <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <FossCreditsContent />
        </div>

        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid #9da6b4',
            background: '#dfe4ec',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 11, color: '#475569' }}>
            See <code>CREDITS.md</code> in the repository root for full license details.
          </span>
          <button className="aqua-btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
