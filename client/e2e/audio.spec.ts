// The microphone plays speech with fan and keyboard noise, the other side measures what arrives.
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectFlowing, joinRoom, stats } from './helpers';
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
    body: JSON.stringify({ name: 'Звук', members: [ids.bob], room_name: 'Общая', channel_name: 'общий' }),
  });
});
test.afterAll(async () => stack?.stop());

function noisySpeechWav(): string {
  const wav = readFileSync(path.join(__dirname, 'fixtures/speech-16k.wav'));
  const at = wav.indexOf('data') + 8;
  const speech = new Int16Array(wav.buffer.slice(wav.byteOffset + at, wav.byteOffset + wav.length - ((wav.length - at) % 2)));
  const SR = 16000;
  const pause = 2 * SR;
  const len = 2 * (speech.length + pause);
  const x = new Float32Array(len);
  for (let r = 0; r < 2; r++) for (let i = 0; i < speech.length; i++) x[r * (speech.length + pause) + i] = (speech[i] / 32768) * 0.7;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  let brown = 0;
  let nextKey = 0;
  for (let i = 0; i < len; i++) {
    brown = 0.98 * brown + 0.2 * rnd();
    let n = brown * 0.05 + 0.01 * Math.sin((2 * Math.PI * 120 * i) / SR);
    if (i >= nextKey) nextKey = i + Math.round((0.1 + Math.abs(rnd()) * 0.4) * SR);
    const d = nextKey - i;
    if (d < 60) n += rnd() * 0.25 * (d / 60);
    x[i] += n;
  }
  const out = Buffer.alloc(44 + len * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + len * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(len * 2, 40);
  for (let i = 0; i < len; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tt-audio-')), 'noisy-speech.wav');
  writeFileSync(file, out);
  return file;
}

/** dBFS percentiles of 20 ms frames. */
function received(p: Page, from: number, seconds: number) {
  return p.evaluate(
    async ({ from, seconds }) => {
      const r = (globalThis as any).__tolktak.room;
      const part = [...r.remoteParticipants.values()].find((x: any) => x.identity === String(from));
      const pub = [...part.trackPublications.values()].find((t: any) => t.source === 'microphone');
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(new MediaStream([pub.track.mediaStreamTrack])).connect(an);
      const buf = new Float32Array(an.fftSize);
      const levels: number[] = [];
      await new Promise<void>((done) => {
        const t = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (const v of buf) s += v * v;
          levels.push(10 * Math.log10(s / buf.length + 1e-12));
          if (levels.length >= seconds * 50) (clearInterval(t), done());
        }, 20);
      });
      ctx.close();
      levels.sort((a, b) => a - b);
      const q = (f: number) => Math.round(levels[Math.floor(f * (levels.length - 1))] * 10) / 10;
      return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
    },
    { from, seconds },
  );
}

test('voice processing: noise suppression and leveller on the wire', async () => {
  test.skip(!process.env.DISPLAY, 'needs an X display (xvfb-run)');
  const wav = noisySpeechWav();
  const launch = async (user: string, mic?: string) => {
    const app = await electron.launch({
      args: [
        path.join(__dirname, '..'),
        '--no-sandbox',
        '--lang=ru',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--no-proxy-server',
        ...(mic ? [`--use-file-for-fake-audio-capture=${mic}`] : []),
      ],
      env: { ...process.env, TOLKTAK_USER_DATA: mkdtempSync(path.join(tmpdir(), 'tt-audio-')) } as Record<string, string>,
    });
    const w = await app.firstWindow();
    w.on('console', (m) => m.type() === 'error' && console.log(`[electron ${user}]`, m.text()));
    await w.fill('input[name=server]', stack.api);
    await w.fill('input[name=username]', user);
    await w.fill('input[name=password]', 'password123');
    await w.click('button[type=submit]');
    await expect(w.locator('.shell')).toBeVisible();
    return { app, w };
  };
  const { app, w: alice } = await launch('alice', wav);
  const { app: app2, w: bob } = await launch('bob');

  await alice.evaluate(() => (globalThis as any).__tolktak.setPrefs({ denoise: 'max' }));
  await alice.click('button[aria-label="Настройки"]');
  await alice.click('.settings-nav button:has-text("Голос")');
  await expect(alice.locator('.select:has-text("Максимальное")')).toBeVisible();
  await alice.click('button:has-text("Послушать себя")');
  await expect(alice.locator('.meter-gain').first()).toBeVisible({ timeout: 10_000 });
  // The pauses between words are silent after the strongest noise suppression.
  const fill = () => alice.locator('.meter-fill').first().evaluate((e) => parseFloat((e as HTMLElement).style.width));
  await expect.poll(fill, { message: 'meter moves with the processed voice', timeout: 5000 }).toBeGreaterThan(0);
  if (process.env.SHOWCASE_DIR) await alice.screenshot({ path: path.join(process.env.SHOWCASE_DIR, '20-voice-processing.png') });
  await alice.click('button:has-text("Остановить")');
  await alice.keyboard.press('Escape');

  // No real output devices here: setSinkId is recorded instead of applied.
  await bob.evaluate(() => {
    const sinks: string[] = ((globalThis as any).__sinks = []);
    (AudioContext.prototype as any).setSinkId = function (id: string) {
      sinks.push(id);
      Object.defineProperty(this, 'sinkId', { value: id, configurable: true });
      return Promise.resolve();
    };
    (globalThis as any).__tolktak.setPrefs({ outputDevice: 'tt-test-speakers' });
  });

  await joinRoom(alice, 'Звук');
  await joinRoom(bob, 'Звук');
  await expectFlowing(bob, ids.alice, 'microphone', 20);
  await expect.poll(() => bob.evaluate(() => (globalThis as any).__tolktak.room.audioContext?.sinkId), { message: 'voices play on the chosen output device' }).toBe('tt-test-speakers');
  await expect(bob.locator('.tile.speaking:has-text("alice")'), 'alice is shown speaking').toBeVisible({ timeout: 5000 });
  const processor = await alice.evaluate(() => (globalThis as any).__tolktak.room.localParticipant.getTrackPublication('microphone')?.track?.getProcessor()?.name);
  expect(processor).toBe('tolktak-voice');

  await bob.waitForTimeout(3000); // leveller settles
  const max = await received(bob, ids.alice, 12);

  const switchTo = async (denoise: string) => {
    await alice.evaluate(async (d) => {
      const t = (globalThis as any).__tolktak;
      t.setPrefs({ denoise: d });
      await t.restartMic();
    }, denoise);
    await bob.waitForTimeout(3000);
    return received(bob, ids.alice, 12);
  };
  const medium = await switchTo('medium');
  const light = await switchTo('light');
  const without = await switchTo('off');
  test.info().annotations.push({ type: 'levels', description: JSON.stringify({ max, medium, light, without }) });
  console.log('received levels', JSON.stringify({ max, medium, light, without }));

  for (const [name, r] of Object.entries({ max, medium, light })) {
    expect(r.p10, `${name}: noise in pauses is suppressed`).toBeLessThan(without.p10 - 15);
    expect(Math.abs(r.p90 - without.p90), `${name}: speech level is kept`).toBeLessThan(8);
  }

  // Deafened, nothing is received, but the SFU still reports her speaking.
  await bob.evaluate(() => (globalThis as any).__tolktak.toggleDeafen());
  const aliceIn = async () => (await stats(bob)).inbound.find((x) => x.from === String(ids.alice) && x.source === 'microphone');
  const packets = async () => (await aliceIn())?.packetsReceived ?? 0;
  await expect
    .poll(async () => { const a = await packets(); await bob.waitForTimeout(1000); return (await packets()) - a; }, { message: 'deafened: no voice packets arrive' })
    .toBeLessThan(3);
  await bob.waitForTimeout(2500);
  await expect(bob.locator('.tile.speaking:has-text("alice")'), 'deafened: alice still shown speaking').toBeVisible({ timeout: 10_000 });
  const t0 = Date.now();
  await bob.evaluate(() => (globalThis as any).__tolktak.toggleDeafen());
  try {
    await expect
      .poll(async () => { const a = await packets(); await bob.waitForTimeout(100); return (await packets()) - a; }, { message: 'sound back on: voice packets arrive', timeout: 10_000, intervals: [0] })
      .toBeGreaterThan(0);
  } catch (e) {
    console.log('after undeafen', JSON.stringify(await aliceIn()), await bob.evaluate((id) => {
      const p = (globalThis as any).__tolktak.room.remoteParticipants.get(id);
      return JSON.stringify([...p.trackPublications.values()].map((t: any) => ({ s: t.source, sub: t.isSubscribed, want: t.subscribed, muted: t.isMuted, track: !!t.track, enabled: t.isEnabled })));
    }, String(ids.alice)));
    throw e;
  }
  console.log('undeafen: voice packets again after', Date.now() - t0, 'ms');
  const back = await received(bob, ids.alice, 4);
  console.log('undeafen: received level', JSON.stringify(back));
  expect(back.p90, 'sound back on: voice is not silent').toBeGreaterThan(-40);

  await app2.close();
  await app.close();
});
