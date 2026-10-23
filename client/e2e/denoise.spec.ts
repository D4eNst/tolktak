// The model alone removed speech below about -50 dBFS.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const worklet = readFileSync(path.join(root, 'vendor/deepfilternet/df.js'), 'utf8') + '\n' + readFileSync(path.join(root, 'src/renderer/audio/dfn-worklet.js'), 'utf8');
const wav = readFileSync(path.join(__dirname, 'fixtures/speech-16k.wav'));
const at = wav.indexOf('data') + 8;
const pcm = Array.from(new Int16Array(wav.buffer.slice(wav.byteOffset + at, wav.byteOffset + wav.length - ((wav.length - at) % 2))));

test('max noise suppression keeps quiet speech and removes noise', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('https://worklet.test/**', (r) => {
    const name = new URL(r.request().url()).pathname;
    if (name === '/df_bg.wasm') return r.fulfill({ contentType: 'application/wasm', body: readFileSync(path.join(root, 'vendor/deepfilternet/df_bg.wasm')) });
    if (name === '/model') return r.fulfill({ contentType: 'application/octet-stream', body: readFileSync(path.join(root, 'vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz')) });
    return r.fulfill({ contentType: 'text/html', body: '<html></html>' });
  });
  await page.goto('https://worklet.test/'); // AudioWorklet needs a secure context
  const result = await page.evaluate(
    async ({ worklet, pcm }) => {
      const SR = 48000;
      const [wasmModule, model] = await Promise.all([
        fetch('/df_bg.wasm').then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)),
        fetch('/model').then((r) => r.arrayBuffer()),
      ]);
      const url = URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' }));
      const voice = new Float32Array(pcm.length * 3);
      for (let i = 0; i < voice.length; i++) voice[i] = (pcm[Math.floor(i / 3)] ?? 0) / 32768;
      const run = async (speechDb: number, noiseDb: number) => {
        const lead = 2 * SR;
        const n = lead + voice.length;
        const ctx = new OfflineAudioContext(1, n, SR);
        await ctx.audioWorklet.addModule(url);
        const buf = ctx.createBuffer(1, n, SR);
        const x = buf.getChannelData(0);
        let peak = 0;
        for (const v of voice) peak = Math.max(peak, Math.abs(v));
        const gs = Math.pow(10, speechDb / 20) / peak;
        const gn = Math.pow(10, noiseDb / 20) * Math.sqrt(3);
        let seed = 7;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
        const isSpeech = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const v = i >= lead ? voice[i - lead] * gs : 0;
          x[i] = v + rnd() * gn;
          isSpeech[i] = Math.abs(v) > Math.pow(10, (speechDb - 20) / 20) ? 1 : 0;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const dn = new AudioWorkletNode(ctx, 'tolktak-deepfilter', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1], processorOptions: { wasmModule, model, attenuation: 100 } });
        src.connect(dn).connect(ctx.destination);
        src.start();
        const y = (await ctx.startRendering()).getChannelData(0);
        const delay = 960 + 128;
        let si = 0, so = 0, ni = 0, no = 0;
        for (let i = SR / 2; i + delay < n; i++) {
          if (i < lead - SR / 4) (ni += x[i] ** 2, no += y[i + delay] ** 2);
          else if (isSpeech[i]) (si += x[i] ** 2, so += y[i + delay] ** 2);
        }
        const db = (a: number, b: number) => Math.max(-120, 10 * Math.log10(a / b + 1e-12));
        return { speech: db(so, si), noise: db(no, ni) };
      };
      return { normal: await run(-6, -55), quiet: await run(-40, -80) };
    },
    { worklet, pcm },
  );
  console.log('denoise', JSON.stringify(result));
  for (const [name, r] of Object.entries(result)) {
    expect(r.speech, `${name}: speech is kept`).toBeGreaterThan(-6);
    expect(r.noise, `${name}: noise is removed`).toBeLessThan(-15);
  }
});
