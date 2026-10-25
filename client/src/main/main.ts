import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  net,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globalPushToTalk, type HotkeyName, type Hotkeys, installHotkeys, uninstallHotkeys } from './hotkeys';
import { watchOcclusion } from './occlusion';
import { checkBeforeLaunch, closeLaunchWindow, installUpdate, installUpdater, serverChanged } from './updater';
import { audioPidForWindow, exeForPid, hwndFromSourceId, processLoopbackSupported, windowsBuild } from './winaudio';

if (process.env.TOLKTAK_USER_DATA) app.setPath('userData', path.resolve(process.env.TOLKTAK_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.exit();
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

// Settings come from a file and from the renderer: only known keys of the expected types are kept.
function cleanSettings(raw: unknown): Persisted {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Persisted = {};
  if (typeof r.server === 'string' && (r.server === '' || /^https?:\/\/[^\s]{1,2000}$/i.test(r.server))) out.server = r.server;
  if (typeof r.token === 'string' && /^[\x21-\x7e]{0,256}$/.test(r.token)) out.token = r.token;
  for (const k of ['minimizeToTray', 'openAtLogin', 'allowWin10Loopback'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k];
  }
  if (r.hotkeys && typeof r.hotkeys === 'object') {
    const keys = r.hotkeys as Record<string, unknown>;
    out.hotkeys = {};
    for (const name of ['mute', 'deafen', 'ptt'] as HotkeyName[]) {
      const accel = keys[name];
      if (typeof accel === 'string' && accel.length <= 64) out.hotkeys[name] = accel;
    }
  }
  return out;
}

function readSettings(): Persisted {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {
    return { minimizeToTray: true };
  }
  if (!raw || typeof raw !== 'object') return { minimizeToTray: true };
  if (typeof raw.tokenEnc === 'string' && safeStorage.isEncryptionAvailable()) {
    try {
      raw.token = safeStorage.decryptString(Buffer.from(raw.tokenEnc, 'base64'));
    } catch (err) {
      // Encrypted under another OS account or keychain: sign in again, keep the other settings.
      console.warn('settings: cannot decrypt the saved token', err);
    }
  }
  if (typeof raw.muteShortcut === 'string' && !raw.hotkeys) raw.hotkeys = { mute: raw.muteShortcut };
  return cleanSettings(raw);
}

function writeSettings(s: Persisted) {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out: Persisted & { tokenEnc?: string } = { ...s };
  if (s.token && safeStorage.isEncryptionAvailable()) {
    out.tokenEnc = safeStorage.encryptString(s.token).toString('base64');
    delete out.token;
  }
  const file = settingsFile();
  writeFileSync(file + '.tmp', JSON.stringify(out), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

let settings: Persisted = {};

// The main process has no renderer dictionaries: it follows the OS language.
const STRINGS = {
  en: { open: 'Open TolkTak', toggleMic: 'Mute / unmute microphone', toggleSound: 'Mute / unmute sound', quit: 'Quit', inVoice: 'TolkTak — in voice', unread: (n: number) => `Unread: ${n}` },
  ru: { open: 'Открыть TolkTak', toggleMic: 'Микрофон вкл/выкл', toggleSound: 'Звук вкл/выкл', quit: 'Выход', inVoice: 'TolkTak — в голосе', unread: (n: number) => `Непрочитанных: ${n}` },
};
const str = () => (app.getLocale().toLowerCase().startsWith('ru') ? STRINGS.ru : STRINGS.en);

const AUDIO_MODES = ['app', 'system', 'system-all', 'none'] as const;
type CaptureChoice = { id: string; audio: (typeof AUDIO_MODES)[number] };
let offeredSources = new Set<string>();
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
    closeLaunchWindow();
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!quitting && (process.platform === 'darwin' || settings.minimizeToTray !== false)) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => (win = null));
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

// Only the app's own page may use the main process.
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    const frame = e.senderFrame;
    if (e.sender.id !== win?.webContents.id || !frame || frame.parent || !frame.url.startsWith('file://')) {
      throw new Error(`${channel}: not allowed from this frame`);
    }
    return fn(...args);
  });
}

function installIpc() {
  handle('settings:get', () => ({
    server: settings.server ?? '',
    token: settings.token ?? '',
    minimizeToTray: settings.minimizeToTray !== false,
    hotkeys: settings.hotkeys ?? {},
    openAtLogin: !!settings.openAtLogin,
    allowWin10Loopback: !!settings.allowWin10Loopback,
  }));
  handle('settings:set', (patch: unknown) => {
    const valid = cleanSettings(patch);
    Object.assign(settings, valid);
    writeSettings(settings);
    if ('hotkeys' in valid) registerShortcuts();
    if ('openAtLogin' in valid && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, args: ['--hidden'] });
    return true;
  });
  handle('app:badge', (count: number, dataUrl: string) => {
    if (process.platform === 'darwin') app.dock?.setBadge(count ? String(count) : '');
    else if (process.platform === 'win32') win?.setOverlayIcon(count && dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count ? str().unread(count) : '');
    else app.setBadgeCount(count);
  });
  // fetch() cannot read large assets from file://.
  const assets = new Set(['dfn/df_bg.wasm', 'dfn/model.tar.gz']);
  handle('asset:read', (name: string) => (assets.has(name) ? readFileSync(path.join(__dirname, 'assets', name)) : null));
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    windowsBuild: windowsBuild(),
    processLoopback: processLoopbackSupported(!!settings.allowWin10Loopback),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    globalPushToTalk,
  }));
  handle('capture:sources', async () => {
    const own = win?.getMediaSourceId();
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    const offered = sources.filter((s) => s.id !== own && s.name !== 'TolkTak');
    offeredSources = new Set(offered.map((s) => s.id));
    return offered.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
    }));
  });
  handle('capture:select', (choice: Partial<CaptureChoice> | null) => {
    if (!choice || !offeredSources.has(choice.id ?? '') || !AUDIO_MODES.includes(choice.audio as CaptureChoice['audio'])) return false;
    pendingChoice = { id: choice.id!, audio: choice.audio! };
    return true;
  });
  handle('capture:lastAudio', () => lastAudioInfo);
  handle('app:inCall', (inCall: boolean) => {
    // Throttling stays on in calls: with it off a hidden window keeps decoding the watched stream.
    if (inCall && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
    if (!inCall && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    tray?.setToolTip(inCall ? str().inVoice : 'TolkTak');
  });
  handle('update:install', installUpdate);
  handle('update:server', serverChanged);
  handle('app:attention', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  // The page is file://, so <a download> is ignored for files on the server.
  handle('app:download', (url: string) => {
    if (/^https?:\/\//i.test(url)) win?.webContents.downloadURL(url);
  });
  handle('media:access', async (kind: 'microphone' | 'camera', ask: boolean) => {
    if (kind !== 'microphone' && kind !== 'camera') return 'denied';
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
    const status = systemPreferences.getMediaAccessStatus(kind);
    if (status === 'not-determined' && ask && process.platform === 'darwin') return (await systemPreferences.askForMediaAccess(kind)) ? 'granted' : 'denied';
    return status;
  });
  handle('media:openPrivacy', (kind: 'microphone' | 'camera') => {
    const mac = kind === 'camera' ? 'Privacy_Camera' : 'Privacy_Microphone';
    if (process.platform === 'darwin') shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${mac}`);
    else if (process.platform === 'win32') shell.openExternal(kind === 'camera' ? 'ms-settings:privacy-webcam' : 'ms-settings:privacy-microphone');
  });
}

// The page is loaded from file://, which would otherwise let it read any file on the disk.
function restrictFileProtocol() {
  protocol.handle('file', (req) => {
    let rel: string;
    try {
      rel = path.relative(__dirname, fileURLToPath(req.url));
    } catch {
      return new Response(null, { status: 403 });
    }
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return new Response(null, { status: 403 });
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
}

function installPermissions() {
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);
  const ours = (wc: Electron.WebContents | null) => !!wc && wc.id === win?.webContents.id;
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission) && ours(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission) && ours(wc));
}

app.on('activate', () => win?.show());

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  // Packaged builds take the dock icon from the bundle.
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, 'assets', 'icon-512.png'));
  settings = readSettings();
  // First, so that nothing failing below can keep the app from receiving a fix.
  installUpdater(() => win);
  restrictFileProtocol();
  installPermissions();
  installDisplayMediaHandler();
  installIpc();
  await checkBeforeLaunch(settings.server ?? '', process.argv.includes('--hidden'));
  createWindow();
  createTray();
  registerShortcuts();
});

app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => uninstallHotkeys());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
