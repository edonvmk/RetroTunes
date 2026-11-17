import { getDatabaseDiagnostics } from '../db';
import { listNetworkShares } from '../shareManager';
import { getSettings } from '../settings';

/**
 * Active default provider for RetroTunes:
 * Local SQLite + FTS5 database paired with direct OS-mounted NFS/SMB shares.
 * Kept strictly independent from remoteServer.ts and auth/authentik.ts.
 */
export const standaloneLocalProvider = {
  mode: 'standalone' as const,

  getStatus() {
    const settings = getSettings();
    const shares = listNetworkShares();
    const dbDiag = getDatabaseDiagnostics();
    return {
      mode: 'standalone' as const,
      dbPath: dbDiag.dbFilePath,
      dbSizeBytes: dbDiag.dbSizeBytes,
      localCachePath: settings.localCachePath,
      sharesCount: shares.length,
      mountedSharesCount: shares.filter((s) => s.is_mounted === 1).length,
    };
  },
};
