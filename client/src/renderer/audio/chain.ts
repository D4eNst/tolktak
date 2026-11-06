import rnnoiseGlue from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js?text';
import { GtcrnWorkletNode } from '@sapphi-red/web-noise-suppressor';
import gtcrnWorklet from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?text';
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?binary';
import dfnGlue from '../../../vendor/deepfilternet/df.js?text';
import { bridge } from '../bridge';
import dfnWorklet from './dfn-worklet.js?text';
import rnnoiseWorklet from './rnnoise-worklet.js?text';
import voiceWorklet from './voice-worklet.js?text';

/** light = RNNoise 0.2, medium = GTCRN, max = DeepFilterNet3. */
export type Denoise = 'off' | 'light' | 'medium' | 'max';
export type GateMode = 'open' | 'ptt' | 'threshold';

export type ChainSettings = {
  agc: boolean;
  inputGain: number; // dB
  mode: GateMode;
  threshold: number; // dBFS
  hold: number; // ms
  ptt?: boolean;
};

export type ChainStats = {
  level: number; // dBFS
  out: number; // dBFS
  gain: number; // dB
  open: boolean;
  speech: boolean;
};

const moduleUrls = new Map<string, string>();
function moduleUrl(name: string, code: string) {
  const cached = moduleUrls.get(name);
  if (cached) return cached;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  moduleUrls.set(name, url);
  return url;
}
const copyBuffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;
const MONO_OPTIONS: AudioWorkletNodeOptions = { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] };

let dfn: Promise<{ wasmModule: WebAssembly.Module; model: ArrayBuffer }> | undefined;
function loadDfn() {
  dfn ??= Promise.all([bridge.readAsset('dfn/df_bg.wasm').then((b) => WebAssembly.compile(copyBuffer(b))), bridge.readAsset('dfn/model.tar.gz')]).then(
    ([wasmModule, model]) => ({ wasmModule, model: copyBuffer(model) }),
  );
  dfn.catch(() => (dfn = undefined));
  return dfn;
}

export class VoiceChain {
  readonly ctx: AudioContext;
  readonly output: MediaStreamTrack;
  readonly denoise: Denoise;
  private readonly node: AudioWorkletNode;
  private readonly src: MediaStreamAudioSourceNode;
  private closed = false;

  private constructor(ctx: AudioContext, src: MediaStreamAudioSourceNode, node: AudioWorkletNode, denoise: Denoise) {
    this.ctx = ctx;
    this.src = src;
    this.node = node;
    this.denoise = denoise;
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    this.output = dest.stream.getAudioTracks()[0];
  }

  static async create(track: MediaStreamTrack, denoise: Denoise, settings: ChainSettings, gainDb: number | undefined, onStats: (s: ChainStats) => void) {
    // The noise models expect 48 kHz.
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    try {
      await ctx.audioWorklet.addModule(moduleUrl('voice', voiceWorklet));
      let denoiser: GtcrnWorkletNode | AudioWorkletNode | undefined;
      if (denoise === 'light') {
        await ctx.audioWorklet.addModule(moduleUrl('rnnoise', rnnoiseGlue.replace(/export default createRNNWasmModuleSync;\s*$/, '') + '\n' + rnnoiseWorklet));
        denoiser = new AudioWorkletNode(ctx, 'tolktak-rnnoise', MONO_OPTIONS);
      } else if (denoise === 'medium') {
        await ctx.audioWorklet.addModule(moduleUrl('gtcrn', gtcrnWorklet));
        denoiser = new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: copyBuffer(gtcrnWasm) });
      } else if (denoise === 'max') {
        const [assets] = await Promise.all([loadDfn(), ctx.audioWorklet.addModule(moduleUrl('dfn', dfnGlue + '\n' + dfnWorklet))]);
        denoiser = new AudioWorkletNode(ctx, 'tolktak-deepfilter', { ...MONO_OPTIONS, processorOptions: { ...assets, attenuation: 100 } });
      }
      const node = new AudioWorkletNode(ctx, 'tolktak-voice', { ...MONO_OPTIONS, numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { ...settings, gainDb } });
      node.port.onmessage = (e) => onStats(e.data as ChainStats);
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      if (denoiser) src.connect(denoiser).connect(node);
      else src.connect(node);
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      return new VoiceChain(ctx, src, node, denoise);
    } catch (e) {
      ctx.close().catch(() => {});
      throw e;
    }
  }

  set(patch: Partial<ChainSettings>) {
    if (!this.closed) this.node.port.postMessage(patch);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.src.disconnect();
    this.node.port.onmessage = null;
    this.output.stop();
    this.ctx.close().catch(() => {});
  }
}
