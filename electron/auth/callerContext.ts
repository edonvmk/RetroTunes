import { AsyncLocalStorage } from 'async_hooks';

export type LibraryPermLevel = 0 | 1 | 2;
export type FeaturePermLevel = 0 | 1 | 2;
export type SwitchPerm = 0 | 1;

export interface RolePermissions {
  libMusic: LibraryPermLevel;
  libMovies: LibraryPermLevel;
  libTvShows: LibraryPermLevel;
  libMusicVideos: LibraryPermLevel;
  libBooks: LibraryPermLevel;
  libAudiobooks: LibraryPermLevel;
  libPhotos: LibraryPermLevel;
  featEgenius: FeaturePermLevel;
  featGenreMap: FeaturePermLevel;
  featDevicesSync: SwitchPerm;
  localCacheTier: 0 | 1 | 2;
  localCacheLimitMb: number;
  mediaUpload: 0 | 1 | 2;
  storeRequest: 0 | 1 | 2;
  playlists: 0 | 1 | 2;
  approveUploads: SwitchPerm;
  approveStore: SwitchPerm;
  rescanLibrary: SwitchPerm;
  rebuildDb: SwitchPerm;
  manageApiKeys: SwitchPerm;
  viewServerLogs: SwitchPerm;
  manageUac: SwitchPerm;
}

export const ROADIE_PERMISSIONS: RolePermissions = {
  libMusic: 1,
  libMovies: 1,
  libTvShows: 1,
  libMusicVideos: 1,
  libBooks: 1,
  libAudiobooks: 1,
  libPhotos: 1,
  featEgenius: 1,
  featGenreMap: 1,
  featDevicesSync: 1,
  localCacheTier: 1,
  localCacheLimitMb: 2048,
  mediaUpload: 0,
  storeRequest: 0,
  playlists: 1,
  approveUploads: 0,
  approveStore: 0,
  rescanLibrary: 0,
  rebuildDb: 0,
  manageApiKeys: 0,
  viewServerLogs: 0,
  manageUac: 0,
};

export const BAND_PERMISSIONS: RolePermissions = {
  libMusic: 2,
  libMovies: 2,
  libTvShows: 2,
  libMusicVideos: 2,
  libBooks: 2,
  libAudiobooks: 2,
  libPhotos: 2,
  featEgenius: 2,
  featGenreMap: 2,
  featDevicesSync: 1,
  localCacheTier: 2,
  localCacheLimitMb: 0,
  mediaUpload: 1,
  storeRequest: 1,
  playlists: 2,
  approveUploads: 0,
  approveStore: 0,
  rescanLibrary: 0,
  rebuildDb: 0,
  manageApiKeys: 0,
  viewServerLogs: 0,
  manageUac: 0,
};

export const LABEL_PERMISSIONS: RolePermissions = {
  libMusic: 2,
  libMovies: 2,
  libTvShows: 2,
  libMusicVideos: 2,
  libBooks: 2,
  libAudiobooks: 2,
  libPhotos: 2,
  featEgenius: 2,
  featGenreMap: 2,
  featDevicesSync: 1,
  localCacheTier: 2,
  localCacheLimitMb: 0,
  mediaUpload: 2,
  storeRequest: 2,
  playlists: 2,
  approveUploads: 1,
  approveStore: 1,
  rescanLibrary: 1,
  rebuildDb: 1,
  manageApiKeys: 1,
  viewServerLogs: 1,
  manageUac: 1,
};

export interface CallerContext {
  userId: number | null;
  username: string;
  displayName: string;
  roles: string[];
  isSuperAdmin: boolean;
  isGuest: boolean;
  authSource: 'local-owner' | 'local' | 'authentik' | 'proxy-headers' | 'local-pin' | 'guest';
  permissions: RolePermissions;
}

export class ForbiddenError extends Error {
  statusCode = 403;
  constructor(message = 'Permission denied for your account role.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class UnauthorizedError extends Error {
  statusCode = 401;
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export function createLocalOwnerCallerContext(): CallerContext {
  return {
    userId: null,
    username: 'local-owner',
    displayName: 'Local Owner',
    roles: ['Label'],
    isSuperAdmin: true,
    isGuest: false,
    authSource: 'local-owner',
    permissions: { ...LABEL_PERMISSIONS },
  };
}

export function createGuestCallerContext(): CallerContext {
  return {
    userId: null,
    username: 'guest',
    displayName: 'Guest (Roadie)',
    roles: ['Roadie'],
    isSuperAdmin: false,
    isGuest: true,
    authSource: 'guest',
    permissions: { ...ROADIE_PERMISSIONS },
  };
}

const callerAls = new AsyncLocalStorage<CallerContext>();

export function runWithCallerContext<T>(ctx: CallerContext, fn: () => T): T {
  return callerAls.run(ctx, fn);
}

export function getCallerContext(): CallerContext {
  return callerAls.getStore() || createLocalOwnerCallerContext();
}

export function requirePermission(
  key: keyof RolePermissions,
  minLevel = 1,
  message?: string
): CallerContext {
  const ctx = getCallerContext();
  if (ctx.isSuperAdmin) return ctx;
  const val = Number(ctx.permissions[key] ?? 0);
  if (val < minLevel) {
    throw new ForbiddenError(
      message || `Insufficient permission (${key}: required ${minLevel}, have ${val}).`
    );
  }
  return ctx;
}
