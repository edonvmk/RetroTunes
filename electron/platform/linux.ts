import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { safeStorage } from 'electron';
import { PlatformDriver, ShareMountParams } from './types';

const execFileAsync = promisify(execFile);

function getFallbackSecretPath(service: string, account: string): string {
  const dir = path.join(os.homedir(), '.config', 'RetroTunes', 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${service}_${account}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(dir, `${safeName}.bin`);
}

export const linuxDriver: PlatformDriver = {
  platform: 'linux',
  isMacOsStyleMenu: false,
  quitOnAllWindowsClosed: true,

  getFallbackUserDataDir() {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'RetroTunes');
  },

  getDefaultCacheDir() {
    return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'RetroTunes');
  },

  getMtpBinaryName() {
    return 'rtunes-mtp';
  },

  setSecret(service: string, account: string, secret: string): boolean {
    if (!secret) {
      return this.deleteSecret(service, account);
    }
    try {
      execFileSync(
        'secret-tool',
        ['store', `--label=${service}:${account}`, 'service', service, 'account', account],
        { input: secret, stdio: ['pipe', 'ignore', 'ignore'] }
      );
      return true;
    } catch {
      try {
        const secretFile = getFallbackSecretPath(service, account);
        if (safeStorage?.isEncryptionAvailable?.()) {
          fs.writeFileSync(secretFile, safeStorage.encryptString(secret));
        } else {
          fs.writeFileSync(secretFile, Buffer.from(secret, 'utf8'), { mode: 0o600 });
        }
        return true;
      } catch {
        return false;
      }
    }
  },

  getSecret(service: string, account: string): string | null {
    try {
      const out = execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out.trim()) return out.trim();
    } catch {
      // fall through
    }
    try {
      const secretFile = getFallbackSecretPath(service, account);
      if (!fs.existsSync(secretFile)) return null;
      const buf = fs.readFileSync(secretFile);
      if (safeStorage?.isEncryptionAvailable?.()) {
        return safeStorage.decryptString(buf);
      }
      return buf.toString('utf8');
    } catch {
      return null;
    }
  },

  deleteSecret(service: string, account: string): boolean {
    try {
      execFileSync('secret-tool', ['clear', 'service', service, 'account', account], { stdio: 'ignore' });
    } catch {
      // ignore
    }
    try {
      const secretFile = getFallbackSecretPath(service, account);
      if (fs.existsSync(secretFile)) fs.unlinkSync(secretFile);
      return true;
    } catch {
      return false;
    }
  },

  async renameVolume(mountPath: string) {
    return { ok: false, newMountPath: mountPath };
  },

  async unmountVolume(mountPath: string) {
    try {
      await execFileAsync('udisksctl', ['unmount', '-p', mountPath], { timeout: 8000 });
      return { ok: true, message: `Safely unmounted ${mountPath}.` };
    } catch {
      try {
        await execFileAsync('umount', [mountPath], { timeout: 8000 });
        return { ok: true, message: `Safely unmounted ${mountPath}.` };
      } catch (err) {
        return {
          ok: false,
          message: `Could not unmount volume: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  },

  async cleanOsMetadata(mountPath: string): Promise<number> {
    let cleaned = 0;
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.name.startsWith('.Trash-')) {
          try {
            await fsp.rm(full, { recursive: true, force: true });
            cleaned++;
          } catch {
            // ignore
          }
        } else if (ent.isDirectory()) {
          await walk(full);
        }
      }
    };
    await walk(mountPath);
    return cleaned;
  },

  async resizeImageFallback(): Promise<boolean> {
    return false;
  },

  resolveExistingShareMount(exportPath: string): string | null {
    if ((exportPath.startsWith('/mnt/') || exportPath.startsWith('/media/') || exportPath.startsWith('/run/media/')) && fs.existsSync(exportPath)) {
      return exportPath;
    }
    return null;
  },

  async mountNetworkShare(params: ShareMountParams): Promise<void> {
    if (params.protocol === 'smb') {
      const cleanShare = params.exportPath.replace(/^\/+/, '');
      const smbUrl = `smb://${params.host}/${cleanShare}`;
      await execFileAsync('gio', ['mount', smbUrl], { timeout: 15000 });
      return;
    }
    const cleanExport = params.exportPath.startsWith('/') ? params.exportPath : `/${params.exportPath}`;
    await execFileAsync('mount', ['-t', 'nfs', `${params.host}:${cleanExport}`, params.mountPoint], {
      timeout: 15000,
    });
  },

  async unmountNetworkShare(mountPoint: string): Promise<void> {
    await execFileAsync('umount', [mountPoint], { timeout: 8000 }).catch(() => {});
  },

  getPreferredVideoEncoders(mode, availableEncodersOutput) {
    if (mode === 'software') return ['libx264'];
    const order: string[] = [];
    if ((mode === 'auto' || mode === 'nvenc') && availableEncodersOutput.includes('h264_nvenc')) {
      order.push('h264_nvenc');
    }
    if ((mode === 'auto' || mode === 'qsv') && availableEncodersOutput.includes('h264_qsv')) {
      order.push('h264_qsv');
    }
    if (mode === 'auto' && availableEncodersOutput.includes('h264_vaapi')) {
      order.push('h264_vaapi');
    }
    order.push('libx264');
    return order;
  },

  async getAutoOpenOnMtp(): Promise<boolean> {
    return false;
  },

  async setAutoOpenOnMtp(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'Windows AutoPlay registration is only supported on Windows.' };
  },
};
