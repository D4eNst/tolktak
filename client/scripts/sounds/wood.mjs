const N = { D5: 587.33, E5: 659.26, Fs5: 739.99, A5: 880, B5: 987.77, D6: 1174.66, E6: 1318.51, Fs6: 1479.98 };
const note = (f, at, len, extra = {}) => ({ f, at, len, ...extra });
const notes = (frequencies, gap, lengths, extra = {}) => frequencies.map((f, i) => note(f, i * gap, lengths[i] ?? lengths.at(-1), extra));

function plan(event) {
  const { D5, E5, Fs5, A5, B5, D6, E6, Fs6 } = N;
  const map = {
    join: notes([D5, Fs5, A5], .08, [.18, .18, .55]),
    leave: notes([A5, Fs5, D5], .095, [.16, .16, .45]),
    'peer-join': notes([A5, D6], .07, [.12, .3]),
    'peer-leave': [note(D6, 0, .12), note(A5, .07, .25, { cutoff: 3000 })],
    unmute: [note(B5, 0, .2, { overtone: .14 })],
    mute: [note(E5, 0, .07, { dim: true })],
    'ptt-on': [note(E6, 0, .035, { block: true })],
    'ptt-off': [note(B5, 0, .03, { block: true })],
    message: [note(B5, 0, .3), note(Fs6, .015, .38, { amp: .6 })],
    test: notes([D5, E5, Fs5, A5, B5, D6], .09, [.18, .18, .18, .18, .18, .6]),
  };
  if (event !== 'ring') return map[event];
  return [0, 3.2].flatMap((start, cycle) => [
    note(D5, start, .15), note(Fs5, start + .12, .15), note(A5, start + .24, .5),
    note(E5, start + .72, .15), note(A5, start + .84, .15), note(cycle ? D6 : B5, start + .96, .85),
  ]);
}

function noise(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  let seed = 1873;
  for (let i = 0; i < buffer.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    buffer.getChannelData(0)[i] = seed / 2 ** 31 - 1;
  }
  return buffer;
}

function synth(ctx, destination, n, pitch) {
  const at = n.at + .02, end = at + n.len;
  const filter = ctx.createBiquadFilter();
  filter.type = n.block ? 'bandpass' : 'lowpass';
  filter.Q.value = n.block ? 4 : .7;
  filter.frequency.setValueAtTime(n.cutoff ?? (n.block ? n.f : (n.dim ? 1600 : 5000) * pitch), at);
  filter.connect(destination);
  const osc = (ratio, level, decay = 1) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = n.f * ratio;
    const peak = (n.amp ?? 1) * level, attack = Math.min(n.len / 4, n.block ? .001 : .003);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.setTargetAtTime(0, at + attack, n.len / (4.6 * decay));
    g.gain.setValueAtTime(peak * Math.exp(-4.6 * decay * (n.len - .012) / n.len), Math.max(at + attack, end - .01));
    g.gain.linearRampToValueAtTime(0, end);
    o.connect(g).connect(filter);
    o.start(at); o.stop(end);
    return o;
  };

  osc(1, 1);
  if (!n.block) osc(4, n.dim ? .025 : n.overtone ?? .1, 4);
  const click = ctx.createBufferSource(), g = ctx.createGain(), band = ctx.createBiquadFilter();
  click.buffer = noise(ctx, .004);
  band.type = 'bandpass'; band.frequency.value = 2200 * pitch; band.Q.value = 1.2;
  g.gain.value = n.block ? .16 : .05;
  click.connect(band).connect(g).connect(filter); click.start(at);
}

export async function renderWood(event) {
  const pitch = .5;
  const score = plan(event).map(n => ({ ...n, f: n.f * pitch, ...(n.cutoff ? { cutoff: n.cutoff * pitch } : {}) }));
  const duration = Math.max(.3, ...score.map(n => n.at + n.len)) + .15;
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * 48000), 48000);
  for (const n of score) synth(ctx, ctx.destination, n, pitch);
  const buffer = await ctx.startRendering(), samples = buffer.getChannelData(0);
  let peak = 0, energy = 0, active = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  for (const s of samples) if (Math.abs(s) > peak * .025) { energy += s * s; active++; }
  const target = event.startsWith('ptt') ? .05 : event === 'ring' ? .08 : .07;
  const gain = Math.min(.36 / peak, target / Math.sqrt(energy / active));
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return buffer;
}
