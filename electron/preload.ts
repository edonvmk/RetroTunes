import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rtunesElectron', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, data: unknown) => listener(data);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
});
