import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getCoreDb, getVideoDb, TrackRow, VideoRow } from './db';
import { getSettings } from './settings';
import { logger } from './logger';
import { resolveReachableTrackPath } from './trackSources';
import { detectHardwareEncoder } from './transcoder/binaryManager';

let serverPort = 0;
let mediaServerInstance: http.Server | null = null;

const MIME_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function serveByteRangeFile(filePath: string, req: http.IncomingMessage, res: http.ServerResponse) {
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('File not found');
    return;
  }

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

export function handleMediaHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (
    url.pathname !== '/track' &&
    url.pathname !== '/video' &&
    url.pathname !== '/artwork'
  ) {
    return false;
  }

  if (url.pathname === '/track') {
    const uid = url.searchParams.get('uid')?.trim();
    const id = Number(url.searchParams.get('id'));
    const coreDb = getCoreDb();
    const track = (
      uid
        ? coreDb.prepare('SELECT * FROM tracks WHERE track_uid = ?').get(uid)
        : coreDb.prepare('SELECT * FROM tracks WHERE id = ?').get(id)
    ) as TrackRow | undefined;
    if (!track) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end('Track not found');
      return true;
    }
    const filePath = resolveReachableTrackPath(track);
    if (track.local_cache_path) {
      getVideoDb()
        .prepare("UPDATE cache_jobs SET last_accessed = datetime('now') WHERE item_type = 'audio' AND item_id = ?")
        .run(track.id);
    }
    serveByteRangeFile(filePath, req, res);
    return true;
  }

  if (url.pathname === '/video') {
    const id = Number(url.searchParams.get('id'));
    const video = getVideoDb().prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined;
    if (!video) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end('Video not found');
      return true;
    }

    const filePath =
      video.local_cache_path && fs.existsSync(video.local_cache_path)
        ? video.local_cache_path
        : video.remote_nfs_path;

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end('Video file not found on disk');
      return true;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mkv' || ext === '.avi') {
      const settings = getSettings();
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
      });

      const encoder = detectHardwareEncoder(settings.ffmpegBinaryPath, settings.hardwareAccelMode);
      const videoCodecArgs =
        encoder === 'libx264'
          ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
          : ['-c:v', encoder, '-b:v', '2500k'];

      const ff = spawn(settings.ffmpegBinaryPath, [
        '-i',
        filePath,
        ...videoCodecArgs,
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-ac',
        '2',
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1',
      ]);

      ff.stdout.pipe(res);
      req.on('close', () => {
        ff.kill('SIGKILL');
      });
      return true;
    }

    serveByteRangeFile(filePath, req, res);
    return true;
  }

  const filePath = url.searchParams.get('path') || '';
  serveByteRangeFile(filePath, req, res);
  return true;
}

export function startMediaServer(): Promise<number> {
  if (mediaServerInstance && serverPort > 0) {
    return Promise.resolve(serverPort);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (handleMediaHttpRequest(req, res)) return;
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
      } catch (err) {
        logger.error('PLAYBACK', 'Media streaming server error', err);
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
        res.end('Internal Server Error');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
        mediaServerInstance = server;
        logger.info('PLAYBACK', `Embedded local media streaming server listening on http://127.0.0.1:${serverPort}`);
        resolve(serverPort);
      } else {
        reject(new Error('Failed to bind media server port'));
      }
    });
  });
}

export function getMediaServerPort(): number {
  return serverPort;
}
