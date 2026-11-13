import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { safeStorage } from 'electron';
import { PlatformDriver, ShareMountParams } from './types';

const execFileAsync = promisify(execFile);

function getFallbackSecretPath(service: string, account: string): string {
  const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'RetroTunes', 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${service}_${account}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(dir, `${safeName}.bin`);
}

export const win32Driver: PlatformDriver = {
  platform: 'win32',
  isMacOsStyleMenu: false,
  quitOnAllWindowsClosed: true,

  getFallbackUserDataDir() {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'RetroTunes');
  },

  getDefaultCacheDir() {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'RetroTunes',
      'Cache'
    );
  },

  getMtpBinaryName() {
    return 'rtunes-mtp.exe';
  },

  setSecret(service: string, account: string, secret: string): boolean {
    try {
      const secretFile = getFallbackSecretPath(service, account);
      if (!secret) {
        return this.deleteSecret(service, account);
      }
      if (safeStorage?.isEncryptionAvailable?.()) {
        fs.writeFileSync(secretFile, safeStorage.encryptString(secret));
        return true;
      }
      fs.writeFileSync(secretFile, Buffer.from(secret, 'utf8'));
      return true;
    } catch {
      return false;
    }
  },

  getSecret(service: string, account: string): string | null {
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
      const secretFile = getFallbackSecretPath(service, account);
      if (fs.existsSync(secretFile)) fs.unlinkSync(secretFile);
      return true;
    } catch {
      return false;
    }
  },

  async renameVolume(mountPath: string, desiredName: string) {
    const driveMatch = /^([A-Za-z]):/.exec(mountPath);
    if (!driveMatch) return { ok: false, newMountPath: mountPath };
    const driveLetter = driveMatch[1].toUpperCase();
    const cleanName = desiredName.trim().replace(/[/\\:*?"<>|]/g, '-').slice(0, 32);
    if (!cleanName) return { ok: false, newMountPath: mountPath };

    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Set-Volume -DriveLetter '${driveLetter}' -NewFileSystemLabel '${cleanName.replace(/'/g, "''")}'`,
        ],
        { timeout: 10000 }
      );
      return { ok: true, newMountPath: mountPath };
    } catch {
      return { ok: false, newMountPath: mountPath };
    }
  },

  async unmountVolume(mountPath: string) {
    const driveMatch = /^([A-Za-z]):/.exec(mountPath);
    if (!driveMatch) return { ok: false, message: 'Invalid Windows drive path.' };
    const driveLetter = driveMatch[1].toUpperCase();
    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$vol = New-Object -ComObject Shell.Application; $vol.Namespace(17).ParseName('${driveLetter}:').InvokeVerb('Eject')`,
        ],
        { timeout: 10000 }
      );
      return { ok: true, message: `Safely ejected ${driveLetter}:.` };
    } catch (err) {
      return {
        ok: false,
        message: `Could not eject drive ${driveLetter}: (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  },

  async cleanOsMetadata(mountPath: string): Promise<number> {
    let cleaned = 0;
    const trashNames = new Set(['Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information']);
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (trashNames.has(ent.name)) {
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
    if (/^[A-Za-z]:\\/.test(exportPath) || exportPath.startsWith('\\\\')) {
      if (fs.existsSync(exportPath)) return exportPath;
    }
    return null;
  },

  async mountNetworkShare(params: ShareMountParams): Promise<void> {
    const cleanShare = params.exportPath.replace(/^[/\\]+/, '').replace(/\//g, '\\');
    const uncPath = `\\\\${params.host}\\${cleanShare}`;
    if (params.protocol === 'smb') {
      const cmd = params.username
        ? `New-SmbMapping -RemotePath '${uncPath}' -UserName '${params.username.replace(/'/g, "''")}' -Password '${(params.password || '').replace(/'/g, "''")}' -Persistent $false`
        : `New-SmbMapping -RemotePath '${uncPath}' -Persistent $false`;
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 15000 });
      return;
    }
    await execFileAsync('mount.exe', ['-o', 'anon', `${params.host}:${params.exportPath}`, '*'], {
      timeout: 15000,
    });
  },

  async unmountNetworkShare(mountPoint: string): Promise<void> {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Remove-SmbMapping -RemotePath '${mountPoint.replace(/'/g, "''")}' -Force`],
      { timeout: 8000 }
    ).catch(() => {});
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
    if (mode === 'auto' && availableEncodersOutput.includes('h264_amf')) {
      order.push('h264_amf');
    }
    order.push('libx264');
    return order;
  },
};
