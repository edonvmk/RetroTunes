import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { BrowserWindow } from 'electron';
import { getDb, CacheJobRow, TrackRow, VideoRow } from './db';
import { getSettings } from './settings';
import { logger } from './logger';

let workerRunning = false;

export interface CacheStats {
  cachePath: string;
  usedBytes: number;
  quotaBytes: number;
  usagePercent: number;
  audioCount: number;
  videoCount: number;
  artworkCount: number;
  jobs: CacheJobRow[];
}

function broadcastCacheStatus() {
  try {
    const stats = getCacheStats();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('cache:status', stats);
      }
    }
  } catch {
    // ignore
  }
}

function getDirStats(dirPath: string): { bytes: number; count: number } {
  if (!dirPath || !fs.existsSync(dirPath)) return { bytes: 0, count: 0 };
  let bytes = 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = getDirStats(full);
        bytes += sub.bytes;
        count += sub.count;
      } else if (entry.isFile()) {
        bytes += fs.statSync(full).size;
        count++;
      }
    }
  } catch {
    // ignore
  }
  return { bytes, count };
}

export function getCacheStats(): CacheStats {
  const settings = getSettings();
  const db = getDb();
  const audioStats = getDirStats(path.join(settings.localCachePath, 'audio'));
  const videoStats = getDirStats(path.join(settings.localCachePath, 'video'));
  const artworkStats = getDirStats(path.join(settings.localCachePath, 'artwork'));

  const usedBytes = audioStats.bytes + videoStats.bytes + artworkStats.bytes;
  const quotaBytes = Math.max(10, settings.cacheMaxSizeGb) * 1024 * 1024 * 1024;
  const usagePercent = Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10);

  const jobs = db
    .prepare('SELECT * FROM cache_jobs ORDER BY id DESC LIMIT 100')
    .all() as CacheJobRow[];

  return {
    cachePath: settings.localCachePath,
    usedBytes,
    quotaBytes,
    usagePercent,
    audioCount: audioStats.count,
    videoCount: videoStats.count,
    artworkCount: artworkStats.count,
    jobs,
  };
}

/**
 * Enforces the user's configured Local Cache Quota (10 GB - 500 GB) via Auto-LRU Eviction.
 */
export function enforceCacheQuotaLru(): { evictedFiles: number; freedBytes: number } {
  const settings = getSettings();
  if (!settings.autoEvictLru) return { evictedFiles: 0, freedBytes: 0 };

  const stats = getCacheStats();
  if (stats.usedBytes <= stats.quotaBytes) {
    return { evictedFiles: 0, freedBytes: 0 };
  }

  const db = getDb();
  const bytesToFree = stats.usedBytes - stats.quotaBytes;
  let freedBytes = 0;
  let evictedFiles = 0;

  // Find completed cache_jobs ordered by oldest last_accessed first
  const candidates = db
    .prepare("SELECT * FROM cache_jobs WHERE status = 'completed' ORDER BY last_accessed ASC")
    .all() as CacheJobRow[];

  for (const job of candidates) {
    if (freedBytes >= bytesToFree) break;
    try {
      if (job.target_path && fs.existsSync(job.target_path)) {
        const sz = fs.statSync(job.target_path).size;
        fs.unlinkSync(job.target_path);
        freedBytes += sz;
        evictedFiles++;
      }
      if (job.item_type === 'audio') {
        db.prepare('UPDATE tracks SET local_cache_path = NULL, keep_cached = 0 WHERE id = ?').run(job.item_id);
      } else {
        db.prepare(
          "UPDATE videos SET local_cache_path = NULL, is_transcoded = 0, transcode_status = 'none', keep_cached = 0 WHERE id = ?"
        ).run(job.item_id);
      }
      db.prepare('DELETE FROM cache_jobs WHERE id = ?').run(job.id);
    } catch (err) {
      logger.warn('CACHE', `LRU eviction error for ${job.target_path}`, { error: String(err) });
    }
  }

  if (evictedFiles > 0) {
    logger.info('CACHE', `LRU Eviction freed ${freedBytes} bytes across ${evictedFiles} cached items.`);
    broadcastCacheStatus();
  }
  return { evictedFiles, freedBytes };
}

export function clearLocalCache(): { deletedFiles: number; freedBytes: number } {
  const settings = getSettings();
  const db = getDb();
  let deletedFiles = 0;
  let freedBytes = 0;

  for (const sub of ['audio', 'video']) {
    const dir = path.join(settings.localCachePath, sub);
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) {
            freedBytes += st.size;
            fs.unlinkSync(full);
            deletedFiles++;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  db.exec(`
    UPDATE tracks SET local_cache_path = NULL, keep_cached = 0;
    UPDATE videos SET local_cache_path = NULL, keep_cached = 0, is_transcoded = 0, transcode_status = 'none', transcode_progress = 0;
    DELETE FROM cache_jobs;
  `);

  logger.info('CACHE', `Cleared Local Cache: removed ${deletedFiles} files (${freedBytes} bytes).`);
  broadcastCacheStatus();
  return { deletedFiles, freedBytes };
}

export function queueTrackCache(trackId: number, keepCached = true): void {
  const db = getDb();
  const settings = getSettings();
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as TrackRow | undefined;
  if (!track) return;

  if (!keepCached) {
    if (track.local_cache_path && fs.existsSync(track.local_cache_path)) {
      try {
        fs.unlinkSync(track.local_cache_path);
      } catch {
        // ignore
      }
    }
    db.prepare('UPDATE tracks SET keep_cached = 0, local_cache_path = NULL WHERE id = ?').run(trackId);
    db.prepare("DELETE FROM cache_jobs WHERE item_type = 'audio' AND item_id = ?").run(trackId);
    broadcastCacheStatus();
    return;
  }

  db.prepare('UPDATE tracks SET keep_cached = 1 WHERE id = ?').run(trackId);

  // Check if already cached on disk
  if (track.local_cache_path && fs.existsSync(track.local_cache_path)) {
    return;
  }

  const ext = path.extname(track.remote_nfs_path) || '.mp3';
  const safeBase = `${track.id}_${track.artist}_${track.title}`
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  const targetPath = path.join(settings.localCachePath, 'audio', `${safeBase}${ext}`);

  const existingJob = db
    .prepare("SELECT id FROM cache_jobs WHERE item_type = 'audio' AND item_id = ? AND status IN ('queued', 'running')")
    .get(trackId);
  if (existingJob) return;

  db.prepare(`
    INSERT INTO cache_jobs (item_type, item_id, title, source_path, target_path, status, progress)
    VALUES ('audio', ?, ?, ?, ?, 'queued', 0)
  `).run(track.id, `${track.artist} - ${track.title}`, track.remote_nfs_path, targetPath);

  logger.info('CACHE', `Queued audio track for local SSD cache: ${track.artist} - ${track.title}`);
  broadcastCacheStatus();
  void processNextCacheJob();
}

export function queueVideoTranscode(videoId: number, keepCached = true): void {
  const db = getDb();
  const settings = getSettings();
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as VideoRow | undefined;
  if (!video) return;

  if (!keepCached) {
    if (video.local_cache_path && fs.existsSync(video.local_cache_path)) {
      try {
        fs.unlinkSync(video.local_cache_path);
      } catch {
        // ignore
      }
    }
    db.prepare(
      "UPDATE videos SET keep_cached = 0, local_cache_path = NULL, is_transcoded = 0, transcode_status = 'none', transcode_progress = 0 WHERE id = ?"
    ).run(videoId);
    db.prepare("DELETE FROM cache_jobs WHERE item_type = 'video' AND item_id = ?").run(videoId);
    broadcastCacheStatus();
    return;
  }

  if (video.local_cache_path && fs.existsSync(video.local_cache_path) && video.is_transcoded) {
    db.prepare("UPDATE videos SET keep_cached = 1, transcode_status = 'ready' WHERE id = ?").run(videoId);
    return;
  }

  const safeBase = `${video.id}_${video.title}`
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  const targetPath = path.join(settings.localCachePath, 'video', `${safeBase}_360p.mp4`);

  db.prepare(
    "UPDATE videos SET keep_cached = 1, transcode_status = 'queued', transcode_progress = 0 WHERE id = ?"
  ).run(videoId);

  const existingJob = db
    .prepare("SELECT id FROM cache_jobs WHERE item_type = 'video' AND item_id = ? AND status IN ('queued', 'running')")
    .get(videoId);
  if (existingJob) return;

  db.prepare(`
    INSERT INTO cache_jobs (item_type, item_id, title, source_path, target_path, status, progress)
    VALUES ('video', ?, ?, ?, ?, 'queued', 0)
  `).run(video.id, video.title, video.remote_nfs_path, targetPath);

  logger.info('TRANSCODE', `Queued video for 360p ePod transcoding: ${video.title}`, {
    source: video.remote_nfs_path,
    target: targetPath,
  });
  broadcastCacheStatus();
  void processNextCacheJob();
}

export function detectHardwareEncoder(ffmpegPath: string, mode: string): string {
  if (mode === 'software') return 'libx264';
  try {
    const out = execFileSync(ffmpegPath, ['-encoders'], { encoding: 'utf8' });
    if ((mode === 'auto' || mode === 'vt_h264') && out.includes('h264_videotoolbox')) {
      return 'h264_videotoolbox';
    }
    if ((mode === 'auto' || mode === 'nvenc') && out.includes('h264_nvenc')) {
      return 'h264_nvenc';
    }
    if ((mode === 'auto' || mode === 'qsv') && out.includes('h264_qsv')) {
      return 'h264_qsv';
    }
  } catch {
    // ignore
  }
  return 'libx264';
}

async function processNextCacheJob(): Promise<void> {
  if (workerRunning) return;
  const db = getDb();
  const nextJob = db
    .prepare("SELECT * FROM cache_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
    .get() as CacheJobRow | undefined;

  if (!nextJob) return;
  workerRunning = true;

  try {
    const settings = getSettings();
    db.prepare("UPDATE cache_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(
      nextJob.id
    );
    broadcastCacheStatus();

    if (nextJob.item_type === 'audio') {
      const start = Date.now();
      fs.mkdirSync(path.dirname(nextJob.target_path), { recursive: true });
      fs.copyFileSync(nextJob.source_path, nextJob.target_path);
      const sz = fs.statSync(nextJob.target_path).size;

      db.prepare(`
        UPDATE cache_jobs
        SET status = 'completed', progress = 100, encoder_used = 'stream_copy', size_bytes = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(sz, nextJob.id);

      db.prepare('UPDATE tracks SET local_cache_path = ?, keep_cached = 1 WHERE id = ?').run(
        nextJob.target_path,
        nextJob.item_id
      );

      logger.info(
        'CACHE',
        `Cached audio track locally: ${nextJob.title}`,
        { target: nextJob.target_path, sizeBytes: sz },
        Date.now() - start
      );
    } else if (nextJob.item_type === 'video') {
      await runVideoTranscodeJob(nextJob);
    }

    enforceCacheQuotaLru();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE cache_jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(msg, nextJob.id);
    if (nextJob.item_type === 'video') {
      db.prepare("UPDATE videos SET transcode_status = 'error' WHERE id = ?").run(nextJob.item_id);
    }
    logger.error('TRANSCODE', `Cache/Transcode job failed for ${nextJob.title}: ${msg}`, err);
  } finally {
    workerRunning = false;
    broadcastCacheStatus();
    // Check if more jobs remain in queue
    const remaining = db
      .prepare("SELECT COUNT(*) as c FROM cache_jobs WHERE status = 'queued'")
      .get() as { c: number };
    if (remaining.c > 0) {
      void processNextCacheJob();
    }
  }
}

function runVideoTranscodeJob(job: CacheJobRow): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const db = getDb();
    const settings = getSettings();
    fs.mkdirSync(path.dirname(job.target_path), { recursive: true });

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(job.item_id) as VideoRow | undefined;
    const totalDurationSec = video?.duration && video.duration > 0 ? video.duration : 0;

    const encoder = detectHardwareEncoder(settings.ffmpegBinaryPath, settings.hardwareAccelMode);
    db.prepare("UPDATE cache_jobs SET encoder_used = ? WHERE id = ?").run(encoder, job.id);
    db.prepare("UPDATE videos SET transcode_status = 'transcoding', transcode_progress = 1 WHERE id = ?").run(
      job.item_id
    );
    broadcastCacheStatus();

    // Target specs from Section 3:
    // Max width 480, max height 360, 30fps cap, H.264 Baseline/Main profile, AAC 128kbps stereo, fast-start MP4 atom
    const args = [
      '-y',
      '-i',
      job.source_path,
      '-vf',
      "scale='min(480,iw)':'min(360,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
      '-r',
      '30',
      '-c:v',
      encoder,
      '-profile:v',
      'main',
      '-b:v',
      '750k',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-movflags',
      '+faststart',
      job.target_path,
    ];

    logger.info('TRANSCODE', `Starting 360p ePod video transcode via ${encoder}: ${job.title}`, {
      binary: settings.ffmpegBinaryPath,
      args,
    });

    const proc = spawn(settings.ffmpegBinaryPath, args);
    let stderrTail = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-1500);

      // Parse time=HH:MM:SS.xx from FFmpeg output
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
      if (timeMatch && totalDurationSec > 0) {
        const hrs = parseInt(timeMatch[1], 10);
        const mins = parseInt(timeMatch[2], 10);
        const secs = parseFloat(timeMatch[3]);
        const elapsedSec = hrs * 3600 + mins * 60 + secs;
        const pct = Math.min(99, Math.max(1, Math.round((elapsedSec / totalDurationSec) * 100)));

        db.prepare('UPDATE cache_jobs SET progress = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
          pct,
          job.id
        );
        db.prepare('UPDATE videos SET transcode_progress = ? WHERE id = ?').run(pct, job.item_id);
        broadcastCacheStatus();
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(job.target_path)) {
        const sz = fs.statSync(job.target_path).size;
        db.prepare(`
          UPDATE cache_jobs
          SET status = 'completed', progress = 100, size_bytes = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(sz, job.id);

        db.prepare(`
          UPDATE videos
          SET local_cache_path = ?, is_transcoded = 1, transcode_status = 'ready', transcode_progress = 100
          WHERE id = ?
        `).run(job.target_path, job.item_id);

        logger.info(
          'TRANSCODE',
          `Completed 360p video transcode for "${job.title}" (${encoder})`,
          { target: job.target_path, sizeBytes: sz },
          Date.now() - start
        );
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderrTail.slice(-400)}`));
      }
    });
  });
}
