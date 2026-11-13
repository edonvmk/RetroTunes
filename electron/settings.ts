import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { getDb } from './db';
import { logger } from './logger';

// Resolve bundled ffmpeg / ffprobe sidecar paths
let bundledFfmpegPath = '';
let bundledFfprobePath = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  bundledFfmpegPath = require('ffmpeg-static') || '';
} catch {
  bundledFfmpegPath = '';
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffprobeStatic = require('ffprobe-static');
  bundledFfprobePath = ffprobeStatic?.path || '';
} catch {
  bundledFfprobePath = '';
}

export interface AppSettings {
  backendMode?: 'standalone' | 'docker_server';
  dockerServerUrl?: string;

  // Paths
  nfsSharePath: string;
  musicRootPath: string;
  videoRootPath: string;
  tvRootPath: string;
  musicVideosRootPath?: string;
  booksRootPath?: string;
  audiobooksRootPath?: string;
  photosRootPath?: string;
  localCachePath: string;
  ffmpegBinaryPath: string;
  ffprobeBinaryPath: string;
  handbrakeBinaryPath: string;

  // Cache Management
  cacheMaxSizeGb: number;
  autoEvictLru: boolean;
  autoCachePlayback: boolean;
  hardwareAccelMode: 'auto' | 'vt_h264' | 'nvenc' | 'qsv' | 'software';
  metadataHydrationMode: 'hybrid' | 'on_demand';
  tableColumnsJson: string;
  showOfflineDevices?: boolean;

  // Authentication (Authentik SSO / OIDC + Homelab Gateway)
  authMode: 'standalone' | 'authentik';
  authentikIssuerUrl: string;
  authentikClientId: string;
  authentikRedirectUri: string;
  homelabGatewayUrl: string;

  // API Keys & Integrations
  listenbrainzToken: string;
  listenbrainzUsername: string;
  lastfmApiKey?: string;
  theAudioDbApiKey?: string;

  plexUrl?: string;
  plexToken?: string;

  lidarrUrl: string;
  lidarrApiKey: string;
  lidarrQualityProfileId: number;
  lidarrMetadataProfileId: number;
  lidarrRootFolderPath: string;

  radarrUrl: string;
  radarrApiKey: string;
  radarrQualityProfileId: number;
  radarrRootFolderPath: string;

  sonarrUrl: string;
  sonarrApiKey: string;
  sonarrQualityProfileId: number;
  sonarrRootFolderPath: string;

  chaptarrUrl?: string;
  chaptarrApiKey?: string;
  audiobookshelfUrl?: string;
  audiobookshelfToken?: string;
  immichUrl?: string;
  immichApiKey?: string;

  tmdbApiKey: string;
  tvdbApiKey: string;
}

const SECRET_KEYS: (keyof AppSettings)[] = [
  'listenbrainzToken',
  'lastfmApiKey',
  'theAudioDbApiKey',
  'plexToken',
  'lidarrApiKey',
  'radarrApiKey',
  'sonarrApiKey',
  'chaptarrApiKey',
  'audiobookshelfToken',
  'immichApiKey',
  'tmdbApiKey',
  'tvdbApiKey',
];

const KEYCHAIN_SERVICE = 'com.retrotunes.epodsuite';

export function setKeychainSecret(account: string, secret: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    if (!secret) {
      try {
        execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
          stdio: 'ignore',
        });
      } catch {
        // Ignore if not found
      }
      return true;
    }
    execFileSync(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', secret],
      { stdio: 'ignore' }
    );
    return true;
  } catch (err) {
    logger.debug('SYSTEM', `Keychain write fallback for ${account}`, { error: String(err) });
    return false;
  }
}

export function getKeychainSecret(account: string): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.trim();
  } catch {
    return null;
  }
}

export function getDefaultSettings(): AppSettings {
  const defaultCacheDir = path.join(os.homedir(), 'Library', 'Caches', 'RetroTunes');
  return {
    backendMode: 'standalone',
    dockerServerUrl: 'https://rtunes-server.local:8443',

    nfsSharePath: '',
    musicRootPath: '',
    videoRootPath: '',
    tvRootPath: '',
    musicVideosRootPath: '',
    booksRootPath: '',
    audiobooksRootPath: '',
    photosRootPath: '',
    localCachePath: defaultCacheDir,
    ffmpegBinaryPath: bundledFfmpegPath || '/opt/homebrew/bin/ffmpeg',
    ffprobeBinaryPath: bundledFfprobePath || '/opt/homebrew/bin/ffprobe',
    handbrakeBinaryPath: '/opt/homebrew/bin/HandBrakeCLI',

    cacheMaxSizeGb: 50,
    autoEvictLru: true,
    autoCachePlayback: true,
    hardwareAccelMode: 'auto',
    metadataHydrationMode: 'hybrid',
    tableColumnsJson: '',
    showOfflineDevices: false,

    authMode: 'standalone',
    authentikIssuerUrl: '',
    authentikClientId: 'retrotunes-desktop',
    authentikRedirectUri: 'http://127.0.0.1:42813/callback',
    homelabGatewayUrl: '',

    listenbrainzToken: '',
    listenbrainzUsername: '',
    lastfmApiKey: '',
    theAudioDbApiKey: '2',

    plexUrl: 'http://localhost:32400',
    plexToken: '',

    lidarrUrl: 'http://localhost:8686',
    lidarrApiKey: '',
    lidarrQualityProfileId: 1,
    lidarrMetadataProfileId: 1,
    lidarrRootFolderPath: '',

    radarrUrl: 'http://localhost:7878',
    radarrApiKey: '',
    radarrQualityProfileId: 1,
    radarrRootFolderPath: '',

    sonarrUrl: 'http://localhost:8989',
    sonarrApiKey: '',
    sonarrQualityProfileId: 1,
    sonarrRootFolderPath: '',

    chaptarrUrl: 'http://localhost:8787',
    chaptarrApiKey: '',
    audiobookshelfUrl: 'http://localhost:13378',
    audiobookshelfToken: '',
    immichUrl: 'http://localhost:2283',
    immichApiKey: '',

    tmdbApiKey: '',
    tvdbApiKey: '',
  };
}

let cachedSettings: AppSettings | null = null;

export function getSettings(forceReload = false): AppSettings {
  if (cachedSettings && !forceReload) {
    return cachedSettings;
  }
  const db = getDb();
  const defaults = getDefaultSettings();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const stored: Record<string, unknown> = {};

  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }

  const merged: AppSettings = {
    ...defaults,
    ...(stored as Partial<AppSettings>),
  };

  // Ensure bundled ffmpeg is populated if stored path doesn't exist
  if (
    (!merged.ffmpegBinaryPath || !fs.existsSync(merged.ffmpegBinaryPath)) &&
    bundledFfmpegPath &&
    fs.existsSync(bundledFfmpegPath)
  ) {
    merged.ffmpegBinaryPath = bundledFfmpegPath;
  }
  if (
    (!merged.ffprobeBinaryPath || !fs.existsSync(merged.ffprobeBinaryPath)) &&
    bundledFfprobePath &&
    fs.existsSync(bundledFfprobePath)
  ) {
    merged.ffprobeBinaryPath = bundledFfprobePath;
  }

  // Pull secrets from macOS Keychain if available
  for (const key of SECRET_KEYS) {
    const keychainVal = getKeychainSecret(key);
    if (keychainVal !== null && keychainVal.length > 0) {
      (merged as unknown as Record<string, unknown>)[key] = keychainVal;
    }
  }

  // Ensure localCachePath directory exists
  try {
    fs.mkdirSync(merged.localCachePath, { recursive: true });
    fs.mkdirSync(path.join(merged.localCachePath, 'audio'), { recursive: true });
    fs.mkdirSync(path.join(merged.localCachePath, 'video'), { recursive: true });
    fs.mkdirSync(path.join(merged.localCachePath, 'artwork'), { recursive: true });
  } catch {
    const fallbackCache = path.join(process.cwd(), '.cache');
    fs.mkdirSync(path.join(fallbackCache, 'audio'), { recursive: true });
    fs.mkdirSync(path.join(fallbackCache, 'video'), { recursive: true });
    fs.mkdirSync(path.join(fallbackCache, 'artwork'), { recursive: true });
    merged.localCachePath = fallbackCache;
  }

  cachedSettings = merged;
  return merged;
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined) continue;
      if (SECRET_KEYS.includes(k as keyof AppSettings) && typeof v === 'string') {
        setKeychainSecret(k, v);
      }
      upsert.run(k, JSON.stringify(v));
    }
  });

  tx();
  cachedSettings = null;
  logger.info('SYSTEM', 'Updated application settings in SQLite & OS Keychain.', {
    updatedKeys: Object.keys(partial),
  });
  return getSettings(true);
}

export interface ConnectionTestResult {
  ok: boolean;
  target: string;
  message: string;
  latencyMs: number;
  details?: Record<string, unknown>;
}

export async function testIntegrationConnection(
  target:
    | 'paths'
    | 'binaries'
    | 'listenbrainz'
    | 'lidarr'
    | 'radarr'
    | 'sonarr'
    | 'tmdb'
    | 'tvdb'
    | 'authentik',
  overrideConfig?: Partial<AppSettings>
): Promise<ConnectionTestResult> {
  const start = Date.now();
  const cfg: AppSettings = { ...getSettings(), ...(overrideConfig || {}) };

  try {
    switch (target) {
      case 'paths': {
        const results: Record<string, { exists: boolean; readable: boolean; path: string }> = {};
        const checkPath = (label: string, p: string) => {
          if (!p) {
            results[label] = { exists: false, readable: false, path: '(not set)' };
            return;
          }
          const exists = fs.existsSync(p);
          let readable = false;
          if (exists) {
            try {
              fs.accessSync(p, fs.constants.R_OK);
              readable = true;
            } catch {
              readable = false;
            }
          }
          results[label] = { exists, readable, path: p };
        };

        checkPath('nfsSharePath', cfg.nfsSharePath);
        checkPath('musicRootPath', cfg.musicRootPath);
        checkPath('videoRootPath', cfg.videoRootPath);
        checkPath('tvRootPath', cfg.tvRootPath);
        checkPath('localCachePath', cfg.localCachePath);

        const cacheOk = results.localCachePath.exists && results.localCachePath.readable;
        const mediaConfigured = Boolean(cfg.musicRootPath || cfg.videoRootPath || cfg.tvRootPath || cfg.nfsSharePath);
        const mediaOk =
          (cfg.musicRootPath ? results.musicRootPath.readable : true) &&
          (cfg.videoRootPath ? results.videoRootPath.readable : true) &&
          (cfg.tvRootPath ? results.tvRootPath.readable : true);

        const ok = cacheOk && mediaConfigured && mediaOk;
        const msg = !mediaConfigured
          ? 'Local cache is ready, but no Music/Video/NFS root path is configured yet.'
          : ok
          ? 'All configured media & local cache directories are accessible.'
          : 'One or more configured media directories do not exist or are not readable.';

        logger.info('SYSTEM', `Path connection test: ${msg}`, results, Date.now() - start);
        return { ok, target, message: msg, latencyMs: Date.now() - start, details: results };
      }

      case 'binaries': {
        let ffmpegOk = false;
        let ffmpegVersion = 'Not found';
        const hwEncoders: string[] = [];

        if (cfg.ffmpegBinaryPath && fs.existsSync(cfg.ffmpegBinaryPath)) {
          try {
            const verOut = execFileSync(cfg.ffmpegBinaryPath, ['-version'], { encoding: 'utf8' });
            ffmpegVersion = verOut.split('\n')[0] || 'FFmpeg available';
            ffmpegOk = true;

            const encOut = execFileSync(cfg.ffmpegBinaryPath, ['-encoders'], { encoding: 'utf8' });
            if (encOut.includes('h264_videotoolbox')) hwEncoders.push('h264_videotoolbox (macOS ARM64)');
            if (encOut.includes('h264_nvenc')) hwEncoders.push('h264_nvenc (NVIDIA)');
            if (encOut.includes('h264_qsv')) hwEncoders.push('h264_qsv (Intel QSV)');
            if (encOut.includes('libx264')) hwEncoders.push('libx264 (Software)');
          } catch (e) {
            ffmpegVersion = `Error: ${String(e)}`;
          }
        }

        let handbrakeOk = false;
        let handbrakeVersion = 'Not installed (using FFmpeg engine)';
        if (cfg.handbrakeBinaryPath && fs.existsSync(cfg.handbrakeBinaryPath)) {
          try {
            const hbOut = execFileSync(cfg.handbrakeBinaryPath, ['--version'], { encoding: 'utf8' });
            handbrakeVersion = hbOut.trim().split('\n')[0];
            handbrakeOk = true;
          } catch (e) {
            handbrakeVersion = `Error: ${String(e)}`;
          }
        }

        const ok = ffmpegOk || handbrakeOk;
        const message = ok
          ? `Transcode Engine Ready (${ffmpegVersion}; Encoders: ${hwEncoders.join(', ')})`
          : 'Neither FFmpeg nor HandBrakeCLI could be executed.';

        logger.info('TRANSCODE', message, { ffmpegOk, handbrakeOk, hwEncoders }, Date.now() - start);
        return {
          ok,
          target,
          message,
          latencyMs: Date.now() - start,
          details: { ffmpegOk, ffmpegVersion, handbrakeOk, handbrakeVersion, hwEncoders },
        };
      }

      case 'listenbrainz': {
        if (!cfg.listenbrainzToken) {
          return {
            ok: false,
            target,
            message: 'ListenBrainz token is empty.',
            latencyMs: Date.now() - start,
          };
        }
        const res = await fetch('https://api.listenbrainz.org/1/validate-token', {
          headers: {
            Authorization: `Token ${cfg.listenbrainzToken.trim()}`,
            Accept: 'application/json',
          },
        });
        const data = (await res.json()) as { valid?: boolean; user_name?: string; message?: string };
        if (res.ok && data.valid) {
          if (data.user_name) {
            saveSettings({ listenbrainzUsername: data.user_name });
          }
          logger.info('LISTENBRAINZ', `Token validated for user: ${data.user_name}`, data, Date.now() - start);
          return {
            ok: true,
            target,
            message: `Authenticated as ListenBrainz user "${data.user_name}"`,
            latencyMs: Date.now() - start,
            details: data,
          };
        }
        logger.warn('LISTENBRAINZ', 'ListenBrainz token validation failed', data, Date.now() - start);
        return {
          ok: false,
          target,
          message: data.message || `Token invalid (HTTP ${res.status})`,
          latencyMs: Date.now() - start,
          details: data,
        };
      }

      case 'lidarr':
      case 'radarr':
      case 'sonarr': {
        const apiVer = target === 'lidarr' ? 'v1' : 'v3';
        const baseUrl = (
          target === 'lidarr' ? cfg.lidarrUrl : target === 'radarr' ? cfg.radarrUrl : cfg.sonarrUrl
        ).replace(/\/+$/, '');
        const apiKey = (
          target === 'lidarr' ? cfg.lidarrApiKey : target === 'radarr' ? cfg.radarrApiKey : cfg.sonarrApiKey
        ).trim();

        if (!baseUrl || !apiKey) {
          return {
            ok: false,
            target,
            message: `${target.toUpperCase()} URL and API Key are required.`,
            latencyMs: Date.now() - start,
          };
        }

        const statusRes = await fetch(`${baseUrl}/api/${apiVer}/system/status`, {
          headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        });
        if (!statusRes.ok) {
          throw new Error(`HTTP ${statusRes.status}: ${statusRes.statusText}`);
        }
        const statusData = (await statusRes.json()) as { appName?: string; version?: string };

        const profilesRes = await fetch(`${baseUrl}/api/${apiVer}/qualityprofile`, {
          headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        });
        const profiles = profilesRes.ok
          ? ((await profilesRes.json()) as { id: number; name: string }[])
          : [];

        const rootRes = await fetch(`${baseUrl}/api/${apiVer}/rootfolder`, {
          headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        });
        const rootFolders = rootRes.ok
          ? ((await rootRes.json()) as { id: number; path: string; freeSpace?: number }[])
          : [];

        const msg = `Connected to ${statusData.appName || target.toUpperCase()} v${statusData.version} (${profiles.length} quality profiles, ${rootFolders.length} root folders)`;
        logger.info('ARR_STORE', msg, { target, version: statusData.version, profiles, rootFolders }, Date.now() - start);
        return {
          ok: true,
          target,
          message: msg,
          latencyMs: Date.now() - start,
          details: {
            version: statusData.version,
            profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
            rootFolders: rootFolders.map((r) => ({ id: r.id, path: r.path, freeSpace: r.freeSpace })),
          },
        };
      }

      case 'tmdb': {
        const key = cfg.tmdbApiKey.trim();
        if (!key) {
          return { ok: false, target, message: 'TMDB API Key is empty.', latencyMs: Date.now() - start };
        }
        const isBearer = key.length > 60 || key.startsWith('eyJ');
        const url = isBearer
          ? 'https://api.themoviedb.org/3/configuration'
          : `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`;
        const res = await fetch(url, {
          headers: isBearer ? { Authorization: `Bearer ${key}`, Accept: 'application/json' } : { Accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`TMDB returned HTTP ${res.status}`);
        }
        logger.info('ARR_STORE', 'TMDB API connection verified.', {}, Date.now() - start);
        return {
          ok: true,
          target,
          message: 'TMDB API v3 connection verified.',
          latencyMs: Date.now() - start,
        };
      }

      case 'tvdb': {
        const key = cfg.tvdbApiKey.trim();
        if (!key) {
          return { ok: false, target, message: 'TVDB API Key is empty.', latencyMs: Date.now() - start };
        }
        const res = await fetch('https://api4.thetvdb.com/v4/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ apikey: key }),
        });
        if (!res.ok) {
          throw new Error(`TVDB login returned HTTP ${res.status}`);
        }
        logger.info('ARR_STORE', 'TVDB API v4 connection verified.', {}, Date.now() - start);
        return {
          ok: true,
          target,
          message: 'TVDB API v4 token authentication verified.',
          latencyMs: Date.now() - start,
        };
      }

      case 'authentik': {
        const issuer = cfg.authentikIssuerUrl.trim().replace(/\/+$/, '');
        if (!issuer) {
          return { ok: false, target, message: 'Authentik Issuer URL is empty.', latencyMs: Date.now() - start };
        }
        const wellKnownUrl = issuer.endsWith('.well-known/openid-configuration')
          ? issuer
          : `${issuer}/.well-known/openid-configuration`;
        const res = await fetch(wellKnownUrl, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          throw new Error(`OIDC discovery failed with HTTP ${res.status} at ${wellKnownUrl}`);
        }
        const oidc = (await res.json()) as {
          issuer?: string;
          authorization_endpoint?: string;
          token_endpoint?: string;
          userinfo_endpoint?: string;
        };
        logger.info('AUTH_OIDC', 'Authentik OIDC discovery verified.', oidc, Date.now() - start);
        return {
          ok: true,
          target,
          message: `OIDC Provider Verified (${oidc.issuer || issuer})`,
          latencyMs: Date.now() - start,
          details: oidc,
        };
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('SYSTEM', `Connection test failed for ${target}: ${errMsg}`, err, Date.now() - start);
    return {
      ok: false,
      target,
      message: errMsg,
      latencyMs: Date.now() - start,
    };
  }
}
