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
import { SOUND_ASSETS } from '../sounds';
import { fileURLToPath } from 'node:url';
import { globalPushToTalk, type HotkeyName, type Hotkeys, installHotkeys, uninstallHotkeys } from './hotkeys';
import { watchOcclusion } from './occlusion';
import { checkBeforeLaunch, closeLaunchWindow, installUpdate, installUpdater, serverChanged } from './updater';
import { audioProcessForWindow, hwndFromSourceId, processLoopbackSupported, windowsBuild } from './winaudio';

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
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const cleaned: Persisted = {};
  if (typeof input.server === 'string' && (input.server === '' || /^https?:\/\/[^\s]{1,2000}$/i.test(input.server))) cleaned.server = input.server;
  if (typeof input.token === 'string' && /^[\x21-\x7e]{0,256}$/.test(input.token)) cleaned.token = input.token;
  for (const k of ['minimizeToTray', 'openAtLogin', 'allowWin10Loopback'] as const) {
    if (typeof input[k] === 'boolean') cleaned[k] = input[k];
  }
  if (input.hotkeys && typeof input.hotkeys === 'object') {
    const keys = input.hotkeys as Record<string, unknown>;
    cleaned.hotkeys = {};
    for (const name of ['mute', 'deafen', 'ptt', 'window'] as HotkeyName[]) {
      const accel = keys[name];
      if (typeof accel === 'string' && accel.length <= 64) cleaned.hotkeys[name] = accel;
    }
  }
  return cleaned;
}

async function readSettings(): Promise<Persisted> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {
    return { minimizeToTray: true };
  }
  if (!raw || typeof raw !== 'object') return { minimizeToTray: true };
  if (typeof raw.tokenEnc === 'string' && (await safeStorage.isAsyncEncryptionAvailable())) {
    try {
      raw.token = (await safeStorage.decryptStringAsync(Buffer.from(raw.tokenEnc, 'base64'))).result;
    } catch (err) {
      // Encrypted under another OS account or keychain: sign in again, keep the other settings.
      console.warn('settings: cannot decrypt the saved token', err);
    }
  }
  if (typeof raw.muteShortcut === 'string' && !raw.hotkeys) raw.hotkeys = { mute: raw.muteShortcut };
  return cleanSettings(raw);
}

let saving = Promise.resolve();
// In order: a write still encrypting must not land after a later one.
function writeSettings(s: Persisted) {
  const snapshot = { ...s };
  return (saving = saving.catch(() => {}).then(() => saveSettings(snapshot)));
}

async function saveSettings(s: Persisted) {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out: Persisted & { tokenEnc?: string } = { ...s };
  if (s.token && (await safeStorage.isAsyncEncryptionAvailable())) {
    out.tokenEnc = (await safeStorage.encryptStringAsync(s.token)).toString('base64');
    delete out.token;
  }
  const file = settingsFile();
  writeFileSync(file + '.tmp', JSON.stringify(out), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

let settings: Persisted = {};

// The main process has no renderer dictionaries: it follows the OS language.
const STRINGS = {
  en: { open: 'Open TolkTak', toggleMic: 'Mute / unmute microphone', toggleSound: 'Mute / unmute sound', quit: 'Quit', inVoice: 'TolkTak — in call', unread: (n: number) => `Unread: ${n}` },
  ru: { open: 'Открыть TolkTak', toggleMic: 'Микрофон вкл/выкл', toggleSound: 'Звук вкл/выкл', quit: 'Выход', inVoice: 'TolkTak — в звонке', unread: (n: number) => `Непрочитанные сообщения: ${n}` },
};
const str = () => (app.getLocale().toLowerCase().startsWith('ru') ? STRINGS.ru : STRINGS.en);

const AUDIO_MODES = ['app', 'system', 'system-all', 'none'] as const;
type CaptureChoice = { id: string; audio: (typeof AUDIO_MODES)[number] };
let offeredSources = new Map<string, string>();
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
    const proc = hwnd !== null ? audioProcessForWindow(hwnd) : null;
    if (proc) {
      lastAudioInfo = { device: 'applicationLoopback', ...proc };
      return `applicationLoopback:${proc.pid}`;
    }
  }
  // Whole screen, or a window whose PID is unknown: everything except TolkTak.
  lastAudioInfo = { device: 'loopbackWithoutChrome' };
  return 'loopbackWithoutChrome';
}

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const choice = pendingChoice;
    pendingChoice = null;
    const name = choice ? offeredSources.get(choice.id) : undefined;
    if (!choice || name === undefined) {
      callback({});
      return;
    }
    try {
      const streams: Electron.Streams = { video: { id: choice.id, name } };
      const device = request.audioRequested ? audioDeviceFor(choice) : null;
      if (device) {
        // Electron forwards a plain string as the Chromium audio device id.
        (streams as { audio?: string }).audio = device;
      }
      console.log(`[capture] source=${choice.id} (${name}) audio=${device ?? 'none'} pid=${lastAudioInfo?.pid ?? '-'} exe=${lastAudioInfo?.exe ?? '-'}`);
      callback(streams);
    } catch (err) {
      console.error('display media handler', err);
      callback({});
    }
  });
}

function toBrowser(url: string) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return { action: 'deny' as const };
}

let revealMain = () => {};
let colors = { app: '#0b1327', island: '#131d37', symbol: '#97a3c5' };
const popped = new Set<BrowserWindow>();

function paintWindow(w: BrowserWindow, bg: string) {
  w.setBackgroundColor(bg);
  if (process.platform !== 'darwin') w.setTitleBarOverlay({ color: bg, symbolColor: colors.symbol });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b1327',
    title: 'TolkTak',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 21 } }
      : { titleBarOverlay: { color: '#0b1327', symbolColor: '#97a3c5', height: 56 } }),
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
  // Keep the launch window until the renderer reports its first screen.
  let revealed = false;
  revealMain = () => {
    if (revealed) return;
    revealed = true;
    if (!process.argv.includes('--hidden')) win?.show();
    closeLaunchWindow();
  };
  win.once('ready-to-show', () => setTimeout(() => revealMain(), 15_000));
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // A window of the desk on its own: a blank page of the same origin that the desk draws into.
    if (url === 'about:blank' && frameName.startsWith('tolktak-pop'))
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          minWidth: 320,
          minHeight: 240,
          backgroundColor: colors.island,
          autoHideMenuBar: true,
          icon: path.join(__dirname, 'assets', 'icon.png'),
          // No title bar of its own: the window's head is the bar, as in the main window.
          titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
          ...(process.platform === 'darwin'
            ? { trafficLightPosition: { x: 14, y: 15 } }
            : { titleBarOverlay: { color: colors.island, symbolColor: colors.symbol, height: 46 } }),
        },
      };
    return toBrowser(url);
  });
  // Popped-out windows show the same chats, so their links leave for the browser too.
  win.webContents.on('did-create-window', (child) => {
    popped.add(child);
    child.on('closed', () => popped.delete(child));
    child.webContents.on('will-navigate', (e) => e.preventDefault());
    child.webContents.setWindowOpenHandler(({ url }) => toBrowser(url));
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
  installHotkeys(settings.hotkeys ?? {}, (name) => {
    if (name !== 'toggleWindow') return win?.webContents.send('shortcut', name);
    if (win?.isVisible() && win.isFocused()) win.hide();
    else (win?.show(), win?.focus());
  });
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
  handle('settings:set', async (patch: unknown) => {
    const valid = cleanSettings(patch);
    Object.assign(settings, valid);
    await writeSettings(settings);
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
  const assets = new Set(['dfn/df_bg.wasm', 'dfn/model.tar.gz', ...SOUND_ASSETS]);
  handle('asset:read', (name: string) => (assets.has(name) ? readFileSync(path.join(__dirname, 'assets', name)) : null));
  handle('app:ready', () => revealMain());
  handle('app:colors', (c: typeof colors) => {
    if (![c?.app, c?.island, c?.symbol].every((x) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x))) return;
    colors = { app: c.app, island: c.island, symbol: c.symbol };
    if (win) paintWindow(win, colors.app);
    popped.forEach((w) => paintWindow(w, colors.island));
  });
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
    offeredSources = new Map(offered.map((s) => [s.id, s.name]));
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
  settings = await readSettings();
  // Install first so startup failures cannot disable updates.
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
