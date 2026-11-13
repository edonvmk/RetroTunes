import { contextBridge, ipcRenderer } from 'electron';

const isDev = process.argv.includes('--rtunes-dev');

contextBridge.exposeInMainWorld('electronAPI', {
  isDev,
  platform: process.platform,
});

contextBridge.exposeInMainWorld('rtunesElectron', {
  isDev,
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, data: unknown) => listener(data);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
});
