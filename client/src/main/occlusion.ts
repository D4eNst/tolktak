// Windows only. Chromium does not report a window covered by other windows (a borderless game) as hidden.
import type { BrowserWindow } from 'electron';

type Koffi = typeof import('koffi');

const GW_HWNDPREV = 3;
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20; // click-through overlays
const WS_EX_LAYERED = 0x80000;
const LWA_COLORKEY = 0x1;
const LWA_ALPHA = 0x2;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14; // hidden UWP windows, other virtual desktops
const RGN_AND = 1;
const RGN_DIFF = 4;
const NULLREGION = 1;
const SM_XVIRTUALSCREEN = 76;
const MAX_WINDOWS = 1000;

type Rect = { left: number; top: number; right: number; bottom: number };

let api: {
  GetWindow: (hwnd: bigint, cmd: number) => bigint;
  IsWindowVisible: (hwnd: bigint) => boolean;
  IsIconic: (hwnd: bigint) => boolean;
  GetWindowRect: (hwnd: bigint, r: Rect) => boolean;
  GetWindowLongPtrW: (hwnd: bigint, index: number) => number | bigint;
  GetLayeredWindowAttributes: (hwnd: bigint, key: Buffer, alpha: Buffer, flags: Buffer) => boolean;
  GetSystemMetrics: (index: number) => number;
  DwmGetWindowAttribute: (hwnd: bigint, attr: number, out: unknown, size: number) => number;
  CreateRectRgn: (l: number, t: number, r: number, b: number) => unknown;
  CombineRgn: (dst: unknown, a: unknown, b: unknown, mode: number) => number;
  SetRectRgn: (rgn: unknown, l: number, t: number, r: number, b: number) => boolean;
  DeleteObject: (obj: unknown) => boolean;
  rectSize: number;
} | null = null;

function load() {
  if (api || process.platform !== 'win32') return api;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi: Koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('OCCL_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  api = {
    GetWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(uintptr_t hWnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ OCCL_RECT *lpRect)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int nIndex)'),
    GetLayeredWindowAttributes: user32.func('bool __stdcall GetLayeredWindowAttributes(uintptr_t hwnd, _Out_ void *pcrKey, _Out_ void *pbAlpha, _Out_ void *pdwFlags)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
    DwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 dwAttribute, _Out_ void *pvAttribute, uint32 cbAttribute)'),
    CreateRectRgn: gdi32.func('void * __stdcall CreateRectRgn(int x1, int y1, int x2, int y2)'),
    CombineRgn: gdi32.func('int __stdcall CombineRgn(void *hrgnDst, void *hrgnSrc1, void *hrgnSrc2, int iMode)'),
    SetRectRgn: gdi32.func('bool __stdcall SetRectRgn(void *hrgn, int left, int top, int right, int bottom)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(void *ho)'),
    rectSize: koffi.sizeof(RECT),
  };
  return api;
}

/** Without the invisible resize borders of Windows 10/11. */
function bounds(a: NonNullable<typeof api>, hwnd: bigint): Rect | null {
  const buf = Buffer.alloc(a.rectSize);
  if (a.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, a.rectSize) === 0) {
    return { left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) };
  }
  const r: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  return a.GetWindowRect(hwnd, r) ? r : null;
}

function cloaked(a: NonNullable<typeof api>, hwnd: bigint): boolean {
  const buf = Buffer.alloc(4);
  return a.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) === 0 && buf.readUInt32LE(0) !== 0;
}

/** Colour key, partial alpha or per-pixel alpha (no attributes) means see-through. */
function translucent(a: NonNullable<typeof api>, hwnd: bigint, exStyle: number): boolean {
  if (!(exStyle & WS_EX_LAYERED)) return false;
  const key = Buffer.alloc(4);
  const alpha = Buffer.alloc(1);
  const flags = Buffer.alloc(4);
  if (!a.GetLayeredWindowAttributes(hwnd, key, alpha, flags)) return true;
  const f = flags.readUInt32LE(0);
  return (f & LWA_COLORKEY) !== 0 || ((f & LWA_ALPHA) !== 0 && alpha[0] < 255);
}

export function isOccluded(win: BrowserWindow): boolean {
  const a = load();
  if (!a || !win.isVisible() || win.isMinimized()) return false;
  const self = win.getNativeWindowHandle().readBigUInt64LE(0);
  const own = bounds(a, self);
  if (!own) return false;
  const left = a.CreateRectRgn(own.left, own.top, own.right, own.bottom);
  const vx = a.GetSystemMetrics(SM_XVIRTUALSCREEN);
  const vy = a.GetSystemMetrics(SM_XVIRTUALSCREEN + 1);
  const screen = a.CreateRectRgn(vx, vy, vx + a.GetSystemMetrics(SM_XVIRTUALSCREEN + 2), vy + a.GetSystemMetrics(SM_XVIRTUALSCREEN + 3));
  const other = a.CreateRectRgn(0, 0, 0, 0);
  try {
    if (a.CombineRgn(left, left, screen, RGN_AND) === NULLREGION) return false;
    let h = a.GetWindow(self, GW_HWNDPREV);
    for (let i = 0; h && i < MAX_WINDOWS; i++, h = a.GetWindow(h, GW_HWNDPREV)) {
      if (!a.IsWindowVisible(h) || a.IsIconic(h) || cloaked(a, h)) continue;
      const exStyle = Number(a.GetWindowLongPtrW(h, GWL_EXSTYLE));
      if (exStyle & WS_EX_TRANSPARENT || translucent(a, h, exStyle)) continue;
      const r = bounds(a, h);
      if (!r || r.right <= r.left || r.bottom <= r.top) continue;
      a.SetRectRgn(other, r.left, r.top, r.right, r.bottom);
      if (a.CombineRgn(left, left, other, RGN_DIFF) === NULLREGION) return true;
    }
    return false;
  } finally {
    a.DeleteObject(left);
    a.DeleteObject(screen);
    a.DeleteObject(other);
  }
}

/** Checked twice a second even unfocused: a game may cover the window without taking focus. */
export function watchOcclusion(win: BrowserWindow, onChange: (occluded: boolean) => void): void {
  if (process.platform !== 'win32') return;
  let last = false;
  let timer: NodeJS.Timeout | null = null;
  const set = (v: boolean) => {
    if (v !== last) onChange((last = v));
  };
  const check = () => {
    try {
      set(!win.isDestroyed() && (win.isMinimized() || !win.isVisible() || isOccluded(win)));
    } catch {
      set(false);
    }
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    if (timer || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    timer = setInterval(check, 500);
    check();
  };
  const shown = () => {
    check();
    start();
  };
  win.on('restore', shown);
  win.on('show', shown);
  win.on('focus', check);
  win.on('blur', check);
  // Chromium reports minimised or tray only while background throttling is on.
  const gone = () => {
    stopTimer();
    check();
  };
  win.on('minimize', gone);
  win.on('hide', gone);
  win.on('closed', stopTimer);
  win.once('ready-to-show', start);
  win.webContents.on('did-finish-load', () => last && onChange(true));
}
