declare global {
  interface Window {
    rtunesElectron?: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (payload: unknown) => void) => () => void;
    };
  }
}

export async function invokeRpc<T = any>(channel: string, ...args: unknown[]): Promise<T> {
  if (window.rtunesElectron?.invoke) {
    return (await window.rtunesElectron.invoke(channel, ...args)) as T;
  }

  // Fallback to local diagnostic HTTP RPC bridge (port 42815)
  const res = await fetch('http://127.0.0.1:42815/rpc', {
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

export function subscribeEvent<T = any>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  if (window.rtunesElectron?.on) {
    return window.rtunesElectron.on(channel, (data) => listener(data as T));
  }
  return () => {};
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
