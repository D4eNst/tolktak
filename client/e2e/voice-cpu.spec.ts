// Render time over the number of 10 ms frames is CPU time per frame on one core.
// The budgets catch a lost SIMD build or a much slower model, not noise.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLab, readWav, render, upsample, type ChainSpec } from './audio-lab';

const BUDGET_MS: Record<string, number> = { off: 0.2, voice: 0.3, light: 3, medium: 4, max: 12, 'max+voice': 12.5 };

test('noise suppression CPU per 10 ms frame', async () => {
  test.setTimeout(300_000);
  test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs an X display (xvfb-run)');
  const app = await electron.launch({ args: [path.join(__dirname, 'lab/main.cjs'), '--no-sandbox'] });
  const page = await app.firstWindow();
  await openLab(page);
  const speech = upsample(readWav(path.join(__dirname, 'fixtures/speech-16k.wav')).x, 3);
  const x = new Float32Array(48000 * 20);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  let brown = 0;
  for (let i = 0; i < x.length; i++) {
    brown = 0.98 * brown + 0.2 * rnd();
    x[i] = (speech[i % (speech.length + 24000)] ?? 0) * 0.5 + brown * 0.02;
  }
  const specs: Record<string, ChainSpec> = {
    off: { denoise: 'off' },
    voice: { denoise: 'off', voice: true },
    light: { denoise: 'light' },
    medium: { denoise: 'medium' },
    max: { denoise: 'max' },
    'max+voice': { denoise: 'max', voice: true },
  };
  const result: Record<string, { msPerFrame: number; runs: number[] }> = {};
  for (const [name, spec] of Object.entries(specs)) {
    await render(page, spec, x.subarray(0, 48000)); // warm-up
    const runs: number[] = [];
    for (let k = 0; k < 5; k++) runs.push((await render(page, spec, x)).ms / (x.length / 480));
    runs.sort((a, b) => a - b);
    result[name] = { msPerFrame: +runs[2].toFixed(3), runs: runs.map((v) => +v.toFixed(3)) };
  }
  const info = {
    engine: await page.evaluate(() => navigator.userAgent),
    cpu: os.cpus()[0]?.model,
    threads: os.cpus().length,
    platform: `${process.platform} ${os.release()}`,
    load: os.loadavg(),
    note: 'median of 5 offline renders of 20 s; ms of one core per 10 ms frame (10 ms = 100 % of a core)',
  };
  await app.close();
  console.log('voice-cpu', JSON.stringify({ info, result }));
  test.info().annotations.push({ type: 'voice-cpu', description: JSON.stringify(result) });
  if (process.env.TT_OUT) {
    mkdirSync(process.env.TT_OUT, { recursive: true });
    writeFileSync(path.join(process.env.TT_OUT, 'voice-cpu.json'), JSON.stringify({ info, result }, null, 1));
  }
  for (const [name, r] of Object.entries(result)) expect(r.msPerFrame, `${name} CPU per 10 ms frame`).toBeLessThan(BUDGET_MS[name]);
});
