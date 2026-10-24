import { app, BrowserWindow, ipcMain, net, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { build } from '../../package.json';
import type { LaunchAction, LaunchState } from '../launch/state';

// The app follows its server: it installs exactly the server's version, from the releases of
// the repository it was built from. The server sends a version string, never a URL.
const { owner, repo } = build.publish[0];
const RELEASES = `https://github.com/${owner}/${repo}/releases`;

type ServerVersion = { version: string; min_client?: string };

const enabled = app.isPackaged && !process.env.TOLKTAK_NO_UPDATES;
// Squirrel.Mac needs a signed app, and the portable zip and .deb/.rpm cannot replace themselves.
const silent =
  process.platform === 'win32'
    ? existsSync(path.join(path.dirname(process.execPath), 'Uninstall TolkTak.exe'))
    : process.platform === 'linux' && !!process.env.APPIMAGE;

let mainWindow: () => BrowserWindow | null = () => null;
let launchWin: BrowserWindow | null = null;
let launchState: LaunchState | null = null;
let choose: ((action: LaunchAction) => void) | null = null;
let offered = '';
let downloaded = '';
let downloads = Promise.resolve(false);

export function installUpdater(getWindow: () => BrowserWindow | null) {
  mainWindow = getWindow;
  ipcMain.handle('launch:act', (e, action: LaunchAction) => {
    if (e.sender === launchWin?.webContents) choose?.(action);
  });
  if (!enabled) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => console.warn('update failed:', e.message));
  autoUpdater.on('download-progress', (p) => {
    if (launchState?.kind === 'download') show({ ...launchState, percent: p.percent, transferred: p.transferred, total: p.total, speed: p.bytesPerSecond });
  });
}

/** Resolves when the main window may open. Never resolves when the app quits to install. */
export async function checkBeforeLaunch(server: string, hidden: boolean) {
  if (!enabled || !server || hidden) return;
  const from = app.getVersion();
  show({ kind: 'check', from });
  const s = await fetchServerVersion(server);
  if (!s) {
    show({ kind: 'offline', from });
    await sleep(1200);
  } else if (isNewer(s.version, from)) {
    await update(s.version, isNewer(s.min_client, from));
  }
  show({ kind: 'start', from });
}

export function closeLaunchWindow() {
  const w = launchWin;
  launchWin = null;
  launchState = null;
  w?.close();
}

export const installUpdate = () => autoUpdater.quitAndInstall(true, true);

export async function serverChanged(s: ServerVersion) {
  const from = app.getVersion();
  if (!enabled || launchWin || !isNewer(s.version, from) || s.version === offered) return;
  offered = s.version;
  if (isNewer(s.min_client, from)) {
    mainWindow()?.hide();
    await update(s.version, true);
  } else if (!silent) {
    mainWindow()?.webContents.send('update:available', { version: s.version, url: releasePage(s.version) });
  } else if (await download(s.version)) {
    mainWindow()?.webContents.send('update:ready', s.version);
  } else {
    offered = '';
  }
}

/** Runs the update in the launch window. Returns when the app should go on without it. */
async function update(to: string, required: boolean): Promise<void> {
  const from = app.getVersion();
  let attempt = silent;
  for (;;) {
    if (attempt) {
      show({ kind: 'download', from, to, percent: 0, transferred: 0, total: 0, speed: 0 });
      if (await download(to)) {
        show({ kind: 'install', from, to });
        await sleep(600);
        autoUpdater.quitAndInstall(true, true);
        // Still running means the installer did not start, e.g. an AppImage in a read-only folder.
        await sleep(10_000);
      }
      if (!required) return;
    }
    show(silent ? { kind: 'failed', from, to } : { kind: 'manual', from, to, required, platform: process.platform });
    const action = await new Promise<LaunchAction>((resolve) => (choose = resolve));
    choose = null;
    if (action === 'quit') {
      app.quit();
      return new Promise(() => {});
    }
    if (action === 'download') shell.openExternal(releasePage(to));
    if (action === 'later' || (action === 'download' && !required)) return;
    attempt = action === 'retry';
  }
}

/** One at a time: electron-updater gives a second caller the download already running, whatever its version. */
function download(to: string): Promise<boolean> {
  downloads = downloads.then(() => fetchUpdate(to));
  return downloads;
}

async function fetchUpdate(to: string) {
  if (downloaded === to) return true;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: `${RELEASES}/download/v${to}` });
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo.version !== to || !result.downloadPromise) return false;
    await result.downloadPromise;
    downloaded = to;
    return true;
  } catch {
    // The 'error' event has logged it.
    return false;
  }
}

async function fetchServerVersion(server: string): Promise<ServerVersion | null> {
  try {
    const r = await net.fetch(`${server}/api/v1/server`, { signal: AbortSignal.timeout(3000) });
    const info = await r.json();
    return typeof info?.version === 'string' ? { version: info.version, min_client: info.min_client } : null;
  } catch {
    return null;
  }
}

function show(state: LaunchState) {
  launchState = state;
  if (launchWin) {
    launchWin.webContents.send('launch:state', state);
    return;
  }
  const w = new BrowserWindow({
    width: 360,
    height: 250,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'TolkTak',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'launch-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  launchWin = w;
  w.once('ready-to-show', () => w.show());
  // Anything sent while the page was loading is lost.
  w.webContents.on('did-finish-load', () => launchState && w.webContents.send('launch:state', launchState));
  w.on('closed', () => {
    if (launchWin !== w) return;
    launchWin = null;
    app.quit();
  });
  w.loadFile(path.join(__dirname, 'launch.html'));
}

function isNewer(a: string | undefined, b: string) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Release versions only, so the app never updates towards a developer build. */
function parseVersion(v: string | undefined) {
  const m = v ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v) : null;
  return m ? m.slice(1).map(Number) : null;
}

const releasePage = (v: string) => `${RELEASES}/tag/v${v}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
