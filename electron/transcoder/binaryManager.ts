import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app, BrowserWindow } from 'electron';
import { getSettings, saveSettings } from '../settings';
import { platformDriver } from '../platform';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export interface BinaryInfo {
  name: 'ffmpeg' | 'ffprobe' | 'HandBrakeCLI';
  path: string | null;
  present: boolean;
  version: string | null;
  source: 'system' | 'bundled' | 'userData' | 'missing';
}

export interface TranscoderBinaryStatus {
  binDir: string;
  ffmpeg: BinaryInfo;
  ffprobe: BinaryInfo;
  handbrake: BinaryInfo;
  checking: boolean;
  lastCheckedAt: string | null;
  lastMessage: string | null;
}

export interface BinaryProgressEvent {
  running: boolean;
  stage: string;
  percent?: number;
}

let checkingActive = false;
let lastCheckedAt: string | null = null;
let lastMessage: string | null = null;

function getUserDataDir(): string {
  return app?.isReady?.() ? app.getPath('userData') : platformDriver.getFallbackUserDataDir();
}

export function getManagedBinDir(): string {
  return path.join(getUserDataDir(), 'bin');
}

function broadcastBinaryProgress(ev: BinaryProgressEvent) {
  try {
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      if (!win.isDestroyed()) {
        win.webContents.send('transcoder:binaryProgress', ev);
      }
    }
  } catch {
    // ignore in headless CLI mode
  }
}

async function readBinaryVersion(binPath: string, flag: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, [flag], { timeout: 4000 });
    const firstLine = (stdout || stderr || '').split(/\r?\n/)[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

async function findInPath(exeName: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, [exeName], { timeout: 3000 });
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

async function resolveBinary(
  name: 'ffmpeg' | 'ffprobe' | 'HandBrakeCLI',
  configuredPath?: string
): Promise<BinaryInfo> {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const exeName = `${name}${ext}`;
  const managedPath = path.join(getManagedBinDir(), exeName);

  const candidates: { p: string; src: BinaryInfo['source'] }[] = [];
  if (fs.existsSync(managedPath)) candidates.push({ p: managedPath, src: 'userData' });
  if (configuredPath && fs.existsSync(configuredPath)) {
    candidates.push({
      p: configuredPath,
      src: configuredPath.includes('node_modules') ? 'bundled' : 'system',
    });
  }
  const fromPath = await findInPath(exeName);
  if (fromPath) candidates.push({ p: fromPath, src: 'system' });

  for (const c of candidates) {
    if (fs.existsSync(c.p)) {
      const flag = name === 'HandBrakeCLI' ? '--version' : '-version';
      const version = await readBinaryVersion(c.p, flag);
      return { name, path: c.p, present: true, version, source: c.src };
    }
  }

  return { name, path: null, present: false, version: null, source: 'missing' };
}

export async function getTranscoderBinaryStatus(): Promise<TranscoderBinaryStatus> {
  const settings = getSettings();
  const [ffmpeg, ffprobe, handbrake] = await Promise.all([
    resolveBinary('ffmpeg', settings.ffmpegBinaryPath),
    resolveBinary('ffprobe', undefined),
    resolveBinary('HandBrakeCLI', settings.handbrakeBinaryPath),
  ]);

  return {
    binDir: getManagedBinDir(),
    ffmpeg,
    ffprobe,
    handbrake,
    checking: checkingActive,
    lastCheckedAt,
    lastMessage,
  };
}

interface GithubRelease {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
}

async function fetchLatestRelease(repo: string): Promise<GithubRelease | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'RetroTunes/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as GithubRelease;
  } catch {
    return null;
  }
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RetroTunes/1.0' },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

async function extractArchive(archivePath: string, extractDir: string): Promise<boolean> {
  await fsp.mkdir(extractDir, { recursive: true });
  try {
    if (archivePath.endsWith('.zip')) {
      if (process.platform === 'win32') {
        await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
          ],
          { timeout: 60000 }
        );
      } else {
        await execFileAsync('unzip', ['-o', archivePath, '-d', extractDir], { timeout: 60000 });
      }
      return true;
    }
    if (archivePath.endsWith('.tar.xz') || archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir], { timeout: 60000 });
      return true;
    }
  } catch (err) {
    logger.warn('TRANSCODE', `Archive extraction failed for ${archivePath}`, { error: String(err) });
  }
  return false;
}

function findExecutableRecursive(dir: string, targetNames: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (targetNames.includes(ent.name)) {
        found[ent.name] = full;
      }
    }
  };
  walk(dir);
  return found;
}

function pickFfmpegAsset(assets: { name: string; browser_download_url: string }[]) {
  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'winarm64' : 'win64';
    return assets.find((a) => a.name.includes(arch) && a.name.includes('lgpl') && a.name.endsWith('.zip')) ||
      assets.find((a) => a.name.includes(arch) && a.name.endsWith('.zip'));
  }
  if (process.platform === 'linux') {
    const arch = process.arch === 'arm64' ? 'linuxarm64' : 'linux64';
    return assets.find((a) => a.name.includes(arch) && a.name.includes('lgpl') && a.name.endsWith('.tar.xz')) ||
      assets.find((a) => a.name.includes(arch) && a.name.endsWith('.tar.xz'));
  }
  return undefined;
}

function pickHandbrakeAsset(assets: { name: string; browser_download_url: string }[]) {
  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    return assets.find((a) => /HandBrakeCLI/i.test(a.name) && a.name.includes('win') && a.name.includes(arch) && a.name.endsWith('.zip')) ||
      assets.find((a) => /HandBrakeCLI/i.test(a.name) && a.name.includes('win') && a.name.endsWith('.zip'));
  }
  if (process.platform === 'darwin') {
    return assets.find((a) => /HandBrakeCLI/i.test(a.name) && (a.name.endsWith('.dmg') || a.name.endsWith('.zip')));
  }
  return undefined;
}

export async function checkAndUpdateTranscoderBinaries(options?: {
  forceDownload?: boolean;
  autoDownload?: boolean;
}): Promise<TranscoderBinaryStatus> {
  if (checkingActive) {
    return getTranscoderBinaryStatus();
  }
  checkingActive = true;
  const binDir = getManagedBinDir();
  await fsp.mkdir(binDir, { recursive: true });

  try {
    const statusBefore = await getTranscoderBinaryStatus();
    const force = Boolean(options?.forceDownload);
    const autoDownload = options?.autoDownload !== false;

    const ext = process.platform === 'win32' ? '.exe' : '';
    const needFfmpeg = force || !statusBefore.ffmpeg.present || !statusBefore.ffprobe.present;
    const needHandbrake = force || !statusBefore.handbrake.present;

    if (!needFfmpeg && !needHandbrake && !force) {
      lastCheckedAt = new Date().toISOString();
      lastMessage = 'FFmpeg & HandBrakeCLI verified.';
      return statusBefore;
    }

    const updatedSettings = { ...getSettings() };
    let changed = false;

    if (autoDownload && needFfmpeg) {
      broadcastBinaryProgress({ running: true, stage: 'Checking FFmpeg release on GitHub...', percent: 15 });
      const rel = await fetchLatestRelease('BtbN/FFmpeg-Builds');
      const asset = rel?.assets ? pickFfmpegAsset(rel.assets) : undefined;
      if (asset) {
        const tmpArchive = path.join(binDir, `_tmp_${asset.name}`);
        const tmpExtract = path.join(binDir, `_tmp_ffmpeg_extract`);
        broadcastBinaryProgress({ running: true, stage: `Downloading ${asset.name}...`, percent: 35 });
        if (await downloadFile(asset.browser_download_url, tmpArchive)) {
          broadcastBinaryProgress({ running: true, stage: 'Extracting FFmpeg & FFprobe...', percent: 65 });
          if (await extractArchive(tmpArchive, tmpExtract)) {
            const exes = findExecutableRecursive(tmpExtract, [`ffmpeg${ext}`, `ffprobe${ext}`]);
            for (const exeName of [`ffmpeg${ext}`, `ffprobe${ext}`]) {
              if (exes[exeName]) {
                const dest = path.join(binDir, exeName);
                await fsp.copyFile(exes[exeName], dest);
                if (process.platform !== 'win32') await fsp.chmod(dest, 0o755);
              }
            }
            const installedFfmpeg = path.join(binDir, `ffmpeg${ext}`);
            if (fs.existsSync(installedFfmpeg)) {
              updatedSettings.ffmpegBinaryPath = installedFfmpeg;
              changed = true;
              logger.info('TRANSCODE', `Installed FFmpeg (${rel?.tag_name || 'latest'}) to ${installedFfmpeg}`);
            }
          }
        }
        await fsp.rm(tmpArchive, { force: true }).catch(() => {});
        await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (autoDownload && needHandbrake) {
      broadcastBinaryProgress({ running: true, stage: 'Checking HandBrakeCLI release on GitHub...', percent: 75 });
      const rel = await fetchLatestRelease('HandBrake/HandBrake');
      const asset = rel?.assets ? pickHandbrakeAsset(rel.assets) : undefined;
      if (asset && asset.name.endsWith('.zip')) {
        const tmpArchive = path.join(binDir, `_tmp_${asset.name}`);
        const tmpExtract = path.join(binDir, `_tmp_hb_extract`);
        broadcastBinaryProgress({ running: true, stage: `Downloading ${asset.name}...`, percent: 85 });
        if (await downloadFile(asset.browser_download_url, tmpArchive)) {
          if (await extractArchive(tmpArchive, tmpExtract)) {
            const exes = findExecutableRecursive(tmpExtract, [`HandBrakeCLI${ext}`]);
            if (exes[`HandBrakeCLI${ext}`]) {
              const dest = path.join(binDir, `HandBrakeCLI${ext}`);
              await fsp.copyFile(exes[`HandBrakeCLI${ext}`], dest);
              if (process.platform !== 'win32') await fsp.chmod(dest, 0o755);
              updatedSettings.handbrakeBinaryPath = dest;
              changed = true;
              logger.info('TRANSCODE', `Installed HandBrakeCLI (${rel?.tag_name || 'latest'}) to ${dest}`);
            }
          }
        }
        await fsp.rm(tmpArchive, { force: true }).catch(() => {});
        await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (changed) {
      saveSettings(updatedSettings);
    }

    lastCheckedAt = new Date().toISOString();
    lastMessage = 'Transcoder binary check completed.';
    broadcastBinaryProgress({ running: false, stage: lastMessage, percent: 100 });
    return getTranscoderBinaryStatus();
  } catch (err) {
    lastCheckedAt = new Date().toISOString();
    lastMessage = `Binary check error: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn('TRANSCODE', lastMessage);
    broadcastBinaryProgress({ running: false, stage: lastMessage });
    return getTranscoderBinaryStatus();
  } finally {
    checkingActive = false;
  }
}
