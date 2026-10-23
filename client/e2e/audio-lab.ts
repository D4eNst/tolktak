// TolkTak's microphone chain as shipped, in Chromium's OfflineAudioContext.
import type { Page } from '@playwright/test';
import type { Denoise } from '../src/renderer/audio/chain';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const gtcrnDir = 'node_modules/@sapphi-red/web-noise-suppressor/dist';

export type ChainSpec = { denoise: Denoise; voice?: boolean };

export type RenderResult = { out: Float32Array; ms: number; seconds: number };

const sources = () => ({
  voice: read('src/renderer/audio/voice-worklet.js'),
  light: read('node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js').replace(/export default createRNNWasmModuleSync;\s*$/, '') + '\n' + read('src/renderer/audio/rnnoise-worklet.js'),
  medium: read(`${gtcrnDir}/gtcrn/workletProcessor.js`),
  max: read('vendor/deepfilternet/df.js') + '\n' + read('src/renderer/audio/dfn-worklet.js'),
});

export async function openLab(page: Page) {
  await page.route('https://audio-lab.test/**', (r) => {
    const name = new URL(r.request().url()).pathname;
    const files: Record<string, string> = {
      '/df_bg.wasm': 'vendor/deepfilternet/df_bg.wasm',
      '/dfn-model': 'vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz',
      '/gtcrn.wasm': `${gtcrnDir}/gtcrn.wasm`,
    };
    if (files[name]) return r.fulfill({ contentType: 'application/octet-stream', body: readFileSync(path.join(root, files[name])) });
    return r.fulfill({ contentType: 'text/html', body: '<html></html>' });
  });
  await page.goto('https://audio-lab.test/'); // AudioWorklet needs a secure context
  await page.evaluate(async (src) => {
    const bin = (u: string) => fetch(u).then((r) => r.arrayBuffer());
    const [dfnWasm, dfnModel, gtcrnWasm] = await Promise.all(['/df_bg.wasm', '/dfn-model', '/gtcrn.wasm'].map(bin));
    (globalThis as any).lab = { src, dfnModule: await WebAssembly.compile(dfnWasm), dfnModel, gtcrnWasm };
  }, sources());
}

export async function render(page: Page, spec: ChainSpec, input: Float32Array): Promise<RenderResult> {
  const b64 = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64');
  const r = await page.evaluate(
    async ({ spec, b64 }) => {
      const lab = (globalThis as any).lab;
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const x = new Float32Array(raw.buffer);
      const SR = 48000;
      const ctx = new OfflineAudioContext(1, x.length, SR);
      const url = (code: string) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const modules = [spec.denoise !== 'off' && lab.src[spec.denoise], spec.voice && lab.src.voice].filter(Boolean);
      await Promise.all(modules.map((code: string) => ctx.audioWorklet.addModule(url(code))));
      const buf = ctx.createBuffer(1, x.length, SR);
      buf.copyToChannel(x, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const mono: AudioWorkletNodeOptions = { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] };
      let node: AudioNode = src;
      if (spec.denoise === 'light') node = node.connect(new AudioWorkletNode(ctx, 'tolktak-rnnoise', mono));
      if (spec.denoise === 'medium') {
        const dn = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/gtcrn', { processorOptions: { maxChannels: 1, wasmBinary: lab.gtcrnWasm.slice(0) } });
        // The GTCRN processor compiles its wasm asynchronously.
        await new Promise((r) => setTimeout(r, 300));
        node = node.connect(dn);
      }
      if (spec.denoise === 'max') {
        node = node.connect(new AudioWorkletNode(ctx, 'tolktak-deepfilter', { ...mono, processorOptions: { wasmModule: lab.dfnModule, model: lab.dfnModel.slice(0), attenuation: 100 } }));
      }
      if (spec.voice) node = node.connect(new AudioWorkletNode(ctx, 'tolktak-voice', { ...mono, numberOfInputs: 1, numberOfOutputs: 1, processorOptions: {} }));
      node.connect(ctx.destination);
      src.start();
      const t0 = performance.now();
      const y = (await ctx.startRendering()).getChannelData(0);
      const ms = performance.now() - t0;
      const bytes = new Uint8Array(y.buffer, y.byteOffset, y.byteLength);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { out: btoa(s), ms, seconds: x.length / SR };
    },
    { spec, b64 },
  );
  const out = Buffer.from(r.out, 'base64');
  return { out: new Float32Array(out.buffer, out.byteOffset, out.length / 4), ms: r.ms, seconds: r.seconds };
}

export function readWav(file: string): { x: Float32Array; rate: number } {
  const b = readFileSync(file);
  let p = 12;
  let rate = 0;
  let bits = 16;
  let fmt = 1;
  let ch = 1;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = b.readUInt16LE(p + 8);
      ch = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
      bits = b.readUInt16LE(p + 22);
    } else if (id === 'data') {
      const n = Math.floor(Math.min(size, b.length - p - 8) / (bits / 8) / ch);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = p + 8 + i * ch * (bits / 8);
        x[i] = fmt === 3 ? b.readFloatLE(o) : bits === 16 ? b.readInt16LE(o) / 32768 : b.readInt32LE(o) / 2147483648;
      }
      return { x, rate };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in ' + file);
}

export function upsample(x: Float32Array, factor: number): Float32Array {
  const taps = 32;
  const y = new Float32Array(x.length * factor);
  for (let i = 0; i < y.length; i++) {
    const t = i / factor;
    const c = Math.floor(t);
    let s = 0;
    for (let k = c - taps + 1; k <= c + taps; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = t - k;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / taps);
      s += x[k] * (d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)) * w;
    }
    y[i] = s;
  }
  return y;
}
