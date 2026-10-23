// Windows polls GetAsyncKeyState: it sees key releases and side mouse buttons,
// and unlike RegisterHotKey never takes the key away from the game.
import { globalShortcut } from 'electron';

export type HotkeyName = 'mute' | 'deafen' | 'ptt';
export type Hotkeys = Partial<Record<HotkeyName, string>>;

type Koffi = typeof import('koffi');
let getKey: ((vk: number) => number) | null = null;

function loadUser32() {
  if (getKey || process.platform !== 'win32') return getKey;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi: Koffi = require('koffi');
  getKey = koffi.load('user32.dll').func('int16 __stdcall GetAsyncKeyState(int vKey)');
  return getKey;
}

const NAMED: Record<string, number> = {
  Space: 0x20,
  Tab: 0x09,
  Enter: 0x0d,
  Backspace: 0x08,
  Escape: 0x1b,
  CapsLock: 0x14,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Up: 0x26,
  Down: 0x28,
  Left: 0x25,
  Right: 0x27,
  '`': 0xc0,
  '-': 0xbd,
  '=': 0xbb,
  '[': 0xdb,
  ']': 0xdd,
  '\\': 0xdc,
  ';': 0xba,
  "'": 0xde,
  ',': 0xbc,
  '.': 0xbe,
  '/': 0xbf,
  Mouse3: 0x04,
  Mouse4: 0x05,
  Mouse5: 0x06,
};
const MODS: Record<string, number> = { Ctrl: 0x11, Shift: 0x10, Alt: 0x12, Super: 0x5b };

export function parseAccelerator(accel: string): { mods: number[]; key: number } | null {
  const parts = accel.split('+').filter(Boolean);
  if (!parts.length) return null;
  const mods: number[] = [];
  let key = 0;
  for (const p of parts) {
    if (MODS[p]) mods.push(MODS[p]);
    else if (/^[A-Z0-9]$/.test(p)) key = p.charCodeAt(0);
    else if (/^F([1-9]|1\d|2[0-4])$/.test(p)) key = 0x6f + Number(p.slice(1));
    else if (/^Num[0-9]$/.test(p)) key = 0x60 + Number(p.slice(3));
    else if (NAMED[p]) key = NAMED[p];
    else return null;
  }
  // A modifier alone is a valid push-to-talk key (e.g. "Alt").
  if (!key && mods.length === 1) return { mods: [], key: mods[0] };
  return key ? { mods, key } : null;
}

let timer: NodeJS.Timeout | null = null;

/** `fire` receives "toggleMute", "toggleDeafen", "ptt:down" or "ptt:up". */
export function installHotkeys(keys: Hotkeys, fire: (name: string) => void) {
  uninstallHotkeys();

  const user32 = (() => {
    try {
      return loadUser32();
    } catch (err) {
      console.error('hotkeys: user32 unavailable', err);
      return null;
    }
  })();

  if (!user32) {
    for (const [name, event] of [
      ['mute', 'toggleMute'],
      ['deafen', 'toggleDeafen'],
    ] as const) {
      const accel = keys[name];
      if (!accel || accel.startsWith('Mouse')) continue;
      try {
        globalShortcut.register(accel, () => fire(event));
      } catch (err) {
        console.error('hotkeys: register', accel, err);
      }
    }
    return;
  }

  const parsed = (['mute', 'deafen', 'ptt'] as const)
    .map((name) => ({ name, combo: keys[name] ? parseAccelerator(keys[name]!) : null, down: false }))
    .filter((x) => x.combo);
  if (!parsed.length) return;
  const isDown = (vk: number) => (user32(vk) & 0x8000) !== 0;
  timer = setInterval(() => {
    for (const k of parsed) {
      const c = k.combo!;
      const now = isDown(c.key) && c.mods.every(isDown);
      if (now === k.down) continue;
      k.down = now;
      if (k.name === 'ptt') fire(now ? 'ptt:down' : 'ptt:up');
      else if (now) fire(k.name === 'mute' ? 'toggleMute' : 'toggleDeafen');
    }
  }, 25);
}

export function uninstallHotkeys() {
  if (timer) clearInterval(timer);
  timer = null;
  globalShortcut.unregisterAll();
}

export const globalPushToTalk = process.platform === 'win32';
