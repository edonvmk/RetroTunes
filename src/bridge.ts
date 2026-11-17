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
  if (window.rtunesElectron?.invoke) {
    return (await window.rtunesElectron.invoke(channel, ...args)) as T;
  }

  const baseUrl = getRpcBaseUrl();
  const res = await fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  });
  const json = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!json.ok) {
    throw new Error(json.error || `RPC error on ${channel}`);
  }
  return json.data as T;
}

let sharedEventSource: EventSource | null = null;
const sseListeners = new Map<string, Set<(payload: any) => void>>();

function ensureSharedEventSource(): void {
  if (sharedEventSource || typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return;
  }
  const baseUrl = getRpcBaseUrl();
  const es = new EventSource(`${baseUrl}/events`);
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

export function subscribeEvent<T = any>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  if (window.rtunesElectron?.on) {
    return window.rtunesElectron.on(channel, (data) => listener(data as T));
  }

  ensureSharedEventSource();
  let set = sseListeners.get(channel);
  if (!set) {
    set = new Set();
    sseListeners.set(channel, set);
  }
  set.add(listener);

  return () => {
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
