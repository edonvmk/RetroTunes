import {
  AuthState,
  initAuthFromKeychain,
  getPublicAuthState,
  startAuthentikPkceLogin,
  logoutAuthentikSso,
} from '../authOidc';

export type { AuthState };

/**
 * Authentik OIDC / SSO gateway boundary.
 */
export function initAuthentikAuth(_isDev = true): AuthState {
  return initAuthFromKeychain();
}

export function getAuthentikAuthState(_isDev = true): AuthState {
  return getPublicAuthState();
}

export async function loginWithAuthentik(_isDev = true): Promise<AuthState> {
  return startAuthentikPkceLogin();
}

export function logoutAuthentik(_isDev = true): AuthState {
  return logoutAuthentikSso();
}
