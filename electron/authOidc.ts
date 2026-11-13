import http from 'http';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { BrowserWindow, shell } from 'electron';
import { getSettings } from './settings';
import { logger } from './logger';
import { platformDriver } from './platform';

export interface SsoUserProfile {
  sub: string;
  username: string;
  name: string;
  email: string;
  groups: string[];
  isAdmin: boolean;
}

export interface AuthState {
  authenticated: boolean;
  mode: 'standalone' | 'authentik';
  user: SsoUserProfile | null;
  accessToken: string | null;
  expiresAt: number | null;
}

const KEYCHAIN_SERVICE = 'com.retrotunes.epodsuite.oidc';

let currentAuthState: AuthState = {
  authenticated: false,
  mode: 'standalone',
  user: null,
  accessToken: null,
  expiresAt: null,
};

let activeCallbackServer: http.Server | null = null;

function saveOidcSessionToKeychain(sessionJson: string) {
  platformDriver.setSecret(KEYCHAIN_SERVICE, 'oidc_session', sessionJson);
}

function loadOidcSessionFromKeychain(): string | null {
  return platformDriver.getSecret(KEYCHAIN_SERVICE, 'oidc_session');
}

function deleteOidcSessionFromKeychain() {
  platformDriver.deleteSecret(KEYCHAIN_SERVICE, 'oidc_session');
}

function broadcastAuthState() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('auth:state', getPublicAuthState());
      }
    }
  } catch {
    // ignore
  }
}

export function initAuthFromKeychain(): AuthState {
  const settings = getSettings();
  currentAuthState.mode = settings.authMode;
  const raw = loadOidcSessionFromKeychain();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AuthState;
      if (parsed.authenticated && parsed.user) {
        currentAuthState = {
          ...parsed,
          mode: settings.authMode,
        };
        logger.info('AUTH_OIDC', `Restored Authentik SSO session from macOS Keychain for ${parsed.user.username}`);
      }
    } catch {
      // ignore
    }
  }
  return getPublicAuthState();
}

export function getAuthState(): AuthState {
  return currentAuthState;
}

export function getPublicAuthState(): AuthState {
  const settings = getSettings();
  return {
    ...currentAuthState,
    mode: settings.authMode,
    accessToken: currentAuthState.accessToken ? '[PRESENT]' : null,
  };
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Initiates the OAuth2 PKCE flow against the user's configured Authentik Issuer URL (Section 2).
 */
export async function startAuthentikPkceLogin(): Promise<AuthState> {
  const settings = getSettings();
  const issuer = settings.authentikIssuerUrl.trim().replace(/\/+$/, '');
  const clientId = settings.authentikClientId.trim();
  const redirectUri = settings.authentikRedirectUri.trim() || 'http://127.0.0.1:42813/callback';

  if (!issuer || !clientId) {
    throw new Error('Authentik Issuer URL and Client ID must be configured in Preferences -> Authentication.');
  }

  const discoveryUrl = issuer.endsWith('.well-known/openid-configuration')
    ? issuer
    : `${issuer}/.well-known/openid-configuration`;

  logger.info('AUTH_OIDC', `Starting Authentik OIDC PKCE login discovery at ${discoveryUrl}`);

  const discRes = await fetch(discoveryUrl, { headers: { Accept: 'application/json' } });
  if (!discRes.ok) {
    throw new Error(`Failed to fetch OIDC discovery document (HTTP ${discRes.status})`);
  }

  const oidcConfig = (await discRes.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint?: string;
  };

  if (!oidcConfig.authorization_endpoint || !oidcConfig.token_endpoint) {
    throw new Error('OIDC discovery response is missing authorization_endpoint or token_endpoint.');
  }

  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64UrlEncode(crypto.randomBytes(16));

  const parsedRedirect = new URL(redirectUri);
  const listenPort = Number(parsedRedirect.port) || 42813;

  if (activeCallbackServer) {
    try {
      activeCallbackServer.close();
    } catch {
      // ignore
    }
    activeCallbackServer = null;
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${listenPort}`);
        if (reqUrl.pathname !== parsedRedirect.pathname) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const errorParam = reqUrl.searchParams.get('error');

        if (errorParam) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="font-family:sans-serif;padding:30px;"><h2>Authentik SSO Error: ${errorParam}</h2><p>You may close this window.</p></body></html>`);
          server.close();
          reject(new Error(`Authentik OAuth error: ${errorParam}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body>Invalid OAuth callback state or missing code.</body></html>');
          server.close();
          reject(new Error('Invalid OAuth state or missing authorization code.'));
          return;
        }

        // Exchange authorization code for tokens using PKCE code_verifier
        const bodyParams = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        });

        const tokenRes = await fetch(oidcConfig.token_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: bodyParams.toString(),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${errText}`);
        }

        const tokenData = (await tokenRes.json()) as {
          access_token: string;
          refresh_token?: string;
          id_token?: string;
          expires_in?: number;
        };

        let userInfo: Record<string, unknown> = {};
        if (oidcConfig.userinfo_endpoint) {
          const uiRes = await fetch(oidcConfig.userinfo_endpoint, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (uiRes.ok) {
            userInfo = (await uiRes.json()) as Record<string, unknown>;
          }
        } else if (tokenData.id_token) {
          // Decode JWT payload
          const parts = tokenData.id_token.split('.');
          if (parts.length >= 2) {
            userInfo = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          }
        }

        const groups = Array.isArray(userInfo.groups)
          ? (userInfo.groups as string[])
          : [];
        const profile: SsoUserProfile = {
          sub: String(userInfo.sub || 'user'),
          username: String(userInfo.preferred_username || userInfo.name || userInfo.email || 'authentik_user'),
          name: String(userInfo.name || userInfo.preferred_username || 'Authentik User'),
          email: String(userInfo.email || ''),
          groups,
          isAdmin: groups.some((g) => g.toLowerCase().includes('admin')),
        };

        currentAuthState = {
          authenticated: true,
          mode: 'authentik',
          user: profile,
          accessToken: tokenData.access_token,
          expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
        };

        saveOidcSessionToKeychain(JSON.stringify(currentAuthState));
        broadcastAuthState();

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family:'Lucida Grande',sans-serif;background:#d6dde5;text-align:center;padding:40px;">
              <div style="background:#fff;border:1px solid #888;border-radius:8px;padding:24px;max-width:420px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.2);">
                <h2 style="margin-top:0;color:#1d4ed8;">RetroTunes (rTunes) SSO Complete</h2>
                <p>Signed in as <strong>${profile.name} (@${profile.username})</strong>.</p>
                <p style="font-size:12px;color:#555;">You may close this browser tab and return to RetroTunes.</p>
              </div>
            </body>
          </html>
        `);

        logger.info('AUTH_OIDC', `Authentik OIDC PKCE login succeeded for ${profile.username}`, {
          groups: profile.groups,
          isAdmin: profile.isAdmin,
        });

        server.close();
        activeCallbackServer = null;
        resolve(getPublicAuthState());
      } catch (err) {
        server.close();
        activeCallbackServer = null;
        logger.error('AUTH_OIDC', 'Authentik OIDC callback processing failed', err);
        reject(err);
      }
    });

    activeCallbackServer = server;
    server.listen(listenPort, '127.0.0.1', () => {
      const authUrl = new URL(oidcConfig.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'openid profile email groups');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      logger.info('AUTH_OIDC', `Opening Authentik authorization URL on loopback port ${listenPort}`, {
        url: authUrl.toString(),
      });
      void shell.openExternal(authUrl.toString());
    });
  });
}

export function logoutAuthentikSso(): AuthState {
  deleteOidcSessionFromKeychain();
  currentAuthState = {
    authenticated: false,
    mode: getSettings().authMode,
    user: null,
    accessToken: null,
    expiresAt: null,
  };
  logger.info('AUTH_OIDC', 'Logged out of Authentik SSO and cleared Keychain tokens.');
  broadcastAuthState();
  return getPublicAuthState();
}
