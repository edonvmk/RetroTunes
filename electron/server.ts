import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import path from 'path';
import { Readable } from 'stream';
import {
  initDatabase,
  getDb,
  getDeltaSyncBatch,
  applyPlaybackDeltaSync,
  PlaybackDeltaUpdate,
} from './db';
import { getAppDataPath, getAppPath, isPackaged, onRendererEvent } from './runtimeBus';
import { registerCoreRpcHandlers, RpcHandlerFn } from './rpcHandlers';
import { handleMediaHttpRequest } from './mediaServer';
import { getSettings, saveSettings } from './settings';
import { hasPendingIndexCheckpoint, runLibraryScan } from './indexer';
import { logger } from './logger';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface UnifiedHttpServerOptions {
  port: number;
  host: string;
  registry: Map<string, RpcHandlerFn>;
  serveStaticDist?: boolean;
  mountMedia?: boolean;
}

async function handleFileUploadRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const stagingDir = path.join(getAppDataPath(), 'staging', String(Date.now()));
  await fsp.mkdir(stagingDir, { recursive: true });
  const filePaths: string[] = [];

  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('multipart/form-data')) {
    const webReq = new Request('http://localhost/api/upload-files', {
      method: 'POST',
      headers: req.headers as Record<string, string>,
      body: Readable.toWeb(req) as any,
      duplex: 'half',
    } as RequestInit);
    const form = await webReq.formData();
    for (const [, value] of form.entries()) {
      if (typeof value === 'string') continue;
      const safeName = path.basename(value.name || 'upload.bin').replace(/[/\\?%*:|"<>]/g, '_');
      const destPath = path.join(stagingDir, safeName);
      const buf = Buffer.from(await value.arrayBuffer());
      await fsp.writeFile(destPath, buf);
      filePaths.push(destPath);
    }
  } else {
    const rawName = String(req.headers['x-file-name'] || 'upload.bin');
    const safeName = path.basename(rawName).replace(/[/\\?%*:|"<>]/g, '_');
    const destPath = path.join(stagingDir, safeName);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(destPath);
      req.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
      req.on('error', reject);
    });
    filePaths.push(destPath);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, filePaths }));
}

function serveStaticAsset(reqPath: string, distDir: string, res: http.ServerResponse): boolean {
  if (!fs.existsSync(distDir)) return false;
  const cleanRel = decodeURIComponent(reqPath.split('?')[0]).replace(/^\/+/, '');
  let target = path.resolve(distDir, cleanRel || 'index.html');
  if (!target.startsWith(distDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(distDir, 'index.html');
  }
  if (!fs.existsSync(target)) return false;
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
  return true;
}

export function startUnifiedHttpServer(
  options: UnifiedHttpServerOptions
): Promise<{ server: http.Server; port: number }> {
  const { port, host, registry, serveStaticDist = false, mountMedia = false } = options;
  const distDir = path.resolve(getAppPath(), 'dist');

  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const reqPath = (req.url || '/').split('?')[0];

      if (req.method === 'GET' && reqPath === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: 'server', version: '1.0.0' }));
        return;
      }

      if (req.method === 'GET' && reqPath === '/api/sync/delta') {
        const reqUrl = new URL(req.url || '/', `http://${host}:${port}`);
        const sinceRev = Number(reqUrl.searchParams.get('since_rev')) || 0;
        const limit = Math.min(5000, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 2000));
        const payload = getDeltaSyncBatch(sinceRev, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/sync/playback') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}') as { updates?: PlaybackDeltaUpdate[] };
            const result = applyPlaybackDeltaSync(Array.isArray(parsed.updates) ? parsed.updates : []);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }

      if (req.method === 'GET' && reqPath === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(': connected\n\n');

        const unsubscribe = onRendererEvent((channel, payload) => {
          try {
            res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`);
          } catch {
            // ignore closed socket
          }
        });

        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(keepAlive);
          }
        }, 25000);

        req.on('close', () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/upload-files') {
        try {
          await handleFileUploadRequest(req, res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && reqPath === '/rpc') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { channel, args } = JSON.parse(body) as { channel: string; args?: unknown[] };
            const fn = registry.get(channel);
            if (!fn) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `Unknown RPC channel: ${channel}` }));
              return;
            }
            const data = await fn(...(args || []));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, data }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }

      if (mountMedia && handleMediaHttpRequest(req, res)) {
        return;
      }

      if (serveStaticDist && req.method === 'GET' && serveStaticAsset(req.url || '/', distDir, res)) {
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    srv.on('error', (err) => {
      logger.warn('SYSTEM', `HTTP server listen error on ${host}:${port}`, { error: String(err) });
      reject(err);
    });

    srv.listen(port, host, () => {
      const addr = srv.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : port;
      logger.info('SYSTEM', `rTunes-Server listening on http://${host}:${boundPort}`);
      resolve({ server: srv, port: boundPort });
    });
  });
}

function applyContainerMediaDefaults(): void {
  const mediaRoot = process.env.RTUNES_MEDIA_DIR?.trim();
  if (!mediaRoot || !fs.existsSync(mediaRoot)) return;
  const settings = getSettings();
  if (settings.musicRootPath || settings.nfsSharePath) return;

  const subIfExists = (name: string) => {
    const candidate = path.join(mediaRoot, name);
    return fs.existsSync(candidate) ? candidate : '';
  };

  saveSettings({
    nfsSharePath: mediaRoot,
    musicRootPath: subIfExists('Music') || mediaRoot,
    videoRootPath: subIfExists('Movies'),
    tvRootPath: subIfExists('TV Shows'),
    musicVideosRootPath: subIfExists('Music Videos'),
    booksRootPath: subIfExists('Books'),
    audiobooksRootPath: subIfExists('Audiobooks'),
    photosRootPath: subIfExists('Photos'),
  });
}

async function bootHeadlessServer(): Promise<void> {
  initDatabase();
  applyContainerMediaDefaults();

  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const isDev = process.env.NODE_ENV === 'development' && !isPackaged();

  const registry = new Map<string, RpcHandlerFn>();
  let activePort = port;
  registerCoreRpcHandlers((ch, fn) => registry.set(ch, fn), {
    isDev,
    mediaPortGetter: () => activePort,
  });

  const started = await startUnifiedHttpServer({
    port,
    host,
    registry,
    serveStaticDist: true,
    mountMedia: true,
  });
  activePort = started.port;

  if (hasPendingIndexCheckpoint()) {
    void runLibraryScan(undefined, { resume: true });
  } else if (process.env.RTUNES_MEDIA_DIR) {
    const count = (getDb().prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;
    if (count === 0) {
      void runLibraryScan();
    }
  }
}

if (require.main === module) {
  bootHeadlessServer().catch((err) => {
    logger.error('SYSTEM', 'Fatal rTunes-Server startup failure', err);
    process.exit(1);
  });
}
