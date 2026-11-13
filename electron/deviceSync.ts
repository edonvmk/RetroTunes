import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import {
  getDb,
  DeviceRow,
  PlaylistRow,
  TrackRow,
  VideoRow,
  BookRow,
  AudiobookRow,
  PhotoRow,
} from './db';
import { getPlaylistTracks, getPlaylistVideos, generateRelativeM3u8 } from './smartPlaylists';
import { getSettings } from './settings';
import { logger } from './logger';
import { platformDriver } from './platform';

const execFileAsync = promisify(execFile);
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface MtpStoragePool {
  storageId: string;
  description: string;
  maxCapacity: number;
  freeSpaceInBytes: number;
  hasManifest: boolean;
  manifestJson?: string;
}

export type DeviceCatalogCategory =
  | 'music'
  | 'movies'
  | 'tv'
  | 'music_videos'
  | 'audiobooks'
  | 'books'
  | 'photos'
  | 'playlists';

export interface DeviceCatalogItem {
  devicePath: string;
  storageId?: string;
  mediaType: DeviceCatalogCategory;
  localTrackId?: number | null;
  localItemId?: number | null;
  title: string;
  artist?: string;
  album?: string;
  showName?: string;
  duration?: number;
  size: number;
}

export interface DeviceCatalog {
  version: 1;
  deviceUuid: string;
  updatedAt: string;
  items: DeviceCatalogItem[];
  playlists: { name: string; devicePath: string; trackCount: number; storageId?: string }[];
}

function broadcastDeviceCatalogUpdated(uuid: string, catalog: DeviceCatalog) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('devices:catalogUpdated', { uuid, catalog });
  }
}

export interface DeviceProfile {
  uuid: string;
  name: string;
  deviceType: 'epod_y2' | 'classic_dap' | 'phone' | 'custom';
  icon: string;
  transportMode?: 'mtp' | 'ums';
  mtpSerial?: string;
  selectedStorageId?: string;
  videoResolution: '480x360' | '320x240' | '720p' | '1080p' | 'source';
  videoFps: number;
  audioBitrateKbps: number;
  audioPassthrough: boolean;
  audioTranscodeFormat?: 'mp3' | 'aac' | 'passthrough';
  includeTrackNumberInFilename?: boolean;
  playlistFormat: 'm3u8' | 'm3u';
  musicSubdir: string;
  videoSubdir: string;
  playlistSubdir: string;
  downloadLrc: boolean;
  sanitizeCoverArt: boolean;
  cleanMacMetadata: boolean;
  syncAllMusic: boolean;
  syncPlaylistIds: number[];
  syncVideoIds: number[];
  syncPlexOnDeck?: boolean;
  plexOnDeckLimit?: number;
  syncPhotos?: boolean;
  syncPhotoAlbumNames?: string[];
  syncMusicVideos?: boolean;
  syncAudiobookIds?: number[];
  syncBookIds?: number[];
}

export interface StorageBreakdown {
  totalBytes: number;
  audioBytes: number;
  videoBytes: number;
  otherBytes: number;
  freeBytes: number;
  mounted: boolean;
}

export interface SyncProgress {
  running: boolean;
  deviceUuid: string;
  stage: string;
  processed: number;
  total: number;
  currentFile: string;
  lovedImported: number;
  listenbrainzPushed: number;
  lrcFetched: number;
  tracksSynced: number;
  videosSynced: number;
  dotfilesCleaned: number;
}

export interface DeviceTransportProvider {
  mode: 'mtp' | 'ums';
  isConnected(): Promise<boolean>;
  readTextFile(remoteRelPath: string): Promise<string | null>;
  writeTextFile(remoteRelPath: string, content: string): Promise<boolean>;
  uploadFile(localPath: string, remoteRelPath: string): Promise<boolean>;
  listDir(remoteRelPath: string): Promise<{ name: string; isDir: boolean; size: number }[]>;
}

interface MtpDetectResult {
  connected: boolean;
  busy?: boolean;
  error?: string;
  vendorId?: number;
  productId?: number;
  manufacturer?: string;
  product?: string;
  serial?: string;
  friendlyName?: string;
  storages?: MtpStoragePool[];
}

let activeSyncProgress: SyncProgress = {
  running: false,
  deviceUuid: '',
  stage: 'Idle',
  processed: 0,
  total: 0,
  currentFile: '',
  lovedImported: 0,
  listenbrainzPushed: 0,
  lrcFetched: 0,
  tracksSynced: 0,
  videosSynced: 0,
  dotfilesCleaned: 0,
};

function broadcastSyncProgress(update: Partial<SyncProgress>) {
  activeSyncProgress = { ...activeSyncProgress, ...update };
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('device:syncProgress', activeSyncProgress);
      }
    }
  } catch {
    // ignore
  }
}

function broadcastDevicesChanged() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('devices:changed');
      }
    }
  } catch {
    // ignore
  }
}

function broadcastMtpLockWarning(message: string | null) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('devices:mtpLockWarning', message);
      }
    }
  } catch {
    // ignore
  }
}

export function getSyncProgress(): SyncProgress {
  return activeSyncProgress;
}

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.m4v']);

// ============================================================================
// MTP SIDECAR HELPER & USB AUTO-DETECTION POLLER (Priority 1.1)
// ============================================================================

let mtpQueue: Promise<unknown> = Promise.resolve();
function withMtpLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mtpQueue.then(fn, fn);
  mtpQueue = next.catch(() => {});
  return next;
}

let cachedMtpState: MtpDetectResult = { connected: false };
let lastUsbPollSignature = '';
let lastMtpDetectTime = 0;
const ejectedMtpUuids = new Set<string>();
let mtpPollerTimer: NodeJS.Timeout | null = null;

export function getRtunesMtpBinaryPath(): string {
  const binName = platformDriver.getMtpBinaryName();
  const candidates = [
    path.join(process.cwd(), '.toolchain', 'bin', binName),
    path.join(__dirname, '..', '..', '.toolchain', 'bin', binName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function normalizeMtpListEntries(
  raw: string | unknown
): { name: string; isDir: boolean; size: number }[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!parsed) return [];

  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.entries)) {
      items = obj.entries;
    } else if (Array.isArray(obj.files) || Array.isArray(obj.folders)) {
      const folders = Array.isArray(obj.folders)
        ? obj.folders.map((f) => (typeof f === 'string' ? { name: f, isDir: true, size: 0 } : f))
        : [];
      const files = Array.isArray(obj.files)
        ? obj.files.map((f) => (typeof f === 'string' ? { name: f, isDir: false, size: 0 } : f))
        : [];
      items = [...folders, ...files];
    }
  }

  return items
    .map((entry) => {
      if (typeof entry === 'string') {
        return { name: entry, isDir: false, size: 0 };
      }
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const name = String(e.name ?? e.filename ?? '');
        if (!name) return null;
        return {
          name,
          isDir: Boolean(e.isDir ?? e.is_dir ?? e.type === 'dir'),
          size: Number(e.size ?? e.filesize ?? 0),
        };
      }
      return null;
    })
    .filter((e): e is { name: string; isDir: boolean; size: number } => e !== null);
}

export function createMtpTransportProvider(
  storageId: string,
  localStagingRoot: string
): DeviceTransportProvider {
  return {
    mode: 'mtp',
    async isConnected(): Promise<boolean> {
      const mtp = await refreshMtpState(false);
      return Boolean(mtp.connected && mtp.storages?.some((s) => s.storageId === storageId));
    },
    async listDir(remoteRelPath: string) {
      const normPath = remoteRelPath.startsWith('/') ? remoteRelPath : `/${remoteRelPath}`;
      const res = await withMtpLock(() => runMtpCommand(['ls', storageId, normPath], 10000));
      return normalizeMtpListEntries(res.stdout);
    },
    async readTextFile(remoteRelPath: string): Promise<string | null> {
      const normPath = remoteRelPath.startsWith('/') ? remoteRelPath : `/${remoteRelPath}`;
      const tmpPath = path.join(localStagingRoot, `.mtp_read_${Date.now()}_${path.basename(normPath)}`);
      await fsp.mkdir(path.dirname(tmpPath), { recursive: true });
      const res = await withMtpLock(() => runMtpCommand(['get', storageId, normPath, tmpPath], 10000));
      if (!res.ok || !fs.existsSync(tmpPath)) return null;
      try {
        return await fsp.readFile(tmpPath, 'utf8');
      } finally {
        await fsp.unlink(tmpPath).catch(() => {});
      }
    },
    async writeTextFile(remoteRelPath: string, content: string): Promise<boolean> {
      const normPath = remoteRelPath.startsWith('/') ? remoteRelPath : `/${remoteRelPath}`;
      const tmpPath = path.join(localStagingRoot, `.mtp_write_${Date.now()}_${path.basename(normPath)}`);
      await fsp.mkdir(path.dirname(tmpPath), { recursive: true });
      await fsp.writeFile(tmpPath, content, 'utf8');
      try {
        const res = await withMtpLock(() => runMtpCommand(['put', storageId, tmpPath, normPath], 15000));
        return res.ok;
      } finally {
        await fsp.unlink(tmpPath).catch(() => {});
      }
    },
    async uploadFile(localPath: string, remoteRelPath: string): Promise<boolean> {
      const normPath = remoteRelPath.startsWith('/') ? remoteRelPath : `/${remoteRelPath}`;
      const res = await withMtpLock(() => runMtpCommand(['put', storageId, localPath, normPath], 30000));
      return res.ok;
    },
  };
}

export async function runMtpCommand(
  args: string[],
  timeoutMs = 15000
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const bin = getRtunesMtpBinaryPath();
  if (!fs.existsSync(bin)) {
    return { stdout: '', stderr: 'rtunes-mtp binary not found', ok: false };
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: timeoutMs });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || e.message || '').trim(),
      ok: false,
    };
  }
}

export async function refreshMtpState(force = false): Promise<MtpDetectResult> {
  // Never interrupt an active MTP batch transfer
  if (activeSyncProgress.running) {
    return cachedMtpState;
  }
  if (!force && Date.now() - lastMtpDetectTime < 3000) {
    return cachedMtpState;
  }

  return withMtpLock(async () => {
    const res = await runMtpCommand(['detect'], 10000);
    lastMtpDetectTime = Date.now();
    if (!res.stdout) {
      cachedMtpState = { connected: false };
      return cachedMtpState;
    }
    try {
      const parsed = JSON.parse(res.stdout) as MtpDetectResult;
      cachedMtpState = parsed;

      if (parsed.busy) {
        const warning =
          parsed.error ||
          'USB MTP interface is locked by another process (e.g., OpenMTP or Android File Transfer). Please quit conflicting MTP apps.';
        logger.warn('DEVICE_SYNC', warning);
        broadcastMtpLockWarning(warning);
      } else {
        broadcastMtpLockWarning(null);
      }

      if (parsed.connected && parsed.storages && parsed.storages.length > 0) {
        reconcileMtpDeviceWithDatabase(parsed);
      }
      return cachedMtpState;
    } catch {
      cachedMtpState = { connected: false };
      return cachedMtpState;
    }
  });
}

function classifyMtpStorages(storages: MtpStoragePool[]): {
  internal: MtpStoragePool;
  sdCard: MtpStoragePool | null;
  isMultiDrive: boolean;
} {
  if (storages.length <= 1) {
    return { internal: storages[0], sdCard: null, isMultiDrive: false };
  }
  const sdMatch = (s: MtpStoragePool) =>
    /sd|card|external|removable|0xffff0002|ffff0002/i.test(`${s.description} ${s.storageId}`);
  const intMatch = (s: MtpStoragePool) =>
    /internal|phone|device|0xffff0001|ffff0001/i.test(`${s.description} ${s.storageId}`);

  let sdCard = storages.find(sdMatch) || null;
  let internal = storages.find((s) => s !== sdCard && intMatch(s)) || null;

  if (!internal || !sdCard) {
    const sortedAsc = [...storages].sort((a, b) => (a.maxCapacity || 0) - (b.maxCapacity || 0));
    if (!internal) internal = sortedAsc.find((s) => s !== sdCard) || sortedAsc[0];
    if (!sdCard) sdCard = sortedAsc.find((s) => s !== internal) || null;
  }

  return { internal, sdCard, isMultiDrive: Boolean(sdCard && sdCard.storageId !== internal.storageId) };
}

function detectPresetForMtp(mtp: MtpDetectResult): 'epod_y2' | 'classic_dap' | 'phone' {
  const label = `${mtp.friendlyName || ''} ${mtp.manufacturer || ''} ${mtp.product || ''}`;
  if (/pixel|android|samsung|galaxy|oneplus|xiaomi|phone/i.test(label)) return 'phone';
  if (/rockbox|ipod|dap/i.test(label)) return 'classic_dap';
  return 'epod_y2';
}

function reconcileMtpDeviceWithDatabase(mtp: MtpDetectResult) {
  if (!mtp.connected || !mtp.storages || mtp.storages.length === 0) return;
  const db = getDb();
  const serial = mtp.serial || 'MTP-DEVICE';

  // 1. Check if any storage pool has .retrotunes_device.json manifest
  let matchedUuid: string | null = null;
  let matchedStorageId: string | null = null;
  let parsedManifest: DeviceProfile | null = null;

  for (const st of mtp.storages) {
    if (st.hasManifest && st.manifestJson) {
      try {
        const manifest = JSON.parse(st.manifestJson) as DeviceProfile;
        if (manifest && manifest.uuid) {
          matchedUuid = manifest.uuid;
          matchedStorageId = st.storageId;
          parsedManifest = manifest;
          break;
        }
      } catch {
        // ignore invalid manifest json
      }
    }
  }

  const classified = classifyMtpStorages(mtp.storages);
  // Pick primary storage pool (prefer manifest storage, else SD card / largest pool)
  const defaultStorage =
    mtp.storages.find((s) => s.storageId === matchedStorageId) ||
    classified.sdCard ||
    classified.internal;

  if (matchedUuid && parsedManifest) {
    const existingRow = db
      .prepare('SELECT * FROM devices WHERE uuid = ?')
      .get(matchedUuid) as DeviceRow | undefined;

    let mergedProfile: DeviceProfile = {
      ...getDefaultProfileForPreset(parsedManifest.deviceType || detectPresetForMtp(mtp), parsedManifest.name, matchedUuid),
      ...parsedManifest,
      transportMode: 'mtp',
      mtpSerial: serial,
      selectedStorageId: matchedStorageId || defaultStorage.storageId,
      videoSubdir: 'Videos',
    };

    if (existingRow) {
      try {
        const dbProf = JSON.parse(existingRow.profile_json) as DeviceProfile;
        mergedProfile = {
          ...mergedProfile,
          ...dbProf,
          transportMode: 'mtp',
          mtpSerial: serial,
          selectedStorageId:
            (dbProf.selectedStorageId && mtp.storages.some((s) => s.storageId === dbProf.selectedStorageId)
              ? dbProf.selectedStorageId
              : null) ||
            matchedStorageId ||
            defaultStorage.storageId,
          videoSubdir: 'Videos',
        };
      } catch {
        // ignore
      }
    } else {
      logger.info('DEVICE_SYNC', `Recognized MTP device via .retrotunes_device.json: "${mergedProfile.name}" (${matchedUuid})`);
    }

    const mountUri = `mtp://${serial}/${mergedProfile.selectedStorageId}`;
    db.prepare(`
      INSERT INTO devices (uuid, name, mount_path, device_type, profile_json, transport_mode, mtp_serial, last_connected)
      VALUES (?, ?, ?, ?, ?, 'mtp', ?, datetime('now'))
      ON CONFLICT(uuid) DO UPDATE SET
        name = excluded.name,
        mount_path = excluded.mount_path,
        transport_mode = 'mtp',
        mtp_serial = excluded.mtp_serial,
        profile_json = excluded.profile_json,
        last_connected = datetime('now')
    `).run(
      mergedProfile.uuid,
      mergedProfile.name,
      mountUri,
      mergedProfile.deviceType,
      JSON.stringify(mergedProfile),
      serial
    );
    return;
  }

  // 2. Check if any existing device row already has mtp_serial = serial
  const bySerial = db
    .prepare('SELECT * FROM devices WHERE mtp_serial = ?')
    .get(serial) as DeviceRow | undefined;
  if (bySerial) {
    let prof: DeviceProfile;
    try {
      prof = JSON.parse(bySerial.profile_json) as DeviceProfile;
    } catch {
      prof = getDefaultProfileForPreset(bySerial.device_type, bySerial.name, bySerial.uuid);
    }
    const stId =
      prof.selectedStorageId && mtp.storages.some((s) => s.storageId === prof.selectedStorageId)
        ? prof.selectedStorageId
        : defaultStorage.storageId;
    prof.transportMode = 'mtp';
    prof.mtpSerial = serial;
    prof.selectedStorageId = stId;
    prof.videoSubdir = 'Videos';
    db.prepare(
      `UPDATE devices SET mount_path = ?, transport_mode = 'mtp', profile_json = ?, last_connected = datetime('now') WHERE uuid = ?`
    ).run(`mtp://${serial}/${stId}`, JSON.stringify(prof), bySerial.uuid);
    return;
  }

  // 3. Auto-register ANY newly connected MTP device (even if other devices already exist in SQLite)
  const preset = detectPresetForMtp(mtp);
  const devName = mtp.friendlyName || mtp.product || 'Portable MTP Device';
  const newProf = getDefaultProfileForPreset(preset, devName);
  newProf.transportMode = 'mtp';
  newProf.mtpSerial = serial;
  newProf.selectedStorageId = defaultStorage.storageId;
  const mountUri = `mtp://${serial}/${defaultStorage.storageId}`;
  db.prepare(`
    INSERT INTO devices (uuid, name, mount_path, device_type, profile_json, transport_mode, mtp_serial, last_connected)
    VALUES (?, ?, ?, ?, ?, 'mtp', ?, datetime('now'))
  `).run(newProf.uuid, newProf.name, mountUri, preset, JSON.stringify(newProf), serial);
  logger.info('DEVICE_SYNC', `Auto-registered new MTP device "${newProf.name}" (${serial})`, {
    uuid: newProf.uuid,
    preset,
    storages: mtp.storages.length,
  });
}

export function startMtpUsbPoller(): void {
  if (mtpPollerTimer) return;

  const pollOnce = async () => {
    if (activeSyncProgress.running) return;
    const pollRes = await runMtpCommand(['usb-poll'], 3000);
    if (!pollRes.ok || !pollRes.stdout) return;
    if (pollRes.stdout !== lastUsbPollSignature) {
      const prevSig = lastUsbPollSignature;
      lastUsbPollSignature = pollRes.stdout;
      try {
        const parsed = JSON.parse(pollRes.stdout) as { usbAttached: boolean; serial?: string };
        if (parsed.usbAttached) {
          ejectedMtpUuids.clear();
          logger.info('DEVICE_SYNC', `USB MTP device detected on bus (${parsed.serial || 'MTP'}), querying MTP responder...`);
          await refreshMtpState(true);
        } else {
          ejectedMtpUuids.clear();
          if (prevSig) {
            logger.info('DEVICE_SYNC', 'USB MTP device disconnected from bus.');
          }
          cachedMtpState = { connected: false };
        }
        broadcastDevicesChanged();
      } catch {
        // ignore
      }
    }
  };

  void pollOnce();
  mtpPollerTimer = setInterval(() => {
    void pollOnce();
  }, 3500);
}

/**
 * Explicitly links/migrates an existing UMS device profile (e.g. "Vilasinis ePod")
 * to the currently connected MTP device & target storage pool without losing any settings.
 */
export async function migrateDeviceToMtp(
  uuid: string,
  targetStorageId?: string
): Promise<{ ok: boolean; message: string }> {
  const mtp = await refreshMtpState(true);
  if (!mtp.connected || !mtp.storages || mtp.storages.length === 0) {
    return {
      ok: false,
      message: mtp.busy
        ? mtp.error || 'MTP USB interface is locked by another application.'
        : 'No MTP device is currently connected over USB.',
    };
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM devices WHERE uuid = ?').get(uuid) as DeviceRow | undefined;
  if (!row) {
    return { ok: false, message: 'Device profile not found in database.' };
  }

  let profile: DeviceProfile;
  try {
    profile = JSON.parse(row.profile_json) as DeviceProfile;
  } catch {
    profile = getDefaultProfileForPreset(row.device_type, row.name, row.uuid);
  }

  const chosenStorage =
    mtp.storages.find((s) => s.storageId === targetStorageId) ||
    mtp.storages.find((s) => s.hasManifest) ||
    [...mtp.storages].sort((a, b) => b.maxCapacity - a.maxCapacity)[0];

  const serial = mtp.serial || 'MTP-DEVICE';
  profile.transportMode = 'mtp';
  profile.mtpSerial = serial;
  profile.selectedStorageId = chosenStorage.storageId;
  profile.videoSubdir = 'Videos';

  const mountUri = `mtp://${serial}/${chosenStorage.storageId}`;
  db.prepare(`
    UPDATE devices
    SET mount_path = ?, transport_mode = 'mtp', mtp_serial = ?, profile_json = ?, last_connected = datetime('now')
    WHERE uuid = ?
  `).run(mountUri, serial, JSON.stringify(profile), uuid);

  // Write .retrotunes_device.json manifest to the MTP storage root
  const settings = getSettings();
  const tmpManifest = path.join(settings.localCachePath, `.manifest_${uuid}.json`);
  try {
    await fsp.mkdir(path.dirname(tmpManifest), { recursive: true });
    await fsp.writeFile(tmpManifest, JSON.stringify(profile, null, 2), 'utf8');
    await withMtpLock(async () => {
      await runMtpCommand(
        ['put', chosenStorage.storageId, tmpManifest, '/.retrotunes_device.json'],
        15000
      );
    });
  } catch (err) {
    logger.warn('DEVICE_SYNC', 'Failed to write manifest during MTP migration', { error: String(err) });
  }

  await refreshMtpState(true);
  broadcastDevicesChanged();
  logger.info(
    'DEVICE_SYNC',
    `Migrated device profile "${profile.name}" (${uuid}) to MTP (${serial} / ${chosenStorage.description} [${chosenStorage.storageId}])`
  );
  return {
    ok: true,
    message: `Linked "${profile.name}" to MTP device ${serial} (${chosenStorage.description}).`,
  };
}

export function getDefaultProfileForPreset(
  preset: 'epod_y2' | 'classic_dap' | 'phone' | 'custom',
  name: string,
  uuid?: string
): DeviceProfile {
  const id = uuid || crypto.randomUUID();
  if (preset === 'epod_y2') {
    return {
      uuid: id,
      name: name || 'Innioasis Y2 (ePod)',
      deviceType: 'epod_y2',
      icon: 'epod-silver',
      videoResolution: '480x360',
      videoFps: 30,
      audioBitrateKbps: 128,
      audioPassthrough: true,
      audioTranscodeFormat: 'passthrough',
      includeTrackNumberInFilename: false,
      playlistFormat: 'm3u8',
      musicSubdir: 'Music',
      videoSubdir: 'Videos',
      playlistSubdir: 'Playlists',
      downloadLrc: true,
      sanitizeCoverArt: true,
      cleanMacMetadata: true,
      syncAllMusic: true,
      syncPlaylistIds: [],
      syncVideoIds: [],
      syncPlexOnDeck: false,
      plexOnDeckLimit: 5,
      syncPhotos: false,
      syncMusicVideos: true,
    };
  }
  if (preset === 'classic_dap') {
    return {
      uuid: id,
      name: name || 'Classic Click-Wheel DAP (Rockbox)',
      deviceType: 'classic_dap',
      icon: 'classic-dap',
      videoResolution: '320x240',
      videoFps: 30,
      audioBitrateKbps: 160,
      audioPassthrough: true,
      audioTranscodeFormat: 'passthrough',
      includeTrackNumberInFilename: false,
      playlistFormat: 'm3u8',
      musicSubdir: 'Music',
      videoSubdir: 'Videos',
      playlistSubdir: 'Playlists',
      downloadLrc: true,
      sanitizeCoverArt: true,
      cleanMacMetadata: true,
      syncAllMusic: true,
      syncPlaylistIds: [],
      syncVideoIds: [],
      syncPlexOnDeck: false,
      plexOnDeckLimit: 5,
    };
  }
  return {
    uuid: id,
    name: name || 'Custom Portable Device',
    deviceType: preset,
    icon: 'device-generic',
    videoResolution: '720p',
    videoFps: 30,
    audioBitrateKbps: 256,
    audioPassthrough: true,
    audioTranscodeFormat: 'passthrough',
    includeTrackNumberInFilename: false,
    playlistFormat: 'm3u8',
    musicSubdir: 'Music',
    videoSubdir: 'Videos',
    playlistSubdir: 'Playlists',
    downloadLrc: false,
    sanitizeCoverArt: false,
    cleanMacMetadata: true,
    syncAllMusic: true,
    syncPlaylistIds: [],
    syncVideoIds: [],
  };
}

/**
 * Lists mounted volumes in /Volumes plus any connected MTP storage pools.
 */
export function listMountedVolumes(): {
  name: string;
  mountPath: string;
  hasManifest: boolean;
  manifestUuid?: string;
  totalBytes: number;
  freeBytes: number;
}[] {
  const volumesRoot = '/Volumes';
  const results: {
    name: string;
    mountPath: string;
    hasManifest: boolean;
    manifestUuid?: string;
    totalBytes: number;
    freeBytes: number;
  }[] = [];

  // Include MTP storage pools if an MTP device is currently connected
  if (cachedMtpState.connected && cachedMtpState.storages) {
    const serial = cachedMtpState.serial || 'MTP-DEVICE';
    for (const st of cachedMtpState.storages) {
      let manifestUuid: string | undefined;
      if (st.hasManifest && st.manifestJson) {
        try {
          manifestUuid = (JSON.parse(st.manifestJson) as DeviceProfile).uuid;
        } catch {
          // ignore
        }
      }
      results.push({
        name: `${cachedMtpState.friendlyName || cachedMtpState.product || 'ePod MTP'} — ${st.description}`,
        mountPath: `mtp://${serial}/${st.storageId}`,
        hasManifest: st.hasManifest,
        manifestUuid,
        totalBytes: st.maxCapacity,
        freeBytes: st.freeSpaceInBytes,
      });
    }
  }

  if (fs.existsSync(volumesRoot)) {
    try {
      const entries = fs.readdirSync(volumesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'Macintosh HD' || entry.name === 'Macintosh HD - Data') continue;
        const mountPath = path.join(volumesRoot, entry.name);
        try {
          const stat = fs.statSync(mountPath);
          if (!stat.isDirectory()) continue;

          let totalBytes = 0;
          let freeBytes = 0;
          try {
            const sfs = fs.statfsSync(mountPath);
            totalBytes = sfs.blocks * sfs.bsize;
            freeBytes = sfs.bavail * sfs.bsize;
          } catch {
            // ignore
          }

          const manifestPath = path.join(mountPath, '.retrotunes_device.json');
          let hasManifest = false;
          let manifestUuid: string | undefined;

          if (fs.existsSync(manifestPath)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DeviceProfile;
              hasManifest = true;
              manifestUuid = parsed.uuid;
              upsertDeviceRecord(mountPath, parsed);
            } catch {
              // ignore corrupt manifest
            }
          }

          results.push({
            name: entry.name,
            mountPath,
            hasManifest,
            manifestUuid,
            totalBytes,
            freeBytes,
          });
        } catch {
          // ignore inaccessible mount
        }
      }
    } catch {
      // ignore
    }
  }
  return results;
}

function upsertDeviceRecord(mountPath: string, profile: DeviceProfile) {
  const db = getDb();
  const mode = mountPath.startsWith('mtp://') ? 'mtp' : 'ums';
  db.prepare(`
    INSERT INTO devices (uuid, name, mount_path, device_type, profile_json, transport_mode, mtp_serial, last_connected)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(uuid) DO UPDATE SET
      name = excluded.name,
      mount_path = excluded.mount_path,
      device_type = excluded.device_type,
      profile_json = excluded.profile_json,
      transport_mode = excluded.transport_mode,
      mtp_serial = COALESCE(excluded.mtp_serial, devices.mtp_serial),
      last_connected = datetime('now')
  `).run(
    profile.uuid,
    profile.name,
    mountPath,
    profile.deviceType,
    JSON.stringify(profile),
    mode,
    profile.mtpSerial || null
  );
}

export async function getRegisteredDevicesAsync(): Promise<
  (DeviceRow & {
    profile: DeviceProfile;
    storage: StorageBreakdown;
    mtp_storages?: MtpStoragePool[];
    mtp_connected?: boolean;
    mtp_busy_warning?: string | null;
  })[]
> {
  await refreshMtpState(false);
  return getRegisteredDevices();
}

export function getRegisteredDevices(): (DeviceRow & {
  profile: DeviceProfile;
  storage: StorageBreakdown;
  mtp_storages?: MtpStoragePool[];
  mtp_connected?: boolean;
  mtp_busy_warning?: string | null;
})[] {
  listMountedVolumes();

  const db = getDb();
  const rows = db.prepare('SELECT * FROM devices ORDER BY last_connected DESC').all() as DeviceRow[];

  return rows.map((row) => {
    let profile: DeviceProfile;
    try {
      profile = JSON.parse(row.profile_json) as DeviceProfile;
    } catch {
      profile = getDefaultProfileForPreset(row.device_type, row.name, row.uuid);
    }

    const isMtpRow =
      row.transport_mode === 'mtp' ||
      row.mount_path.startsWith('mtp://') ||
      profile.transportMode === 'mtp';

    const isEjectedMtp = ejectedMtpUuids.has(row.uuid);
    const mtpAvailable = !isEjectedMtp && cachedMtpState.connected && (cachedMtpState.storages?.length || 0) > 0;
    const isBoundToConnectedMtp =
      !isEjectedMtp &&
      mtpAvailable &&
      (isMtpRow ||
        cachedMtpState.storages?.some((s) => {
          if (!s.manifestJson) return false;
          try {
            return (JSON.parse(s.manifestJson) as DeviceProfile).uuid === row.uuid;
          } catch {
            return false;
          }
        }));

    let storage: StorageBreakdown;
    if (isBoundToConnectedMtp && cachedMtpState.storages) {
      const targetSt =
        cachedMtpState.storages.find((s) => s.storageId === profile.selectedStorageId) ||
        cachedMtpState.storages.find((s) => s.hasManifest) ||
        [...cachedMtpState.storages].sort((a, b) => b.maxCapacity - a.maxCapacity)[0];

      profile.transportMode = 'mtp';
      profile.mtpSerial = cachedMtpState.serial;
      profile.selectedStorageId = targetSt.storageId;
      storage = getMtpStorageBreakdown(row.uuid, cachedMtpState.storages, targetSt);
    } else {
      storage = getDeviceStorageBreakdown(row.mount_path);
    }

    return {
      ...row,
      transport_mode: isBoundToConnectedMtp ? 'mtp' : row.transport_mode || 'ums',
      mtp_serial: isBoundToConnectedMtp ? cachedMtpState.serial || row.mtp_serial : row.mtp_serial,
      profile,
      storage,
      mtp_storages: mtpAvailable ? cachedMtpState.storages : undefined,
      mtp_connected: mtpAvailable,
      mtp_busy_warning: cachedMtpState.busy ? cachedMtpState.error || 'USB MTP interface is busy.' : null,
    };
  });
}

function getMtpStorageBreakdown(
  deviceUuid: string,
  storages: MtpStoragePool[],
  primaryPool: MtpStoragePool
): StorageBreakdown {
  const totalBytes = storages.reduce((acc, s) => acc + (s.maxCapacity || 0), 0);
  const freeBytes = storages.reduce((acc, s) => acc + (s.freeSpaceInBytes || 0), 0);
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  // Estimate audio vs video breakdown from local sync ledger if available, else proportional
  let audioBytes = 0;
  let videoBytes = 0;
  try {
    const settings = getSettings();
    const ledgerPath = path.join(
      settings.localCachePath,
      `mtp_ledger_${deviceUuid}_${primaryPool.storageId}.json`
    );
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
        audioBytes?: number;
        videoBytes?: number;
      };
      audioBytes = Math.min(usedBytes, ledger.audioBytes || 0);
      videoBytes = Math.min(Math.max(0, usedBytes - audioBytes), ledger.videoBytes || 0);
    }
  } catch {
    // ignore
  }

  const otherBytes = Math.max(0, usedBytes - audioBytes - videoBytes);
  return {
    totalBytes,
    audioBytes,
    videoBytes,
    otherBytes,
    freeBytes,
    mounted: true,
  };
}

export function provisionDevice(
  mountPath: string,
  profileInput: Partial<DeviceProfile> & { name: string; deviceType: 'epod_y2' | 'classic_dap' | 'phone' | 'custom' }
): DeviceRow & { profile: DeviceProfile; storage: StorageBreakdown } {
  const start = Date.now();
  const baseProfile = getDefaultProfileForPreset(
    profileInput.deviceType,
    profileInput.name,
    profileInput.uuid
  );
  const fullProfile: DeviceProfile = {
    ...baseProfile,
    ...profileInput,
    videoSubdir: 'Videos',
  };

  if (mountPath.startsWith('mtp://')) {
    const parts = mountPath.replace('mtp://', '').split('/');
    fullProfile.transportMode = 'mtp';
    fullProfile.mtpSerial = parts[0] || cachedMtpState.serial || 'MTP-DEVICE';
    fullProfile.selectedStorageId = parts[1] || '0xffff0001';
    upsertDeviceRecord(mountPath, fullProfile);

    // Asynchronously push .retrotunes_device.json to the MTP storage root
    const settings = getSettings();
    const tmpManifest = path.join(settings.localCachePath, `.manifest_${fullProfile.uuid}.json`);
    fs.mkdirSync(path.dirname(tmpManifest), { recursive: true });
    fs.writeFileSync(tmpManifest, JSON.stringify(fullProfile, null, 2), 'utf8');
    void withMtpLock(async () => {
      await runMtpCommand([
        'put',
        fullProfile.selectedStorageId!,
        tmpManifest,
        '/.retrotunes_device.json',
      ]);
    });

    const pool = cachedMtpState.storages?.find(
      (s) => s.storageId === fullProfile.selectedStorageId
    );
    const storage = pool
      ? getMtpStorageBreakdown(fullProfile.uuid, cachedMtpState.storages || [pool], pool)
      : { totalBytes: 0, audioBytes: 0, videoBytes: 0, otherBytes: 0, freeBytes: 0, mounted: true };

    return {
      uuid: fullProfile.uuid,
      name: fullProfile.name,
      mount_path: mountPath,
      device_type: fullProfile.deviceType,
      profile_json: JSON.stringify(fullProfile),
      transport_mode: 'mtp',
      mtp_serial: fullProfile.mtpSerial,
      last_connected: new Date().toISOString(),
      last_synced: null,
      profile: fullProfile,
      storage,
    };
  }

  fs.mkdirSync(mountPath, { recursive: true });

  // Write .retrotunes_device.json manifest to device root (Section 1.2)
  const manifestPath = path.join(mountPath, '.retrotunes_device.json');
  fs.writeFileSync(manifestPath, JSON.stringify(fullProfile, null, 2), 'utf8');

  // Create exact Section 1.2 directory hierarchy on the device
  for (const dir of [
    'Music',
    'Playlists',
    path.join('Videos', 'Movies'),
    path.join('Videos', 'TV Shows'),
    path.join('Videos', 'Music Videos'),
    'Pictures',
    'Books',
    'Audiobooks',
  ]) {
    fs.mkdirSync(path.join(mountPath, dir), { recursive: true });
  }

  upsertDeviceRecord(mountPath, fullProfile);

  logger.info(
    'DEVICE_SYNC',
    `Provisioned device "${fullProfile.name}" (${fullProfile.deviceType}) at ${mountPath}`,
    { manifestPath, profile: fullProfile },
    Date.now() - start
  );

  const storage = getDeviceStorageBreakdown(mountPath);
  return {
    uuid: fullProfile.uuid,
    name: fullProfile.name,
    mount_path: mountPath,
    device_type: fullProfile.deviceType,
    profile_json: JSON.stringify(fullProfile),
    transport_mode: 'ums',
    last_connected: new Date().toISOString(),
    last_synced: null,
    profile: fullProfile,
    storage,
  };
}

/**
 * Priority 1.3: Unified Device Renaming across MTP (0xD402 DeviceFriendlyName + manifest)
 * and UMS (diskutil rename with FAT32 11-uppercase-char vs exFAT mixed-case awareness).
 */
export async function updateDeviceProfile(uuid: string, updatedProfile: DeviceProfile): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM devices WHERE uuid = ?').get(uuid) as DeviceRow | undefined;
  if (!row) return;

  updatedProfile.videoSubdir = 'Videos';
  let currentMountPath = row.mount_path;
  const nameChanged =
    Boolean(updatedProfile.name) && updatedProfile.name.trim() !== row.name.trim();

  const isMtp =
    row.transport_mode === 'mtp' ||
    currentMountPath.startsWith('mtp://') ||
    updatedProfile.transportMode === 'mtp';

  if (isMtp && cachedMtpState.connected) {
    const serial = cachedMtpState.serial || row.mtp_serial || 'MTP-DEVICE';
    const storageId =
      updatedProfile.selectedStorageId ||
      cachedMtpState.storages?.[0]?.storageId ||
      '0xffff0002';
    currentMountPath = `mtp://${serial}/${storageId}`;
    updatedProfile.transportMode = 'mtp';
    updatedProfile.mtpSerial = serial;
    updatedProfile.selectedStorageId = storageId;

    if (nameChanged) {
      logger.info(
        'DEVICE_SYNC',
        `Updating MTP DeviceFriendlyName (0xD402) to "${updatedProfile.name.trim()}"...`
      );
      await withMtpLock(async () => {
        await runMtpCommand(['rename', updatedProfile.name.trim()], 10000);
      });
    }

    // Also update Root/.retrotunes_device.json on the selected MTP storage pool
    try {
      const settings = getSettings();
      const tmpManifest = path.join(settings.localCachePath, `.manifest_${uuid}.json`);
      await fsp.mkdir(path.dirname(tmpManifest), { recursive: true });
      await fsp.writeFile(tmpManifest, JSON.stringify(updatedProfile, null, 2), 'utf8');
      await withMtpLock(async () => {
        await runMtpCommand(['put', storageId, tmpManifest, '/.retrotunes_device.json'], 15000);
      });
    } catch (err) {
      logger.warn('DEVICE_SYNC', 'Could not write updated .retrotunes_device.json over MTP', {
        error: String(err),
      });
    }
  } else if (
    nameChanged &&
    currentMountPath &&
    fs.existsSync(currentMountPath)
  ) {
    try {
      logger.info(
        'DEVICE_SYNC',
        `Renaming mounted UMS volume ${currentMountPath} to "${updatedProfile.name.trim()}"...`
      );
      const renamed = await platformDriver.renameVolume(currentMountPath, updatedProfile.name);
      if (renamed.ok && renamed.newMountPath) {
        currentMountPath = renamed.newMountPath;
        logger.info('DEVICE_SYNC', `OS volume renamed and remounted at ${currentMountPath}`);
      }
    } catch (err) {
      logger.warn('DEVICE_SYNC', `Could not rename OS volume ${currentMountPath}`, {
        error: String(err),
      });
    }
  }

  db.prepare(
    'UPDATE devices SET name = ?, mount_path = ?, device_type = ?, profile_json = ?, transport_mode = ? WHERE uuid = ?'
  ).run(
    updatedProfile.name,
    currentMountPath,
    updatedProfile.deviceType,
    JSON.stringify(updatedProfile),
    isMtp ? 'mtp' : 'ums',
    uuid
  );

  if (!isMtp && currentMountPath && fs.existsSync(currentMountPath)) {
    try {
      await fsp.writeFile(
        path.join(currentMountPath, '.retrotunes_device.json'),
        JSON.stringify(updatedProfile, null, 2),
        'utf8'
      );
      logger.info('DEVICE_SYNC', `Updated .retrotunes_device.json manifest on ${currentMountPath}`);
    } catch (err) {
      logger.warn('DEVICE_SYNC', `Could not update .retrotunes_device.json at ${currentMountPath}`, {
        error: String(err),
      });
    }
  }
}

export function getDeviceStorageBreakdown(mountPath: string): StorageBreakdown {
  if (!mountPath || mountPath.startsWith('mtp://') || !fs.existsSync(mountPath)) {
    return {
      totalBytes: 0,
      audioBytes: 0,
      videoBytes: 0,
      otherBytes: 0,
      freeBytes: 0,
      mounted: false,
    };
  }

  let totalBytes = 64 * 1024 * 1024 * 1024;
  let freeBytes = 32 * 1024 * 1024 * 1024;
  try {
    const sfs = fs.statfsSync(mountPath);
    totalBytes = sfs.blocks * sfs.bsize;
    freeBytes = sfs.bavail * sfs.bsize;
  } catch {
    // fallback if statfs restricted
  }

  let audioBytes = 0;
  let videoBytes = 0;
  let scannedBytes = 0;

  const scanDir = (dir: string, depth = 0) => {
    if (depth > 6) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const sz = fs.statSync(full).size;
          scannedBytes += sz;
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTS.has(ext)) {
            audioBytes += sz;
          } else if (VIDEO_EXTS.has(ext)) {
            videoBytes += sz;
          }
        } catch {
          // ignore
        }
      }
    }
  };

  scanDir(mountPath);

  const usedBytesOnFs = Math.max(scannedBytes, totalBytes - freeBytes);
  const otherBytes = Math.max(0, usedBytesOnFs - audioBytes - videoBytes);

  return {
    totalBytes,
    audioBytes,
    videoBytes,
    otherBytes,
    freeBytes,
    mounted: true,
  };
}

/**
 * Fetches synchronized karaoke lyrics (.lrc) via LRCLIB API.
 */
async function fetchLrcFromLrclib(track: TrackRow): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist,
    });
    if (track.album && track.album !== 'Unknown Album') {
      params.set('album_name', track.album);
    }
    if (track.duration && track.duration > 0) {
      params.set('duration', String(Math.round(track.duration)));
    }

    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: {
        'User-Agent': 'RetroTunes/2.0.0 ( https://retrotunes.local )',
        Accept: 'application/json',
      },
    });

    if (res.ok) {
      const data = (await res.json()) as { syncedLyrics?: string; plainLyrics?: string };
      if (data.syncedLyrics) return data.syncedLyrics;
      if (data.plainLyrics) return data.plainLyrics;
    }

    const searchRes = await fetch(
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(track.title)}&artist_name=${encodeURIComponent(track.artist)}`,
      {
        headers: {
          'User-Agent': 'RetroTunes/2.0.0 ( https://retrotunes.local )',
          Accept: 'application/json',
        },
      }
    );
    if (searchRes.ok) {
      const list = (await searchRes.json()) as { syncedLyrics?: string; plainLyrics?: string }[];
      const firstWithSynced = list.find((item) => item.syncedLyrics);
      if (firstWithSynced?.syncedLyrics) return firstWithSynced.syncedLyrics;
    }
  } catch (err) {
    logger.debug('LRCLIB', `LRCLIB fetch skipped for "${track.artist} - ${track.title}"`, {
      error: String(err),
    });
  }
  return null;
}

let cancelSyncRequested = false;
let activeSyncAbortController: AbortController | null = null;
let activeSyncChildProcess: ChildProcess | null = null;

function killActiveSyncChild(): void {
  const child = activeSyncChildProcess;
  activeSyncChildProcess = null;
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

export function cancelDeviceSync(): void {
  cancelSyncRequested = true;
  activeSyncAbortController?.abort();
  killActiveSyncChild();
  broadcastSyncProgress({
    running: false,
    stage: 'Sync cancelled by user',
    currentFile: '',
  });
  logger.info('DEVICE_SYNC', 'User requested cancellation of active ePod sync (hard-cancelled).');
}

async function sanitizeCoverArtTo500Baseline(
  sourceArtPath: string,
  targetArtPath: string,
  ffmpegPath: string
): Promise<boolean> {
  try {
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      await execFileAsync(
        ffmpegPath,
        [
          '-y',
          '-i',
          sourceArtPath,
          '-vf',
          'scale=500:500:force_original_aspect_ratio=increase,crop=500:500',
          '-pix_fmt',
          'yuvj420p',
          '-q:v',
          '4',
          targetArtPath,
        ],
        { timeout: 8000 }
      );
      return fs.existsSync(targetArtPath);
    }
    if (await platformDriver.resizeImageFallback(sourceArtPath, targetArtPath, 500)) {
      return true;
    }
  } catch (err) {
    logger.debug('DEVICE_SYNC', `Cover art sanitization fallback for ${sourceArtPath}`, {
      error: String(err),
    });
  }
  return false;
}

async function downscalePhotoTo480x360(
  sourcePhotoPath: string,
  targetPhotoPath: string,
  ffmpegPath: string
): Promise<boolean> {
  try {
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      await execFileAsync(
        ffmpegPath,
        [
          '-y',
          '-i',
          sourcePhotoPath,
          '-vf',
          'scale=480:360:force_original_aspect_ratio=decrease',
          '-pix_fmt',
          'yuvj420p',
          '-q:v',
          '4',
          targetPhotoPath,
        ],
        { timeout: 8000 }
      );
      return fs.existsSync(targetPhotoPath);
    }
    if (await platformDriver.resizeImageFallback(sourcePhotoPath, targetPhotoPath, 480)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Cleans macOS metadata files (dot_clean -m, deletes .DS_Store, .Spotlight-V100, and ._*) on UMS drives.
 */
export async function cleanMacMetadataFiles(mountPath: string): Promise<number> {
  if (!mountPath || mountPath.startsWith('mtp://') || !fs.existsSync(mountPath)) return 0;
  return platformDriver.cleanOsMetadata(mountPath);
}

export async function syncDevice(uuid: string): Promise<SyncProgress> {
  if (activeSyncProgress.running) {
    return activeSyncProgress;
  }
  cancelSyncRequested = false;
  activeSyncAbortController = new AbortController();
  broadcastSyncProgress({
    running: true,
    deviceUuid: uuid,
    stage: 'Starting Background ePod Sync Engine...',
    processed: 0,
    total: 100,
    currentFile: '',
    lovedImported: 0,
    listenbrainzPushed: 0,
    lrcFetched: 0,
    tracksSynced: 0,
    videosSynced: 0,
    dotfilesCleaned: 0,
  });

  void runSyncDeviceWorker(uuid);
  return activeSyncProgress;
}

/**
 * Runs a single-session MTP batch upload using `.toolchain/bin/rtunes-mtp batch-put`
 * and streams progress updates to the UI.
 */
async function executeMtpBatchUpload(
  items: { storageId: string; localPath: string; remotePath: string }[],
  onItemUploaded: (idx: number, total: number, remotePath: string) => void
): Promise<number> {
  if (items.length === 0) return 0;

  // Filter out any macOS metadata files (.DS_Store, .Spotlight-V100, ._*) before MTP transfer!
  const filtered = items.filter((item) => {
    const base = path.basename(item.remotePath);
    if (
      base === '.DS_Store' ||
      base === '.Spotlight-V100' ||
      base.startsWith('._') ||
      base === '.Trashes'
    ) {
      return false;
    }
    return fs.existsSync(item.localPath);
  });

  if (filtered.length === 0) return 0;

  const byStorage = new Map<string, { localPath: string; remotePath: string }[]>();
  for (const item of filtered) {
    const list = byStorage.get(item.storageId) || [];
    list.push({ localPath: item.localPath, remotePath: item.remotePath });
    byStorage.set(item.storageId, list);
  }

  const settings = getSettings();
  const totalCount = filtered.length;
  let globalIdx = 0;
  let uploadedCount = 0;

  for (const [storageId, poolItems] of byStorage.entries()) {
    if (cancelSyncRequested) break;
    const batchFile = path.join(settings.localCachePath, `mtp_batch_${Date.now()}_${storageId}.txt`);
    await fsp.mkdir(path.dirname(batchFile), { recursive: true });
    const batchContent = poolItems.map((i) => `${i.localPath}\t${i.remotePath}`).join('\n') + '\n';
    await fsp.writeFile(batchFile, batchContent, 'utf8');

    const poolUploaded = await withMtpLock(
      () =>
        new Promise<number>((resolve) => {
          if (cancelSyncRequested) {
            fsp.rm(batchFile, { force: true }).catch(() => {});
            resolve(0);
            return;
          }
          const bin = getRtunesMtpBinaryPath();
          const child = spawn(bin, ['batch-put', storageId, batchFile]);
          activeSyncChildProcess = child;
          let count = 0;
          let buffer = '';
          let watchdog: NodeJS.Timeout | null = null;

          const resetWatchdog = () => {
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(() => {
              logger.warn('DEVICE_SYNC', `MTP batch transfer stalled >35s on storage ${storageId}; terminating worker.`);
              killActiveSyncChild();
            }, 35000);
          };
          resetWatchdog();

          const finish = () => {
            if (watchdog) clearTimeout(watchdog);
            if (activeSyncChildProcess === child) activeSyncChildProcess = null;
            fsp.rm(batchFile, { force: true }).catch(() => {});
            resolve(count);
          };

          child.stdout.on('data', (chunk: Buffer) => {
            resetWatchdog();
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('BATCH_OK ')) {
                count++;
                globalIdx++;
                const m = line.match(/^BATCH_OK\s+(\d+)\/(\d+)\s+(.+)$/);
                if (m) {
                  onItemUploaded(globalIdx, totalCount, m[3]);
                }
              } else if (line.startsWith('BATCH_ERR ')) {
                globalIdx++;
                logger.warn('DEVICE_SYNC', `MTP file skipped: ${line}`);
              }
            }
            if (cancelSyncRequested) {
              killActiveSyncChild();
            }
          });

          child.on('close', finish);
          child.on('error', finish);
        })
    );
    uploadedCount += poolUploaded;
  }

  return uploadedCount;
}

/**
 * Asynchronous Background Two-Way Synchronization Worker supporting both
 * Native MTP (Y2 Reborn / Y2Linux) and UMS (/Volumes/...) with the exact Section 1.2 hierarchy
 * and Priority 6 Delta & Log-based Play Count Sync.
 */
async function runSyncDeviceWorker(uuid: string): Promise<SyncProgress> {
  const start = Date.now();
  const db = getDb();
  const settings = getSettings();
  const deviceRow = db.prepare('SELECT * FROM devices WHERE uuid = ?').get(uuid) as
    | DeviceRow
    | undefined;
  if (!deviceRow) {
    broadcastSyncProgress({ running: false, stage: 'Device not found' });
    throw new Error(`Device ${uuid} not found in database.`);
  }

  const profile = JSON.parse(deviceRow.profile_json) as DeviceProfile;
  profile.videoSubdir = 'Videos';

  const isMtp =
    deviceRow.transport_mode === 'mtp' ||
    deviceRow.mount_path.startsWith('mtp://') ||
    profile.transportMode === 'mtp';

  let mtpStorageId = profile.selectedStorageId || '0xffff0002';
  let localRootPath = deviceRow.mount_path;

  if (isMtp) {
    if (!cachedMtpState.connected) {
      await refreshMtpState(true);
    }
    if (!cachedMtpState.connected) {
      broadcastSyncProgress({ running: false, stage: 'MTP Device not connected' });
      throw new Error('MTP Device is not currently connected over USB.');
    }
    const validPool =
      cachedMtpState.storages?.find((s) => s.storageId === mtpStorageId) ||
      cachedMtpState.storages?.[0];
    if (validPool) {
      mtpStorageId = validPool.storageId;
    }
    // Use local staging directory mirroring the exact MTP storage hierarchy
    localRootPath = path.join(settings.localCachePath, 'mtp_staging', `${uuid}_${mtpStorageId}`);
    await fsp.mkdir(localRootPath, { recursive: true });
  } else {
    if (!fs.existsSync(localRootPath)) {
      broadcastSyncProgress({ running: false, stage: 'Device not mounted' });
      throw new Error(`Device mount path ${localRootPath} is not currently mounted.`);
    }
  }

  // Load MTP ledger of previously uploaded relative paths -> size so we only push delta changes over USB
  const ledgerPath = path.join(
    settings.localCachePath,
    `mtp_ledger_${uuid}_${mtpStorageId}.json`
  );
  let mtpUploadedLedger: Record<string, number> = {};
  if (isMtp && fs.existsSync(ledgerPath)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(ledgerPath, 'utf8')) as {
        files?: Record<string, number>;
      };
      mtpUploadedLedger = parsed.files || {};
    } catch {
      mtpUploadedLedger = {};
    }
  }

  const pendingMtpUploads: { storageId: string; localPath: string; remotePath: string }[] = [];

  // Dynamic multi-drive MTP storage allocator:
  // - Videos -> Internal Storage (up to 80% of internal capacity), overflowing to SD Card
  // - Music / Other -> SD Card, overflowing to Internal Storage (up to 80% of internal capacity)
  const mtpPools = isMtp && cachedMtpState.storages?.length ? cachedMtpState.storages : [];
  const classifiedPools = mtpPools.length > 0 ? classifyMtpStorages(mtpPools) : null;
  let internalUsedBytes = classifiedPools
    ? Math.max(0, (classifiedPools.internal.maxCapacity || 0) - (classifiedPools.internal.freeSpaceInBytes || 0))
    : 0;
  const internalCap80Bytes = classifiedPools
    ? Math.floor((classifiedPools.internal.maxCapacity || 0) * 0.8)
    : 0;
  let sdUsedBytes = classifiedPools?.sdCard
    ? Math.max(0, (classifiedPools.sdCard.maxCapacity || 0) - (classifiedPools.sdCard.freeSpaceInBytes || 0))
    : 0;
  const sdCap98Bytes = classifiedPools?.sdCard
    ? Math.floor((classifiedPools.sdCard.maxCapacity || 0) * 0.98)
    : 0;

  const chooseTargetStorageForItem = (
    kind: 'video' | 'music' | 'other',
    fileSize: number
  ): string => {
    if (!classifiedPools || !classifiedPools.isMultiDrive || !classifiedPools.sdCard) {
      return mtpStorageId;
    }
    const internalId = classifiedPools.internal.storageId;
    const sdId = classifiedPools.sdCard.storageId;

    if (kind === 'video') {
      if (internalUsedBytes + fileSize <= internalCap80Bytes) {
        internalUsedBytes += fileSize;
        return internalId;
      }
      if (sdUsedBytes + fileSize <= sdCap98Bytes) {
        sdUsedBytes += fileSize;
        return sdId;
      }
      const intFree = Math.max(0, (classifiedPools.internal.maxCapacity || 0) - internalUsedBytes);
      const sdFree = Math.max(0, (classifiedPools.sdCard.maxCapacity || 0) - sdUsedBytes);
      if (intFree >= sdFree) {
        internalUsedBytes += fileSize;
        return internalId;
      }
      sdUsedBytes += fileSize;
      return sdId;
    }

    // Music / Playlists / Other: prefer SD card, overflow to Internal up to 80%, then SD card
    if (sdUsedBytes + fileSize <= sdCap98Bytes) {
      sdUsedBytes += fileSize;
      return sdId;
    }
    if (internalUsedBytes + fileSize <= internalCap80Bytes) {
      internalUsedBytes += fileSize;
      return internalId;
    }
    sdUsedBytes += fileSize;
    return sdId;
  };

  const catalogItems: DeviceCatalogItem[] = [];
  const catalogPlaylists: DeviceCatalog['playlists'] = [];

  const queueIfNeeded = async (
    localFile: string,
    remoteRelPath: string,
    kind: 'video' | 'music' | 'other' = 'other'
  ): Promise<string | undefined> => {
    if (!isMtp) return undefined;
    try {
      const st = await fsp.stat(localFile);
      const targetStorageId = chooseTargetStorageForItem(kind, st.size);
      const ledgerKey = `${targetStorageId}:${remoteRelPath}`;
      if (
        (mtpUploadedLedger[ledgerKey] === st.size || mtpUploadedLedger[remoteRelPath] === st.size) &&
        st.size > 0
      ) {
        return targetStorageId; // Already present on MTP storage with identical byte size
      }
      pendingMtpUploads.push({ storageId: targetStorageId, localPath: localFile, remotePath: remoteRelPath });
      return targetStorageId;
    } catch {
      return undefined;
    }
  };

  logger.info(
    'DEVICE_SYNC',
    `Starting Async Two-Way ePod Sync (${isMtp ? `MTP [${mtpStorageId}]` : `UMS [${localRootPath}]`}) for "${profile.name}"`,
    {
      uuid,
      transport: isMtp ? 'mtp' : 'ums',
      storageId: isMtp ? mtpStorageId : undefined,
      mountPath: localRootPath,
    }
  );

  let lovedImported = 0;
  let listenbrainzPushed = 0;
  let lrcFetched = 0;
  let tracksSynced = 0;
  let videosSynced = 0;

  try {
    // =========================================================================
    // PHASE 1: DEVICE-TO-APP FEEDBACK, .SCROBBLER.LOG & DELTA PLAY COUNT SYNC
    // =========================================================================
    broadcastSyncProgress({
      stage: isMtp
        ? 'Reading on-device Favorites & Scrobble Logs over MTP...'
        : 'Reading on-device Favorites & Scrobble Logs...',
    });

    if (isMtp) {
      ejectedMtpUuids.delete(uuid);
      const mtpProvider = createMtpTransportProvider(mtpStorageId, localRootPath);
      // Pull feedback files from MTP root if they exist on the device
      const rawRootEntries = await mtpProvider.listDir('/');
      const rootEntries = Array.isArray(rawRootEntries) ? rawRootEntries : [];
      const rootNames = new Set(rootEntries.map((e) => e.name));

      // Ensure Section 1.2 target directory tree exists even on an empty MTP storage root
      const requiredMtpDirs = [
        '/Music',
        '/Playlists',
        '/Videos',
        '/Videos/Movies',
        '/Videos/TV Shows',
        '/Videos/Music Videos',
        '/Pictures',
        '/Books',
        '/Audiobooks',
      ];
      for (const dirPath of requiredMtpDirs) {
        const topName = dirPath.split('/')[1];
        if (!rootNames.has(topName) || dirPath.includes('/', 1)) {
          await withMtpLock(() => runMtpCommand(['mkdir', mtpStorageId, dirPath], 8000));
        }
      }

      for (const fname of [
        'Favorites.m3u',
        'Favorites.m3u8',
        'My Favorite.m3u',
        '.jj_ratings.json',
        '.scrobbler.log',
        '.retrotunes_plays.json',
      ]) {
        if (rootNames.has(fname)) {
          await withMtpLock(() =>
            runMtpCommand(
              ['get', mtpStorageId, `/${fname}`, path.join(localRootPath, fname)],
              10000
            )
          );
        }
      }
    }

    const favoriteCandidates = [
      path.join(localRootPath, 'Favorites.m3u'),
      path.join(localRootPath, 'Favorites.m3u8'),
      path.join(localRootPath, 'My Favorite.m3u'),
      path.join(localRootPath, 'Playlists', 'Favorites.m3u'),
      path.join(localRootPath, 'Playlists', 'Favorites.m3u8'),
      path.join(localRootPath, 'Playlists', 'My Favorite.m3u'),
    ];

    const lovedBasenames = new Set<string>();
    for (const favFile of favoriteCandidates) {
      if (fs.existsSync(favFile)) {
        const content = await fsp.readFile(favFile, 'utf8');
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const base = path.basename(line.replace(/\\/g, '/'));
          if (base) lovedBasenames.add(base.toLowerCase());
        }
      }
    }

    const jjRatingsPath = path.join(localRootPath, '.jj_ratings.json');
    const customRatingsMap = new Map<string, number>();
    if (fs.existsSync(jjRatingsPath)) {
      try {
        const ratingsObj = JSON.parse(await fsp.readFile(jjRatingsPath, 'utf8')) as Record<
          string,
          number
        >;
        for (const [k, stars] of Object.entries(ratingsObj)) {
          const base = path.basename(k.replace(/\\/g, '/')).toLowerCase();
          customRatingsMap.set(base, stars);
          if (stars >= 5) lovedBasenames.add(base);
        }
      } catch {
        // ignore
      }
    }

    const allTracks = db.prepare('SELECT * FROM tracks').all() as TrackRow[];

    // Priority 6.2: Parse .scrobbler.log (Rockbox / Y2Linux format) with high-water timestamp
    const scrobblerLogPath = path.join(localRootPath, '.scrobbler.log');
    let maxScrobbleTs = deviceRow.last_processed_scrobble_ts || 0;
    if (fs.existsSync(scrobblerLogPath)) {
      try {
        const logContent = await fsp.readFile(scrobblerLogPath, 'utf8');
        const incPlayStmt = db.prepare(
          `UPDATE tracks SET play_count = COALESCE(play_count, 0) + 1, last_played = datetime(?, 'unixepoch') WHERE LOWER(artist) = LOWER(?) AND LOWER(title) = LOWER(?)`
        );
        for (const rawLine of logContent.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const parts = line.split('\t');
          if (parts.length >= 7) {
            const [art, , tit, , , rating, tsStr] = parts;
            const ts = parseInt(tsStr, 10) || 0;
            if (rating === 'L' && ts > (deviceRow.last_processed_scrobble_ts || 0)) {
              incPlayStmt.run(ts, art.trim(), tit.trim());
              if (ts > maxScrobbleTs) maxScrobbleTs = ts;
            }
          }
        }
        if (maxScrobbleTs > (deviceRow.last_processed_scrobble_ts || 0)) {
          db.prepare('UPDATE devices SET last_processed_scrobble_ts = ? WHERE uuid = ?').run(
            maxScrobbleTs,
            uuid
          );
        }
      } catch (err) {
        logger.warn('DEVICE_SYNC', 'Failed to parse .scrobbler.log', { error: String(err) });
      }
    }

    // Priority 6.2: Delta-based play count sync via .retrotunes_plays.json & device_play_state table
    const devicePlaysJsonPath = path.join(localRootPath, '.retrotunes_plays.json');
    if (fs.existsSync(devicePlaysJsonPath)) {
      try {
        const playsMap = JSON.parse(await fsp.readFile(devicePlaysJsonPath, 'utf8')) as Record<
          string,
          number
        >;
        const getPlayStateStmt = db.prepare(
          'SELECT last_known_device_plays FROM device_play_state WHERE device_uuid = ? AND track_id = ?'
        );
        const upsertPlayStateStmt = db.prepare(`
          INSERT INTO device_play_state (device_uuid, track_id, last_known_device_plays, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(device_uuid, track_id) DO UPDATE SET
            last_known_device_plays = excluded.last_known_device_plays,
            updated_at = datetime('now')
        `);
        const addPlayDeltaStmt = db.prepare(
          `UPDATE tracks SET play_count = COALESCE(play_count, 0) + ?, last_played = datetime('now') WHERE id = ?`
        );

        for (const [trackIdOrKey, devCumulativePlays] of Object.entries(playsMap)) {
          const tid = Number(trackIdOrKey);
          if (!Number.isFinite(tid) || devCumulativePlays <= 0) continue;
          const prevRow = getPlayStateStmt.get(uuid, tid) as
            | { last_known_device_plays: number }
            | undefined;
          const prevPlays = prevRow?.last_known_device_plays || 0;
          const delta = Math.max(0, devCumulativePlays - prevPlays);
          if (delta > 0) {
            addPlayDeltaStmt.run(delta, tid);
          }
          if (devCumulativePlays !== prevPlays) {
            upsertPlayStateStmt.run(uuid, tid, devCumulativePlays);
          }
        }
      } catch {
        // ignore
      }
    }

    const markLovedStmt = db.prepare(
      'UPDATE tracks SET is_loved = 1, local_star_rating = MAX(local_star_rating, ?) WHERE id = ?'
    );

    for (let i = 0; i < allTracks.length; i++) {
      if (i % 500 === 0) await yieldToEventLoop();
      const track = allTracks[i];
      const remoteBase = path.basename(track.remote_nfs_path).toLowerCase();
      const extLower = path.extname(track.remote_nfs_path).toLowerCase();
      const cleanSongBase = `${track.title}${extLower}`
        .replace(/[/\\?%*:|"<>]/g, '_')
        .toLowerCase();
      const numberedSongBase = `${String(track.track_num || 1).padStart(2, '0')} - ${track.title}${extLower}`
        .replace(/[/\\?%*:|"<>]/g, '_')
        .toLowerCase();

      const matchedFav =
        lovedBasenames.has(remoteBase) ||
        lovedBasenames.has(cleanSongBase) ||
        lovedBasenames.has(numberedSongBase);
      const customStars =
        customRatingsMap.get(remoteBase) ||
        customRatingsMap.get(cleanSongBase) ||
        customRatingsMap.get(numberedSongBase) ||
        5;

      if (matchedFav && (!track.is_loved || track.local_star_rating < customStars)) {
        markLovedStmt.run(customStars, track.id);
        lovedImported++;

        if (settings.listenbrainzToken && track.mbid_recording) {
          try {
            const lbRes = await fetch(
              'https://api.listenbrainz.org/1/feedback/recording-feedback',
              {
                method: 'POST',
                headers: {
                  Authorization: `Token ${settings.listenbrainzToken.trim()}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  recording_mbid: track.mbid_recording,
                  score: 1,
                }),
              }
            );
            if (lbRes.ok) {
              listenbrainzPushed++;
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // =========================================================================
    // PHASE 2: PREPARE EXACT SECTION 1.2 DIRECTORY HIERARCHY & FILES
    // =========================================================================
    const tracksToSyncMap = new Map<number, TrackRow>();
    const playlistVideosMap = new Map<number, VideoRow>();

    if (profile.syncAllMusic || profile.syncPlaylistIds.length === 0) {
      for (const t of db.prepare('SELECT * FROM tracks').all() as TrackRow[]) {
        tracksToSyncMap.set(t.id, t);
      }
    } else {
      for (const plId of profile.syncPlaylistIds) {
        for (const t of getPlaylistTracks(plId)) {
          tracksToSyncMap.set(t.id, t);
        }
        for (const v of getPlaylistVideos(plId)) {
          playlistVideosMap.set(v.id, v);
        }
      }
    }

    const explicitVideos =
      profile.syncVideoIds.length > 0
        ? (db
            .prepare(
              `SELECT * FROM videos WHERE id IN (${profile.syncVideoIds.map(() => '?').join(',')})`
            )
            .all(...profile.syncVideoIds) as VideoRow[])
        : (db
            .prepare('SELECT * FROM videos WHERE keep_cached = 1 OR is_transcoded = 1')
            .all() as VideoRow[]);

    for (const v of explicitVideos) {
      playlistVideosMap.set(v.id, v);
    }

    // Priority 6.3: Auto-Sync Plex On Deck (Next N Unwatched Episodes)
    if (profile.syncPlexOnDeck) {
      const limit = Math.max(1, Math.min(50, profile.plexOnDeckLimit || 5));
      const unwatchedEpisodes = db
        .prepare(
          `SELECT * FROM videos WHERE type = 'tv' AND COALESCE(play_count, 0) = 0 ORDER BY show_name ASC, season ASC, episode ASC LIMIT ?`
        )
        .all(limit) as VideoRow[];
      for (const ep of unwatchedEpisodes) {
        playlistVideosMap.set(ep.id, ep);
      }
    }

    // Priority 7.3: Include Music Videos if enabled
    if (profile.syncMusicVideos) {
      const mvs = db
        .prepare(`SELECT * FROM videos WHERE type = 'music_video'`)
        .all() as VideoRow[];
      for (const mv of mvs) {
        playlistVideosMap.set(mv.id, mv);
      }
    }

    const videosToSync = Array.from(playlistVideosMap.values());
    const photosToSync = profile.syncPhotos
      ? (db.prepare('SELECT * FROM photos LIMIT 500').all() as PhotoRow[])
      : [];
    const booksToSync = db.prepare('SELECT * FROM books LIMIT 200').all() as BookRow[];
    const audiobooksToSync = db
      .prepare('SELECT * FROM audiobooks LIMIT 200')
      .all() as AudiobookRow[];

    const totalItems =
      tracksToSyncMap.size +
      videosToSync.length +
      photosToSync.length +
      booksToSync.length +
      audiobooksToSync.length;
    let processedItems = 0;

    // Exact Section 1.2 Directory Layout
    const musicRootOnDevice = path.join(localRootPath, 'Music');
    const videoRootOnDevice = path.join(localRootPath, 'Videos');
    const playlistRootOnDevice = path.join(localRootPath, 'Playlists');
    const picturesRootOnDevice = path.join(localRootPath, 'Pictures');
    const booksRootOnDevice = path.join(localRootPath, 'Books');
    const audiobooksRootOnDevice = path.join(localRootPath, 'Audiobooks');

    await fsp.mkdir(musicRootOnDevice, { recursive: true });
    await fsp.mkdir(path.join(videoRootOnDevice, 'Movies'), { recursive: true });
    await fsp.mkdir(path.join(videoRootOnDevice, 'TV Shows'), { recursive: true });
    await fsp.mkdir(path.join(videoRootOnDevice, 'Music Videos'), { recursive: true });
    await fsp.mkdir(playlistRootOnDevice, { recursive: true });
    await fsp.mkdir(picturesRootOnDevice, { recursive: true });
    await fsp.mkdir(booksRootOnDevice, { recursive: true });
    await fsp.mkdir(audiobooksRootOnDevice, { recursive: true });

    const deviceAudioFileMap = new Map<number, string>();
    const sanitizedAlbums = new Set<string>();
    let totalAudioBytesSynced = 0;
    let totalVideoBytesSynced = 0;

    // Write .retrotunes_device.json manifest
    const manifestLocalPath = path.join(localRootPath, '.retrotunes_device.json');
    await fsp.writeFile(manifestLocalPath, JSON.stringify(profile, null, 2), 'utf8');
    await queueIfNeeded(manifestLocalPath, '/.retrotunes_device.json');

    // 1. Music: Root/Music/<Artist>/<Album>/<Track>
    for (const track of tracksToSyncMap.values()) {
      if (cancelSyncRequested) break;
      await yieldToEventLoop();
      processedItems++;
      broadcastSyncProgress({
        stage: isMtp
          ? 'Staging Audio, 500x500 Cover Art & .LRC Lyrics for MTP...'
          : 'Syncing Audio, 500x500 Cover Art & .LRC Lyrics...',
        processed: processedItems,
        total: Math.max(1, totalItems),
        currentFile: `${track.artist} - ${track.title}`,
        lovedImported,
        listenbrainzPushed,
        lrcFetched,
        tracksSynced,
      });

      const sourceAudioPath =
        track.local_cache_path && fs.existsSync(track.local_cache_path)
          ? track.local_cache_path
          : track.remote_nfs_path;

      if (!sourceAudioPath || !fs.existsSync(sourceAudioPath)) continue;

      const safeArtist = (track.artist || 'Unknown Artist').replace(/[/\\?%*:|"<>]/g, '_');
      const safeAlbum = (track.album || 'Unknown Album').replace(/[/\\?%*:|"<>]/g, '_');
      const albumDirOnDevice = path.join(musicRootOnDevice, safeArtist, safeAlbum);
      await fsp.mkdir(albumDirOnDevice, { recursive: true });

      const shouldTranscodeAudio =
        !profile.audioPassthrough &&
        profile.audioTranscodeFormat &&
        profile.audioTranscodeFormat !== 'passthrough' &&
        settings.ffmpegBinaryPath &&
        fs.existsSync(settings.ffmpegBinaryPath);

      const ext = shouldTranscodeAudio
        ? profile.audioTranscodeFormat === 'aac'
          ? '.m4a'
          : '.mp3'
        : path.extname(sourceAudioPath);

      const cleanTrackTitle =
        track.title
          .replace(/^\d{1,3}\s*[-._)\s]+\s*/, '')
          .replace(/[/\\?%*:|"<>]/g, '_')
          .trim() || track.title.replace(/[/\\?%*:|"<>]/g, '_');

      const trackPrefix =
        profile.includeTrackNumberInFilename && track.track_num
          ? `${String(track.track_num).padStart(2, '0')} - `
          : '';

      const trackFilename = `${trackPrefix}${cleanTrackTitle}${ext}`;
      const targetAudioPath = path.join(albumDirOnDevice, trackFilename);
      const remoteRelAudioPath = `/Music/${safeArtist}/${safeAlbum}/${trackFilename}`;

      if (!isMtp && !profile.includeTrackNumberInFilename && track.track_num) {
        const legacyNumberedPath = path.join(
          albumDirOnDevice,
          `${String(track.track_num).padStart(2, '0')} - ${cleanTrackTitle}${ext}`
        );
        if (legacyNumberedPath !== targetAudioPath && fs.existsSync(legacyNumberedPath)) {
          try {
            await fsp.rename(legacyNumberedPath, targetAudioPath);
          } catch {
            // ignore
          }
        }
      }

      // If MTP and passthrough, we can point directly to sourceAudioPath without duplicating on local disk!
      let localFileForMtp = targetAudioPath;
      if (isMtp && !shouldTranscodeAudio) {
        localFileForMtp = sourceAudioPath;
      } else {
        let needsCopy = true;
        if (fs.existsSync(targetAudioPath)) {
          try {
            const dstStat = await fsp.stat(targetAudioPath);
            if (shouldTranscodeAudio) {
              if (dstStat.size > 1024) needsCopy = false;
            } else {
              const srcStat = await fsp.stat(sourceAudioPath);
              if (srcStat.size === dstStat.size) needsCopy = false;
            }
          } catch {
            needsCopy = true;
          }
        }

        if (needsCopy) {
          if (shouldTranscodeAudio) {
            const bitrate = `${profile.audioBitrateKbps || 192}k`;
            const codecArgs =
              profile.audioTranscodeFormat === 'aac'
                ? ['-c:a', 'aac', '-b:a', bitrate]
                : ['-c:a', 'libmp3lame', '-b:a', bitrate];
            try {
              await execFileAsync(
                settings.ffmpegBinaryPath,
                ['-y', '-i', sourceAudioPath, '-vn', ...codecArgs, targetAudioPath],
                { timeout: 120000 }
              );
            } catch {
              await fsp.copyFile(sourceAudioPath, targetAudioPath);
            }
          } else {
            await fsp.copyFile(sourceAudioPath, targetAudioPath);
          }
        }
      }

      let trackSize = track.file_size || 0;
      try {
        const st = await fsp.stat(localFileForMtp);
        trackSize = st.size;
        totalAudioBytesSynced += st.size;
      } catch {
        // ignore
      }

      const assignedStorage = await queueIfNeeded(localFileForMtp, remoteRelAudioPath, 'music');
      deviceAudioFileMap.set(track.id, targetAudioPath);
      catalogItems.push({
        devicePath: remoteRelAudioPath,
        storageId: assignedStorage,
        mediaType: 'music',
        localTrackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration || 0,
        size: trackSize,
      });
      tracksSynced++;

      // Cover art 500x500 baseline JPEG
      const albumKey = `${safeArtist}/${safeAlbum}`;
      if (profile.sanitizeCoverArt && track.cover_art_path && !sanitizedAlbums.has(albumKey)) {
        const deviceCoverPath = path.join(albumDirOnDevice, 'cover.jpg');
        if (!fs.existsSync(deviceCoverPath) && fs.existsSync(track.cover_art_path)) {
          await sanitizeCoverArtTo500Baseline(
            track.cover_art_path,
            deviceCoverPath,
            settings.ffmpegBinaryPath
          );
        }
        if (fs.existsSync(deviceCoverPath)) {
          await queueIfNeeded(deviceCoverPath, `/Music/${safeArtist}/${safeAlbum}/cover.jpg`, 'music');
        }
        sanitizedAlbums.add(albumKey);
      }

      // Synchronized Karaoke Lyrics (.lrc)
      if (profile.downloadLrc) {
        const targetLrcPath = targetAudioPath.replace(/\.[^/.]+$/, '.lrc');
        const remoteRelLrcPath = remoteRelAudioPath.replace(/\.[^/.]+$/, '.lrc');
        if (!fs.existsSync(targetLrcPath)) {
          if (track.lrc_path && fs.existsSync(track.lrc_path)) {
            await fsp.copyFile(track.lrc_path, targetLrcPath);
            lrcFetched++;
          } else {
            const lrcText = await fetchLrcFromLrclib(track);
            if (lrcText) {
              await fsp.writeFile(targetLrcPath, lrcText, 'utf8');
              const cachedLrcDir = path.join(settings.localCachePath, 'audio');
              await fsp.mkdir(cachedLrcDir, { recursive: true });
              const cachedLrc = path.join(cachedLrcDir, `${track.id}.lrc`);
              await fsp.writeFile(cachedLrc, lrcText, 'utf8');
              db.prepare('UPDATE tracks SET lrc_path = ? WHERE id = ?').run(cachedLrc, track.id);
              lrcFetched++;
            }
          }
        }
        if (fs.existsSync(targetLrcPath)) {
          await queueIfNeeded(targetLrcPath, remoteRelLrcPath, 'music');
        }
      }
    }

    // 2. Videos:
    // - Movies: Root/Videos/Movies/<Movie Title (Year)>.mp4
    // - TV Shows: Root/Videos/TV Shows/<Show Name>/Season <XX>/<Episode>.mp4
    // - Music Videos: Root/Videos/Music Videos/<Artist> - <Title>.mp4
    for (const video of videosToSync) {
      if (cancelSyncRequested) break;
      await yieldToEventLoop();
      processedItems++;
      broadcastSyncProgress({
        stage: `Syncing Videos (${profile.videoResolution})...`,
        processed: processedItems,
        total: Math.max(1, totalItems),
        currentFile: video.title,
        videosSynced,
      });

      const sourceVideoPath =
        video.local_cache_path && fs.existsSync(video.local_cache_path)
          ? video.local_cache_path
          : video.remote_nfs_path;

      if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) continue;

      const ext = path.extname(sourceVideoPath) || '.mp4';
      let targetVideoPath: string;
      let remoteRelVideoPath: string;

      if (video.type === 'tv' && video.show_name) {
        const safeShow = video.show_name.replace(/[/\\?%*:|"<>]/g, '_');
        const seasonNum = video.season ?? 1;
        const seasonFolder = `Season ${String(seasonNum).padStart(2, '0')}`;
        const showDirOnDevice = path.join(videoRootOnDevice, 'TV Shows', safeShow, seasonFolder);
        await fsp.mkdir(showDirOnDevice, { recursive: true });
        const epTag = `S${String(seasonNum).padStart(2, '0')}E${String(video.episode || 1).padStart(2, '0')}`;
        const safeTitle = video.title.replace(/[/\\?%*:|"<>]/g, '_');
        const fname = `${epTag} - ${safeTitle}${ext}`;
        targetVideoPath = path.join(showDirOnDevice, fname);
        remoteRelVideoPath = `/Videos/TV Shows/${safeShow}/${seasonFolder}/${fname}`;
      } else if (video.type === 'music_video') {
        const mvDirOnDevice = path.join(videoRootOnDevice, 'Music Videos');
        await fsp.mkdir(mvDirOnDevice, { recursive: true });
        const safeArtist = (video.artist || 'Unknown Artist').replace(/[/\\?%*:|"<>]/g, '_');
        const safeTitle = video.title.replace(/[/\\?%*:|"<>]/g, '_');
        const fname = `${safeArtist} - ${safeTitle}${ext}`;
        targetVideoPath = path.join(mvDirOnDevice, fname);
        remoteRelVideoPath = `/Videos/Music Videos/${fname}`;
      } else {
        const moviesDirOnDevice = path.join(videoRootOnDevice, 'Movies');
        await fsp.mkdir(moviesDirOnDevice, { recursive: true });
        const safeTitle = video.title.replace(/[/\\?%*:|"<>]/g, '_');
        const fname = `${safeTitle}${ext}`;
        targetVideoPath = path.join(moviesDirOnDevice, fname);
        remoteRelVideoPath = `/Videos/Movies/${fname}`;
      }

      if (!isMtp && !fs.existsSync(targetVideoPath)) {
        await fsp.copyFile(sourceVideoPath, targetVideoPath);
      }

      let vidSize = video.file_size || 0;
      try {
        const st = await fsp.stat(sourceVideoPath);
        vidSize = st.size;
        totalVideoBytesSynced += st.size;
      } catch {
        // ignore
      }

      const vidStorage = await queueIfNeeded(isMtp ? sourceVideoPath : targetVideoPath, remoteRelVideoPath, 'video');
      catalogItems.push({
        devicePath: remoteRelVideoPath,
        storageId: vidStorage,
        mediaType: video.type === 'tv' ? 'tv' : video.type === 'music_video' ? 'music_videos' : 'movies',
        localItemId: video.id,
        title: video.title,
        artist: video.artist || undefined,
        showName: video.show_name || undefined,
        duration: video.duration || 0,
        size: vidSize,
      });
      videosSynced++;
    }

    // 3. Photos: Root/Pictures/<Album Name>/<Image>.jpg (480x360 JPEG)
    for (const photo of photosToSync) {
      if (cancelSyncRequested) break;
      await yieldToEventLoop();
      processedItems++;
      const srcPhoto = photo.remote_nfs_path;
      if (!srcPhoto || !fs.existsSync(srcPhoto)) continue;
      const safeAlbum = (photo.album_name || 'Library Photos').replace(/[/\\?%*:|"<>]/g, '_');
      const albumDir = path.join(picturesRootOnDevice, safeAlbum);
      await fsp.mkdir(albumDir, { recursive: true });
      const safeTitle = (photo.title || `photo_${photo.id}`).replace(/[/\\?%*:|"<>]/g, '_');
      const fname = `${safeTitle}.jpg`;
      const dstPhoto = path.join(albumDir, fname);
      if (!fs.existsSync(dstPhoto)) {
        await downscalePhotoTo480x360(srcPhoto, dstPhoto, settings.ffmpegBinaryPath);
      }
      if (fs.existsSync(dstPhoto)) {
        const pPath = `/Pictures/${safeAlbum}/${fname}`;
        const pStorage = await queueIfNeeded(dstPhoto, pPath);
        let pSize = photo.file_size || 0;
        try { pSize = (await fsp.stat(dstPhoto)).size; } catch { /* ignore */ }
        catalogItems.push({
          devicePath: pPath,
          storageId: pStorage,
          mediaType: 'photos',
          localItemId: photo.id,
          title: photo.title,
          album: photo.album_name,
          size: pSize,
        });
      }
    }

    // 4. Books: Root/Books/<Author>/<Book>
    for (const book of booksToSync) {
      if (cancelSyncRequested) break;
      if (!book.remote_nfs_path || !fs.existsSync(book.remote_nfs_path)) continue;
      const safeAuthor = (book.author || 'Unknown Author').replace(/[/\\?%*:|"<>]/g, '_');
      const authorDir = path.join(booksRootOnDevice, safeAuthor);
      await fsp.mkdir(authorDir, { recursive: true });
      const fname = path.basename(book.remote_nfs_path).replace(/[/\\?%*:|"<>]/g, '_');
      const dstBook = path.join(authorDir, fname);
      if (!isMtp && !fs.existsSync(dstBook)) {
        await fsp.copyFile(book.remote_nfs_path, dstBook);
      }
      const bPath = `/Books/${safeAuthor}/${fname}`;
      const bStorage = await queueIfNeeded(isMtp ? book.remote_nfs_path : dstBook, bPath);
      catalogItems.push({
        devicePath: bPath,
        storageId: bStorage,
        mediaType: 'books',
        localItemId: book.id,
        title: book.title,
        artist: book.author,
        size: book.file_size || 0,
      });
    }

    // 5. Audiobooks: Root/Audiobooks/<Author>/<Book Title>/<Chapters>
    for (const ab of audiobooksToSync) {
      if (cancelSyncRequested) break;
      if (!ab.remote_nfs_path || !fs.existsSync(ab.remote_nfs_path)) continue;
      const safeAuthor = (ab.author || 'Unknown Author').replace(/[/\\?%*:|"<>]/g, '_');
      const safeBook = (ab.title || 'Audiobook').replace(/[/\\?%*:|"<>]/g, '_');
      const abDir = path.join(audiobooksRootOnDevice, safeAuthor, safeBook);
      await fsp.mkdir(abDir, { recursive: true });
      const fname = path.basename(ab.remote_nfs_path).replace(/[/\\?%*:|"<>]/g, '_');
      const dstAb = path.join(abDir, fname);
      if (!isMtp && !fs.existsSync(dstAb)) {
        await fsp.copyFile(ab.remote_nfs_path, dstAb);
      }
      const abPath = `/Audiobooks/${safeAuthor}/${safeBook}/${fname}`;
      const abStorage = await queueIfNeeded(isMtp ? ab.remote_nfs_path : dstAb, abPath);
      catalogItems.push({
        devicePath: abPath,
        storageId: abStorage,
        mediaType: 'audiobooks',
        localItemId: ab.id,
        title: ab.title,
        artist: ab.author,
        duration: ab.duration || 0,
        size: ab.file_size || 0,
      });
    }

    // =========================================================================
    // PHASE 3: M3U8 EXPORT (Root/Playlists/<PlaylistName>.m3u8 with ../Music/...)
    // =========================================================================
    broadcastSyncProgress({
      stage: 'Generating relative-path .m3u8 Playlists...',
      currentFile: 'Favorites.m3u8',
    });

    const lovedTracks = db
      .prepare(
        'SELECT * FROM tracks WHERE is_loved = 1 OR local_star_rating >= 5 ORDER BY artist ASC, title ASC'
      )
      .all() as TrackRow[];
    const favM3uContent = generateRelativeM3u8(
      lovedTracks,
      deviceAudioFileMap,
      playlistRootOnDevice
    );
    const favPlaylistPath = path.join(playlistRootOnDevice, 'Favorites.m3u8');
    if (favM3uContent && favM3uContent.trim().length > 0) {
      await fsp.writeFile(favPlaylistPath, favM3uContent, 'utf8');
      await queueIfNeeded(favPlaylistPath, '/Playlists/Favorites.m3u8', 'music');
    }

    const rootFavM3uContent = generateRelativeM3u8(lovedTracks, deviceAudioFileMap, localRootPath);
    const rootFavPath = path.join(localRootPath, 'Favorites.m3u');
    if (rootFavM3uContent && rootFavM3uContent.trim().length > 0) {
      await fsp.writeFile(rootFavPath, rootFavM3uContent, 'utf8');
      await queueIfNeeded(rootFavPath, '/Favorites.m3u', 'music');
    }

    const playlists = db.prepare('SELECT * FROM playlists').all() as PlaylistRow[];
    for (const pl of playlists) {
      await yieldToEventLoop();
      const plTracks = getPlaylistTracks(pl.id);
      const m3u8Text = generateRelativeM3u8(plTracks, deviceAudioFileMap, playlistRootOnDevice);
      const safePlName = pl.name.replace(/[/\\?%*:|"<>]/g, '_');
      const ext = profile.playlistFormat === 'm3u' ? '.m3u' : '.m3u8';
      const localPlFile = path.join(playlistRootOnDevice, `${safePlName}${ext}`);
      const remotePlPath = `/Playlists/${safePlName}${ext}`;
      await fsp.writeFile(localPlFile, m3u8Text, 'utf8');
      const plStorage = await queueIfNeeded(localPlFile, remotePlPath, 'music');
      catalogPlaylists.push({
        name: pl.name,
        devicePath: remotePlPath,
        trackCount: plTracks.length,
        storageId: plStorage,
      });

      const hash = crypto.createHash('md5').update(m3u8Text).digest('hex');
      db.prepare('UPDATE playlists SET last_synced_hash = ? WHERE id = ?').run(hash, pl.id);
    }

    // Write .retrotunes_catalog.json manifest alongside .retrotunes_device.json
    const deviceCatalog: DeviceCatalog = {
      version: 1,
      deviceUuid: uuid,
      updatedAt: new Date().toISOString(),
      items: catalogItems,
      playlists: catalogPlaylists,
    };
    const catalogJson = JSON.stringify(deviceCatalog, null, 2);
    const catalogLocalPath = path.join(localRootPath, '.retrotunes_catalog.json');
    await fsp.writeFile(catalogLocalPath, catalogJson, 'utf8');
    await saveCachedDeviceCatalog(uuid, deviceCatalog);
    if (isMtp) {
      pendingMtpUploads.push({
        storageId: mtpStorageId,
        localPath: catalogLocalPath,
        remotePath: '/.retrotunes_catalog.json',
      });
    }
    broadcastDeviceCatalogUpdated(uuid, deviceCatalog);

    // =========================================================================
    // PHASE 4: MTP BATCH TRANSFER OR UMS DOT_CLEAN
    // =========================================================================
    let dotfilesCleaned = 0;
    if (isMtp) {
      if (pendingMtpUploads.length > 0 && !cancelSyncRequested) {
        broadcastSyncProgress({
          stage: `Uploading ${pendingMtpUploads.length} files over MTP...`,
          processed: 0,
          total: pendingMtpUploads.length,
        });
        await executeMtpBatchUpload(
          pendingMtpUploads,
          (idx, tot, remotePath) => {
            broadcastSyncProgress({
              stage: `MTP Transfer (${idx}/${tot})...`,
              processed: idx,
              total: tot,
              currentFile: remotePath,
            });
          }
        );

        // Update MTP ledger
        for (const item of pendingMtpUploads) {
          try {
            const st = await fsp.stat(item.localPath);
            mtpUploadedLedger[`${item.storageId}:${item.remotePath}`] = st.size;
            mtpUploadedLedger[item.remotePath] = st.size;
          } catch {
            // ignore
          }
        }
      }
      await fsp.writeFile(
        ledgerPath,
        JSON.stringify(
          {
            audioBytes: totalAudioBytesSynced,
            videoBytes: totalVideoBytesSynced,
            files: mtpUploadedLedger,
          },
          null,
          2
        ),
        'utf8'
      );
    } else if (profile.cleanMacMetadata && !cancelSyncRequested) {
      broadcastSyncProgress({
        stage: 'Cleaning OS .DS_Store & hidden (._*) metadata...',
        currentFile: localRootPath,
      });
      dotfilesCleaned = await cleanMacMetadataFiles(localRootPath);
    }

    db.prepare("UPDATE devices SET last_synced = datetime('now') WHERE uuid = ?").run(uuid);

    broadcastSyncProgress({
      running: false,
      stage: cancelSyncRequested ? 'Sync Cancelled' : 'Sync Complete',
      processed: totalItems,
      total: totalItems,
      currentFile: '',
      lovedImported,
      listenbrainzPushed,
      lrcFetched,
      tracksSynced,
      videosSynced,
      dotfilesCleaned,
    });

    logger.info(
      'DEVICE_SYNC',
      `Completed Two-Way Sync (${isMtp ? 'MTP' : 'UMS'}) for "${profile.name}": ${tracksSynced} tracks, ${videosSynced} videos, ${lrcFetched} .lrc lyrics, ${lovedImported} loved ratings imported.`,
      activeSyncProgress,
      Date.now() - start
    );

    return activeSyncProgress;
  } catch (err) {
    broadcastSyncProgress({
      running: false,
      stage: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    logger.error('DEVICE_SYNC', `Sync failed for device ${uuid}`, err, Date.now() - start);
    throw err;
  }
}

export function deleteRegisteredDevice(uuid: string): { ok: boolean; message: string } {
  const db = getDb();
  const row = db.prepare('SELECT name FROM devices WHERE uuid = ?').get(uuid) as { name: string } | undefined;
  if (!row) {
    return { ok: false, message: 'Device not found.' };
  }
  db.prepare('DELETE FROM device_play_state WHERE device_uuid = ?').run(uuid);
  db.prepare('DELETE FROM devices WHERE uuid = ?').run(uuid);
  ejectedMtpUuids.delete(uuid);

  try {
    const cacheDir = getSettings().localCachePath;
    if (fs.existsSync(cacheDir)) {
      for (const file of fs.readdirSync(cacheDir)) {
        if (file.startsWith(`mtp_ledger_${uuid}_`) || file.startsWith(`.manifest_${uuid}`)) {
          fs.rmSync(path.join(cacheDir, file), { force: true });
        }
      }
    }
  } catch {
    // ignore cleanup errors
  }

  broadcastDevicesChanged();
  logger.info('DEVICE_SYNC', `Deleted registered device "${row.name}" (${uuid}).`);
  return { ok: true, message: `Forgot device "${row.name}".` };
}

export async function ejectDevice(uuid: string): Promise<{ ok: boolean; message: string }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM devices WHERE uuid = ?').get(uuid) as DeviceRow | undefined;
  if (!row) return { ok: false, message: 'Device not found.' };

  if (activeSyncProgress.running && activeSyncProgress.deviceUuid === uuid) {
    cancelSyncRequested = true;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (row.transport_mode === 'mtp' || row.mount_path.startsWith('mtp://')) {
    ejectedMtpUuids.add(uuid);
    broadcastDevicesChanged();
    return {
      ok: true,
      message: `"${row.name}" MTP session closed cleanly. It is safe to unplug the USB cable.`,
    };
  }

  if (fs.existsSync(row.mount_path)) {
    logger.info('DEVICE_SYNC', `Preparing to eject "${row.name}" at ${row.mount_path}...`);
    const res = await platformDriver.unmountVolume(row.mount_path);
    if (res.ok) {
      logger.info('DEVICE_SYNC', res.message);
      broadcastDevicesChanged();
    } else {
      logger.error('DEVICE_SYNC', res.message);
    }
    return res;
  }
  return {
    ok: true,
    message: `"${row.name}" is already unmounted and safe to disconnect.`,
  };
}

function getCatalogCachePath(uuid: string): string {
  const cacheDir = getSettings().localCachePath || process.cwd();
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, `.catalog_${uuid}.json`);
}

async function saveCachedDeviceCatalog(uuid: string, catalog: DeviceCatalog): Promise<void> {
  try {
    await fsp.writeFile(getCatalogCachePath(uuid), JSON.stringify(catalog, null, 2), 'utf8');
  } catch {
    // ignore cache write errors
  }
}

function emptyCatalog(uuid: string): DeviceCatalog {
  return {
    version: 1,
    deviceUuid: uuid,
    updatedAt: new Date().toISOString(),
    items: [],
    playlists: [],
  };
}

function getMtpDefaultStorageId(mountPath: string): string {
  if (!mountPath.startsWith('mtp://')) return 'sFFFF0001';
  const parts = mountPath.replace('mtp://', '').split('/');
  return parts[1] || 'sFFFF0001';
}

function inferCategoryFromDevicePath(relPosix: string): DeviceCatalogCategory | null {
  const lower = relPosix.toLowerCase();
  if (lower.startsWith('/music/')) return 'music';
  if (lower.startsWith('/videos/tv shows/')) return 'tv';
  if (lower.startsWith('/videos/music videos/')) return 'music_videos';
  if (lower.startsWith('/videos/')) return 'movies';
  if (lower.startsWith('/audiobooks/')) return 'audiobooks';
  if (lower.startsWith('/books/')) return 'books';
  if (lower.startsWith('/pictures/')) return 'photos';
  if (lower.startsWith('/playlists/')) return 'playlists';
  return null;
}

const reconcilingCatalogs = new Set<string>();

export async function reconcileDeviceCatalog(uuid: string): Promise<DeviceCatalog | null> {
  if (reconcilingCatalogs.has(uuid)) return null;
  reconcilingCatalogs.add(uuid);
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM devices WHERE uuid = ?').get(uuid) as DeviceRow | undefined;
    if (!row) return null;

    const isMtp = row.transport_mode === 'mtp' || row.mount_path.startsWith('mtp://');
    let current = emptyCatalog(uuid);
    try {
      const cachePath = getCatalogCachePath(uuid);
      if (fs.existsSync(cachePath)) {
        current = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as DeviceCatalog;
      }
    } catch {
      // ignore
    }

    if (!isMtp && fs.existsSync(row.mount_path)) {
      const deviceManifestPath = path.join(row.mount_path, '.retrotunes_catalog.json');
      if (fs.existsSync(deviceManifestPath)) {
        try {
          current = JSON.parse(await fsp.readFile(deviceManifestPath, 'utf8')) as DeviceCatalog;
        } catch {
          // ignore
        }
      }

      const existingByPath = new Map(current.items.map((it) => [it.devicePath, it]));
      const existingPlByPath = new Map(current.playlists.map((pl) => [pl.devicePath, pl]));
      const scannedItems: DeviceCatalogItem[] = [];
      const scannedPlaylists: DeviceCatalog['playlists'] = [];

      const scanRoots = [
        'Music',
        'Videos',
        'Audiobooks',
        'Books',
        'Pictures',
        'Playlists',
      ];

      const walkDir = async (dir: string) => {
        await yieldToEventLoop();
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(full);
          } else if (entry.isFile()) {
            const relPosix = '/' + path.relative(row.mount_path, full).split(path.sep).join('/');
            const cat = inferCategoryFromDevicePath(relPosix);
            if (!cat) continue;
            if (cat === 'playlists') {
              const lower = entry.name.toLowerCase();
              if (!lower.endsWith('.m3u8') && !lower.endsWith('.m3u')) continue;
              const prevPl = existingPlByPath.get(relPosix);
              if (prevPl) {
                scannedPlaylists.push(prevPl);
              } else {
                let trackCount = 0;
                try {
                  const txt = await fsp.readFile(full, 'utf8');
                  trackCount = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length;
                } catch {
                  // ignore
                }
                scannedPlaylists.push({
                  name: entry.name.replace(/\.(m3u8|m3u)$/i, ''),
                  devicePath: relPosix,
                  trackCount,
                });
              }
            } else {
              if (entry.name.toLowerCase() === 'cover.jpg' || entry.name.toLowerCase().endsWith('.lrc')) {
                continue;
              }
              const prev = existingByPath.get(relPosix);
              if (prev) {
                scannedItems.push(prev);
              } else {
                let size = 0;
                try {
                  size = (await fsp.stat(full)).size;
                } catch {
                  // ignore
                }
                const segs = relPosix.split('/').filter(Boolean);
                scannedItems.push({
                  devicePath: relPosix,
                  mediaType: cat,
                  title: entry.name.replace(/\.[^.]+$/, ''),
                  artist: segs.length >= 3 ? segs[1] : undefined,
                  album: segs.length >= 4 ? segs[2] : undefined,
                  size,
                });
              }
            }
          }
        }
      };

      for (const root of scanRoots) {
        const fullRoot = path.join(row.mount_path, root);
        if (fs.existsSync(fullRoot)) {
          await walkDir(fullRoot);
        }
      }

      const changed =
        scannedItems.length !== current.items.length ||
        scannedPlaylists.length !== current.playlists.length;

      const updated: DeviceCatalog = {
        version: 1,
        deviceUuid: uuid,
        updatedAt: new Date().toISOString(),
        items: scannedItems,
        playlists: scannedPlaylists,
      };
      await saveCachedDeviceCatalog(uuid, updated);
      try {
        await fsp.writeFile(deviceManifestPath, JSON.stringify(updated, null, 2), 'utf8');
      } catch {
        // ignore read-only mount
      }
      if (changed) {
        broadcastDeviceCatalogUpdated(uuid, updated);
      }
      return updated;
    }

    if (isMtp && !ejectedMtpUuids.has(uuid)) {
      const storageId = getMtpDefaultStorageId(row.mount_path);
      const tmpDest = path.join(getSettings().localCachePath || process.cwd(), `.tmp_catalog_${uuid}.json`);
      try {
        const res = await runMtpCommand(['get', storageId, '/.retrotunes_catalog.json', tmpDest], 12000);
        if (res.ok && fs.existsSync(tmpDest)) {
          const parsed = JSON.parse(await fsp.readFile(tmpDest, 'utf8')) as DeviceCatalog;
          await saveCachedDeviceCatalog(uuid, parsed);
          if (parsed.items.length !== current.items.length || parsed.playlists.length !== current.playlists.length) {
            broadcastDeviceCatalogUpdated(uuid, parsed);
          }
          try { fs.unlinkSync(tmpDest); } catch { /* ignore */ }
          return parsed;
        }
      } catch {
        // ignore if manifest not yet present on MTP
      }
    }

    return current;
  } finally {
    reconcilingCatalogs.delete(uuid);
  }
}

export async function getDeviceCatalog(uuid: string): Promise<DeviceCatalog> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM devices WHERE uuid = ?').get(uuid) as DeviceRow | undefined;
  let catalog = emptyCatalog(uuid);

  if (row && !(row.transport_mode === 'mtp' || row.mount_path.startsWith('mtp://'))) {
    const devManifest = path.join(row.mount_path, '.retrotunes_catalog.json');
    if (fs.existsSync(devManifest)) {
      try {
        catalog = JSON.parse(await fsp.readFile(devManifest, 'utf8')) as DeviceCatalog;
        await saveCachedDeviceCatalog(uuid, catalog);
      } catch {
        // fallback to cache
      }
    }
  }

  if (catalog.items.length === 0 && catalog.playlists.length === 0) {
    try {
      const cachePath = getCatalogCachePath(uuid);
      if (fs.existsSync(cachePath)) {
        catalog = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as DeviceCatalog;
      }
    } catch {
      // ignore
    }
  }

  // Trigger non-blocking background reconcile
  setTimeout(() => {
    void reconcileDeviceCatalog(uuid);
  }, 50);

  return catalog;
}

export async function removeDeviceCatalogItem(
  uuid: string,
  devicePath: string,
  storageId?: string
): Promise<DeviceCatalog> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM devices WHERE uuid = ?').get(uuid) as DeviceRow | undefined;
  if (!row) throw new Error('Device not found');

  const isMtp = row.transport_mode === 'mtp' || row.mount_path.startsWith('mtp://');
  if (isMtp) {
    const targetStorage = storageId || getMtpDefaultStorageId(row.mount_path);
    await runMtpCommand(['rm', targetStorage, devicePath], 15000);
  } else {
    const localTarget = path.join(row.mount_path, ...devicePath.replace(/^\/+/, '').split('/'));
    if (fs.existsSync(localTarget)) {
      await fsp.rm(localTarget, { force: true });
    }
  }

  const catalog = await getDeviceCatalog(uuid);
  const updated: DeviceCatalog = {
    version: 1,
    deviceUuid: uuid,
    updatedAt: new Date().toISOString(),
    items: catalog.items.filter((it) => it.devicePath !== devicePath),
    playlists: catalog.playlists.filter((pl) => pl.devicePath !== devicePath),
  };

  await saveCachedDeviceCatalog(uuid, updated);
  if (isMtp) {
    const tmpCatalog = path.join(getSettings().localCachePath || process.cwd(), `.tmp_put_catalog_${uuid}.json`);
    await fsp.writeFile(tmpCatalog, JSON.stringify(updated, null, 2), 'utf8');
    await runMtpCommand(['put', getMtpDefaultStorageId(row.mount_path), tmpCatalog, '/.retrotunes_catalog.json'], 15000);
    try { fs.unlinkSync(tmpCatalog); } catch { /* ignore */ }
  } else if (fs.existsSync(row.mount_path)) {
    await fsp.writeFile(path.join(row.mount_path, '.retrotunes_catalog.json'), JSON.stringify(updated, null, 2), 'utf8');
  }

  broadcastDeviceCatalogUpdated(uuid, updated);
  logger.info('DEVICE_SYNC', `Removed ${devicePath} from device "${row.name}" (master library untouched).`);
  return updated;
}

export async function reexportSyncedPlaylistM3u8(playlistId: number): Promise<void> {
  const db = getDb();
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as PlaylistRow | undefined;
  if (!pl) return;

  const devices = db.prepare('SELECT * FROM devices').all() as DeviceRow[];
  const plTracks = getPlaylistTracks(playlistId);
  const safePlName = pl.name.replace(/[/\\?%*:|"<>]/g, '_');

  for (const dev of devices) {
    let profile: DeviceProfile;
    try {
      profile = JSON.parse(dev.profile_json) as DeviceProfile;
    } catch {
      continue;
    }
    if (!profile.syncAllMusic && !(profile.syncPlaylistIds || []).includes(playlistId)) {
      continue;
    }

    const isMtp = dev.transport_mode === 'mtp' || dev.mount_path.startsWith('mtp://');
    const ext = profile.playlistFormat === 'm3u' ? '.m3u' : '.m3u8';
    const remotePlPath = `/Playlists/${safePlName}${ext}`;

    // Build track path map from cached catalog if available
    const catalog = await getDeviceCatalog(dev.uuid);
    const trackMap = new Map<number, string>();
    for (const item of catalog.items) {
      if (item.mediaType === 'music' && item.localTrackId) {
        trackMap.set(item.localTrackId, item.devicePath);
      }
    }

    const m3u8Text = generateRelativeM3u8(plTracks, trackMap, '/Playlists');
    if (!isMtp && fs.existsSync(dev.mount_path)) {
      const playlistDir = path.join(dev.mount_path, profile.playlistSubdir || 'Playlists');
      await fsp.mkdir(playlistDir, { recursive: true });
      await fsp.writeFile(path.join(playlistDir, `${safePlName}${ext}`), m3u8Text, 'utf8');
    } else if (isMtp && !ejectedMtpUuids.has(dev.uuid) && m3u8Text.trim().length > 0) {
      const tmpPl = path.join(getSettings().localCachePath || process.cwd(), `.tmp_pl_${playlistId}${ext}`);
      await fsp.writeFile(tmpPl, m3u8Text, 'utf8');
      await runMtpCommand(['put', getMtpDefaultStorageId(dev.mount_path), tmpPl, remotePlPath], 15000);
      try { fs.unlinkSync(tmpPl); } catch { /* ignore */ }
    }
  }
}
