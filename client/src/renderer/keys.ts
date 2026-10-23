// The main process listens globally on Windows, this module only while the window is focused.
import { signal } from '@preact/signals';
import { bridge, type Hotkeys, isDesktop, platform } from './bridge';
import { t } from './i18n';
import { setPushToTalk, toggleDeafen, toggleMic } from './voice';

export const hotkeys = signal<Hotkeys>({});
const globalKeys = isDesktop && platform === 'win32';

const CODE_NAMES: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  CapsLock: 'CapsLock',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return 'Num' + code.slice(6);
  return CODE_NAMES[code] ?? null;
}

const MOD_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** Electron accelerator syntax, or null while only modifiers are held. */
export function accelFromEvent(e: KeyboardEvent, allowModifierOnly = false): string | null {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
  if (MOD_CODES.has(e.code)) {
    if (!allowModifierOnly) return null;
    return e.code.startsWith('Control') ? 'Ctrl' : e.code.startsWith('Alt') ? 'Alt' : e.code.startsWith('Shift') ? 'Shift' : 'Super';
  }
  const k = keyName(e.code);
  return k ? [...mods, k].join('+') : null;
}

export function accelFromMouse(e: MouseEvent): string | null {
  return e.button === 1 ? 'Mouse3' : e.button === 3 ? 'Mouse4' : e.button === 4 ? 'Mouse5' : null;
}

export function accelLabel(a?: string) {
  if (!a) return '';
  const n = t().settings.keyNames;
  return a
    .replace('Mouse3', n.wheel)
    .replace('Mouse4', n.mouse4)
    .replace('Mouse5', n.mouse5)
    .replace('Super', platform === 'darwin' ? 'Cmd' : 'Win')
    .replace('Space', n.space)
    .split('+')
    .join(' + ');
}

export async function loadHotkeys() {
  const s = await bridge.getSettings();
  hotkeys.value = s.hotkeys ?? {};
}

export function setHotkey(name: keyof Hotkeys, accel: string) {
  const next = { ...hotkeys.value, [name]: accel || undefined };
  hotkeys.value = next;
  bridge.setSettings({ hotkeys: next });
}

export function installHotkeys(): () => void {
  const off = bridge.onShortcut((name) => {
    if (name === 'toggleMute') toggleMic();
    if (name === 'toggleDeafen') toggleDeafen();
    if (name === 'ptt:down') setPushToTalk(true);
    if (name === 'ptt:up') setPushToTalk(false);
  });
  const typing = (e: Event) => {
    const el = e.target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('.key-capture'));
  };
  const down = (e: KeyboardEvent) => {
    if (globalKeys || e.repeat) return;
    const k = hotkeys.value;
    const a = accelFromEvent(e, true);
    if (!a) return;
    if (a === k.ptt && !typing(e)) setPushToTalk(true);
    if (a === k.mute && !typing(e)) (e.preventDefault(), toggleMic());
    if (a === k.deafen && !typing(e)) (e.preventDefault(), toggleDeafen());
  };
  const up = (e: KeyboardEvent) => {
    if (globalKeys) return;
    const k = hotkeys.value.ptt;
    if (!k) return;
    const last = k.split('+').pop();
    const name = accelFromEvent(e, true)?.split('+').pop();
    if (name === last) setPushToTalk(false);
  };
  const mdown = (e: MouseEvent) => !globalKeys && accelFromMouse(e) === hotkeys.value.ptt && setPushToTalk(true);
  const mup = (e: MouseEvent) => !globalKeys && accelFromMouse(e) === hotkeys.value.ptt && setPushToTalk(false);
  const blur = () => !globalKeys && setPushToTalk(false);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('mousedown', mdown);
  window.addEventListener('mouseup', mup);
  window.addEventListener('blur', blur);
  return () => {
    off();
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('mousedown', mdown);
    window.removeEventListener('mouseup', mup);
    window.removeEventListener('blur', blur);
  };
}

export const hotkeysAreGlobal = globalKeys;
