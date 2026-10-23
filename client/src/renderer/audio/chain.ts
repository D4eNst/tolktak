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

const urls = new Map<string, string>();
function moduleUrl(name: string, code: string) {
  let u = urls.get(name);
  if (!u) urls.set(name, (u = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))));
  return u;
}
const copy = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const MONO: AudioWorkletNodeOptions = { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] };

let dfn: Promise<{ wasmModule: WebAssembly.Module; model: ArrayBuffer }> | undefined;
function loadDfn() {
  dfn ??= Promise.all([bridge.readAsset('dfn/df_bg.wasm').then((b) => WebAssembly.compile(copy(b))), bridge.readAsset('dfn/model.tar.gz')]).then(
    ([wasmModule, model]) => ({ wasmModule, model: copy(model) }),
  );
  dfn.catch(() => (dfn = undefined));
  return dfn;
}

export class VoiceChain {
  readonly ctx: AudioContext;
  readonly output: MediaStreamTrack;
  readonly denoise: Denoise;
  private readonly node: AudioWorkletNode;
  private readonly dn?: GtcrnWorkletNode | AudioWorkletNode;
  private readonly src: MediaStreamAudioSourceNode;
  private closed = false;

  private constructor(ctx: AudioContext, src: MediaStreamAudioSourceNode, node: AudioWorkletNode, dn: VoiceChain['dn'], denoise: Denoise) {
    this.ctx = ctx;
    this.src = src;
    this.node = node;
    this.dn = dn;
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
      let dn: VoiceChain['dn'];
      if (denoise === 'light') {
        await ctx.audioWorklet.addModule(moduleUrl('rnnoise', rnnoiseGlue.replace(/export default createRNNWasmModuleSync;\s*$/, '') + '\n' + rnnoiseWorklet));
        dn = new AudioWorkletNode(ctx, 'tolktak-rnnoise', MONO);
      } else if (denoise === 'medium') {
        await ctx.audioWorklet.addModule(moduleUrl('gtcrn', gtcrnWorklet));
        dn = new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: copy(gtcrnWasm) });
      } else if (denoise === 'max') {
        const [assets] = await Promise.all([loadDfn(), ctx.audioWorklet.addModule(moduleUrl('dfn', dfnGlue + '\n' + dfnWorklet))]);
        dn = new AudioWorkletNode(ctx, 'tolktak-deepfilter', { ...MONO, processorOptions: { ...assets, attenuation: 100 } });
      }
      const node = new AudioWorkletNode(ctx, 'tolktak-voice', { ...MONO, numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { ...settings, gainDb } });
      node.port.onmessage = (e) => onStats(e.data as ChainStats);
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      if (dn) src.connect(dn).connect(node);
      else src.connect(node);
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      return new VoiceChain(ctx, src, node, dn, denoise);
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
    if (this.dn && 'destroy' in this.dn) this.dn.destroy();
    else {
      this.dn?.port.postMessage('destroy');
      this.dn?.disconnect();
    }
    this.output.stop();
    this.ctx.close().catch(() => {});
  }
}
