import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const worklet = readFileSync(path.join(__dirname, '../src/renderer/audio/voice-worklet.js'), 'utf8');
const wav = readFileSync(path.join(__dirname, 'fixtures/speech-16k.wav'));
const at = wav.indexOf('data') + 8;
const pcm = Array.from(new Int16Array(wav.buffer.slice(wav.byteOffset + at, wav.byteOffset + wav.length - ((wav.length - at) % 2))));

test('leveller: no blast after silence, no fade after a loud sound, quiet voices come up', async ({ page }) => {
  await page.route('https://worklet.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('https://worklet.test/'); // AudioWorklet needs a secure context
  const r = await page.evaluate(
    async ({ worklet, pcm }) => {
      const SR = 48000;
      const voice = new Float32Array(pcm.length * 3);
      for (let i = 0; i < voice.length; i++) {
        const j = i / 3;
        const a = pcm[Math.floor(j)] ?? 0;
        const b = pcm[Math.min(pcm.length - 1, Math.floor(j) + 1)] ?? 0;
        voice[i] = (a + (b - a) * (j % 1)) / 32768;
      }
      const F = 480;
      const fe: number[] = [];
      for (let f = 0; f + F <= voice.length; f += F) {
        let e = 0;
        for (let k = 0; k < F; k++) e += voice[f + k] ** 2;
        fe.push(e / F);
      }
      const maxE = Math.max(...fe);
      const isActive = (j: number) => (fe[Math.floor(j / F)] ?? 0) > maxE * 3e-4;
      let es = 0;
      let en = 0;
      for (const e of fe) if (e > maxE * 3e-4) (es += e, en++);
      const voiceRms = Math.sqrt(es / en);
      let seed = 3;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

      function synth(segs: [string, number, number?][]) {
        const total = segs.reduce((a, s) => a + s[1], 0);
        const x = new Float32Array(new ArrayBuffer(Math.round(total * SR) * 4));
        const active = new Uint8Array(x.length);
        let t = 0;
        let vpos = 0;
        for (const [kind, dur, db = -30] of segs) {
          const n0 = Math.round(t * SR);
          const n = Math.round(dur * SR);
          const g = Math.pow(10, db / 20);
          for (let k = 0; k < n; k++) {
            if (kind === 'voice') {
              const j = vpos++ % voice.length;
              x[n0 + k] = (voice[j] / voiceRms) * g;
              if (isActive(j)) active[n0 + k] = 1;
            } else if (kind === 'clap') {
              x[n0 + k] = Math.max(-1, Math.min(1, g * 2 * gauss() * Math.exp(-k / (0.03 * SR))));
              active[n0 + k] = 2;
            }
          }
          t += dur;
        }
        for (let i = 0; i < x.length; i++) x[i] += 3e-4 * gauss(); // -70 dBFS room noise
        return { x, active };
      }
      async function render(x: Float32Array<ArrayBuffer>) {
        const ctx = new OfflineAudioContext(1, x.length, SR);
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' })));
        const buf = ctx.createBuffer(1, x.length, SR);
        buf.copyToChannel(x, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(new AudioWorkletNode(ctx, 'tolktak-voice', { outputChannelCount: [1] })).connect(ctx.destination);
        src.start();
        return (await ctx.startRendering()).getChannelData(0);
      }
      const level = (s: { active: Uint8Array }, y: Float32Array, a: number, b: number) => {
        let e = 0;
        let n = 0;
        for (let i = Math.round(a * SR); i < Math.min(y.length, Math.round(b * SR)); i++) if (s.active[i] === 1) (e += y[i] ** 2, n++);
        return 10 * Math.log10(e / n + 1e-12);
      };
      const peak = (y: Float32Array) => 20 * Math.log10(y.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
      const out: Record<string, number> = {};
      {
        const s = synth([['voice', 8, -32], ['silence', 15], ['voice', 4, -32]]);
        const y = await render(s.x);
        out.silenceBefore = level(s, y, 4, 8);
        out.silenceAfter = level(s, y, 23, 23.7);
      }
      {
        const s = synth([['voice', 10, -30], ['clap', 0.2, -1], ['voice', 5, -30]]);
        const y = await render(s.x);
        out.clapBefore = level(s, y, 7, 10);
        out.clapAfter = level(s, y, 10.2, 11.2);
        out.clapPeak = peak(y);
      }
      {
        const s = synth([['voice', 12, -46]]);
        const y = await render(s.x);
        out.quietIn = level(s, s.x, 0, 12);
        out.quietOut = level(s, y, 6, 12);
      }
      {
        const s = synth([['voice', 6, -32], ['silence', 4], ['voice', 3, -8]]);
        const y = await render(s.x);
        out.shoutPeak = peak(y);
        out.shoutFirstSecond = level(s, y, 10, 11) - level(s, y, 3, 6);
      }
      return out;
    },
    { worklet, pcm },
  );
  test.info().annotations.push({ type: 'levels', description: JSON.stringify(r) });
  console.log('worklet levels', JSON.stringify(r, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
  expect(Math.abs(r.silenceAfter - r.silenceBefore), 'same loudness after a long silence').toBeLessThan(2);
  expect(Math.abs(r.clapAfter - r.clapBefore), 'no fade after a loud sound').toBeLessThan(2.5);
  expect(r.clapPeak, 'limiter ceiling').toBeLessThanOrEqual(-0.9);
  expect(r.quietOut - r.quietIn, 'quiet voice is lifted').toBeGreaterThan(15);
  expect(r.shoutPeak, 'no clipping when shouting').toBeLessThanOrEqual(-0.9);
  expect(r.shoutFirstSecond, 'a shout is tamed from the first second').toBeLessThan(12);
});
