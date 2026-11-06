import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rendererDir = path.join(__dirname, '../src/renderer');
const rendererSource = readFileSync(path.join(rendererDir, 'keys.ts'), 'utf8')
  .replace(/import \{ bridge[^\n]+from '\.\/bridge';/, `const {bridge,isDesktop,platform}=globalThis.hotkeyBoundary;`)
  .replace("import { t } from './i18n';", 'const t=()=>({settings:{keyNames:{}}});')
  .replace("import { setPushToTalk, toggleDeafen, toggleMic } from './voice';", 'const {setPushToTalk,toggleDeafen,toggleMic}=globalThis.hotkeyBoundary;');
const rendererBundle = buildSync({ stdin: { contents: rendererSource, resolveDir: rendererDir, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const mainBundle = buildSync({ entryPoints: [path.join(__dirname, '../src/main/hotkeys.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron', 'koffi'] }).outputFiles[0].text;
let globals: Map<string, PropertyDescriptor | undefined>;
test.beforeEach(() => { globals = new Map(['window', 'hotkeyBoundary'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])); });
test.afterEach(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function renderer(global = false) {
  const ptt: boolean[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let shortcut: ((name: string) => void) | undefined;
  Object.assign(globalThis, {
    window: { addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
    hotkeyBoundary: { isDesktop: global, platform: global ? 'win32' : 'darwin', setPushToTalk: (down: boolean) => ptt.push(down), toggleDeafen() {}, toggleMic() {}, bridge: { onShortcut(fn: (name: string) => void) { shortcut = fn; return () => { shortcut = undefined; }; }, setSettings() { return Promise.resolve(true); } } },
  });
  const module = { exports: {} };
  new Function('module', 'exports', rendererBundle)(module, module.exports);
  const keys = module.exports as typeof import('../src/renderer/keys');
  const off = keys.installHotkeys();
  const event = (name: string, code = '', mods = {}) => listeners.get(name)?.({ code, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, target: { tagName: 'DIV', isContentEditable: false, closest: () => null }, preventDefault() {}, ...mods });
  return { keys, ptt, event, off, listeners, shortcut: (name: string) => shortcut?.(name) };
}

test('clearing or changing a held PTT binding closes the gate before the old key is released', () => {
  const r = renderer();
  r.keys.hotkeys.value = { ptt: 'Space' };
  r.event('keydown', 'Space');
  expect(r.ptt.at(-1)).toBe(true);
  r.keys.setHotkey('ptt', '');
  expect(r.ptt.at(-1)).toBe(false);
  r.event('keyup', 'Space');
  r.keys.setHotkey('ptt', 'V');
  r.event('keydown', 'KeyV');
  expect(r.ptt.at(-1)).toBe(true);
  r.keys.setHotkey('ptt', 'B');
  expect(r.ptt.at(-1)).toBe(false);
  r.event('keyup', 'KeyV');
  expect(r.ptt.at(-1)).toBe(false);
  r.off();
});

test('a PTT chord releases on its modifier; blur and listener teardown cannot leave capture held', () => {
  const r = renderer();
  r.keys.hotkeys.value = { ptt: 'Ctrl+Space' };
  r.event('keydown', 'Space', { ctrlKey: true });
  r.event('keyup', 'ShiftLeft', { ctrlKey: true });
  expect(r.ptt.at(-1)).toBe(true);
  r.event('keyup', 'ControlLeft');
  expect(r.ptt.at(-1)).toBe(false);
  r.event('keydown', 'Space', { ctrlKey: true });
  r.event('blur');
  expect(r.ptt.at(-1)).toBe(false);
  r.event('keydown', 'Space', { ctrlKey: true });
  r.off();
  expect(r.ptt.at(-1)).toBe(false);
  expect(r.listeners.size).toBe(0);
});

test('Windows global PTT keeps working while unfocused and releases through the native key-up event', () => {
  const r = renderer(true);
  r.keys.hotkeys.value = { ptt: 'Space' };
  r.event('keydown', 'Space');
  expect(r.ptt).toHaveLength(0);
  r.shortcut('ptt:down');
  r.event('blur');
  expect(r.ptt).toEqual([true]);
  r.shortcut('ptt:up');
  expect(r.ptt.at(-1)).toBe(false);
  r.off();
  expect(r.listeners.size).toBe(0);
});

test('reinstalling or uninstalling Windows polling sends one release for a held PTT key', () => {
  const held = new Set<number>();
  const events: string[] = [];
  let tick: (() => void) | undefined;
  let unregisters = 0;
  const requireMock = (name: string) => {
    if (name === 'electron') return { globalShortcut: { register() {}, unregisterAll() { unregisters++; } } };
    if (name === 'koffi') return { load: () => ({ func: () => (key: number) => held.has(key) ? 0x8000 : 0 }) };
    throw new Error('Unexpected dependency ' + name);
  };
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'process', 'setInterval', 'clearInterval', mainBundle)(module, module.exports, requireMock, { platform: 'win32' }, (fn: () => void) => { tick = fn; return 1; }, () => { tick = undefined; });
  const keys = module.exports as typeof import('../src/main/hotkeys');
  keys.installHotkeys({ ptt: 'Space' }, (name) => events.push(name));
  held.add(0x20); tick!();
  expect(events).toEqual(['ptt:down']);
  keys.installHotkeys({ ptt: 'V' }, (name) => events.push(name));
  expect(events).toEqual(['ptt:down', 'ptt:up']);
  held.clear(); held.add(0x56); tick!();
  expect(events.at(-1)).toBe('ptt:down');
  keys.uninstallHotkeys();
  expect(events).toEqual(['ptt:down', 'ptt:up', 'ptt:down', 'ptt:up']);
  expect(tick).toBeUndefined();
  const releases = events.length;
  keys.uninstallHotkeys();
  expect(events).toHaveLength(releases);
  expect(unregisters).toBeGreaterThan(0);
});
