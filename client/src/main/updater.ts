import { app, type BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export function installUpdater(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
  if (!app.isPackaged || isPortableWindows() || process.env.TOLKTAK_NO_UPDATES) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => getWindow()?.webContents.send('update:ready', info.version));
  autoUpdater.on('error', (e) => console.warn('update check failed:', e.message));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 30_000);
  setInterval(check, CHECK_EVERY_MS);
}

function isPortableWindows() {
  return process.platform === 'win32' && !existsSync(path.join(path.dirname(process.execPath), 'Uninstall TolkTak.exe'));
}
