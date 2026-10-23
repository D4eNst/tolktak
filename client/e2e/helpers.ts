import { expect, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import type { Stack } from './stack';

export async function openClient(browser: Browser, stack: Stack, username: string, password = 'password123'): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'ru-RU', permissions: ['microphone', 'camera'] });
  await ctx.addInitScript({ path: path.join(__dirname, 'fake-display.js') });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${username} pageerror]`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.log(`[${username} console]`, m.text()));
  await page.goto(stack.web);
  await page.fill('input[name=server]', stack.api);
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await expect(page.locator('.shell')).toBeVisible();
  return page;
}

export type Stats = {
  outbound: { kind: string; source: string; width?: number; height?: number; fps?: number; bitrate?: number; encoder?: string; limitation?: string }[];
  inbound: { kind: string; source: string; from: string; width?: number; height?: number; fps?: number; bitrate?: number; framesDecoded?: number; totalSamplesReceived?: number; packetsReceived?: number; audioLevel?: number; freezeCount?: number }[];
};

export const stats = (p: Page) => p.evaluate(() => (globalThis as any).__tolktak.stats()) as Promise<Stats>;

export async function expectFlowing(p: Page, from: number, source: string, minDelta: number) {
  const pick = (s: Stats) => s.inbound.find((x) => x.from === String(from) && x.source === source);
  const metric = (x?: Stats['inbound'][number]) => (x ? (x.kind === 'video' ? (x.framesDecoded ?? 0) : (x.packetsReceived ?? 0)) : 0);
  try {
    await expect.poll(async () => metric(pick(await stats(p))), { timeout: 30_000 }).toBeGreaterThan(0);
  } catch (e) {
    console.log('stats at failure', JSON.stringify(await stats(p), null, 1));
    console.log(await p.evaluate(() => {
      const r = (globalThis as any).__tolktak.room;
      return JSON.stringify([...r.remoteParticipants.values()].map((x: any) => ({ id: x.identity, pubs: [...x.trackPublications.values()].map((t: any) => ({ s: t.source, sub: t.isSubscribed, muted: t.isMuted, hasTrack: !!t.track })) })));
    }));
    console.log(await p.evaluate(async () => {
      const r = (globalThis as any).__tolktak.room;
      const out: any[] = [];
      for (const x of r.remoteParticipants.values()) for (const t of x.trackPublications.values()) {
        const rep = await t.track?.receiver?.getStats();
        rep?.forEach((s: any) => { if (['transport', 'candidate-pair', 'local-candidate', 'remote-candidate'].includes(s.type)) out.push(s); });
      }
      return JSON.stringify(out);
    }));
    throw e;
  }
  const a = metric(pick(await stats(p)));
  await p.waitForTimeout(4000);
  const after = pick(await stats(p));
  if (metric(after) - a <= minDelta) console.log('slow flow', source, JSON.stringify(after), JSON.stringify((await stats(p)).inbound));
  expect(metric(after) - a, `${source} from ${from} must advance`).toBeGreaterThan(minDelta);
  // Received is not enough: remote audio must be played out.
  if (after?.kind === 'audio') expect(after.totalSamplesReceived ?? 0, `${source} from ${from} must be played`).toBeGreaterThan(0);
  return after!;
}

export async function joinRoom(p: Page, groupName: string, roomName = 'Общая') {
  await p.locator('.rail-btn.group', { hasText: groupName.slice(0, 2).toUpperCase() }).first().click();
  await p.locator('.room-join', { hasText: roomName }).click();
  await expect(p.locator('.stage')).toBeVisible();
  await expect(p.locator('.voicebar-call .dot.ok')).toBeVisible();
}

export async function expectFps(p: Page, from: number, source: string, minFps: number, timeout = 30_000) {
  let last = 0;
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const a = (await stats(p)).inbound.find((x) => x.from === String(from) && x.source === source)?.framesDecoded ?? 0;
        await p.waitForTimeout(1000);
        const b = (await stats(p)).inbound.find((x) => x.from === String(from) && x.source === source)?.framesDecoded ?? 0;
        last = b - a;
        return last;
      },
      { timeout, intervals: [0] },
    )
    .toBeGreaterThanOrEqual(minFps);
  return { fps: last, seconds: (Date.now() - t0) / 1000 };
}
