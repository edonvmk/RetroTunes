import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getDb } from './db';
import { logger } from './logger';
import { platformDriver } from './platform';

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

export type AppProfile = 'client' | 'headless-client' | 'desktop-server' | 'headless-server';
export type ClientSource = 'local' | 'remote';
export type AuthMode = 'standalone' | 'authentik' | 'proxy-headers' | 'local-pin';
export type TranscoderUpdateSchedule = 'off' | 'daily' | 'weekly';

export interface ServerSidebarVisibility {
  music: boolean;
  movies: boolean;
  tvShows: boolean;
  musicVideos: boolean;
  audiobooks: boolean;
  books: boolean;
  photos: boolean;
  store: boolean;
  devices: boolean;
  networkShares: boolean;
  genreMap: boolean;
}

export interface ResolvedRuntimeMode {
  appMode: AppProfile;
  isModeLocked: boolean;
  lockReason: 'docker' | 'cli' | null;
  isDocker: boolean;
  isHeadless: boolean;
  isServerRole: boolean;
  webUiEnabled: boolean;
  cliHost?: string;
  cliPort?: number;
}

export function isDockerContainer(): boolean {
  return (
    process.env.DOCKER_CONTAINER === 'true' ||
    process.env.container === 'docker' ||
    fs.existsSync('/.dockerenv')
  );
}

export function isServerProfile(mode: AppProfile): boolean {
  return mode === 'desktop-server' || mode === 'headless-server';
}

export function isHeadlessProfile(mode: AppProfile): boolean {
  return mode === 'headless-client' || mode === 'headless-server';
}

function readCliFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      return argv[i + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

export function resolveAppMode(
  storedMode?: AppProfile | string,
  argv: string[] = process.argv
): ResolvedRuntimeMode {
  const webUiDisabled =
    argv.includes('--no-web-ui') ||
    process.env.RTUNES_WEB_UI === 'false' ||
    process.env.RTUNES_WEB_UI === '0';
  const cliHost = readCliFlagValue(argv, '--host') || process.env.RTUNES_HOST || process.env.HOST;
  const rawPort = readCliFlagValue(argv, '--port') || process.env.RTUNES_PORT || process.env.PORT;
  const parsedPort = rawPort ? Number(rawPort) : undefined;
  const cliPort = parsedPort && Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined;

  if (isDockerContainer()) {
    return {
      appMode: 'headless-server',
      isModeLocked: true,
      lockReason: 'docker',
      isDocker: true,
      isHeadless: true,
      isServerRole: true,
      webUiEnabled: !webUiDisabled,
      cliHost,
      cliPort,
    };
  }

  const envMode = process.env.RTUNES_MODE;
  const hasHeadlessServer =
    argv.includes('--headless') ||
    argv.includes('--headless-server') ||
    envMode === 'headless-server';
  if (hasHeadlessServer) {
    return {
      appMode: 'headless-server',
      isModeLocked: true,
      lockReason: 'cli',
      isDocker: false,
      isHeadless: true,
      isServerRole: true,
      webUiEnabled: !webUiDisabled,
      cliHost,
      cliPort,
    };
  }

  const hasHeadlessClient =
    argv.includes('--headless-client') || envMode === 'headless-client';
  if (hasHeadlessClient) {
    return {
      appMode: 'headless-client',
      isModeLocked: true,
      lockReason: 'cli',
      isDocker: false,
      isHeadless: true,
      isServerRole: false,
      webUiEnabled: !webUiDisabled,
      cliHost,
      cliPort,
    };
  }

  const appMode: AppProfile = storedMode === 'desktop-server' ? 'desktop-server' : 'client';
  return {
    appMode,
    isModeLocked: false,
    lockReason: null,
    isDocker: false,
    isHeadless: false,
    isServerRole: appMode === 'desktop-server',
    webUiEnabled: !webUiDisabled,
    cliHost,
    cliPort,
  };
}

export function getDefaultServerSidebarVisibility(mode: AppProfile): ServerSidebarVisibility {
  const isHeadlessServer = mode === 'headless-server';
  return {
    music: true,
    movies: true,
    tvShows: true,
    musicVideos: true,
    audiobooks: true,
    books: true,
    photos: true,
    store: true,
    devices: !isHeadlessServer,
    networkShares: !isHeadlessServer,
    genreMap: true,
  };
}

export function hashLocalPin(pin: string, existingSalt?: string): string {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyLocalPin(pin: string, storedHash: string): boolean {
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const actualBuf = crypto.scryptSync(pin, salt, 32);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export interface AppSettings {
  appMode: AppProfile;
  clientSource: ClientSource;
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
  enableClientLocalTranscoding: boolean;
  transcoderUpdateSchedule: TranscoderUpdateSchedule;
  lastTranscoderUpdateCheckAt: number;
  hardwareAccelMode: 'auto' | 'vt_h264' | 'nvenc' | 'qsv' | 'vaapi' | 'software';
  metadataHydrationMode: 'hybrid' | 'on_demand';
  tableColumnsJson: string;
  showOfflineDevices?: boolean;
  lcdArtistClickBehavior?: 'jump' | 'filter';
  genreMapUseLastfm?: boolean;
  genreMapLastfmWeight?: number;
  lanServerPort?: number;
  serverSidebarVisibility: ServerSidebarVisibility;
  backgroundWatchers: boolean;

  // Authentication (Authentik SSO / Proxy Headers / Local PIN)
  authGateEnabled: boolean;
  authMode: AuthMode;
  authentikIssuerUrl: string;
  authentikClientId: string;
  authentikRedirectUri: string;
  homelabGatewayUrl: string;
  trustedProxyHeader: string;
  localPinHash?: string;
  localPinPlaintext?: string;
  hasLocalPin?: boolean;

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
  try {
    return platformDriver.setSecret(KEYCHAIN_SERVICE, account, secret);
  } catch (err) {
    logger.debug('SYSTEM', `Keychain write fallback for ${account}`, { error: String(err) });
    return false;
  }
}

export function getKeychainSecret(account: string): string | null {
  return platformDriver.getSecret(KEYCHAIN_SERVICE, account);
}

export function getDefaultSettings(): AppSettings {
  const defaultCacheDir = platformDriver.getDefaultCacheDir();
  const runtime = resolveAppMode('client');
  return {
    appMode: runtime.appMode,
    clientSource: 'local',
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
    ffmpegBinaryPath:
      bundledFfmpegPath ||
      (process.platform === 'darwin'
        ? '/opt/homebrew/bin/ffmpeg'
        : process.platform === 'win32'
        ? 'ffmpeg.exe'
        : fs.existsSync('/usr/bin/ffmpeg')
        ? '/usr/bin/ffmpeg'
        : 'ffmpeg'),
    ffprobeBinaryPath:
      bundledFfprobePath ||
      (process.platform === 'darwin'
        ? '/opt/homebrew/bin/ffprobe'
        : process.platform === 'win32'
        ? 'ffprobe.exe'
        : fs.existsSync('/usr/bin/ffprobe')
        ? '/usr/bin/ffprobe'
        : 'ffprobe'),
    handbrakeBinaryPath:
      process.platform === 'darwin'
        ? '/opt/homebrew/bin/HandBrakeCLI'
        : process.platform === 'win32'
        ? 'HandBrakeCLI.exe'
        : 'HandBrakeCLI',

    cacheMaxSizeGb: 50,
    autoEvictLru: true,
    autoCachePlayback: true,
    enableClientLocalTranscoding: false,
    transcoderUpdateSchedule: 'weekly',
    lastTranscoderUpdateCheckAt: 0,
    hardwareAccelMode: 'auto',
    metadataHydrationMode: 'hybrid',
    tableColumnsJson: '',
    showOfflineDevices: false,
    lcdArtistClickBehavior: 'jump',
    genreMapUseLastfm: false,
    genreMapLastfmWeight: 20,
    lanServerPort: 3000,
    serverSidebarVisibility: getDefaultServerSidebarVisibility(runtime.appMode),
    backgroundWatchers: true,

    authGateEnabled: false,
    authMode: 'standalone',
    authentikIssuerUrl: '',
    authentikClientId: 'retrotunes-desktop',
    authentikRedirectUri: 'http://127.0.0.1:42813/callback',
    homelabGatewayUrl: '',
    trustedProxyHeader: 'X-authentik-username',
    localPinHash: '',
    localPinPlaintext: '',
    hasLocalPin: false,

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

  let legacyInferredMode: AppProfile | undefined;
  let legacyInferredRemote = false;
  if (stored.appMode === 'desktop-server' || stored.appMode === 'client') {
    legacyInferredMode = stored.appMode;
  } else if (stored.enableLanServerMode === true || stored.backendMode === 'host_server') {
    legacyInferredMode = 'desktop-server';
  } else if (stored.backendMode === 'docker_server') {
    legacyInferredMode = 'client';
    legacyInferredRemote = true;
  }

  delete stored.enableLanServerMode;
  delete stored.backendMode;

  const runtime = resolveAppMode(legacyInferredMode);

  const merged: AppSettings = {
    ...defaults,
    ...(stored as Partial<AppSettings>),
    appMode: runtime.appMode,
    clientSource:
      stored.clientSource === 'remote' || (stored.clientSource === undefined && legacyInferredRemote)
        ? 'remote'
        : 'local',
    serverSidebarVisibility: {
      ...getDefaultServerSidebarVisibility(runtime.appMode),
      ...((stored.serverSidebarVisibility as Partial<ServerSidebarVisibility>) || {}),
    },
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

  // Pull secrets from OS credential store if available
  for (const key of SECRET_KEYS) {
    const keychainVal = getKeychainSecret(key);
    if (keychainVal !== null && keychainVal.length > 0) {
      (merged as unknown as Record<string, unknown>)[key] = keychainVal;
    }
  }

  const storedPinHash = typeof merged.localPinHash === 'string' ? merged.localPinHash : '';
  merged.hasLocalPin = storedPinHash.includes(':');
  merged.localPinHash = '';
  merged.localPinPlaintext = '';

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

export function getStoredLocalPinHash(): string {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'localPinHash'")
    .get() as { value: string } | undefined;
  if (!row) return '';
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return row.value;
  }
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const runtime = resolveAppMode();
  const sanitized: Record<string, unknown> = { ...(partial as Record<string, unknown>) };

  // Strip ephemeral / legacy / locked keys
  delete sanitized.hasLocalPin;
  delete sanitized.enableLanServerMode;
  delete sanitized.backendMode;

  if (runtime.isModeLocked) {
    if (sanitized.appMode !== undefined && sanitized.appMode !== runtime.appMode) {
      logger.warn('SYSTEM', `Ignored appMode change while locked by ${runtime.lockReason}.`, {
        requested: sanitized.appMode,
        lockedTo: runtime.appMode,
      });
    }
    delete sanitized.appMode;
  } else if (sanitized.appMode !== undefined) {
    if (sanitized.appMode === 'headless-client' || sanitized.appMode === 'headless-server') {
      logger.warn('SYSTEM', 'Refused persisting CLI-only headless profile in GUI settings.', {
        requested: sanitized.appMode,
      });
      delete sanitized.appMode;
    } else if (sanitized.appMode !== 'client' && sanitized.appMode !== 'desktop-server') {
      sanitized.appMode = 'client';
    }
  }

  if (typeof sanitized.localPinPlaintext === 'string' && sanitized.localPinPlaintext.trim().length > 0) {
    sanitized.localPinHash = hashLocalPin(sanitized.localPinPlaintext.trim());
  } else if (sanitized.localPinHash === '' || sanitized.localPinHash === '[SET]') {
    delete sanitized.localPinHash;
  }
  delete sanitized.localPinPlaintext;

  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(sanitized)) {
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
    updatedKeys: Object.keys(sanitized),
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
