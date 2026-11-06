import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mainWindow, openClient } from './helpers';
import { buildSync } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SOUND_ASSETS, SOUND_KINDS, SOUND_THEMES } from '../src/sounds';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
const volumeLabel = 'Громкость звуков интерфейса';
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tolktak.voice')!));

async function settings(page: Page) {
  await page.locator('.topbar-avatar').click();
  await page.locator('.self-menu').getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.locator('.settings-nav').getByRole('button', { name: 'Голос', exact: true }).click();
}
async function setVolume(page: Page, value: number) {
  await page.getByRole('slider', { name: volumeLabel, exact: true }).evaluate((el, value) => {
    (el as HTMLInputElement).value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function captureAudio(page: Page, deferSink = false) {
  await page.evaluate((deferSink) => {
    const contexts: OfflineAudioContext[] = [];
    const closed: boolean[] = [];
    const sources: AudioBufferSourceNode[] = [];
    const sinks: string[] = [];
    let ready: (() => void) | undefined;
    (window as any).soundCapture = { contexts, closed, sources, sinks, ready: () => ready?.() };
    const OriginalAudioContext = window.AudioContext;
    (window as any).AudioContext = function (options?: AudioContextOptions) {
      if (options) return new OriginalAudioContext(options);
      const ctx = new OfflineAudioContext(1, 4 * 48000, 48000);
      const index = contexts.push(ctx) - 1;
      closed.push(false);
      const createSource = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = () => { const source = createSource(); sources.push(source); return source; };
      Object.assign(ctx, {
        resume: () => Promise.resolve(),
        close: () => { closed[index] = true; return Promise.resolve(); },
        setSinkId: (id: string) => { sinks.push(id); return deferSink ? new Promise<void>((resolve) => { ready = resolve; }) : Promise.resolve(); },
      });
      return ctx;
    };
  }, deferSink);
}
async function renderLast(page: Page, waitSource = true) {
  if (waitSource) await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBeGreaterThan(0);
  return page.evaluate(async () => {
    const capture = (window as any).soundCapture;
    const ctx = capture.contexts.at(-1) as OfflineAudioContext;
    const samples = (await ctx.startRendering()).getChannelData(0);
    let peak = 0, energy = 0, tail = 0;
    for (let i = 0; i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
      energy += samples[i] ** 2;
      if (i >= 9600) tail += samples[i] ** 2;
    }
    return { peak, rms: Math.sqrt(energy / samples.length), tail: Math.sqrt(tail / (samples.length - 9600)) };
  });
}

test.beforeAll(async () => { stack = await startStack(); await register(stack.api, 'alice'); await register(stack.api, 'bob'); });
test.afterAll(async () => stack?.stop());

async function open(browser: Parameters<typeof openClient>[0], extra = {}) {
  const page = await openClient(browser, stack, 'alice', 'password123', async (page) => {
    await page.addInitScript((extra) => {
      if (!localStorage.getItem('tolktak.voice')) localStorage.setItem('tolktak.voice', JSON.stringify({ micMode: 'ptt', voiceVolume: 0.63, streamVolume: 1.42, ...extra }));
    }, extra);
  });
  await settings(page);
  return page;
}

test('interface volume has a legacy default and persists without changing voice or stream levels', async ({ browser }) => {
  const page = await open(browser);
  try {
    const slider = page.getByRole('slider', { name: volumeLabel, exact: true });
    await expect(slider).toHaveValue('0.7');
    await setVolume(page, 0.25);
    await expect(slider).toHaveAttribute('aria-valuetext', '25%');
    expect(await saved(page)).toMatchObject({ soundTheme: 'tok-tak', soundVolume: 0.25, voiceVolume: 0.63, streamVolume: 1.42 });
    await expect(page.getByRole('button', { name: 'Набор звуков', exact: true })).toHaveText('Ток-так');
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    await settings(page);
    await expect(page.getByRole('slider', { name: volumeLabel, exact: true })).toHaveValue('0.25');
  } finally { await page.context().close(); }
});

test('actual rendered tones follow interface volume and stay below clipping', async ({ browser }) => {
  const page = await open(browser);
  try {
    await captureAudio(page);
    const levels: number[] = [];
    for (const value of [1, 0.5, 0.25]) {
      await setVolume(page, value);
      await page.getByRole('button', { name: 'Проверить звук', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(levels.length + 1);
      const sound = await renderLast(page);
      expect(sound.peak).toBeGreaterThan(0);
      expect(sound.peak).toBeLessThan(0.4);
      levels.push(sound.rms);
    }
    expect(levels[1] / levels[0]).toBeCloseTo(0.5, 4);
    expect(levels[2] / levels[0]).toBeCloseTo(0.25, 4);
    expect(await page.evaluate(() => (window as any).soundCapture.closed.every(Boolean))).toBe(true);
  } finally { await page.context().close(); }
});

test('zero and sounds-off mute an existing signal and prevent new audio contexts', async ({ browser }) => {
  const page = await open(browser);
  try {
    await captureAudio(page);
    const button = page.getByRole('button', { name: 'Проверить звук', exact: true });
    await button.click();
    await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(1);
    await setVolume(page, 0);
    await expect(button).toBeDisabled();
    expect((await renderLast(page)).tail).toBeLessThan(1e-7);
    await page.evaluate(() => (window as any).__tolktak.toggleDeafen());
    expect(await page.evaluate(() => (window as any).soundCapture.contexts.length)).toBe(1);
    await setVolume(page, 0.7);
    await button.click();
    await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(2);
    await page.getByRole('checkbox', { name: /^Звуки интерфейса/ }).uncheck();
    await expect(button).toBeDisabled();
    expect((await renderLast(page)).tail).toBeLessThan(1e-7);
    await page.evaluate(() => (window as any).__tolktak.toggleDeafen());
    expect(await page.evaluate(() => (window as any).soundCapture.contexts.length)).toBe(2);
  } finally { await page.context().close(); }
});

test('muting during output-device selection cancels the pending signal', async ({ browser }) => {
  const page = await open(browser, { outputDevice: 'qa-speakers' });
  try {
    await captureAudio(page, true);
    await page.getByRole('button', { name: 'Проверить звук', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sinks)).toEqual(['qa-speakers']);
    await setVolume(page, 0);
    await page.evaluate(() => (window as any).soundCapture.ready());
    await expect.poll(() => page.evaluate(() => (window as any).soundCapture.closed[0])).toBe(true);
    expect((await renderLast(page, false)).peak).toBe(0);
  } finally { await page.context().close(); }
});

test('three sound themes preview different audio and the chosen theme persists', async ({ browser }) => {
  const page = await open(browser);
  try {
    await captureAudio(page);
    const durations = [];
    for (const [index, label] of ['Ток-так', 'Дерево ниже', 'Бархат'].entries()) {
      await page.getByRole('button', { name: 'Набор звуков', exact: true }).click();
      await expect(page.getByRole('option')).toHaveText(['Ток-так', 'Дерево ниже', 'Бархат']);
      await page.getByRole('option', { name: label, exact: true }).click();
      await page.getByRole('button', { name: 'Проверить звук', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(index + 1);
      expect((await renderLast(page)).peak).toBeGreaterThan(0.01);
      durations.push(await page.evaluate(() => (window as any).soundCapture.sources.at(-1).buffer.duration));
    }
    expect(new Set(durations).size).toBe(3);
    expect((await saved(page)).soundTheme).toBe('velvet');
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    await settings(page);
    await expect(page.getByRole('button', { name: 'Набор звуков', exact: true })).toHaveText('Бархат');
  } finally { await page.context().close(); }
});

test('an obsolete saved theme falls back to Tok-Tak', async ({ browser }) => {
  const page = await open(browser, { soundTheme: 'removed-theme', soundVolume: 5 });
  try {
    await expect(page.getByRole('button', { name: 'Набор звуков', exact: true })).toHaveText('Ток-так');
    await expect(page.getByRole('slider', { name: volumeLabel, exact: true })).toHaveValue('1');
  } finally { await page.context().close(); }
});

const playbackBundle = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/audio/sounds.ts')], bundle: true, write: false, format: 'iife', globalName: 'soundTest' }).outputFiles[0].text;
async function playbackFixture(page: Page) {
  await page.route('http://sounds.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<script src="/playback.js"></script>' });
    if (pathname === '/playback.js') return route.fulfill({ contentType: 'text/javascript', body: playbackBundle });
    const asset = pathname.replace(/^\/assets\//, '');
    if (!SOUND_ASSETS.includes(asset)) return route.abort();
    return route.fulfill({ body: readFileSync(path.join(__dirname, '../src/renderer/assets', asset)), contentType: 'audio/ogg' });
  });
  await page.goto('http://sounds.test/');
  await captureAudio(page);
  await page.evaluate(() => (window as any).soundTest.configureSounds({ sounds: true, soundVolume: .7, soundTheme: 'tok-tak', outputDevice: 'default' }));
}

test('ringing loops one phrase, stops, and switches theme without overlapping loops', async ({ page }) => {
  await playbackFixture(page);
  await page.evaluate(() => { (window as any).soundTest.ringing(true); (window as any).soundTest.ringing(true); });
  await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(1);
  expect(await page.evaluate(() => ({ loop: (window as any).soundCapture.sources[0].loop, duration: (window as any).soundCapture.sources[0].buffer.duration }))).toEqual({ loop: true, duration: 2.2 });
  await page.evaluate(() => (window as any).soundTest.ringing(false));
  expect((await renderLast(page)).tail).toBeLessThan(1e-7);
  await page.evaluate(() => (window as any).soundTest.ringing(true));
  await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(2);
  await page.evaluate(() => (window as any).soundTest.configureSounds({ sounds: true, soundVolume: .7, soundTheme: 'wood-low', outputDevice: 'default' }));
  await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(3);
  expect(await page.evaluate(() => (window as any).soundCapture.sources.at(-1).buffer.duration)).toBe(3.2);
  await page.evaluate(() => (window as any).soundTest.ringing(false));
  expect((await renderLast(page)).tail).toBeLessThan(1e-7);
  await page.evaluate(() => (window as any).soundCapture.contexts[1].startRendering());
  expect(await page.evaluate(() => (window as any).soundCapture.closed.every(Boolean))).toBe(true);
});

test('disabling and restoring interface sounds pauses and resumes a pending call', async ({ page }) => {
  await playbackFixture(page);
  await page.evaluate(() => (window as any).soundTest.ringing(true));
  await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(1);
  await page.evaluate(() => (window as any).soundTest.configureSounds({ sounds: false, soundVolume: .7, soundTheme: 'tok-tak', outputDevice: 'default' }));
  expect((await renderLast(page)).tail).toBeLessThan(1e-7);
  await page.evaluate(() => (window as any).soundTest.configureSounds({ sounds: true, soundVolume: .7, soundTheme: 'tok-tak', outputDevice: 'default' }));
  await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(2);
  await page.evaluate(() => { window.dispatchEvent(new Event('tolktak:session-reset')); });
  expect((await renderLast(page)).tail).toBeLessThan(1e-7);
});

test('background messages use the selected signal and silent OS notifications', async ({ browser }) => {
  const alice = await loginToken(stack.api, 'alice'), bob = await loginToken(stack.api, 'bob');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + alice };
  const bobMe = await (await fetch(stack.api + '/api/v1/me', { headers: { Authorization: 'Bearer ' + bob } })).json();
  const dm = await fetch(stack.api + '/api/v1/dms', { method: 'POST', headers, body: JSON.stringify({ user_id: bobMe.user.id }) });
  expect(dm.ok).toBe(true);
  const { channel } = await dm.json();
  const received: string[] = [];
  const page = await openClient(browser, stack, 'alice', 'password123', async page => {
    page.on('websocket', socket => socket.on('framereceived', event => received.push(String(event.payload))));
    await page.addInitScript(() => {
      const notifications: any[] = [];
      (window as any).notifications = notifications;
      (window as any).testFocused = true;
      document.hasFocus = () => (window as any).testFocused;
      (window as any).Notification = class {
        static permission = 'granted';
        constructor(title: string, options: NotificationOptions) { notifications.push({ title, ...options }); }
      };
    });
  });
  try {
    await expect.poll(() => received.some(frame => frame.includes('\"type\": \"hello\"') || frame.includes('\"type\":\"hello\"'))).toBe(true);
    await captureAudio(page);
    await page.evaluate(() => { (window as any).testFocused = false; window.dispatchEvent(new Event('blur')); });
    const send = async (token: string) => {
      const nonce = crypto.randomUUID();
      const response = await fetch(`${stack.api}/api/v1/channels/${channel.id}/messages`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + token }, body: JSON.stringify({ text: nonce, nonce }) });
      expect(response.ok).toBe(true);
      await expect.poll(() => received.some(frame => frame.includes(nonce))).toBe(true);
    };
    await send(bob);
    await expect.poll(() => page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(1);
    expect((await renderLast(page)).peak).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).notifications.map((n: any) => n.silent))).toEqual([true]);
    await page.evaluate(() => (window as any).__tolktak.setPrefs({ sounds: false }));
    await send(bob);
    expect(await page.evaluate(() => (window as any).notifications.map((n: any) => n.silent))).toEqual([true, true]);
    expect(await page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(1);
    await page.evaluate(() => { (window as any).__tolktak.setPrefs({ sounds: true }); (window as any).testFocused = true; window.dispatchEvent(new Event('focus')); });
    await send(bob);
    await send(alice);
    expect(await page.evaluate(() => (window as any).notifications.length)).toBe(2);
    expect(await page.evaluate(() => (window as any).soundCapture.sources.length)).toBe(1);
  } finally { await page.context().close(); }
});

test('Electron reads and decodes all three sound sets through the native asset bridge', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--no-sandbox', '--no-proxy-server'], env: { ...process.env, TOLKTAK_USER_DATA: mkdtempSync(path.join(tmpdir(), 'tt-sounds-')) } as Record<string, string> });
  try {
    const page = await mainWindow(app);
    const metrics = await page.evaluate(async ({ themes, kinds }) => {
      const decoder = new OfflineAudioContext(1, 1, 48000), result = [];
      for (const theme of themes) for (const kind of kinds) {
        const bytes = await (window as any).tolktak.readAsset(`sounds/${theme}/${kind}.ogg`);
        const buffer = await decoder.decodeAudioData(new Uint8Array(bytes).buffer);
        let peak = 0;
        for (const sample of buffer.getChannelData(0)) { if (!Number.isFinite(sample)) throw new Error('Non-finite sample'); peak = Math.max(peak, Math.abs(sample)); }
        result.push({ theme, kind, peak, duration: buffer.duration });
      }
      return result;
    }, { themes: SOUND_THEMES, kinds: SOUND_KINDS });
    expect(metrics).toHaveLength(33);
    for (const m of metrics) { expect(m.peak).toBeGreaterThan(0.01); expect(m.peak).toBeLessThan(0.5); }
    expect(metrics.filter(m => m.kind === 'ring').map(m => m.duration)).toEqual([2.2, 3.2, 2.4]);
    expect(await page.evaluate(() => (window as any).tolktak.readAsset('../package.json'))).toBeNull();
  } finally { await app.close(); }
});
