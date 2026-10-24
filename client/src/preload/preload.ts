import { contextBridge, ipcRenderer } from 'electron';

/** The returned function unsubscribes. */
function listener<T>(channel: string) {
  const listeners = new Set<(value: T) => void>();
  ipcRenderer.on(channel, (_e, value: T) => listeners.forEach((fn) => fn(value)));
  return (fn: (value: T) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
}

contextBridge.exposeInMainWorld('tolktak', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  appInfo: () => ipcRenderer.invoke('app:info'),
  captureSources: () => ipcRenderer.invoke('capture:sources'),
  selectCapture: (choice: { id: string; audio: string }) => ipcRenderer.invoke('capture:select', choice),
  lastCaptureAudio: () => ipcRenderer.invoke('capture:lastAudio'),
  setInCall: (v: boolean) => ipcRenderer.invoke('app:inCall', v),
  requestAttention: () => ipcRenderer.invoke('app:attention'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  setTitle: (t: string) => ipcRenderer.invoke('app:setTitle', t),
  setBadge: (count: number, dataUrl: string) => ipcRenderer.invoke('app:badge', count, dataUrl),
  copy: (text: string) => ipcRenderer.invoke('app:copy', text),
  mediaAccess: (kind: string, ask: boolean) => ipcRenderer.invoke('media:access', kind, ask),
  openPrivacySettings: (kind: string) => ipcRenderer.invoke('media:openPrivacy', kind),
  onShortcut: listener<string>('shortcut'),
  readAsset: (name: string) => ipcRenderer.invoke('asset:read', name),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateReady: listener<string>('update:ready'),
  onUpdateAvailable: listener<{ version: string; url: string }>('update:available'),
  serverVersion: (server: { version: string; min_client?: string }) => ipcRenderer.invoke('update:server', server),
  onOccluded: listener<boolean>('app:occluded'),
});
