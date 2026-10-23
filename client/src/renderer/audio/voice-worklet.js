// Chain: high-pass 80 Hz, leveller, compressor, 5 ms look-ahead limiter, gate.
// The leveller's gain moves only during speech: no blast after silence, no dip after a cough.

const dbToLin = (db) => Math.pow(10, db / 20);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

class TolkTakVoice extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const sr = sampleRate;
    this.frameLen = Math.round(sr / 100);

    this.agc = o.agc !== false;
    this.inputGain = o.inputGain || 0; // dB, used when the leveller is off
    this.mode = o.mode || 'open';
    this.ptt = !!o.ptt;
    this.threshold = o.threshold ?? -50;
    this.hold = o.hold ?? 350;
    this.target = -21; // dBFS
    this.maxGain = 24;
    this.minGain = -14;

    const w = (2 * Math.PI * 80) / sr;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.hb0 = (1 + cos) / 2 / a0;
    this.hb1 = -(1 + cos) / a0;
    this.hb2 = (1 + cos) / 2 / a0;
    this.ha1 = (-2 * cos) / a0;
    this.ha2 = (1 - alpha) / a0;
    this.hx1 = this.hx2 = this.hy1 = this.hy2 = 0;

    // A gain learned in an earlier call is a better start than 0.
    this.gainDb = clamp(o.gainDb ?? 0, this.minGain, this.maxGain);
    this.speechDb = this.target - this.gainDb;
    this.noiseDb = -65;
    this.learned = o.gainDb !== undefined ? 150 : 0; // speech frames seen
    this.loudRun = 0;
    this.speechHang = 0;
    this.curGain = dbToLin(this.agc ? this.gainDb : this.inputGain);

    this.acc = 0;
    this.n = 0;
    this.outAcc = 0;
    this.frames = 0;
    this.lastLevel = -100;
    this.lastOut = -100;

    this.compEnv = 0;
    this.compGain = 1;
    this.compAtt = 1 - Math.exp(-1 / (0.004 * sr));
    this.compRel = 1 - Math.exp(-1 / (0.05 * sr));
    this.compThr = this.target + 5; // dB RMS
    this.compRatio = 4;

    this.la = Math.round(0.005 * sr);
    this.size = this.la + 1;
    this.delay = new Float32Array(this.size);
    this.need = new Float32Array(this.size);
    this.dq = new Int32Array(this.size + 1); // monotonic deque of indexes into `need`
    this.dqHead = 0;
    this.dqLen = 0;
    this.pos = 0;
    this.limGain = 1;
    this.limAtt = 1 - Math.exp(-1 / (0.0012 * sr));
    this.limRel = 1 - Math.exp(-1 / (0.08 * sr));
    this.ceiling = dbToLin(-1);
    for (let i = 0; i < this.size; i++) this.need[i] = 1;

    this.gate = this.mode === 'open' ? 1 : 0;
    this.gateOpen = this.mode === 'open';
    this.lastVoice = -1e9;
    this.gateAtt = 1 - Math.exp(-1 / (0.003 * sr));
    this.gateRel = 1 - Math.exp(-1 / (0.025 * sr));
    this.time = 0; // ms

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.agc !== undefined) this.agc = !!m.agc;
      if (m.inputGain !== undefined) this.inputGain = m.inputGain;
      if (m.mode !== undefined) this.mode = m.mode;
      if (m.ptt !== undefined) this.ptt = !!m.ptt;
      if (m.threshold !== undefined) this.threshold = m.threshold;
      if (m.hold !== undefined) this.hold = m.hold;
    };
  }

  frame(levelDb) {
    // Noise floor rises 1 dB/s at most: speech must not lift it.
    if (levelDb < this.noiseDb) this.noiseDb += (levelDb - this.noiseDb) * 0.3;
    else this.noiseDb += Math.min(levelDb - this.noiseDb, 0.01);
    this.noiseDb = clamp(this.noiseDb, -100, -25);

    const isSpeech = levelDb > -62 && levelDb > this.noiseDb + 9;
    if (isSpeech) this.speechHang = 25;
    else if (this.speechHang > 0) this.speechHang--;
    this.speech = this.speechHang > 0;

    if (isSpeech && this.agc) {
      // Bursts far above the speech envelope are transients, not a new level.
      const d = levelDb - this.speechDb;
      let w;
      if (d > 10) {
        this.loudRun += 1;
        w = this.loudRun > 30 ? 0.08 : 0.002;
      } else {
        if (this.loudRun > 0) this.loudRun -= 0.5;
        w = d > 0 ? 0.06 : 0.012;
      }
      this.speechDb += d * w;
      this.learned++;
      // Up 3 dB/s, down 20 dB/s, faster while learning a new voice.
      const want = clamp(this.target - this.speechDb, this.minGain, this.maxGain);
      const fast = this.learned < 150 ? 4 : 1;
      const step = want > this.gainDb ? 0.03 * fast : -0.2 * fast;
      if (want > this.gainDb) this.gainDb = Math.min(want, this.gainDb + step);
      else this.gainDb = Math.max(want, this.gainDb + step);
    }

    let voice;
    if (this.mode === 'ptt') voice = this.ptt;
    else if (this.mode === 'threshold') voice = levelDb > this.threshold;
    else voice = true;
    if (voice) this.lastVoice = this.time;
    this.gateOpen = voice || this.time - this.lastVoice < this.hold;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const o = out[0];
    const len = o.length;
    if (!input) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }
    const msPerSample = 1000 / sampleRate;
    const targetGain = dbToLin(this.agc ? this.gainDb : this.inputGain);
    const gTarget = this.gateOpen ? 1 : 0;
    const gCoef = this.gateOpen ? this.gateAtt : this.gateRel;
    const size = this.size;

    for (let i = 0; i < len; i++) {
      const x0 = input[i];
      const y = this.hb0 * x0 + this.hb1 * this.hx1 + this.hb2 * this.hx2 - this.ha1 * this.hy1 - this.ha2 * this.hy2;
      this.hx2 = this.hx1;
      this.hx1 = x0;
      this.hy2 = this.hy1;
      this.hy1 = y;

      this.acc += y * y;
      if (++this.n === this.frameLen) {
        const lvl = 10 * Math.log10(this.acc / this.n + 1e-12);
        this.lastLevel = lvl;
        this.lastOut = 10 * Math.log10(this.outAcc / this.n + 1e-12);
        this.acc = 0;
        this.outAcc = 0;
        this.n = 0;
        this.frame(lvl);
        if (++this.frames % 3 === 0) {
          this.port.postMessage({ level: this.lastLevel, out: this.lastOut, gain: this.agc ? this.gainDb : this.inputGain, open: this.gateOpen, speech: this.speech });
        }
      }

      // Smoothed against zipper noise.
      this.curGain += (targetGain - this.curGain) * 0.0005;
      let s = y * this.curGain;

      this.compEnv += (s * s - this.compEnv) * (s * s > this.compEnv ? this.compAtt : this.compRel);
      if ((i & 15) === 0) {
        const envDb = 10 * Math.log10(this.compEnv + 1e-12);
        const over = envDb - this.compThr;
        this.compGain = over > 0 ? dbToLin(-over * (1 - 1 / this.compRatio)) : 1;
      }
      s *= this.compGain;

      const a = Math.abs(s);
      const need = a > this.ceiling ? this.ceiling / a : 1;
      const p = this.pos;
      const Q = size + 1;
      if (this.dqLen > 0 && this.dq[this.dqHead] === p) {
        this.dqHead = (this.dqHead + 1) % Q;
        this.dqLen--;
      }
      this.need[p] = need;
      while (this.dqLen > 0 && this.need[this.dq[(this.dqHead + this.dqLen - 1) % Q]] >= need) this.dqLen--;
      this.dq[(this.dqHead + this.dqLen) % Q] = p;
      this.dqLen++;
      const minNeed = this.need[this.dq[this.dqHead]];
      this.limGain += (minNeed - this.limGain) * (minNeed < this.limGain ? this.limAtt : this.limRel);
      this.delay[p] = s;
      const next = (p + 1) % size;
      const delayed = this.delay[next];
      this.pos = next;
      let v = delayed * this.limGain;
      if (v > this.ceiling) v = this.ceiling;
      else if (v < -this.ceiling) v = -this.ceiling;

      this.gate += (gTarget - this.gate) * gCoef;
      v *= this.gate;
      this.outAcc += v * v;
      o[i] = v;
    }
    for (let c = 1; c < out.length; c++) out[c].set(o);
    this.time += len * msPerSample;
    return true;
  }
}

registerProcessor('tolktak-voice', TolkTakVoice);
