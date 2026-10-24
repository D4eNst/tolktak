import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('launch', {
  onState: (fn: (state: unknown) => void) => {
    ipcRenderer.on('launch:state', (_e, state) => fn(state));
  },
  act: (action: string) => ipcRenderer.invoke('launch:act', action),
});
