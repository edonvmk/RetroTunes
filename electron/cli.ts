import fs from 'fs';
import path from 'path';
import {
  initDatabase,
  getCoreDb,
  getVideoDb,
  getStoreDb,
  getUsersDb,
  getDatabaseDiagnostics,
  getDomainDatabaseHealth,
  getPendingApprovalTotal,
  rebuildMediaDatabase,
} from './db';
import {
  getSettings,
  saveSettings,
  resolveAppMode,
  normalizeConfiguredServerUrl,
  resolveEffectiveRemoteServerUrl,
  resolveEffectiveRemoteServerToken,
} from './settings';
import { platformDriver } from './platform';
import {
  getRegisteredDevicesAsync,
  getRtunesMtpBinaryPath,
  listMountedVolumes,
  refreshMtpState,
  syncDevice,
} from './deviceSync';
import { deduplicateLibraryTracks, runLibraryScan, syncListenBrainzPopularity } from './indexer';
import { getCacheStats } from './cacheTranscoder';
import {
  approvePendingStoreRequest,
  getArrLiveQueue,
  rejectPendingStoreRequest,
} from './storeArr';
import { approvePendingUpload, rejectPendingUpload } from './uploadWizard';
import { standaloneLocalProvider } from './providers/standaloneLocal';
import { remoteServerProvider } from './providers/remoteServer';
import {
  createUser,
  ensureRbacSeeded,
  generateResetCodeForUsername,
  getUserCount,
  listRoles,
  listUsers,
  resetUserPasswordDirect,
  updateUser,
} from './auth/rbac';
import {
  detectHardwareEncoder,
  getTranscoderBinaryStatus,
} from './transcoder/binaryManager';
import {
  computeGenreArtistSlice,
  generateMix,
  MixDepthMode,
  normalizeGenreTag,
  rebuildGenreMatrix,
  testArtistsAgainstGenre,
} from './egenius';

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx > 2) {
        flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
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

function printHelp() {
  const helpText = `RetroTunes (rTunes) Headless & SSH CLI

Usage:
  npm run cli -- <command> [options]

System & Diagnostics:
  doctor [--json]
      Verify all 5 domain SQLite databases (PRAGMA integrity_check), MTP helper, and transcoder binaries.
  status [--json]
      Report appMode, mode lock, remote server URL, 5-DB sizes/paths, user & session counts,
      pending approvals count, and transcoder / hardware encoder status.
  --help, -h
      Show this command reference and exit 0.

Headless Server & Client Daemons:
  --headless | --headless-server [--host <0.0.0.0>] [--port <3000>] [--open-browser] [--no-open-browser] [--no-web-ui]
      Boot authoritative rTunes-Server HTTP/SSE/RPC daemon (does not open browser by default unless --open-browser is passed or enabled in Preferences).
  --headless-client [--host <127.0.0.1>] [--port <3000>] [--server <url>] [--open-browser] [--no-open-browser] [--no-web-ui]
      Boot headless client daemon (does not open browser by default unless --open-browser is passed or enabled in Preferences).

Authentication & Remote Client Control:
  auth setup --username <u> --password <p> [--display-name <n>] [--email <e>] [--guest-roadie] [--json]
      Bootstrap the initial Label master admin account when users.sqlite has 0 users.
  client login --server <url> --username <u> --password <p> [--json]
      Authenticate against a remote rTunes-Server and persist dockerServerUrl + remoteServerToken.
  client logout [--json]
      Revoke and clear the stored remoteServerToken.
  client sync [--server <url>] [--token <token>] [--json]
      Pull delta library updates from a remote rTunes-Server using stored or explicit bearer token.
  reset-password <username> [--password <newpass>] [--json]
      Reset a local account password directly or generate a 30-minute one-time reset code.

User Access Control (UAC) & Approvals:
  uac users [--json]
      List all registered users, roles, status, and effective permissions.
  uac roles [--json]
      List all system and custom RBAC roles.
  uac suspend <username> [--json]
  uac activate <username> [--json]
      Suspend or re-activate a user account (revokes active sessions on suspend).
  uac approvals [--json]
      List pending staged media uploads and *arr store requests awaiting review.
  uac approve <upload|store> <id> [--json]
  uac reject <upload|store> <id> [--reason "<text>"] [--json]
      Approve or reject a staged upload or store request.

Library, Playlists, Store & Devices:
  db stats [--json]
  db scan [--path <dir>] [--json]
  db rebuild [--json]
  db update-popularity [--force] [--limit <n>] [--json]
  db deduplicate [--json]
  db rebuild-genre-matrix [--lastfm-weight <0-100>] [--reset-stuck] [--json]
  playlist egenius --track-id <id> [--limit 25|50] [--mode hits|balanced|deep] [--offline] [--explain] [--json]
  artist-map --genre "<genre>" [--min 0.55] [--artist "<name>"] [--json]
  genre-map --genre "<genre>" [--min 0.55] [--artist "<name>"] [--json]
  store queue [--json]
  device list [--json]
  device sync [--dry-run] [--uuid <id>] [--json]`;
  console.log(helpText);
}

async function cmdDoctor(asJson: boolean) {
  initDatabase();
  ensureRbacSeeded();
  const dbDiag = getDatabaseDiagnostics();
  const domainDbs = getDomainDatabaseHealth();
  const allDbsOk = domainDbs.length === 5 && domainDbs.every((d) => d.ok);
  const coreIntegrity = domainDbs.find((d) => d.domain === 'core')?.integrity || 'unknown';
  const settings = getSettings();
  const mtpBin = getRtunesMtpBinaryPath();
  const mtpExists = fs.existsSync(mtpBin);
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  const mtpBackend = process.platform === 'win32' ? 'Windows WPD (PortableDeviceApi)' : 'libmtp / libusb';

  const result = {
    ok: allDbsOk,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    isDev,
    platformDriver: platformDriver.platform,
    database: {
      path: dbDiag.dbFilePath,
      integrity: allDbsOk ? 'ok' : coreIntegrity,
      sizeBytes: dbDiag.dbSizeBytes,
    },
    databases: domainDbs,
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
    for (const d of domainDbs) {
      console.log(
        `SQLite [${d.domain.padEnd(14)}]: ${d.path} [integrity=${d.integrity}, size=${d.sizeBytes}B]`
      );
    }
    console.log(`MTP Backend     : ${result.mtp.backend}`);
    console.log(`MTP Helper      : ${result.mtp.binaryPath} [${result.mtp.binaryPresent ? 'OK' : 'MISSING'}]`);
    console.log(`FFmpeg          : ${result.transcoder.ffmpegPath} [${result.transcoder.ffmpegPresent ? 'OK' : 'MISSING'}]`);
    console.log(`HandBrakeCLI    : ${result.transcoder.handbrakePath || '(not configured)'} [${result.transcoder.handbrakePresent ? 'OK' : 'NOT FOUND'}]`);
  }

  return result.ok ? 0 : 1;
}

async function cmdStatus(asJson: boolean) {
  initDatabase();
  ensureRbacSeeded();
  const settings = getSettings();
  const runtime = resolveAppMode(settings.appMode);
  const domainDbs = getDomainDatabaseHealth();
  const dbDiag = getDatabaseDiagnostics();
  const usersDb = getUsersDb();
  const storeDb = getStoreDb();

  const totalUsers = Number(
    (usersDb.prepare('SELECT COUNT(*) AS c FROM users').get() as { c?: number })?.c || 0
  );
  const activeUsers = Number(
    (usersDb.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get() as { c?: number })?.c || 0
  );
  const suspendedUsers = totalUsers - activeUsers;
  const activeSessions = Number(
    (usersDb.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?').get(Date.now()) as { c?: number })?.c || 0
  );

  const pendingUploads = Number(
    (storeDb.prepare("SELECT COUNT(*) AS c FROM upload_history WHERE approval_status = 'pending'").get() as { c?: number })?.c || 0
  );
  const pendingStoreRequests = Number(
    (storeDb.prepare("SELECT COUNT(*) AS c FROM store_requests WHERE approval_status = 'pending'").get() as { c?: number })?.c || 0
  );

  const transcoderStatus = await getTranscoderBinaryStatus();
  const hwEncoder = transcoderStatus.ffmpeg.path
    ? detectHardwareEncoder(transcoderStatus.ffmpeg.path, settings.hardwareAccelMode)
    : 'libx264';

  const remoteServerUrl = resolveEffectiveRemoteServerUrl();
  const hasRemoteServerToken = Boolean(resolveEffectiveRemoteServerToken());

  const payload = {
    ok: domainDbs.every((d) => d.ok),
    appMode: runtime.appMode,
    isModeLocked: runtime.isModeLocked,
    lockReason: runtime.lockReason,
    isDocker: runtime.isDocker,
    isHeadless: runtime.isHeadless,
    isServerRole: runtime.isServerRole,
    webUiEnabled: runtime.webUiEnabled,
    clientSource: settings.clientSource,
    dockerServerUrl: remoteServerUrl,
    hasRemoteServerToken,
    auth: {
      authGateEnabled: Boolean(settings.authGateEnabled),
      authMode: settings.authMode,
      allowGuestRoadie: Boolean(settings.allowGuestRoadie),
      totalUsers,
      activeUsers,
      suspendedUsers,
      activeSessions,
    },
    pendingApprovals: {
      total: getPendingApprovalTotal(),
      uploads: pendingUploads,
      storeRequests: pendingStoreRequests,
    },
    databases: domainDbs,
    libraryCounts: {
      tracks: dbDiag.tracksCount,
      videos: dbDiag.videosCount,
      playlists: dbDiag.playlistsCount,
      devices: dbDiag.devicesCount,
    },
    transcoder: {
      ...transcoderStatus,
      hardwareAccelMode: settings.hardwareAccelMode,
      activeHardwareEncoder: hwEncoder,
    },
  };

  if (asJson) {
    out(payload, true);
  } else {
    console.log('=== RetroTunes (rTunes) Status ===');
    console.log(`App Mode        : ${payload.appMode} (locked=${payload.isModeLocked}, reason=${payload.lockReason || 'none'})`);
    console.log(`Remote Server   : ${payload.dockerServerUrl || '(none)'} [token=${payload.hasRemoteServerToken ? 'SET' : 'NONE'}]`);
    console.log(`Auth Gate       : enabled=${payload.auth.authGateEnabled} mode=${payload.auth.authMode} guestRoadie=${payload.auth.allowGuestRoadie}`);
    console.log(`Users & Sessions: ${totalUsers} user(s) (${activeUsers} active, ${suspendedUsers} suspended), ${activeSessions} active session(s)`);
    console.log(`Approvals Queue : ${payload.pendingApprovals.total} pending (${pendingUploads} uploads, ${pendingStoreRequests} store requests)`);
    for (const d of domainDbs) {
      console.log(`DB [${d.domain.padEnd(14)}]: ${d.path} (${d.sizeBytes}B, integrity=${d.integrity})`);
    }
    console.log(`Transcoder      : ffmpeg=${transcoderStatus.ffmpeg.present} ffprobe=${transcoderStatus.ffprobe.present} handbrake=${transcoderStatus.handbrake.present} hwEncoder=${hwEncoder}`);
  }
  return payload.ok ? 0 : 1;
}

async function cmdAuthSetup(flags: Record<string, string | boolean>, asJson: boolean) {
  initDatabase();
  ensureRbacSeeded();
  if (getUserCount() > 0) {
    throw new Error('Server master account has already been set up.');
  }
  const username = typeof flags.username === 'string' ? flags.username.trim() : '';
  const password = typeof flags.password === 'string' ? flags.password : '';
  if (!username || password.length < 4) {
    throw new Error('Usage: cli auth setup --username <user> --password <pass (min 4 chars)> [--display-name <name>] [--email <email>] [--guest-roadie]');
  }
  const displayName = typeof flags['display-name'] === 'string' ? flags['display-name'].trim() : username;
  const email = typeof flags.email === 'string' ? flags.email.trim() : '';
  const allowGuestRoadie = Boolean(flags['guest-roadie']);

  const user = await createUser({
    username,
    displayName: displayName || username,
    email,
    password,
    roleNames: ['Label'],
  });
  saveSettings({
    authGateEnabled: true,
    authMode: 'local-accounts',
    allowGuestRoadie,
    hasCompletedOnboarding: true,
  });

  const payload = {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      roles: user.roles.map((r) => r.name),
    },
    authGateEnabled: true,
    authMode: 'local-accounts',
    allowGuestRoadie,
  };
  out(payload, asJson);
  return 0;
}

async function cmdClient(
  sub: string | undefined,
  flags: Record<string, string | boolean>,
  asJson: boolean
) {
  initDatabase();
  if (sub === 'login') {
    const rawServer = typeof flags.server === 'string' ? flags.server : process.env.RTUNES_SERVER_URL || '';
    const serverUrl = normalizeConfiguredServerUrl(rawServer);
    const username = typeof flags.username === 'string' ? flags.username.trim() : '';
    const password = typeof flags.password === 'string' ? flags.password : '';
    if (!serverUrl || !username || !password) {
      throw new Error('Usage: cli client login --server <url> --username <user> --password <pass>');
    }
    const res = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      token?: string;
      expiresAt?: number;
      user?: { username?: string; displayName?: string; roles?: { name?: string }[] };
      error?: string;
    };
    if (!res.ok || !json.ok || !json.token) {
      throw new Error(json.error || `Login failed (HTTP ${res.status})`);
    }
    saveSettings({
      clientSource: 'remote',
      dockerServerUrl: serverUrl,
      remoteServerToken: json.token,
      hasCompletedOnboarding: true,
    });
    out(
      {
        ok: true,
        serverUrl,
        username: json.user?.username || username,
        displayName: json.user?.displayName || username,
        roles: (json.user?.roles || []).map((r) => (typeof r === 'string' ? r : r.name)),
        expiresAt: json.expiresAt || null,
        tokenSaved: true,
      },
      asJson
    );
    return 0;
  }

  if (sub === 'logout') {
    const serverUrl = resolveEffectiveRemoteServerUrl(
      typeof flags.server === 'string' ? flags.server : undefined
    );
    const token = resolveEffectiveRemoteServerToken();
    if (serverUrl && token) {
      try {
        await fetch(`${serverUrl}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // ignore network errors on logout
      }
    }
    saveSettings({ remoteServerToken: '' });
    out({ ok: true, serverUrl: serverUrl || null, tokenCleared: true }, asJson);
    return 0;
  }

  if (sub === 'sync') {
    const serverUrl = resolveEffectiveRemoteServerUrl(
      typeof flags.server === 'string' ? flags.server : undefined
    );
    if (!serverUrl) {
      throw new Error('No remote server URL configured. Pass --server <url>, set RTUNES_SERVER_URL, or run "cli client login" first.');
    }
    const token = resolveEffectiveRemoteServerToken(
      typeof flags.token === 'string' ? flags.token : undefined
    );
    const syncRes = await remoteServerProvider.syncDeltaFromRemoteServer(serverUrl, token);
    out({ ...syncRes, serverUrl }, asJson);
    return 0;
  }

  throw new Error('Usage: cli client <login | logout | sync>');
}

async function cmdUac(
  sub: string | undefined,
  restPositional: string[],
  flags: Record<string, string | boolean>,
  asJson: boolean
) {
  initDatabase();
  ensureRbacSeeded();

  if (sub === 'users') {
    const users = listUsers();
    out({ ok: true, count: users.length, users }, asJson);
    return 0;
  }

  if (sub === 'roles') {
    const roles = listRoles();
    out({ ok: true, count: roles.length, roles }, asJson);
    return 0;
  }

  if (sub === 'suspend' || sub === 'activate') {
    const targetUsername = (restPositional[0] || (typeof flags.username === 'string' ? flags.username : '')).trim();
    if (!targetUsername) {
      throw new Error(`Usage: cli uac ${sub} <username>`);
    }
    const user = listUsers().find((u) => u.username.toLowerCase() === targetUsername.toLowerCase());
    if (!user) {
      throw new Error(`User "${targetUsername}" not found.`);
    }
    const nextStatus = sub === 'suspend' ? 'suspended' : 'active';
    const updated = await updateUser(user.id, { status: nextStatus });
    out({ ok: true, id: updated.id, username: updated.username, status: updated.status }, asJson);
    return 0;
  }

  if (sub === 'approvals') {
    const storeDb = getStoreDb();
    const uploads = storeDb
      .prepare("SELECT * FROM upload_history WHERE approval_status = 'pending' ORDER BY id DESC")
      .all();
    const storeRequests = storeDb
      .prepare("SELECT * FROM store_requests WHERE approval_status = 'pending' ORDER BY id DESC")
      .all();
    out(
      {
        ok: true,
        pendingCount: uploads.length + storeRequests.length,
        uploads,
        storeRequests,
      },
      asJson
    );
    return 0;
  }

  if (sub === 'approve' || sub === 'reject') {
    const kindRaw = (restPositional[0] || '').trim().toLowerCase();
    const idNum = Number(restPositional[1] || flags.id || 0);
    if ((kindRaw !== 'upload' && kindRaw !== 'store') || !Number.isFinite(idNum) || idNum <= 0) {
      throw new Error(`Usage: cli uac ${sub} <upload|store> <id>${sub === 'reject' ? ' [--reason "<text>"]' : ''}`);
    }
    const reviewer = { userId: null, username: 'cli-admin' };
    if (sub === 'approve') {
      const res =
        kindRaw === 'upload'
          ? await approvePendingUpload(idNum, reviewer)
          : await approvePendingStoreRequest(idNum, reviewer);
      out({ ...res, kind: kindRaw, id: idNum, status: 'approved' }, asJson);
      return 0;
    }
    const reason = typeof flags.reason === 'string' ? flags.reason : undefined;
    const res =
      kindRaw === 'upload'
        ? await rejectPendingUpload(idNum, reviewer, reason)
        : rejectPendingStoreRequest(idNum, reviewer, reason);
    out({ ...res, kind: kindRaw, id: idNum, status: 'rejected', reason: reason || '' }, asJson);
    return 0;
  }

  throw new Error('Usage: cli uac <users | roles | suspend <username> | activate <username> | approvals | approve <upload|store> <id> | reject <upload|store> <id> [--reason "..."]>');
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
    const db = getCoreDb();
    const videoDb = getVideoDb();
    const trackCount = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;
    const videoCount = (videoDb.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c;
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
  const coreDb = getCoreDb();
  const videoDb = getVideoDb();
  const cache = getCacheStats();
  const stats = {
    tracks: (coreDb.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c,
    videos: (videoDb.prepare('SELECT COUNT(*) as c FROM videos').get() as { c: number }).c,
    books: (videoDb.prepare('SELECT COUNT(*) as c FROM books').get() as { c: number }).c,
    audiobooks: (videoDb.prepare('SELECT COUNT(*) as c FROM audiobooks').get() as { c: number }).c,
    photos: (videoDb.prepare('SELECT COUNT(*) as c FROM photos').get() as { c: number }).c,
    playlists: (coreDb.prepare('SELECT COUNT(*) as c FROM playlists').get() as { c: number }).c,
    devices: (coreDb.prepare('SELECT COUNT(*) as c FROM devices').get() as { c: number }).c,
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

async function cmdPlaylistEgenius(flags: Record<string, string | boolean>, asJson: boolean) {
  initDatabase();
  const trackId = Number(flags['track-id'] || flags.trackId || 0);
  if (!trackId) {
    throw new Error('Missing required --track-id <id>');
  }
  const rawLimit = Number(flags.limit || 25);
  const limit: 25 | 50 = rawLimit === 50 ? 50 : 25;
  const rawMode = String(flags.mode || 'balanced').toLowerCase();
  const mode: MixDepthMode = rawMode === 'hits' || rawMode === 'deep' ? rawMode : 'balanced';

  const mix = await generateMix({
    seedTrackId: trackId,
    limit,
    mode,
    offlineOnly: Boolean(flags.offline),
  });

  if (asJson) {
    out(
      {
        ok: true,
        seedTrack: {
          id: mix.seedTrack.id,
          title: mix.seedTrack.title,
          artist: mix.seedTrack.artist,
          album: mix.seedTrack.album,
          year: mix.seedTrack.year,
          variant: mix.seedVariant,
        },
        mode: mix.mode,
        limit: mix.limit,
        count: mix.tracks.length,
        distinctArtists: mix.distinctArtists,
        hop1Count: mix.hop1Count,
        hop2Count: mix.hop2Count,
        cacheHit: mix.cacheHit,
        elapsedMs: mix.elapsedMs,
        tracks: mix.tracks.map((t, i) => {
          const scoredMatch = mix.scored.find((s) => s.track.id === t.id);
          return {
            pos: i + 1,
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album,
            year: t.year,
            duration: t.duration,
            relScore: t.artist_relative_popularity_score,
            ...(flags.explain && scoredMatch
              ? { breakdown: scoredMatch.breakdown }
              : {}),
          };
        }),
      },
      true
    );
  } else {
    console.log(
      `eGenius Mix from "${mix.seedTrack.title}" by ${mix.seedTrack.artist} (${mix.seedVariant}) — ${mix.tracks.length} tracks, ${mix.distinctArtists} distinct artists, ${mix.elapsedMs}ms [mode=${mix.mode}, cacheHit=${mix.cacheHit}]`
    );
    mix.tracks.forEach((t, i) => {
      console.log(
        `  ${String(i + 1).padStart(2, ' ')}. ${t.artist} — ${t.title} (${t.album || '—'}, ${t.year || '—'}, rel=${(t.artist_relative_popularity_score || 0).toFixed(2)}x)`
      );
    });
  }
  return 0;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const asJson = Boolean(flags.json);
  const [group, sub, ...restPositional] = positional;

  if (flags.help || group === 'help') {
    printHelp();
    process.exitCode = 0;
    return;
  }

  const isHeadlessBoot =
    positional.length === 0 &&
    Boolean(
      flags.headless ||
        flags['headless-server'] ||
        flags['headless-client'] ||
        process.env.RTUNES_MODE === 'headless-server' ||
        process.env.RTUNES_MODE === 'headless-client'
    );

  if (isHeadlessBoot) {
    const { bootHeadlessServer } = await import('./server');
    await bootHeadlessServer();
    return;
  }

  try {
    if (group === 'doctor') {
      process.exitCode = await cmdDoctor(asJson);
      return;
    }
    if (group === 'status') {
      process.exitCode = await cmdStatus(asJson);
      return;
    }
    if (group === 'auth' && sub === 'setup') {
      process.exitCode = await cmdAuthSetup(flags, asJson);
      return;
    }
    if (group === 'client') {
      process.exitCode = await cmdClient(sub, flags, asJson);
      return;
    }
    if (group === 'uac') {
      process.exitCode = await cmdUac(sub, restPositional, flags, asJson);
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
    if (group === 'db' && sub === 'rebuild') {
      initDatabase();
      rebuildMediaDatabase();
      await runLibraryScan();
      const diag = getDatabaseDiagnostics();
      out({ ok: true, rebuilt: true, ...diag }, asJson);
      process.exitCode = 0;
      return;
    }
    if (group === 'db' && sub === 'update-popularity') {
      initDatabase();
      const force = Boolean(flags.force);
      const limit = flags.limit ? Number(flags.limit) : 120;
      const res = await syncListenBrainzPopularity({ force, limit });
      out({ ok: true, ...res }, asJson);
      process.exitCode = 0;
      return;
    }
    if (group === 'db' && sub === 'deduplicate') {
      initDatabase();
      const res = deduplicateLibraryTracks();
      out({ ok: true, ...res }, asJson);
      process.exitCode = 0;
      return;
    }
    if (group === 'db' && sub === 'rebuild-genre-matrix') {
      initDatabase();
      const lfmWeight =
        typeof flags['lastfm-weight'] === 'string'
          ? Number(flags['lastfm-weight'])
          : undefined;
      const res = rebuildGenreMatrix({
        useLastfm: lfmWeight !== undefined ? lfmWeight > 0 : undefined,
        lastfmWeight: lfmWeight,
        resetStuckMetadata: Boolean(flags['reset-stuck']),
      });
      out({ ok: true, ...res }, asJson);
      process.exitCode = 0;
      return;
    }
    if (group === 'artist-map') {
      initDatabase();
      const genreRaw = typeof flags.genre === 'string' ? flags.genre : '';
      if (!genreRaw.trim()) {
        console.error('Usage: npm run cli -- artist-map --genre "<genre>" [--min 0.550] [--artist "<name>"] [--lastfm-weight <0-100>] [--json]');
        process.exitCode = 1;
        return;
      }
      const minThreshold = typeof flags.min === 'string' ? Number(flags.min) : 0.55;
      const artistFilter = typeof flags.artist === 'string' ? flags.artist : '';
      const lfmWeight =
        typeof flags['lastfm-weight'] === 'string'
          ? Number(flags['lastfm-weight'])
          : undefined;
      const slice = computeGenreArtistSlice({
        targetGenre: genreRaw,
        minThreshold,
        artistFilter,
        useLastfm: lfmWeight !== undefined ? lfmWeight > 0 : undefined,
        lastfmWeight: lfmWeight,
      });
      out(
        {
          ok: true,
          targetGenre: slice.targetGenre,
          minThreshold: slice.minThreshold,
          effectiveLastfmWeight: slice.effectiveLastfmWeight,
          hasLastfmApiKey: slice.hasLastfmApiKey,
          totalMatchedArtists: slice.totalMatchedArtists,
          elapsedMs: slice.elapsedMs,
          artists: slice.artists.slice(0, 25),
          sampleMatrixRows: slice.artists.slice(0, 10).map((a, i) => ({
            artist: a.artistName,
            sceneScore: a.sceneScore,
            topPeerScores: slice.artists
              .slice(0, 10)
              .map((b, j) => ({ peer: b.artistName, combined: slice.combinedMatrix[i][j], local: slice.localMatrix[i][j], lastfm: slice.lastfmMatrix[i][j] })),
          })),
        },
        asJson
      );
      process.exitCode = 0;
      return;
    }
    if (group === 'genre-map') {
      initDatabase();
      const genreRaw = typeof flags.genre === 'string' ? flags.genre : '';
      if (!genreRaw.trim()) {
        console.error('Usage: npm run cli -- genre-map --genre <name> [--min 0.550] [--artist <name>] [--json]');
        process.exitCode = 1;
        return;
      }
      const targetGenre = normalizeGenreTag(genreRaw) || genreRaw.trim().toLowerCase();
      const minScore = typeof flags.min === 'string' ? Number(flags.min) : 0.55;
      const artistQuery = typeof flags.artist === 'string' ? flags.artist : '';
      const db = getCoreDb();
      const matrixCells = db
        .prepare(
          `SELECT genre_x as genreX, genre_y as genreY, similarity, is_user_locked as isUserLocked
           FROM subgenre_affinity_matrix
           WHERE genre_x = ? AND similarity >= ?
           ORDER BY similarity DESC`
        )
        .all(targetGenre, minScore) as { genreX: string; genreY: string; similarity: number; isUserLocked: number }[];
      const matchingArtists = testArtistsAgainstGenre(targetGenre, {
        artistQuery,
        minScore: artistQuery ? 0 : minScore,
        limit: 50,
      });
      out(
        {
          ok: true,
          genre: targetGenre,
          minScore,
          adjacentSubgenres: matrixCells,
          matchingArtists,
        },
        asJson
      );
      process.exitCode = 0;
      return;
    }
    if (group === 'store' && sub === 'queue') {
      process.exitCode = await cmdStoreQueue(asJson);
      return;
    }
    if ((group === 'playlist' && sub === 'egenius') || group === 'egenius') {
      process.exitCode = await cmdPlaylistEgenius(flags, asJson);
      return;
    }
    if (group === 'reset-password') {
      const targetUser = (sub || (typeof flags.username === 'string' ? flags.username : '')).trim();
      if (!targetUser) {
        console.error('Usage: npm run cli -- reset-password <username> [--password <newpass>] [--json]');
        process.exitCode = 1;
        return;
      }
      initDatabase();
      ensureRbacSeeded();
      const directPass = typeof flags.password === 'string' ? flags.password : '';
      if (directPass) {
        if (directPass.length < 4) {
          throw new Error('Password must be at least 4 characters.');
        }
        const user = await resetUserPasswordDirect(targetUser, directPass);
        out(
          { ok: true, mode: 'direct', username: user.username, message: `Password updated for "${user.username}".` },
          asJson
        );
      } else {
        const res = generateResetCodeForUsername(targetUser);
        out(
          {
            ok: true,
            mode: 'reset-code',
            username: res.username,
            code: res.code,
            expiresAt: new Date(res.expiresAt).toISOString(),
            message: `One-time reset code generated for "${res.username}": ${res.code} (valid 30 min)`,
          },
          asJson
        );
      }
      process.exitCode = 0;
      return;
    }

    console.error(
      'Usage: npm run cli -- <--help | doctor | status | auth setup ... | client <login|logout|sync> | uac <users|roles|suspend|activate|approvals|approve|reject> | device <list|sync> | db <stats|scan|rebuild|update-popularity|deduplicate|rebuild-genre-matrix> | store queue | playlist egenius ... | reset-password <username> [--password <newpass>]> [--json]'
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
