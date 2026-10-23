// DeepFilterNet3, bundled after vendor/deepfilternet/df.js.
// The model removes speech below about -50 dBFS: each frame is raised before it and lowered after.
/* global wasm_bindgen */
const BLOCK = 128;

class DeepFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmModule, model, attenuation } = options.processorOptions;
    try {
      wasm_bindgen.initSync(wasmModule);
      this.state = wasm_bindgen.df_create(new Uint8Array(model), attenuation);
      this.frame = wasm_bindgen.df_get_frame_length(this.state);
    } catch (e) {
      this.state = 0;
      this.port.postMessage({ error: String(e) });
    }
    const size = (this.frame || 480) * 4;
    this.input = new Float32Array(size);
    this.output = new Float32Array(size);
    this.chunk = new Float32Array(this.frame || 480);
    this.inWrite = this.inRead = this.outWrite = this.outRead = 0;
    this.peakDb = -30; // dB, rises fast, falls 3 dB/s
    this.preDb = 0;
  }

  preGain(frame) {
    let e = 0;
    for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    const db = 10 * Math.log10(e / frame.length + 1e-12);
    if (db > this.peakDb) this.peakDb += (db - this.peakDb) * 0.3;
    else this.peakDb = Math.max(-75, this.peakDb - 0.03);
    const want = Math.max(0, Math.min(30, -24 - this.peakDb));
    this.preDb = want > this.preDb ? Math.min(want, this.preDb + 0.1) : Math.max(want, this.preDb - 3);
    return Math.pow(10, this.preDb / 20);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;
    if (!this.state) {
      output.set(input);
      return true;
    }
    const size = this.input.length;
    for (let i = 0; i < input.length; i++) {
      this.input[this.inWrite] = input[i];
      this.inWrite = (this.inWrite + 1) % size;
    }
    while ((this.inWrite - this.inRead + size) % size >= this.frame) {
      for (let i = 0; i < this.frame; i++) {
        this.chunk[i] = this.input[this.inRead];
        this.inRead = (this.inRead + 1) % size;
      }
      const g = this.preGain(this.chunk);
      for (let i = 0; i < this.frame; i++) this.chunk[i] *= g;
      const clean = wasm_bindgen.df_process_frame(this.state, this.chunk);
      for (let i = 0; i < clean.length; i++) {
        this.output[this.outWrite] = clean[i] / g;
        this.outWrite = (this.outWrite + 1) % size;
      }
    }
    if ((this.outWrite - this.outRead + size) % size >= BLOCK) {
      for (let i = 0; i < BLOCK; i++) {
        output[i] = this.output[this.outRead];
        this.outRead = (this.outRead + 1) % size;
      }
    }
    return true;
  }
}

registerProcessor('tolktak-deepfilter', DeepFilterProcessor);
