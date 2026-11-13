import fs from 'fs';
import path from 'path';
import { initDatabase, getDb, getDatabaseDiagnostics } from './db';
import { getSettings } from './settings';
import { platformDriver } from './platform';
import {
  getRegisteredDevicesAsync,
  getRtunesMtpBinaryPath,
  listMountedVolumes,
  refreshMtpState,
  syncDevice,
} from './deviceSync';
import { runLibraryScan } from './indexer';
import { getCacheStats } from './cacheTranscoder';
import { getArrLiveQueue } from './storeArr';
import { standaloneLocalProvider } from './providers/standaloneLocal';

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function out(data: unknown, asJson: boolean) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdDoctor(asJson: boolean) {
  initDatabase();
  const dbDiag = getDatabaseDiagnostics();
  const integrityRow = getDb().prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
  const integrity = integrityRow?.integrity_check || 'unknown';
  const settings = getSettings();
  const mtpBin = getRtunesMtpBinaryPath();
  const mtpExists = fs.existsSync(mtpBin);
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  const mtpBackend = process.platform === 'win32' ? 'Windows WPD (PortableDeviceApi)' : 'libmtp / libusb';

  const result = {
    ok: integrity === 'ok',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    isDev,
    platformDriver: platformDriver.platform,
    database: {
      path: dbDiag.dbFilePath,
      integrity,
      sizeBytes: dbDiag.dbSizeBytes,
    },
    mtp: {
      backend: mtpBackend,
      binaryPath: mtpBin,
      binaryPresent: mtpExists,
    },
    transcoder: {
      ffmpegPath: settings.ffmpegBinaryPath,
      ffmpegPresent: Boolean(settings.ffmpegBinaryPath && fs.existsSync(settings.ffmpegBinaryPath)),
      handbrakePath: settings.handbrakeBinaryPath,
      handbrakePresent: Boolean(settings.handbrakeBinaryPath && fs.existsSync(settings.handbrakeBinaryPath)),
    },
    provider: standaloneLocalProvider.getStatus(),
  };

  if (asJson) {
    out(result, true);
  } else {
    console.log('=== RetroTunes (rTunes) Doctor ===');
    console.log(`OS / Arch       : ${result.platform} (${result.arch})`);
    console.log(`PlatformDriver  : ${result.platformDriver}`);
    console.log(`isDev           : ${result.isDev}`);
    console.log(`SQLite DB       : ${result.database.path} [integrity=${result.database.integrity}]`);
    console.log(`MTP Backend     : ${result.mtp.backend}`);
    console.log(`MTP Helper      : ${result.mtp.binaryPath} [${result.mtp.binaryPresent ? 'OK' : 'MISSING'}]`);
    console.log(`FFmpeg          : ${result.transcoder.ffmpegPath} [${result.transcoder.ffmpegPresent ? 'OK' : 'MISSING'}]`);
    console.log(`HandBrakeCLI    : ${result.transcoder.handbrakePath || '(not configured)'} [${result.transcoder.handbrakePresent ? 'OK' : 'NOT FOUND'}]`);
  }

  return result.ok ? 0 : 1;
}

async function cmdDeviceList(asJson: boolean) {
  initDatabase();
  const mtp = await refreshMtpState(true);
  const volumes = listMountedVolumes();
  const devices = await getRegisteredDevicesAsync();

  const payload = {
    mtpConnected: mtp.connected,
    mtpFriendlyName: mtp.friendlyName || null,
    mtpSerial: mtp.serial || null,
    mtpStorages: (mtp.storages || []).map((s) => ({
      storageId: s.storageId,
      description: s.description,
      maxCapacity: s.maxCapacity,
      freeSpaceInBytes: s.freeSpaceInBytes,
      hasManifest: Boolean(s.hasManifest),
    })),
    umsVolumes: volumes,
    registeredDevices: devices.map((d) => ({
      uuid: d.uuid,
      name: d.name,
      transportMode: d.transport_mode,
      mountPath: d.mount_path,
      mtpSerial: d.mtp_serial,
      mounted: d.storage.mounted,
      totalBytes: d.storage.totalBytes,
      freeBytes: d.storage.freeBytes,
      storages: d.mtp_storages || [],
    })),
  };

  if (asJson) {
    out(payload, true);
  } else {
    console.log(`MTP Connected: ${payload.mtpConnected} (${payload.mtpFriendlyName || 'none'})`);
    for (const s of payload.mtpStorages) {
      console.log(`  - MTP Storage [${s.storageId}] ${s.description}: free=${s.freeSpaceInBytes} / total=${s.maxCapacity} manifest=${s.hasManifest}`);
    }
    console.log(`Registered Devices (${payload.registeredDevices.length}):`);
    for (const d of payload.registeredDevices) {
      console.log(`  - ${d.name} (${d.uuid}) [${d.transportMode}] ${d.mountPath} mounted=${d.mounted} free=${d.freeBytes}/${d.totalBytes}`);
    }
  }
  return 0;
}

async function cmdDeviceSync(flags: Record<string, string | boolean>, asJson: boolean) {
  initDatabase();
  const dryRun = Boolean(flags['dry-run']);
  const devices = await getRegisteredDevicesAsync();
  const targetUuid = typeof flags.uuid === 'string' ? flags.uuid : devices[0]?.uuid;

  if (!targetUuid) {
    const err = { ok: false, error: 'No registered or connected device found.' };
    out(err, asJson);
    return 1;
  }

  const target = devices.find((d) => d.uuid === targetUuid);
  if (!target) {
    out({ ok: false, error: `Device UUID ${targetUuid} not found.` }, asJson);
    return 1;
  }

  if (dryRun) {
    const mtp = await refreshMtpState(false);
    const db = getDb();
    const trackCount = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;
    const videoCount = (db.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c;
    const playlistCount = (db.prepare('SELECT COUNT(*) as c FROM playlists').get() as { c: number }).c;
    const expectedDirs = [
      '/Music',
      '/Playlists',
      '/Videos',
      '/Videos/Movies',
      '/Videos/TV Shows',
      '/Videos/Music Videos',
    ];
    const sim = {
      ok: true,
      dryRun: true,
      device: { uuid: target.uuid, name: target.name, transportMode: target.transport_mode, mountPath: target.mount_path },
      mtpConnected: mtp.connected,
      storages: mtp.storages || [],
      verifiedTargetDirs: expectedDirs,
      libraryCounts: { tracks: trackCount, videos: videoCount, playlists: playlistCount },
    };
    out(sim, asJson);
    return 0;
  }

  const progress = await syncDevice(target.uuid);
  out({ ok: true, dryRun: false, progress }, asJson);
  return 0;
}

async function cmdDbStats(asJson: boolean) {
  initDatabase();
  const db = getDb();
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  const cache = getCacheStats();
  const stats = {
    tracks: count('tracks'),
    videos: count('videos'),
    books: count('books'),
    audiobooks: count('audiobooks'),
    photos: count('photos'),
    playlists: count('playlists'),
    devices: count('devices'),
    cache,
  };
  out(stats, asJson);
  return 0;
}

async function cmdDbScan(flags: Record<string, string | boolean>, asJson: boolean) {
  initDatabase();
  const folder = typeof flags.path === 'string' ? path.resolve(flags.path) : undefined;
  const res = await runLibraryScan(folder ? [folder] : undefined);
  out({ ok: true, scannedPath: folder || null, result: res }, asJson);
  return 0;
}

async function cmdStoreQueue(asJson: boolean) {
  initDatabase();
  const settings = getSettings();
  const queue = await getArrLiveQueue();
  const payload = {
    ok: true,
    configured: {
      lidarr: Boolean(settings.lidarrUrl && settings.lidarrApiKey),
      radarr: Boolean(settings.radarrUrl && settings.radarrApiKey),
      sonarr: Boolean(settings.sonarrUrl && settings.sonarrApiKey),
    },
    queueCount: queue.length,
    queue,
  };
  out(payload, asJson);
  return 0;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const asJson = Boolean(flags.json);
  const [group, sub] = positional;

  try {
    if (group === 'doctor') {
      process.exitCode = await cmdDoctor(asJson);
      return;
    }
    if (group === 'device' && sub === 'list') {
      process.exitCode = await cmdDeviceList(asJson);
      return;
    }
    if (group === 'device' && sub === 'sync') {
      process.exitCode = await cmdDeviceSync(flags, asJson);
      return;
    }
    if (group === 'db' && sub === 'stats') {
      process.exitCode = await cmdDbStats(asJson);
      return;
    }
    if (group === 'db' && sub === 'scan') {
      process.exitCode = await cmdDbScan(flags, asJson);
      return;
    }
    if (group === 'store' && sub === 'queue') {
      process.exitCode = await cmdStoreQueue(asJson);
      return;
    }

    console.error(
      'Usage: npm run cli -- <doctor | device list | device sync [--dry-run] [--uuid <id>] | db stats | db scan [--path <dir>] | store queue> [--json]'
    );
    process.exitCode = 1;
  } catch (err) {
    if (asJson) {
      console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error('CLI error:', err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  }
}

void main();
