import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import {
  initDatabase,
  closeAllDatabases,
  getDb,
  getDeltaSyncBatch,
  applyPlaybackDeltaSync,
  PlaybackDeltaUpdate,
} from './db';
import {
  getAppDataPath,
  getAppPath,
  isPackaged,
  onRendererEvent,
  openExternalUrl,
} from './runtimeBus';
import { registerCoreRpcHandlers, assertChannelPermission, RpcHandlerFn } from './rpcHandlers';
import { handleMediaHttpRequest } from './mediaServer';
import {
  AppProfile,
  AppSettings,
  getSettings,
  getStoredLocalPinHash,
  isServerProfile,
  resolveAppMode,
  saveSettings,
  verifyLocalPin,
} from './settings';
import {
  CallerContext,
  createGuestCallerContext,
  createLocalOwnerCallerContext,
  ForbiddenError,
  runWithCallerContext,
  UnauthorizedError,
} from './auth/callerContext';
import {
  authenticateLocalUser,
  bootstrapEnvAdminIfNeeded,
  consumeResetCode,
  createSession,
  createUser,
  ensureRbacSeeded,
  getUserById,
  getUserCount,
  hashToken,
  provisionExternalUser,
  resolveSessionToken,
  revokeSessionToken,
} from './auth/rbac';
import {
  hasPendingIndexCheckpoint,
  reconcileBackgroundWatchers,
  runLibraryScan,
  stopBackgroundWatchers,
} from './indexer';
import { runStartupTranscoderCheck } from './transcoder/binaryManager';
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
  appMode?: AppProfile;
  enforceAuthGate?: boolean;
}

const activePinTokens = new Map<string, number>();
const authentikTokenCache = new Map<string, { caller: CallerContext; expiresAt: number }>();
const oidcUserinfoEndpointCache = new Map<string, string>();

function extractBearerToken(req: http.IncomingMessage, reqUrl: URL): string {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return (reqUrl.searchParams.get('token') || '').trim();
}

async function resolveAuthentikCaller(
  token: string,
  settings: AppSettings
): Promise<CallerContext | null> {
  const cacheKey = hashToken(token);
  const cached = authentikTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.caller;
  }
  authentikTokenCache.delete(cacheKey);

  const issuer = (settings.authentikIssuerUrl || '').trim().replace(/\/+$/, '');
  if (!issuer) return null;

  try {
    let userinfoUrl = oidcUserinfoEndpointCache.get(issuer);
    if (!userinfoUrl) {
      const discUrl = issuer.endsWith('.well-known/openid-configuration')
        ? issuer
        : `${issuer}/.well-known/openid-configuration`;
      const discRes = await fetch(discUrl, { signal: AbortSignal.timeout(4000) });
      if (!discRes.ok) return null;
      const doc = (await discRes.json()) as { userinfo_endpoint?: string };
      if (!doc.userinfo_endpoint) return null;
      userinfoUrl = doc.userinfo_endpoint;
      oidcUserinfoEndpointCache.set(issuer, userinfoUrl);
    }

    const uiRes = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!uiRes.ok) return null;
    const info = (await uiRes.json()) as Record<string, unknown>;
    const groups = Array.isArray(info.groups) ? (info.groups as string[]) : [];
    const isAdmin = groups.some((g) => String(g).toLowerCase().includes('admin'));
    const username = String(info.preferred_username || info.email || info.sub || '').trim();
    if (!username) return null;

    const caller = provisionExternalUser({
      username,
      displayName: String(info.name || username),
      email: String(info.email || ''),
      authentikSub: info.sub ? String(info.sub) : null,
      isAdmin,
      authSource: 'authentik',
    });
    if (!caller) return null;

    authentikTokenCache.set(cacheKey, {
      caller,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return caller;
  } catch {
    return null;
  }
}

async function resolveRequestCaller(
  req: http.IncomingMessage,
  reqUrl: URL,
  settings: AppSettings,
  enforceGate: boolean
): Promise<CallerContext | null> {
  if (!enforceGate) {
    return createLocalOwnerCallerContext();
  }

  const token = extractBearerToken(req, reqUrl);
  if (token) {
    const sessionCaller = resolveSessionToken(token);
    if (sessionCaller) {
      return sessionCaller;
    }

    if (settings.authMode === 'local-pin') {
      const expiresAt = activePinTokens.get(token);
      if (expiresAt && expiresAt > Date.now()) {
        return {
          ...createLocalOwnerCallerContext(),
          authSource: 'local-pin',
        };
      }
      activePinTokens.delete(token);
    }

    if (settings.authMode === 'authentik') {
      const ssoCaller = await resolveAuthentikCaller(token, settings);
      if (ssoCaller) {
        return ssoCaller;
      }
    }
  }

  if (settings.authMode === 'proxy-headers') {
    const headerKey = (settings.trustedProxyHeader || 'X-authentik-username').trim().toLowerCase();
    const headerVal = req.headers[headerKey];
    const rawUser = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const username = typeof rawUser === 'string' ? rawUser.trim() : '';
    if (username) {
      return provisionExternalUser({
        username,
        displayName: username,
        isAdmin: getUserCount() === 0,
        authSource: 'proxy-headers',
      });
    }
  }

  if (settings.allowGuestRoadie && getUserCount() > 0) {
    return createGuestCallerContext();
  }

  if (!settings.authGateEnabled && (settings.authMode === 'standalone' || getUserCount() === 0)) {
    return createLocalOwnerCallerContext();
  }

  if (settings.authGateEnabled && settings.authMode === 'standalone') {
    return createLocalOwnerCallerContext();
  }

  if (settings.authGateEnabled && settings.allowGuestRoadie) {
    return createGuestCallerContext();
  }

  return null;
}

function readJsonBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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

function resolveStaticDistDir(): string {
  const candidates = [
    path.join(process.cwd(), 'dist'),
    path.resolve(getAppPath(), 'dist'),
    path.resolve(__dirname, '..', 'dist'),
    path.resolve(__dirname, '..', '..', 'dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return path.resolve(getAppPath(), 'dist');
}

export function startUnifiedHttpServer(
  options: UnifiedHttpServerOptions
): Promise<{ server: http.Server; port: number }> {
  const {
    port,
    host,
    registry,
    serveStaticDist = false,
    mountMedia = false,
    enforceAuthGate = false,
  } = options;
  const distDir = resolveStaticDistDir();

  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Authorization');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const settings = getSettings();
      const effectiveAppMode = options.appMode || settings.appMode;
      const isServerRole = isServerProfile(effectiveAppMode);
      const reqUrl = new URL(req.url || '/', `http://${host || '127.0.0.1'}:${port}`);
      const reqPath = reqUrl.pathname;

      if (req.method === 'GET' && reqPath === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            mode: effectiveAppMode,
            appMode: effectiveAppMode,
            webUiEnabled: serveStaticDist,
            authGateEnabled: Boolean(settings.authGateEnabled),
            version: '1.0.0',
          })
        );
        return;
      }

      if (req.method === 'GET' && reqPath === '/api/auth/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            serverName: os.hostname(),
            version: '1.0.0',
            serverVersion: '1.0.0',
            appMode: effectiveAppMode,
            needsSetup: isServerRole && getUserCount() === 0,
            authGateEnabled: Boolean(settings.authGateEnabled),
            authMode: settings.authMode,
            allowGuestRoadie: Boolean(settings.allowGuestRoadie),
            authentikIssuerUrl: settings.authMode === 'authentik' ? settings.authentikIssuerUrl : '',
            authentikClientId: settings.authMode === 'authentik' ? settings.authentikClientId : '',
            authentikRedirectUri: settings.authMode === 'authentik' ? settings.authentikRedirectUri : '',
            trustedProxyHeader:
              settings.authMode === 'proxy-headers' ? settings.trustedProxyHeader : '',
          })
        );
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/auth/setup') {
        if (!isServerRole) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Setup is only available on server hosts.' }));
          return;
        }
        if (getUserCount() > 0) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Server master account has already been set up.' }));
          return;
        }
        try {
          const parsed = JSON.parse((await readJsonBody(req)) || '{}') as {
            username?: string;
            displayName?: string;
            email?: string;
            password?: string;
            accessMode?: 'local-accounts' | 'guest-lan' | 'authentik';
            allowGuestRoadie?: boolean;
            authentikIssuerUrl?: string;
            authentikClientId?: string;
            authentikRedirectUri?: string;
          };
          const username = String(parsed.username || '').trim();
          const password = String(parsed.password || '');
          if (!username || password.length < 4) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Username and password (min 4 chars) are required.' }));
            return;
          }
          const user = await createUser({
            username,
            displayName: parsed.displayName?.trim() || username,
            email: parsed.email?.trim() || '',
            password,
            roleNames: ['Label'],
          });
          const chosenMode = parsed.accessMode === 'authentik' ? 'authentik' : 'local-accounts';
          const guestEnabled =
            parsed.accessMode === 'guest-lan' || Boolean(parsed.allowGuestRoadie);
          saveSettings({
            authGateEnabled: true,
            authMode: chosenMode,
            allowGuestRoadie: guestEnabled,
            hasCompletedOnboarding: true,
            ...(parsed.authentikIssuerUrl ? { authentikIssuerUrl: parsed.authentikIssuerUrl } : {}),
            ...(parsed.authentikClientId ? { authentikClientId: parsed.authentikClientId } : {}),
            ...(parsed.authentikRedirectUri ? { authentikRedirectUri: parsed.authentikRedirectUri } : {}),
          });
          const { token, expiresAt } = createSession(user.id, 'local');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              token,
              expiresAt,
              user,
              permissions: user.effectivePermissions,
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/auth/login') {
        try {
          const parsed = JSON.parse((await readJsonBody(req)) || '{}') as {
            username?: string;
            password?: string;
          };
          const result = await authenticateLocalUser(
            String(parsed.username || ''),
            String(parsed.password || '')
          );
          if (!result) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid credentials or suspended account.' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              token: result.token,
              expiresAt: result.expiresAt,
              user: result.user,
              permissions: result.user.effectivePermissions,
            })
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/auth/logout') {
        const token = extractBearerToken(req, reqUrl);
        if (token) {
          revokeSessionToken(token);
          activePinTokens.delete(token);
          authentikTokenCache.delete(hashToken(token));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/auth/reset-with-code') {
        try {
          const parsed = JSON.parse((await readJsonBody(req)) || '{}') as {
            username?: string;
            code?: string;
            newPassword?: string;
          };
          await consumeResetCode(
            String(parsed.username || ''),
            String(parsed.code || ''),
            String(parsed.newPassword || '')
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          const status = err instanceof UnauthorizedError ? 401 : 400;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && reqPath === '/api/auth/pin-login') {
        try {
          const raw = await readJsonBody(req);
          const parsed = JSON.parse(raw || '{}') as { pin?: string };
          const storedHash = getStoredLocalPinHash();
          if (!storedHash || !verifyLocalPin(String(parsed.pin || ''), storedHash)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid PIN.' }));
            return;
          }
          const token = crypto.randomBytes(32).toString('hex');
          activePinTokens.set(token, Date.now() + 30 * 86_400_000);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      const isProtectedEndpoint =
        reqPath === '/api/auth/me' ||
        reqPath === '/rpc' ||
        reqPath === '/events' ||
        reqPath === '/api/upload-files' ||
        reqPath.startsWith('/api/sync/') ||
        reqPath === '/track' ||
        reqPath === '/video' ||
        reqPath === '/artwork' ||
        reqPath === '/api/v1/stream';

      let caller: CallerContext | null = null;
      if (isProtectedEndpoint) {
        caller = await resolveRequestCaller(req, reqUrl, settings, enforceAuthGate);
        if (!caller) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: 'Unauthorized',
              authMode: settings.authMode,
              needsSetup: isServerRole && getUserCount() === 0,
            })
          );
          return;
        }
      }

      if (req.method === 'GET' && reqPath === '/api/auth/me' && caller) {
        const user = caller.userId !== null ? getUserById(caller.userId) : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            user,
            username: caller.username,
            displayName: caller.displayName,
            roles: caller.roles,
            isGuest: caller.isGuest,
            isSuperAdmin: caller.isSuperAdmin,
            authSource: caller.authSource,
            permissions: caller.permissions,
          })
        );
        return;
      }

      if (caller) {
        let handledAsyncStream = false;
        await runWithCallerContext(caller, async () => {
          if (req.method === 'GET' && reqPath === '/api/sync/delta') {
            if (!isServerRole) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Sync endpoints disabled in client mode.' }));
              return;
            }
            if (!caller.isSuperAdmin && caller.permissions.libMusic < 1) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Forbidden: Music library access disabled.' }));
              return;
            }
            const sinceRev = Number(reqUrl.searchParams.get('since_rev')) || 0;
            const limit = Math.min(5000, Math.max(1, Number(reqUrl.searchParams.get('limit')) || 2000));
            const payload = getDeltaSyncBatch(sinceRev, limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
          }

          if (req.method === 'POST' && reqPath === '/api/sync/playback') {
            if (!isServerRole) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Sync endpoints disabled in client mode.' }));
              return;
            }
            if (!caller.isSuperAdmin && caller.permissions.libMusic < 1) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Forbidden: Music library access disabled.' }));
              return;
            }
            try {
              const body = await readJsonBody(req);
              const parsed = JSON.parse(body || '{}') as { updates?: PlaybackDeltaUpdate[] };
              const result = applyPlaybackDeltaSync(Array.isArray(parsed.updates) ? parsed.updates : [], caller);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
            }
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
            if (!caller.isSuperAdmin && caller.permissions.mediaUpload < 1) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Forbidden: Media uploads are disabled for your role.' }));
              return;
            }
            try {
              await handleFileUploadRequest(req, res);
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
            }
            return;
          }

          if (req.method === 'POST' && reqPath === '/rpc') {
            try {
              const body = await readJsonBody(req);
              const { channel, args } = JSON.parse(body || '{}') as { channel: string; args?: unknown[] };
              assertChannelPermission(channel, caller);
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
              const status =
                err instanceof ForbiddenError
                  ? 403
                  : err instanceof UnauthorizedError
                  ? 401
                  : 500;
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
            }
            return;
          }

          if ((reqPath === '/track' || reqPath === '/api/v1/stream') && !caller.isSuperAdmin && caller.permissions.libMusic < 1) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Forbidden: Music streaming is disabled for your role.' }));
            return;
          }

          if (
            reqPath === '/video' &&
            !caller.isSuperAdmin &&
            Math.max(caller.permissions.libMovies, caller.permissions.libTvShows, caller.permissions.libMusicVideos) < 1
          ) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Forbidden: Video streaming is disabled for your role.' }));
            return;
          }

          if (mountMedia && handleMediaHttpRequest(req, res)) {
            handledAsyncStream = true;
            return;
          }
        });
        if (res.writableEnded || handledAsyncStream || reqPath === '/events') {
          return;
        }
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

export async function bootHeadlessServer(): Promise<void> {
  initDatabase();
  ensureRbacSeeded();
  const bootstrappedEnvAdmin = await bootstrapEnvAdminIfNeeded();
  let initialSettings = getSettings();
  if (bootstrappedEnvAdmin && !initialSettings.authGateEnabled && initialSettings.authMode === 'standalone') {
    initialSettings = saveSettings({
      authGateEnabled: true,
      authMode: 'local-accounts',
      hasCompletedOnboarding: true,
    });
  }
  if (!resolveAppMode(initialSettings.appMode).isHeadless) {
    process.env.RTUNES_MODE = 'headless-server';
  }
  const runtime = resolveAppMode(initialSettings.appMode);
  const isServerRole = isServerProfile(runtime.appMode);

  if (isServerRole) {
    applyContainerMediaDefaults();
  }

  const port = runtime.cliPort || Number(initialSettings.lanServerPort) || 3000;
  const host = runtime.cliHost || (runtime.appMode === 'headless-client' ? '127.0.0.1' : '0.0.0.0');
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
    serveStaticDist: runtime.webUiEnabled,
    mountMedia: true,
    appMode: runtime.appMode,
    enforceAuthGate: isServerRole,
  });
  activePort = started.port;

  const shouldAutoOpen =
    runtime.webUiEnabled &&
    runtime.autoOpenBrowserOnHeadless &&
    initialSettings.headlessAutoOpenBrowser !== false;
  if (shouldAutoOpen) {
    const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const browserUrl = `http://${browserHost}:${started.port}`;
    logger.info('SYSTEM', `Auto-launching ${runtime.appMode} Web UI in browser: ${browserUrl}`);
    openExternalUrl(browserUrl);
  }

  reconcileBackgroundWatchers(runtime.appMode);
  setTimeout(() => {
    void runStartupTranscoderCheck(runtime.appMode);
  }, 4000).unref();

  const shutdown = () => {
    stopBackgroundWatchers();
    try {
      started.server.close();
    } catch {
      // ignore
    }
    closeAllDatabases();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (isServerRole) {
    if (hasPendingIndexCheckpoint()) {
      void runLibraryScan(undefined, { resume: true });
    } else if (process.env.RTUNES_MEDIA_DIR) {
      const count = (getDb().prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;
      if (count === 0) {
        void runLibraryScan();
      }
    }
  }
}

if (require.main === module) {
  bootHeadlessServer().catch((err) => {
    logger.error('SYSTEM', 'Fatal rTunes-Server startup failure', err);
    process.exit(1);
  });
}
