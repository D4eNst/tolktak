// A bare Electron window: the client's Chromium and WebAssembly without the app.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  w.loadURL('about:blank');
});
