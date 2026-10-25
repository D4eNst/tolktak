// Outside Electron (dev server, tests) a fallback stands in for the preload bridge.

export type CaptureSource = { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string; icon: string };
export type AudioMode = 'app' | 'system' | 'system-all' | 'none';
export type AppInfo = {
  version: string;
  platform: string;
  windowsBuild: number;
  processLoopback: boolean;
  electron?: string;
  chrome?: string;
  globalPushToTalk?: boolean;
};
export type MediaKind = 'microphone' | 'camera';
export type MediaAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
export type Hotkeys = { mute?: string; deafen?: string; ptt?: string };
export type DesktopSettings = {
  server: string;
  token: string;
  minimizeToTray: boolean;
  hotkeys: Hotkeys;
  openAtLogin: boolean;
  allowWin10Loopback: boolean;
};

type Bridge = {
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<boolean>;
  appInfo(): Promise<AppInfo>;
  captureSources(): Promise<CaptureSource[]>;
  selectCapture(choice: { id: string; audio: AudioMode }): Promise<boolean>;
  lastCaptureAudio(): Promise<{ device: string; pid?: number; exe?: string } | null>;
  setInCall(v: boolean): Promise<void>;
  requestAttention(): Promise<void>;
  setBadge(count: number, dataUrl: string): Promise<void>;
  download(url: string): Promise<void>;
  mediaAccess(kind: MediaKind, ask: boolean): Promise<MediaAccess>;
  openPrivacySettings(kind: MediaKind): Promise<void>;
  onShortcut(fn: (name: string) => void): () => void;
  readAsset(name: string): Promise<Uint8Array>;
  installUpdate(): Promise<void>;
  onUpdateReady(fn: (version: string) => void): () => void;
  /** A build that cannot install updates itself offers the release page instead. */
  onUpdateAvailable(fn: (update: { version: string; url: string }) => void): () => void;
  /** The app follows the version of its server. */
  serverVersion(server: { version: string; min_client?: string }): Promise<void>;
  /** Windows: open but fully covered by other windows. */
  onOccluded(fn: (occluded: boolean) => void): () => void;
};

const native = (globalThis as unknown as { tolktak?: Bridge }).tolktak;
export const isDesktop = !!native;

const LS_KEY = 'tolktak.settings';
function lsGet(): DesktopSettings {
  try {
    return { ...defaults(), ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
  } catch {
    return defaults();
  }
}
function defaults(): DesktopSettings {
  return { server: location.protocol.startsWith('http') ? location.origin : '', token: '', minimizeToTray: true, hotkeys: {}, openAtLogin: false, allowWin10Loopback: false };
}

const browserFallback: Bridge = {
  async getSettings() {
    return lsGet();
  },
  async setSettings(patch) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ ...lsGet(), ...patch }));
    } catch {
      /* storage unavailable */
    }
    return true;
  },
  async appInfo() {
    return { version: 'web', platform: 'web', windowsBuild: 0, processLoopback: false };
  },
  async captureSources() {
    return [];
  },
  async selectCapture() {
    return true;
  },
  async lastCaptureAudio() {
    return null;
  },
  async setInCall() {},
  async requestAttention() {},
  async setBadge() {},
  async download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  async mediaAccess() {
    return 'granted'; // the browser asks on first use
  },
  async openPrivacySettings() {},
  onShortcut() {
    return () => {};
  },
  async readAsset(name) {
    const res = await fetch('assets/' + name);
    if (!res.ok) throw new Error(`asset ${name}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async installUpdate() {},
  onUpdateReady() {
    return () => {};
  },
  onUpdateAvailable() {
    return () => {};
  },
  async serverVersion() {},
  onOccluded() {
    return () => {};
  },
};

// Web APIs work the same in Electron, whose window-open handler sends http(s) links to the browser.
const web = {
  async openExternal(url: string) {
    window.open(url, '_blank', 'noopener');
  },
  async setTitle(t: string) {
    document.title = t;
  },
  async copy(text: string) {
    await navigator.clipboard.writeText(text);
  },
};

export const bridge = { ...(native ?? browserFallback), ...web };
export const platform: 'win32' | 'darwin' | 'other' = navigator.userAgent.includes('Windows') ? 'win32' : navigator.userAgent.includes('Mac') ? 'darwin' : 'other';
