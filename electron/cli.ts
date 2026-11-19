import fs from 'fs';
import path from 'path';
import { initDatabase, getCoreDb, getVideoDb, getDatabaseDiagnostics, rebuildMediaDatabase } from './db';
import { getSettings } from './settings';
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
import { getArrLiveQueue } from './storeArr';
import { standaloneLocalProvider } from './providers/standaloneLocal';
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
  const integrityRow = getCoreDb().prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
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
  const [group, sub] = positional;

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

    console.error(
      'Usage: npm run cli -- <doctor | device list | device sync [--dry-run] [--uuid <id>] | db stats | db scan [--path <dir>] | store queue | playlist egenius --track-id <id> [--limit 25|50] [--mode hits|balanced|deep]> [--json]'
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
