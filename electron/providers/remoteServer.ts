/**
 * Isolated stub/preview implementation for the future rTunes-Server Docker
 * HTTPS / WebSocket companion API.
 *
 * Gated behind dev mode (`isDev === true`) and intentionally decoupled from
 * standaloneLocal.ts so local SQLite + direct NFS/SMB workflows remain unaffected.
 */
export interface RemoteServerStatus {
  mode: 'docker_server';
  enabled: boolean;
  serverUrl: string;
  connected: boolean;
  message: string;
}

export const remoteServerProvider = {
  mode: 'docker_server' as const,

  getStatus(isDev: boolean, serverUrl: string): RemoteServerStatus {
    if (!isDev) {
      return {
        mode: 'docker_server',
        enabled: false,
        serverUrl: '',
        connected: false,
        message: 'Coming soon — rTunes is currently focused on direct network shares, local media, and USB/MTP ePod syncing.',
      };
    }
    return {
      mode: 'docker_server',
      enabled: Boolean(serverUrl),
      serverUrl,
      connected: false,
      message: serverUrl
        ? `[DEV PREVIEW] Remote rTunes-Server endpoint configured: ${serverUrl}`
        : '[DEV PREVIEW] No rTunes-Server Companion URL configured.',
    };
  },
};
