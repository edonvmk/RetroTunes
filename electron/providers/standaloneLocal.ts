import {
  getDatabaseDiagnostics,
  searchTracksFts,
  searchVideosFts,
  TrackRow,
  VideoRow,
} from '../db';
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

  searchTracks(query: string, limit = 200000): TrackRow[] {
    return searchTracksFts(query, limit);
  },

  searchVideos(query: string, type?: 'movie' | 'tv'): VideoRow[] {
    return searchVideosFts(query, type);
  },

  getShares() {
    return listNetworkShares();
  },
};
