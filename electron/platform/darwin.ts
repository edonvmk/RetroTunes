import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { PlatformDriver, ShareMountParams } from './types';

const execFileAsync = promisify(execFile);

function isDirNonEmpty(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

export const darwinDriver: PlatformDriver = {
  platform: 'darwin',
  credentialStoreLabel: 'macOS Keychain',
  isMacOsStyleMenu: true,
  quitOnAllWindowsClosed: false,

  getDefaultCacheDir() {
    return path.join(os.homedir(), 'Library', 'Caches', 'RetroTunes');
  },

  getMtpBinaryName() {
    return 'rtunes-mtp';
  },

  setSecret(service: string, account: string, secret: string): boolean {
    try {
      if (!secret) {
        return this.deleteSecret(service, account);
      }
      execFileSync(
        '/usr/bin/security',
        ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret],
        { stdio: 'ignore' }
      );
      return true;
    } catch {
      return false;
    }
  },

  getSecret(service: string, account: string): string | null {
    try {
      const out = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return out.trim();
    } catch {
      return null;
    }
  },

  deleteSecret(service: string, account: string): boolean {
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  },

  async renameVolume(mountPath: string, desiredName: string) {
    if (!mountPath.startsWith('/Volumes/') || !fs.existsSync(mountPath)) {
      return { ok: false, newMountPath: mountPath };
    }
    let isFat32 = false;
    try {
      const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['info', mountPath], {
        timeout: 6000,
      });
      if (/MS-DOS|FAT32|FAT16/i.test(stdout) && !/exFAT/i.test(stdout)) {
        isFat32 = true;
      }
    } catch {
      // ignore
    }

    const cleanVolName = isFat32
      ? desiredName
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9 _-]/g, '')
          .slice(0, 11)
          .trim()
      : desiredName
          .trim()
          .replace(/[/\\:*?"<>|]/g, '-')
          .slice(0, 27);

    if (!cleanVolName) {
      return { ok: false, newMountPath: mountPath };
    }

    await execFileAsync('/usr/sbin/diskutil', ['rename', mountPath, cleanVolName], {
      timeout: 10000,
    });
    const candidateNewMount = path.join('/Volumes', cleanVolName);
    return {
      ok: true,
      newMountPath: fs.existsSync(candidateNewMount) ? candidateNewMount : mountPath,
    };
  },

  async unmountVolume(mountPath: string) {
    if (!mountPath.startsWith('/Volumes/') || !fs.existsSync(mountPath)) {
      return { ok: true, message: 'Volume is already unmounted.' };
    }
    try {
      await execFileAsync('/usr/sbin/diskutil', ['unmount', mountPath], { timeout: 8000 });
      return { ok: true, message: `Safely unmounted ${mountPath}.` };
    } catch {
      try {
        await execFileAsync('/usr/sbin/diskutil', ['unmount', 'force', mountPath], {
          timeout: 8000,
        });
        return { ok: true, message: `Force-unmounted ${mountPath}.` };
      } catch (err) {
        return {
          ok: false,
          message: `Could not unmount OS volume: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  },

  async cleanOsMetadata(mountPath: string): Promise<number> {
    let cleaned = 0;
    if (fs.existsSync('/usr/sbin/dot_clean')) {
      try {
        await execFileAsync('/usr/sbin/dot_clean', ['-m', mountPath], { timeout: 10000 });
      } catch {
        // ignore
      }
    }

    const trashNames = new Set(['.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd']);
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (trashNames.has(ent.name) || ent.name.startsWith('._')) {
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

  async resizeImageFallback(sourcePath: string, targetPath: string, maxDimension: number): Promise<boolean> {
    try {
      await fsp.copyFile(sourcePath, targetPath);
      await execFileAsync('/usr/bin/sips', ['-Z', String(maxDimension), '-s', 'format', 'jpeg', targetPath], {
        timeout: 8000,
      });
      return true;
    } catch {
      return false;
    }
  },

  resolveExistingShareMount(exportPath: string, host?: string): string | null {
    if (exportPath.startsWith('/Volumes/') && fs.existsSync(exportPath) && isDirNonEmpty(exportPath)) {
      return exportPath;
    }
    const baseSegment = path.basename(exportPath.replace(/\/+$/, ''));
    if (baseSegment) {
      const candidate = path.join('/Volumes', baseSegment);
      if (fs.existsSync(candidate) && isDirNonEmpty(candidate)) {
        return candidate;
      }
    }
    if (host) {
      try {
        const mountOut = execFileSync('/sbin/mount', [], { encoding: 'utf8' });
        const escapedHost = host.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lines = mountOut.split(/\r?\n/);
        for (const line of lines) {
          if (new RegExp(`[@/]${escapedHost}[/:]`, 'i').test(line)) {
            const m = /\son\s+(\/Volumes\/[^\s(]+(?:\s+[^\s(]+)*)\s+\(/.exec(line);
            if (m && m[1] && fs.existsSync(m[1]) && isDirNonEmpty(m[1])) {
              return m[1];
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return null;
  },

  async discoverHostShares(params): Promise<string[]> {
    const cleanHost = params.host.trim();
    if (!cleanHost) return [];
    if (params.protocol === 'nfs') {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/showmount', ['-e', cleanHost], {
          timeout: 8000,
        });
        return stdout
          .split(/\r?\n/)
          .slice(1)
          .map((l) => l.trim().split(/\s+/)[0])
          .filter(Boolean);
      } catch {
        return [];
      }
    }
    try {
      const authPart = params.username
        ? params.password
          ? `${encodeURIComponent(params.username)}:${encodeURIComponent(params.password)}@`
          : `${encodeURIComponent(params.username)}@`
        : 'guest@';
      const { stdout } = await execFileAsync('smbutil', ['view', `//${authPart}${cleanHost}`], {
        timeout: 8000,
      });
      const shares: string[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+Disk\b/i.exec(line.trim());
        if (match && match[1] && !match[1].endsWith('$')) {
          shares.push(match[1]);
        }
      }
      return shares;
    } catch {
      return [];
    }
  },

  async mountNetworkShare(params: ShareMountParams): Promise<void> {
    if (params.protocol === 'nfs') {
      const cleanExport = params.exportPath.startsWith('/') ? params.exportPath : `/${params.exportPath}`;
      await execFileAsync(
        '/sbin/mount_nfs',
        ['-o', 'resvport,nolocks,locallocks,soft,intr,rdirplus', `${params.host}:${cleanExport}`, params.mountPoint],
        { timeout: 15000 }
      );
      return;
    }

    const encodeSmbComp = (s: string) =>
      encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

    const tryMountSmbShare = async (shareName: string) => {
      const cleanShare = shareName.replace(/^\/+/, '');
      const authPart = params.username
        ? params.password
          ? `${encodeSmbComp(params.username)}:${encodeSmbComp(params.password)}@`
          : `${encodeSmbComp(params.username)}@`
        : 'guest@';
      const smbUrl = `//${authPart}${params.host}/${cleanShare}`;
      await execFileAsync('/sbin/mount_smbfs', ['-N', smbUrl, params.mountPoint], { timeout: 15000 });
    };

    try {
      await tryMountSmbShare(params.exportPath);
    } catch (firstErr) {
      const discovered = await this.discoverHostShares({
        protocol: 'smb',
        host: params.host,
        username: params.username,
        password: params.password,
      });
      const requested = params.exportPath.replace(/^\/+/, '').toLowerCase();
      const fallbackShare =
        discovered.find((s) => s.toLowerCase() === requested) ||
        discovered.find((s) => s.toLowerCase().includes('media')) ||
        (discovered.length === 1 ? discovered[0] : undefined);

      if (fallbackShare && fallbackShare.toLowerCase() !== requested) {
        await tryMountSmbShare(fallbackShare);
        return;
      }
      if (discovered.length > 0) {
        throw new Error(
          `Share "${params.exportPath}" was not found on ${params.host}. Available shares on this server: ${discovered.join(', ')}`
        );
      }
      throw firstErr;
    }
  },

  async unmountNetworkShare(mountPoint: string): Promise<void> {
    try {
      await execFileAsync('/sbin/umount', [mountPoint], { timeout: 8000 });
    } catch {
      await execFileAsync('/usr/sbin/diskutil', ['unmount', mountPoint], { timeout: 8000 }).catch(() => {});
    }
  },

  getPreferredVideoEncoders(mode, availableEncodersOutput) {
    if (mode === 'software') return ['libx264'];
    if ((mode === 'auto' || mode === 'vt_h264') && availableEncodersOutput.includes('h264_videotoolbox')) {
      return ['h264_videotoolbox', 'libx264'];
    }
    return ['libx264'];
  },

  async getAutoOpenOnMtp(): Promise<boolean> {
    return false;
  },

  async setAutoOpenOnMtp(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'Windows AutoPlay registration is only supported on Windows.' };
  },
};
