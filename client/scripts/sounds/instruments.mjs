const V = (f, at, len, extra = {}) => ({ f, at, len, amp: 1, attack: .006, cutoff: [1400, 500], tau: .12, ...extra });
const H = (f, at, amp = 1, extra = {}) => ({ f, at, amp, scale: 1, click: f < 200 ? 850 : f < 300 ? 1250 : 1600, ...extra });
const Eb = 155.56, Bb = 233.08, C = 261.63, Eb4 = 311.13, G4 = 392, Bb4 = 466.16;
const TOK = 164.81, TAK = 246.94, TIK = 329.63;

function velvet(event) {
  const pads = [];
  if (event === 'ring') {
    const score = [0, 2.4].flatMap((start, cycle) => {
      pads.push({ frequencies: [Eb, Bb], at: start, attack: .06, hold: .8, release: .6, amp: .316, cutoff: [300, 900], sweep: .4 });
      return [Eb4, G4, Bb4, cycle ? 523.25 : G4].map((f, i) => V(f, start + i * .17, .5, { attack: .008, cutoff: [2000, 800], tau: .18 }));
    });
    return { score, pads };
  }
  const score = {
    join: [V(Eb, 0, .7, { attack: .012 }), V(Bb, .07, .7, { attack: .012, amp: .794 }), V(G4, .14, .7, { attack: .012, amp: .631 })],
    leave: [V(G4, 0, .6, { attack: .012, amp: .631 }), V(Bb, .08, .6, { attack: .012, amp: .794 }), V(Eb, .16, .6, { attack: .012 })],
    'peer-join': [V(Bb, 0, .38, { amp: .794 }), V(Eb4, .085, .38)],
    'peer-leave': [V(Eb4, 0, .36, { cutoff: [1100, 400], tau: .11 }), V(Bb, .095, .36, { amp: .708, cutoff: [1100, 400], tau: .11 })],
    unmute: [V(Bb, 0, .14, { attack: .003, cutoff: [300, 1500, 600], sweep: .04, tau: .06 })],
    mute: [V(Eb, 0, .15, { attack: .003, cutoff: [1300, 280], sweep: .07 })],
    'ptt-on': [Eb4, Bb4].map(f => V(f, 0, .085, { attack: .002, cutoff: [2200, 700], tau: .025 })),
    'ptt-off': [Bb, Eb4].map(f => V(f, 0, .1, { attack: .002, amp: .708, cutoff: [1300, 450], tau: .03 })),
    message: [V(C, 0, .3, { attack: .004, cutoff: [1700, 600], tau: .09 }), V(G4, .012, .3, { attack: .004, cutoff: [1700, 600], tau: .09 }), V(G4, .14, .3, { attack: .004, amp: .355, cutoff: [1700, 600], tau: .09 })],
    test: [Eb4, G4, Bb4, 622.25].map((f, i) => V(f, .15 + i * .11, .6, { cutoff: [1900, 700], tau: .15 })),
  }[event];
  if (event === 'test') pads.push({ frequencies: [Eb, Bb], at: 0, attack: .08, hold: .55, release: .65, amp: .398, cutoff: [300, 1000], sweep: .5 });
  return { score, pads };
}

function tokTak(event) {
  const pads = [], glints = [];
  if (event === 'ring') {
    const score = [0, 2.2].flatMap(start => {
      pads.push({ frequencies: [TOK, TAK, 415.3], at: start, attack: .08, hold: .85, release: .45, amp: .251 });
      return [TOK, TAK, TOK, TAK, TIK].map((f, i) => H(f, start + [0, .14, .42, .56, .7][i], [.708, .891, .708, .891, 1][i]));
    });
    return { score, pads, glints };
  }
  const score = {
    join: [H(TOK, 0, .631), H(TAK, .095, .794), H(TIK, .19)],
    leave: [H(TIK, 0), H(TAK, .11, .794), H(TOK, .22, .708, { scale: 1.2 })],
    'peer-join': [H(TOK, 0, .631, { scale: .9 }), H(TAK, .085, .891, { scale: .9 })],
    'peer-leave': [H(TAK, 0, .708, { click: 1000 }), H(TOK, .1, .631, { click: 680 })],
    unmute: [H(TAK, 0, .708, { scale: .55, click: 1500 })],
    mute: [H(TOK, 0, .708, { scale: .55, click: 700 })],
    'ptt-on': [H(TOK, 0, .355, { scale: .45 }), H(TIK, .02, .794, { scale: .45 })],
    'ptt-off': [H(TIK, 0, .355, { scale: .45 }), H(TOK, .02, .708, { scale: .45 })],
    message: [H(TAK, 0, .794), H(TAK, .125, .562)],
    test: [H(TOK, 0), H(TAK, .16), H(TIK, .32), H(TOK, .6), H(TAK, .7)],
  }[event];
  if (event === 'join') pads.push({ frequencies: [TOK, TAK], at: .19, attack: .08, hold: .12, release: .45, amp: .158 });
  if (event === 'message') glints.push({ f: TIK, at: .125, len: .22, amp: .2 });
  if (event === 'test') pads.push({ frequencies: [TOK, TAK, 415.3], at: .52, attack: .08, hold: .2, release: .45, amp: .316 });
  return { score, pads, glints };
}

function envelope(param, at, length, attack, peak) {
  const tau = length / 6.91, fade = Math.min(.01, length / 5), end = at + length;
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(peak, at + attack);
  param.setTargetAtTime(0, at + attack, tau);
  param.setValueAtTime(peak * Math.exp(-(length - fade - attack) / tau), end - fade);
  param.linearRampToValueAtTime(0, end);
}

function filteredNoise(ctx, length) {
  const buffer = ctx.createBuffer(1, Math.ceil(length * ctx.sampleRate), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 5431;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = (seed / 2 ** 31 - 1) * Math.exp(-6.91 * i / data.length);
  }
  return buffer;
}

function voice(ctx, output, n, globalFilter) {
  const at = n.at + .02, end = at + n.len;
  const filter = globalFilter ?? ctx.createBiquadFilter();
  if (!globalFilter) {
    filter.type = 'lowpass'; filter.Q.value = 1;
    const [start, finish, after] = n.cutoff;
    if (n.sweep) {
      filter.frequency.setValueAtTime(start, at);
      filter.frequency.exponentialRampToValueAtTime(finish, at + n.sweep);
      if (after) filter.frequency.setTargetAtTime(after, at + n.sweep, n.tau);
    } else {
      filter.frequency.setValueAtTime(start, at);
      filter.frequency.setTargetAtTime(finish, at, n.tau);
    }
    filter.connect(output);
  }
  for (const [type, amount, detune] of [['triangle', .6, 0], ['sawtooth', .4, 6]]) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type; osc.frequency.value = n.f; osc.detune.value = detune;
    envelope(gain.gain, at, n.len, n.attack, n.amp * amount);
    osc.connect(gain).connect(filter); osc.start(at); osc.stop(end);
  }
}

function hit(ctx, output, n) {
  const at = n.at + .02;
  for (const [ratio, amp, decay] of [[1, 1, .15], [1.51, .5, .095], [2.32, .22, .055]]) {
    const osc = ctx.createOscillator(), gain = ctx.createGain(), len = decay * n.scale;
    osc.frequency.setValueAtTime(n.f * ratio * 1.04, at);
    osc.frequency.setTargetAtTime(n.f * ratio, at, .012);
    envelope(gain.gain, at, len, .001, n.amp * amp);
    osc.connect(gain).connect(output); osc.start(at); osc.stop(at + len);
  }
  const src = ctx.createBufferSource(), gain = ctx.createGain(), band = ctx.createBiquadFilter();
  src.buffer = filteredNoise(ctx, .006);
  band.type = 'bandpass'; band.frequency.value = n.click; band.Q.value = 1;
  envelope(gain.gain, at, .006, .0006, n.amp * .2);
  src.connect(band).connect(gain).connect(output); src.start(at);
}

function pad(ctx, output, n, isVelvet) {
  const at = n.at + .02, end = at + n.hold + n.release;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.Q.value = .7;
  filter.frequency.setValueAtTime(n.cutoff?.[0] ?? 1200, at);
  if (n.cutoff) filter.frequency.exponentialRampToValueAtTime(n.cutoff[1], at + n.sweep);
  filter.connect(output);
  for (const f of n.frequencies) {
    if (isVelvet) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = f;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(n.amp, at + n.attack);
      g.gain.setValueAtTime(n.amp, at + n.hold); g.gain.exponentialRampToValueAtTime(.0001, end - .01); g.gain.linearRampToValueAtTime(0, end);
      osc.connect(g).connect(filter); osc.start(at); osc.stop(end);
    } else for (const [harmonic, level] of [[1, 1], [2, .2], [3, .1]]) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.value = f * harmonic;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(n.amp * level, at + n.attack);
      g.gain.setValueAtTime(n.amp * level, at + n.hold); g.gain.exponentialRampToValueAtTime(.0001, end - .01); g.gain.linearRampToValueAtTime(0, end);
      osc.connect(g).connect(filter); osc.start(at); osc.stop(end);
    }
  }
}

export async function renderInstrument(theme, event) {
  const isVelvet = theme === 'velvet';
  const { score, pads, glints = [] } = isVelvet ? velvet(event) : tokTak(event);
  const hasRoom = isVelvet ? ['join', 'leave', 'ring', 'test'].includes(event) : ['ring', 'test'].includes(event);
  const length = Math.max(event === 'ring' ? (isVelvet ? 4.8 : 4.4) : .3,
    ...score.map(n => n.at + (n.len ?? n.scale * .15)), ...pads.map(n => n.at + n.hold + n.release), ...glints.map(n => n.at + n.len));
  const ctx = new OfflineAudioContext(1, Math.ceil((length + (hasRoom ? .65 : .1)) * 48000), 48000);
  const hp = ctx.createBiquadFilter(), endFilter = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = isVelvet ? 90 : 70; hp.Q.value = .7;
  endFilter.type = isVelvet ? 'highshelf' : 'lowpass'; endFilter.frequency.value = isVelvet ? 3000 : 4000;
  if (isVelvet) endFilter.gain.value = -4;
  hp.connect(endFilter).connect(ctx.destination);
  if (hasRoom) {
    const reverb = ctx.createConvolver(), wet = ctx.createGain(), damp = ctx.createBiquadFilter();
    reverb.buffer = filteredNoise(ctx, .6); wet.gain.value = isVelvet ? .1 : .08;
    damp.frequency.value = 2200;
    endFilter.connect(reverb).connect(damp).connect(wet).connect(ctx.destination);
  }
  let shared;
  if (isVelvet && ['join', 'leave'].includes(event)) {
    shared = ctx.createBiquadFilter(); shared.Q.value = 1;
    shared.frequency.setValueAtTime(event === 'join' ? 350 : 1500, .02);
    shared.frequency.exponentialRampToValueAtTime(event === 'join' ? 1600 : 300, .02 + (event === 'join' ? .26 : .35));
    shared.connect(hp);
  }
  for (const n of score) if (isVelvet) voice(ctx, hp, n, shared); else hit(ctx, hp, n);
  for (const n of pads) pad(ctx, hp, n, isVelvet);
  for (const n of glints) {
    const osc = ctx.createOscillator(), gain = ctx.createGain(); osc.frequency.value = n.f;
    envelope(gain.gain, n.at + .02, n.len, .002, n.amp);
    osc.connect(gain).connect(hp); osc.start(n.at + .02); osc.stop(n.at + .02 + n.len);
  }
  const result = await ctx.startRendering(), samples = result.getChannelData(0);
  let peak = 0, energy = 0, active = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  for (const s of samples) if (Math.abs(s) > peak * .025) { energy += s * s; active++; }
  const target = event.startsWith('ptt') ? .05 : event === 'ring' ? .08 : .07;
  const gain = Math.min(.36 / peak, target / Math.sqrt(energy / active));
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return result;
}
