export type SupportedPlatform = 'darwin' | 'win32' | 'linux';

export interface ShareMountParams {
  protocol: 'nfs' | 'smb';
  host: string;
  exportPath: string;
  mountPoint: string;
  username?: string;
  password?: string;
}

export interface PlatformDriver {
  platform: SupportedPlatform;
  isMacOsStyleMenu: boolean;
  quitOnAllWindowsClosed: boolean;

  // Directories & Sidecars
  getFallbackUserDataDir(): string;
  getDefaultCacheDir(): string;
  getMtpBinaryName(): string;

  // OS Credential / Keychain Store
  setSecret(service: string, account: string, secret: string): boolean;
  getSecret(service: string, account: string): string | null;
  deleteSecret(service: string, account: string): boolean;

  // UMS Volume Operations
  renameVolume(mountPath: string, desiredName: string): Promise<{ ok: boolean; newMountPath: string }>;
  unmountVolume(mountPath: string): Promise<{ ok: boolean; message: string }>;
  cleanOsMetadata(mountPath: string): Promise<number>;
  resizeImageFallback(sourcePath: string, targetPath: string, maxDimension: number): Promise<boolean>;

  // Network Shares (NFS / SMB)
  resolveExistingShareMount(exportPath: string): string | null;
  mountNetworkShare(params: ShareMountParams): Promise<void>;
  unmountNetworkShare(mountPoint: string): Promise<void>;

  // Hardware Transcoding
  getPreferredVideoEncoders(
    mode: 'auto' | 'vt_h264' | 'nvenc' | 'qsv' | 'software',
    availableEncodersOutput: string
  ): string[];

  // OS AutoPlay / Auto-Open on MTP Arrival
  getAutoOpenOnMtp(): Promise<boolean>;
  setAutoOpenOnMtp(enabled: boolean, appLaunchCommand: string): Promise<{ ok: boolean; message: string }>;
}
