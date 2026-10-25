// RNNoise 0.2, bundled after the @jitsi/rnnoise-wasm glue with its `export default` removed.
/* global createRNNWasmModuleSync */
const FRAME = 480;
const BLOCK = 128;

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    try {
      this.m = createRNNWasmModuleSync();
      this.state = this.m._rnnoise_create(0);
      this.inPtr = this.m._malloc(FRAME * 4);
      this.outPtr = this.m._malloc(FRAME * 4);
    } catch (e) {
      this.state = 0;
      this.port.postMessage({ error: String(e) });
    }
    // A ring of 4 frames, as in @sapphi-red/web-noise-suppressor (MIT): ~0.7 ms extra delay, not a whole frame.
    this.ring = new Float32Array(FRAME * 4);
    this.write = 0;
    this.frameAt = FRAME * 2;
    this.vad = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;
    if (!this.state) {
      output.set(input);
      return true;
    }
    const ring = this.ring;
    const size = ring.length;
    ring.set(input, this.write);
    this.write = (this.write + BLOCK) % size;
    if (this.write === 128 || this.write === 512 || this.write === 1024 || this.write === 1536) {
      this.frameAt = (this.frameAt + FRAME) % size;
      // The heap moves when the module grows its memory.
      const at = this.inPtr >> 2;
      const o = this.outPtr >> 2;
      let heap = this.m.HEAPF32;
      for (let i = 0; i < FRAME; i++) heap[at + i] = ring[this.frameAt + i] * 32768;
      this.vad = this.m._rnnoise_process_frame(this.state, this.outPtr, this.inPtr);
      heap = this.m.HEAPF32;
      for (let i = 0; i < FRAME; i++) ring[this.frameAt + i] = heap[o + i] / 32768;
    }
    const read = (this.write + 1280) % size;
    output.set(ring.subarray(read, read + BLOCK));
    return true;
  }
}

registerProcessor('tolktak-rnnoise', RnnoiseProcessor);
