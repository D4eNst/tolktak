import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { globalPushToTalk, type Hotkeys, installHotkeys, uninstallHotkeys } from './hotkeys';
import { watchOcclusion } from './occlusion';
import { installUpdater } from './updater';
import { audioPidForWindow, exeForPid, hwndFromSourceId, processLoopbackSupported, windowsBuild } from './winaudio';

if (process.env.TOLKTAK_USER_DATA) app.setPath('userData', path.resolve(process.env.TOLKTAK_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId('org.tolktak.client');
// WebRTC must not move the system microphone slider: TolkTak levels the voice itself.
// appendSwitch replaces a list given on the command line, hence the merge.
const switchList = (name: string, add: string) =>
  app.commandLine.appendSwitch(name, [app.commandLine.getSwitchValue(name), add].filter(Boolean).join(','));
switchList('disable-features', 'WebRtcAllowInputVolumeAdjustment');
// Windows 11 24H2+: keep WGC frames on the GPU instead of copying each to system memory.
if (process.platform === 'win32') switchList('enable-features', 'WebRtcAllowWgcUsingTexture');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let blockerId: number | null = null;

type Persisted = {
  server?: string;
  token?: string;
  minimizeToTray?: boolean;
  muteShortcut?: string; // older versions, migrated into hotkeys.mute
  hotkeys?: Hotkeys;
  openAtLogin?: boolean;
  allowWin10Loopback?: boolean;
};
const settingsFile = () => path.join(app.getPath('userData'), 'tolktak.json');

function readSettings(): Persisted {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Persisted & { tokenEnc?: string };
    if (raw.tokenEnc && safeStorage.isEncryptionAvailable()) {
      raw.token = safeStorage.decryptString(Buffer.from(raw.tokenEnc, 'base64'));
    }
    delete raw.tokenEnc;
    if (raw.muteShortcut && !raw.hotkeys) raw.hotkeys = { mute: raw.muteShortcut };
    delete raw.muteShortcut;
    return raw;
  } catch {
    return { minimizeToTray: true };
  }
}

function writeSettings(s: Persisted) {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out: Persisted & { tokenEnc?: string } = { ...s };
  if (s.token && safeStorage.isEncryptionAvailable()) {
    out.tokenEnc = safeStorage.encryptString(s.token).toString('base64');
    delete out.token;
  }
  writeFileSync(settingsFile(), JSON.stringify(out), { mode: 0o600 });
}

let settings: Persisted = {};

// The main process has no renderer dictionaries: it follows the OS language.
const STRINGS = {
  en: { open: 'Open TolkTak', toggleMic: 'Mute / unmute microphone', toggleSound: 'Mute / unmute sound', quit: 'Quit', inVoice: 'TolkTak — in voice', unread: (n: number) => `Unread: ${n}` },
  ru: { open: 'Открыть TolkTak', toggleMic: 'Микрофон вкл/выкл', toggleSound: 'Звук вкл/выкл', quit: 'Выход', inVoice: 'TolkTak — в голосе', unread: (n: number) => `Непрочитанных: ${n}` },
};
const str = () => (app.getLocale().toLowerCase().startsWith('ru') ? STRINGS.ru : STRINGS.en);

type CaptureChoice = { id: string; audio: 'app' | 'system' | 'system-all' | 'none' };
let pendingChoice: CaptureChoice | null = null;
let lastAudioInfo: { device: string; pid?: number; exe?: string } | null = null;

function audioDeviceFor(choice: CaptureChoice): string | null {
  lastAudioInfo = null;
  if (choice.audio === 'none' || process.platform !== 'win32') return null;
  const supported = processLoopbackSupported(!!settings.allowWin10Loopback);
  if (choice.audio === 'system-all') return 'loopback';
  if (!supported) return null;
  if (choice.audio === 'app') {
    const hwnd = hwndFromSourceId(choice.id);
    const pid = hwnd !== null ? audioPidForWindow(hwnd) : null;
    if (pid) {
      lastAudioInfo = { device: 'applicationLoopback', pid, exe: exeForPid(pid) };
      return `applicationLoopback:${pid}`;
    }
  }
  // Whole screen, or a window whose PID is unknown: everything except TolkTak.
  lastAudioInfo = { device: 'loopbackWithoutChrome' };
  return 'loopbackWithoutChrome';
}

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const choice = pendingChoice;
    pendingChoice = null;
    if (!choice) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => s.id === choice.id);
      if (!source) {
        callback({});
        return;
      }
      const streams: Electron.Streams = { video: source };
      const device = request.audioRequested ? audioDeviceFor(choice) : null;
      if (device) {
        // Electron forwards a plain string as the Chromium audio device id.
        (streams as { audio?: string }).audio = device;
      }
      console.log(`[capture] source=${source.id} (${source.name}) audio=${device ?? 'none'} pid=${lastAudioInfo?.pid ?? '-'} exe=${lastAudioInfo?.exe ?? '-'}`);
      callback(streams);
    } catch (err) {
      console.error('display media handler', err);
      callback({});
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#0e0c12',
    title: 'TolkTak',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: '#0e0c12', symbolColor: '#b9b1c6', height: 34 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: true,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win?.show();
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!quitting && settings.minimizeToTray !== false) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('focus', () => win?.flashFrame(false));
  watchOcclusion(win, (occluded) => win?.webContents.send('app:occluded', occluded));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('TolkTak');
  tray.on('click', () => {
    win?.show();
    win?.focus();
  });
  const menu = Menu.buildFromTemplate([
    { label: str().open, click: () => win?.show() },
    { label: str().toggleMic, click: () => win?.webContents.send('shortcut', 'toggleMute') },
    { label: str().toggleSound, click: () => win?.webContents.send('shortcut', 'toggleDeafen') },
    { type: 'separator' },
    {
      label: str().quit,
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function registerShortcuts() {
  installHotkeys(settings.hotkeys ?? {}, (name) => win?.webContents.send('shortcut', name));
}

function installIpc() {
  ipcMain.handle('settings:get', () => ({
    server: settings.server ?? '',
    token: settings.token ?? '',
    minimizeToTray: settings.minimizeToTray !== false,
    hotkeys: settings.hotkeys ?? {},
    openAtLogin: !!settings.openAtLogin,
    allowWin10Loopback: !!settings.allowWin10Loopback,
  }));
  ipcMain.handle('settings:set', (_e, patch: Partial<Persisted>) => {
    const allowed: (keyof Persisted)[] = ['server', 'token', 'minimizeToTray', 'hotkeys', 'openAtLogin', 'allowWin10Loopback'];
    for (const k of allowed) {
      if (k in patch) (settings as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
    writeSettings(settings);
    if ('hotkeys' in patch) registerShortcuts();
    if ('openAtLogin' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, args: ['--hidden'] });
    return true;
  });
  ipcMain.handle('app:badge', (_e, count: number, dataUrl: string) => {
    if (process.platform === 'darwin') app.dock?.setBadge(count ? String(count) : '');
    else if (process.platform === 'win32') win?.setOverlayIcon(count && dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count ? str().unread(count) : '');
    else app.setBadgeCount(count);
  });
  // fetch() cannot read large assets from file://.
  const assets = new Set(['dfn/df_bg.wasm', 'dfn/model.tar.gz']);
  ipcMain.handle('asset:read', (_e, name: string) => (assets.has(name) ? readFileSync(path.join(__dirname, 'assets', name)) : null));
  ipcMain.handle('app:copy', (_e, text: string) => clipboard.writeText(String(text).slice(0, 10000)));
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    windowsBuild: windowsBuild(),
    processLoopback: processLoopbackSupported(!!settings.allowWin10Loopback),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    globalPushToTalk,
  }));
  ipcMain.handle('capture:sources', async () => {
    const own = win?.getMediaSourceId();
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.id !== own && s.name !== 'TolkTak')
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
      }));
  });
  ipcMain.handle('capture:select', (_e, choice: CaptureChoice) => {
    pendingChoice = choice;
    return true;
  });
  ipcMain.handle('capture:lastAudio', () => lastAudioInfo);
  ipcMain.handle('app:inCall', (_e, inCall: boolean) => {
    // Throttling stays on in calls: with it off a hidden window keeps decoding the watched stream.
    if (inCall && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
    if (!inCall && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    tray?.setToolTip(inCall ? str().inVoice : 'TolkTak');
  });
  ipcMain.handle('app:attention', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:setTitle', (_e, title: string) => win?.setTitle(String(title).slice(0, 120)));
  ipcMain.handle('media:access', async (_e, kind: 'microphone' | 'camera', ask: boolean) => {
    if (kind !== 'microphone' && kind !== 'camera') return 'denied';
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
    const status = systemPreferences.getMediaAccessStatus(kind);
    if (status === 'not-determined' && ask && process.platform === 'darwin') return (await systemPreferences.askForMediaAccess(kind)) ? 'granted' : 'denied';
    return status;
  });
  ipcMain.handle('media:openPrivacy', (_e, kind: 'microphone' | 'camera') => {
    const mac = kind === 'camera' ? 'Privacy_Camera' : 'Privacy_Microphone';
    if (process.platform === 'darwin') shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${mac}`);
    else if (process.platform === 'win32') shell.openExternal(kind === 'camera' ? 'ms-settings:privacy-webcam' : 'ms-settings:privacy-microphone');
  });
}

function installPermissions() {
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(() => {
  // Packaged builds take the dock icon from the bundle.
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, 'assets', 'icon-512.png'));
  settings = readSettings();
  installPermissions();
  installDisplayMediaHandler();
  installIpc();
  createWindow();
  createTray();
  registerShortcuts();
  installUpdater(() => win);
});

app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => uninstallHotkeys());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
