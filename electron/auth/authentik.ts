import {
  AuthState,
  initAuthFromKeychain,
  getPublicAuthState,
  startAuthentikPkceLogin,
  logoutAuthentikSso,
} from '../authOidc';

export type { AuthState };

const STANDALONE_GUEST_STATE: AuthState = {
  authenticated: false,
  mode: 'standalone',
  user: null,
  accessToken: null,
  expiresAt: null,
};

/**
 * Isolated Authentik OIDC / SSO module.
 * In production builds (isDev === false), SSO is gated as "Coming Soon" and
 * always returns a guest/standalone context without invoking OIDC flows.
 */
export function initAuthentikAuth(isDev: boolean): AuthState {
  if (!isDev) {
    return { ...STANDALONE_GUEST_STATE };
  }
  return initAuthFromKeychain();
}

export function getAuthentikAuthState(isDev: boolean): AuthState {
  if (!isDev) {
    return { ...STANDALONE_GUEST_STATE };
  }
  return getPublicAuthState();
}

export async function loginWithAuthentik(isDev: boolean): Promise<AuthState> {
  if (!isDev) {
    return { ...STANDALONE_GUEST_STATE };
  }
  return startAuthentikPkceLogin();
}

export function logoutAuthentik(isDev: boolean): AuthState {
  if (!isDev) {
    return { ...STANDALONE_GUEST_STATE };
  }
  return logoutAuthentikSso();
}
