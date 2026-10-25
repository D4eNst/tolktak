import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectFlowing, joinRoom } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
const ids: Record<string, number> = {};

test.beforeAll(async () => {
  stack = await startStack();
  for (const u of ['alice', 'bob']) ids[u] = (await register(stack.api, u)).user.id;
  const t = await loginToken(stack.api, 'alice');
  await fetch(stack.api + '/api/v1/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify({ name: 'Электрон', members: [ids.bob], room_name: 'Общая', channel_name: 'общий' }),
  });
});
test.afterAll(async () => stack?.stop());

test('Electron client: login, voice, window share via own picker, H.264', async () => {
  test.skip(!process.env.DISPLAY, 'needs an X display (xvfb-run)');
  const launch = async (user: string) => {
    const app = await electron.launch({
      args: [path.join(__dirname, '..'), '--no-sandbox', '--lang=ru', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-proxy-server'],
      env: { ...process.env, TOLKTAK_USER_DATA: mkdtempSync(path.join(tmpdir(), 'tt-electron-')) } as Record<string, string>,
    });
    const w = await app.firstWindow();
    w.on('console', (m) => m.type() === 'error' && console.log(`[electron ${user}]`, m.text()));
    // Both windows share one desktop, and the one without focus would hide video to save power.
    await w.evaluate(() => localStorage.setItem('tolktak.voice', JSON.stringify({ backgroundSaver: false })));
    await w.reload();
    await w.fill('input[name=server]', stack.api);
    await w.fill('input[name=username]', user);
    await w.fill('input[name=password]', 'password123');
    await w.click('button[type=submit]');
    await expect(w.locator('.shell')).toBeVisible();
    return { app, w };
  };
  const { app, w: win } = await launch('alice');
  const info = await win.evaluate(() => (window as any).tolktak.appInfo());
  test.info().annotations.push({ type: 'electron', description: JSON.stringify(info) });
  const { app: app2, w: bob } = await launch('bob');
  await joinRoom(win, 'Электрон');
  await joinRoom(bob, 'Электрон');
  await expectFlowing(bob, ids.alice, 'microphone', 20);

  await bob.click('button[aria-label="Камера"]');
  await expect(win.locator('.tile video')).toHaveCount(1);
  await win.click('button[aria-label="Демонстрация"]');
  await win.click('.tabs button:has-text("Экраны")');
  await expect(win.locator('.source').first()).toBeVisible();
  const n = await win.locator('.source').count();
  await win.locator('.source').first().click();
  await win.locator('.share-options input[type=checkbox]').first().uncheck(); // no audio capture on Linux
  await win.click('.modal button.primary');
  await expect(win.locator('.stream-card')).toHaveCount(1);
  await bob.locator('.stream-card').click();
  await expectFlowing(bob, ids.alice, 'screen_share', 40);
  const series: string[] = [];
  for (let i = 0; i < 12; i++) {
    await win.waitForTimeout(1000);
    const o = (await win.evaluate(() => (globalThis as any).__tolktak.stats())).outbound.filter((x: any) => x.source === 'screen_share' && x.width);
    series.push(o.map((x: any) => `${x.width}x${x.height}@${x.fps}/${Math.round((x.bitrate ?? 0) / 1000)}k/${x.limitation}`).join(' '));
  }
  test.info().annotations.push({ type: 'series', description: series.join(' | ') });
  const v = await expectFlowing(bob, ids.alice, 'screen_share', 40);
  const out = (await win.evaluate(() => (globalThis as any).__tolktak.stats())).outbound.filter((o: any) => o.source === 'screen_share');
  test.info().annotations.push({ type: 'share', description: JSON.stringify({ sources: n, inbound: v, outbound: out }) });
  expect(out.some((o: any) => /openh264|h264|MediaFoundation/i.test(o.encoder ?? '')), 'Electron must encode H.264').toBeTruthy();
  // Constrained Baseline 42e01f would be software-only on Windows.
  expect(out.every((o: any) => /profile-level-id=42001f/.test(o.codec ?? '')), 'H.264 Baseline 42001f negotiated').toBeTruthy();
  await app2.close();
  await app.close();
});
