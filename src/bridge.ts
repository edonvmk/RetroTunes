import type { RemoteAuthInfo, RolePermissions, UserRecord } from './types';

declare global {
  interface Window {
    electronAPI?: {
      isDev: boolean;
      platform?: NodeJS.Platform;
    };
    rtunesElectron?: {
      isDev?: boolean;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (payload: unknown) => void) => () => void;
    };
  }
}

export function isDevMode(): boolean {
  if (typeof window !== 'undefined' && typeof window.electronAPI?.isDev === 'boolean') {
    return window.electronAPI.isDev;
  }
  return Boolean(import.meta.env?.DEV);
}

export function getRpcBaseUrl(): string {
  if (typeof window !== 'undefined') {
    try {
      const configured = window.localStorage?.getItem('rtunes_server_url')?.trim();
      if (configured) {
        return configured.replace(/\/+$/, '');
      }
    } catch {
      // ignore storage errors
    }
    const { protocol, origin, port } = window.location || {};
    if ((protocol === 'http:' || protocol === 'https:') && port !== '5173') {
      return origin.replace(/\/+$/, '');
    }
  }
  return 'http://127.0.0.1:42815';
}

export function getConfiguredRemoteServerUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage?.getItem('rtunes_server_url')?.trim().replace(/\/+$/, '') || '';
  } catch {
    return '';
  }
}

export function setConfiguredRemoteServerUrl(url: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const cleaned = (url || '').trim().replace(/\/+$/, '');
    if (cleaned) {
      window.localStorage?.setItem('rtunes_server_url', cleaned);
    } else {
      window.localStorage?.removeItem('rtunes_server_url');
    }
  } catch {
    // ignore storage errors
  }
}

export function getStoredAuthToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage?.getItem('rtunes_auth_token')?.trim() || '';
  } catch {
    return '';
  }
}

export function setStoredAuthToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const cleaned = (token || '').trim();
    if (cleaned) {
      window.localStorage?.setItem('rtunes_auth_token', cleaned);
    } else {
      window.localStorage?.removeItem('rtunes_auth_token');
    }
  } catch {
    // ignore storage errors
  }
}

export function appendAuthTokenParam(url: string): string {
  const token = getStoredAuthToken();
  if (!token || !url) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const token = getStoredAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function probeRemoteServerAuth(serverUrl?: string): Promise<RemoteAuthInfo> {
  const base = (serverUrl || getConfiguredRemoteServerUrl() || getRpcBaseUrl()).trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/api/auth/info`);
  if (!res.ok) {
    throw new Error(`Probe failed (HTTP ${res.status})`);
  }
  return (await res.json()) as RemoteAuthInfo;
}

export async function loginWithPin(
  pin: string,
  serverUrl?: string
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const base = (serverUrl || getConfiguredRemoteServerUrl() || getRpcBaseUrl()).trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/api/auth/pin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const json = (await res.json()) as { ok: boolean; token?: string; error?: string };
  if (res.ok && json.ok && json.token) {
    setStoredAuthToken(json.token);
    resetSharedEventSource();
  }
  return json;
}

export async function setupServerMasterAccount(
  payload: {
    username: string;
    displayName?: string;
    email?: string;
    password: string;
    accessMode?: 'local-accounts' | 'guest-lan' | 'authentik';
    allowGuestRoadie?: boolean;
  },
  serverUrl?: string
): Promise<{
  ok: boolean;
  token?: string;
  user?: UserRecord;
  permissions?: RolePermissions;
  error?: string;
}> {
  const base = (serverUrl || getConfiguredRemoteServerUrl() || getRpcBaseUrl()).trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as {
    ok: boolean;
    token?: string;
    user?: UserRecord;
    permissions?: RolePermissions;
    error?: string;
  };
  if (res.ok && json.ok && json.token) {
    setStoredAuthToken(json.token);
    resetSharedEventSource();
  }
  return json;
}

export async function loginWithPassword(
  username: string,
  password: string,
  serverUrl?: string
): Promise<{
  ok: boolean;
  token?: string;
  user?: UserRecord;
  permissions?: RolePermissions;
  error?: string;
}> {
  const base = (serverUrl || getConfiguredRemoteServerUrl() || getRpcBaseUrl()).trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = (await res.json()) as {
    ok: boolean;
    token?: string;
    user?: UserRecord;
    permissions?: RolePermissions;
    error?: string;
  };
  if (res.ok && json.ok && json.token) {
    setStoredAuthToken(json.token);
    resetSharedEventSource();
  }
  return json;
}

export async function resetPasswordWithCode(
  payload: { username: string; code: string; newPassword: string },
  serverUrl?: string
): Promise<{ ok: boolean; error?: string }> {
  const base = (serverUrl || getConfiguredRemoteServerUrl() || getRpcBaseUrl()).trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/api/auth/reset-with-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}

export async function logoutServerSession(serverUrl?: string): Promise<void> {
  const base = (serverUrl || getConfiguredRemoteServerUrl() || getRpcBaseUrl()).trim().replace(/\/+$/, '');
  try {
    await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: buildAuthHeaders(),
    });
  } catch {
    // ignore network errors on logout
  }
  setStoredAuthToken(null);
  resetSharedEventSource();
}

export async function fetchAuthMe(serverUrl?: string): Promise<{
  ok: boolean;
  user: UserRecord | null;
  username: string;
  displayName: string;
  roles: string[];
  isGuest: boolean;
  isSuperAdmin: boolean;
  permissions: RolePermissions;
}> {
  const base = (serverUrl || getConfiguredRemoteServerUrl() || getRpcBaseUrl()).trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/api/auth/me`, { headers: buildAuthHeaders() });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export interface SyncDeltaResponse {
  current_rev: number;
  upserted: any[];
  deleted_uids: string[];
  has_more: boolean;
}

export async function fetchSyncDelta(sinceRev = 0, limit = 2000): Promise<SyncDeltaResponse> {
  const base = getConfiguredRemoteServerUrl() || getRpcBaseUrl();
  const res = await fetch(`${base}/api/sync/delta?since_rev=${sinceRev}&limit=${limit}`, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Delta sync failed (HTTP ${res.status})`);
  }
  return (await res.json()) as SyncDeltaResponse;
}

export async function postPlaybackSync(
  updates: {
    track_uid: string;
    play_count_delta?: number;
    rating?: number;
    loved?: boolean | number;
    last_played_at?: string;
  }[]
): Promise<{ ok: boolean; current_rev: number; applied: number }> {
  const base = getConfiguredRemoteServerUrl() || getRpcBaseUrl();
  const res = await fetch(`${base}/api/sync/playback`, {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) {
    throw new Error(`Playback sync failed (HTTP ${res.status})`);
  }
  return (await res.json()) as { ok: boolean; current_rev: number; applied: number };
}

export function getMediaBaseUrl(mediaPort?: number): string {
  if (typeof window !== 'undefined') {
    try {
      const configured = window.localStorage?.getItem('rtunes_server_url')?.trim();
      if (configured) {
        return configured.replace(/\/+$/, '');
      }
    } catch {
      // ignore storage errors
    }
    const { protocol, hostname, origin, port } = window.location || {};
    if (
      !window.rtunesElectron &&
      (protocol === 'http:' || protocol === 'https:') &&
      port !== '5173'
    ) {
      return origin.replace(/\/+$/, '');
    }
    if (mediaPort && mediaPort > 0) {
      const host = hostname && hostname !== '' ? hostname : '127.0.0.1';
      return `http://${host}:${mediaPort}`;
    }
  }
  return mediaPort && mediaPort > 0 ? `http://127.0.0.1:${mediaPort}` : '';
}

export async function invokeRpc<T = any>(channel: string, ...args: unknown[]): Promise<T> {
  const remoteServerUrl = getConfiguredRemoteServerUrl();
  const routeRemoteUac = Boolean(channel.startsWith('uac:') && remoteServerUrl);
  if (window.rtunesElectron?.invoke && !routeRemoteUac) {
    return (await window.rtunesElectron.invoke(channel, ...args)) as T;
  }

  const baseUrl = routeRemoteUac ? remoteServerUrl : getRpcBaseUrl();
  const res = await fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ channel, args }),
  });
  const json = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
    ok: boolean;
    data?: T;
    error?: string;
    authMode?: string;
  };
  if (res.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rtunes:auth-required', { detail: json }));
  }
  if (!json.ok) {
    throw new Error(json.error || `RPC error on ${channel}`);
  }
  return json.data as T;
}

let sharedEventSource: EventSource | null = null;
const sseListeners = new Map<string, Set<(payload: any) => void>>();
const REMOTE_BRIDGE_SSE_CHANNELS = new Set([
  'uac:approvals-updated',
  'uac:permissions-updated',
  'library:updated',
]);

function ensureSharedEventSource(): void {
  if (sharedEventSource || typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return;
  }
  const remoteUrl = getConfiguredRemoteServerUrl();
  if (window.rtunesElectron && !remoteUrl) {
    return;
  }
  const baseUrl = remoteUrl || getRpcBaseUrl();
  const es = new EventSource(appendAuthTokenParam(`${baseUrl}/events`));
  es.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data) as { channel?: string; payload?: unknown };
      if (!parsed.channel) return;
      const set = sseListeners.get(parsed.channel);
      if (set) {
        for (const fn of set) {
          fn(parsed.payload);
        }
      }
    } catch {
      // ignore malformed event
    }
  };
  es.onerror = () => {
    // EventSource automatically reconnects
  };
  sharedEventSource = es;
}

export function resetSharedEventSource(): void {
  if (sharedEventSource) {
    sharedEventSource.close();
    sharedEventSource = null;
  }
  if (sseListeners.size > 0) {
    ensureSharedEventSource();
  }
}

export function subscribeEvent<T = any>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  const unsubElectron = window.rtunesElectron?.on
    ? window.rtunesElectron.on(channel, (data) => listener(data as T))
    : null;

  if (unsubElectron && (!REMOTE_BRIDGE_SSE_CHANNELS.has(channel) || !getConfiguredRemoteServerUrl())) {
    return unsubElectron;
  }

  ensureSharedEventSource();
  let set = sseListeners.get(channel);
  if (!set) {
    set = new Set();
    sseListeners.set(channel, set);
  }
  set.add(listener);

  return () => {
    unsubElectron?.();
    const currentSet = sseListeners.get(channel);
    if (currentSet) {
      currentSet.delete(listener);
      if (currentSet.size === 0) {
        sseListeners.delete(channel);
      }
    }
  };
}

export function formatDuration(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i >= 2 ? 2 : 0)} ${units[i]}`;
}
