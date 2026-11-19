import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

type RendererEventListener = (channel: string, payload: unknown) => void;

const listeners = new Set<RendererEventListener>();
let cachedElectron: any = undefined;

export function isElectronGuiRuntime(): boolean {
  return Boolean(
    process.versions &&
      process.versions.electron &&
      process.env.ELECTRON_RUN_AS_NODE !== '1'
  );
}

function getElectronModule(): any {
  if (!isElectronGuiRuntime()) return null;
  if (cachedElectron !== undefined) return cachedElectron;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron');
    cachedElectron = typeof mod === 'object' && mod !== null ? mod : null;
  } catch {
    cachedElectron = null;
  }
  return cachedElectron;
}

export function emitRendererEvent(channel: string, payload?: unknown): void {
  const electron = getElectronModule();
  if (electron?.BrowserWindow?.getAllWindows) {
    try {
      for (const win of electron.BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents) {
          win.webContents.send(channel, payload);
        }
      }
    } catch {
      // Electron windows may not be initialized yet
    }
  }

  for (const listener of listeners) {
    try {
      listener(channel, payload);
    } catch {
      // ignore listener errors
    }
  }
}

export function onRendererEvent(listener: RendererEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAppDataPath(): string {
  if (process.env.RTUNES_DATA_DIR && process.env.RTUNES_DATA_DIR.trim()) {
    return path.resolve(process.env.RTUNES_DATA_DIR.trim());
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'RetroTunes'
    );
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'RetroTunes');
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'RetroTunes'
  );
}

export function getAppPath(): string {
  const electron = getElectronModule();
  if (electron?.app?.getAppPath) {
    try {
      return electron.app.getAppPath();
    } catch {
      // fall through
    }
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'dist', 'index.html'))) {
    return cwd;
  }
  const candidates = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
  ];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'dist', 'index.html')) ||
      fs.existsSync(path.join(candidate, 'package.json'))
    ) {
      return candidate;
    }
  }
  return cwd;
}

export function isPackaged(): boolean {
  const electron = getElectronModule();
  if (electron?.app && typeof electron.app.isPackaged === 'boolean') {
    return electron.app.isPackaged;
  }
  return process.env.NODE_ENV === 'production';
}

export function getSafeStorage(): {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
} | null {
  const electron = getElectronModule();
  return electron?.safeStorage || null;
}

export function openExternalUrl(url: string): boolean {
  const cleanUrl = (url || '').trim();
  if (!cleanUrl || (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://'))) {
    return false;
  }
  const electron = getElectronModule();
  if (electron?.shell?.openExternal) {
    void electron.shell.openExternal(cleanUrl);
    return true;
  }
  try {
    if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', cleanUrl], { windowsHide: true }, () => {});
      return true;
    }
    if (process.platform === 'darwin') {
      execFile('open', [cleanUrl], () => {});
      return true;
    }
    execFile('xdg-open', [cleanUrl], () => {});
    return true;
  } catch {
    return false;
  }
}
