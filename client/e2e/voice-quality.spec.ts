// Without uv the DNSMOS/PESQ/STOI part is skipped, not passed. TT_OUT=<dir> keeps the renders.
import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLab, readWav, render, upsample, type ChainSpec } from './audio-lab';

const SR = 48000;
const fx = (f: string) => upsample(readWav(path.join(__dirname, 'fixtures', f)).x, 3);
const PRESETS: Record<string, ChainSpec> = { off: { denoise: 'off' }, light: { denoise: 'light' }, medium: { denoise: 'medium' }, max: { denoise: 'max' } };
// ms of one core per 10 ms frame: CI runners are slow.
const CPU_BUDGET: Record<string, number> = { off: 0.2, light: 3, medium: 4, max: 15 };

const frameDb = (x: Float32Array, i: number) => {
  let e = 0;
  for (let k = 0; k < 480; k++) e += (x[i * 480 + k] ?? 0) ** 2;
  return 10 * Math.log10(e / 480 + 1e-12);
};
function activeLevel(x: Float32Array) {
  const n = Math.floor(x.length / 480);
  const db = Array.from({ length: n }, (_, i) => frameDb(x, i));
  const top = [...db].sort((a, b) => b - a)[Math.floor(n * 0.05)];
  const act = db.filter((d) => d > top - 35);
  return 10 * Math.log10(act.reduce((a, d) => a + 10 ** (d / 10), 0) / act.length);
}
function mix(clean: Float32Array, noise: Float32Array, levelDb: number, snrDb: number) {
  const g = 10 ** ((levelDb - activeLevel(clean)) / 20);
  const c = clean.map((v) => v * g);
  let en = 0;
  for (let i = 0; i < c.length; i++) en += noise[i % noise.length] ** 2;
  const gn = 10 ** ((levelDb - snrDb - 10 * Math.log10(en / c.length)) / 20);
  return { clean: c, noisy: c.map((v, i) => v + noise[i % noise.length] * gn) };
}
function lagOf(x: Float32Array, y: Float32Array) {
  const env = (z: Float32Array) => Array.from({ length: Math.floor(z.length / 48) }, (_, i) => z.subarray(i * 48, i * 48 + 48).reduce((a, v) => a + v * v, 0));
  const a = env(x);
  const b = env(y);
  let best = 0;
  let lag = 0;
  for (let L = 0; L <= 100; L++) {
    let s = 0;
    for (let i = 0; i + L < b.length; i++) s += Math.sqrt(a[i] * b[i + L]);
    if (s > best) (best = s, lag = L);
  }
  return lag * 48;
}
function speechAndPauses(clean: Float32Array, noisy: Float32Array, y: Float32Array) {
  const lag = lagOf(clean, y);
  const n = Math.floor((clean.length - lag) / 480);
  const dc = Array.from({ length: n }, (_, i) => frameDb(clean, i));
  const top = [...dc].sort((a, b) => b - a)[Math.floor(n * 0.05)];
  let sc = 0, so = 0, pn = 0, po = 0;
  for (let i = 0; i < n; i++) {
    const o = y.subarray(lag + i * 480, lag + i * 480 + 480).reduce((a, v) => a + v * v, 0);
    if (dc[i] > top - 20) (sc += 10 ** (dc[i] / 10) * 480, so += o);
    else if (dc[i] < top - 50) (pn += 10 ** (frameDb(noisy, i) / 10) * 480, po += o);
  }
  return { speechDb: 10 * Math.log10(so / sc + 1e-12), noiseDb: 10 * Math.log10(po / pn + 1e-12), lagMs: lag / 48 };
}
function wav16(file: string, x: Float32Array) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(file, b);
}

test('noise suppression presets: speech kept, noise removed, objective scores, CPU', async ({ page }) => {
  test.setTimeout(600_000);
  await openLab(page);
  const out = process.env.TT_OUT ? path.join(process.env.TT_OUT, 'voice-quality') : mkdtempSync(path.join(tmpdir(), 'tt-vq-'));
  mkdirSync(out, { recursive: true });
  const s0 = fx('dns-clean-0.wav');
  const s1 = fx('dns-clean-101.wav');
  const kbd = fx('noise-keyboard.wav');
  const fan = fx('noise-fan.wav');
  const cases = {
    kbd10: mix(s0, kbd, -26, 10),
    fan5: mix(s1, fan, -26, 5),
    quiet50: mix(s0, fan, -50, 20),
    quiet60: mix(s1, fan, -60, 20),
  };
  const res: Record<string, Record<string, ReturnType<typeof speechAndPauses> & { cpuMs: number }>> = {};
  for (const [c, m] of Object.entries(cases)) wav16(path.join(out, `${c}.clean.wav`), m.clean);
  for (const [preset, spec] of Object.entries(PRESETS)) {
    res[preset] = {};
    for (const [c, m] of Object.entries(cases)) {
      const r = await render(page, spec, m.noisy);
      res[preset][c] = { ...speechAndPauses(m.clean, m.noisy, r.out), cpuMs: r.ms / (r.seconds * 100) };
      // Scored at a normal level: DNSMOS judges the processing, not the loudness.
      const g = c.startsWith('quiet') ? 10 ** ((-26 - (c === 'quiet50' ? -50 : -60)) / 20) : 1;
      wav16(path.join(out, `${preset}.${c}.wav`), g === 1 ? r.out : r.out.map((v) => v * g));
      if (g !== 1) wav16(path.join(out, `${c}.clean.wav`), m.clean.map((v) => v * g));
    }
  }
  const round = (o: unknown) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));
  console.log('voice-quality', JSON.stringify(round(res)));
  writeFileSync(path.join(out, 'voice-quality.json'), JSON.stringify(round(res), null, 1));
  for (const [preset, cs] of Object.entries(res)) {
    for (const [c, r] of Object.entries(cs)) {
      // Max still costs 7-9 dB here: the guard is against deleting quiet speech.
      expect(r.speechDb, `${preset} ${c}: speech kept`).toBeGreaterThan(c.startsWith('quiet') ? (preset === 'max' ? -12 : -6) : -4);
      if (preset !== 'off' && !c.startsWith('quiet')) expect(r.noiseDb, `${preset} ${c}: noise removed in pauses`).toBeLessThan(-10);
      expect(r.cpuMs, `${preset} CPU per 10 ms frame`).toBeLessThan(CPU_BUDGET[preset]);
    }
  }

  const uv = spawnSync('uv', ['--version']);
  test.skip(uv.status !== 0, 'uv not installed: DNSMOS/PESQ part skipped');
  const project = path.join(__dirname, '../../tools/voice-scores');
  const log = execFileSync('uv', ['run', '--project', project, 'python', 'score.py', out], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(log);
  expect(log).toContain('all objective thresholds met');
});
