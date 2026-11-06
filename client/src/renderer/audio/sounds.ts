import { SOUND_KINDS, type SoundKind, type SoundTheme } from '../../sounds';
import { bridge } from '../bridge';

type Settings = { sounds: boolean; soundVolume: number; soundTheme: SoundTheme; outputDevice: string };
type Playback = { stop(): void; output?: GainNode };
let settings: Settings = { sounds: true, soundVolume: .7, soundTheme: 'tok-tak', outputDevice: 'default' };
const active = new Set<Playback>();
const buffers = new Map<string, Promise<AudioBuffer>>();
let decoder: OfflineAudioContext | undefined;
let ringRequested = false;
let stopRing: (() => void) | undefined;
let stopPreview: (() => void) | undefined;

function load(theme: SoundTheme, kind: SoundKind) {
  const name = `sounds/${theme}/${kind}.ogg`;
  let buffer = buffers.get(name);
  if (!buffer) {
    buffer = bridge.readAsset(name).then(bytes => {
      decoder ??= new OfflineAudioContext(1, 1, 48000);
      return decoder.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    });
    buffers.set(name, buffer);
    buffer.catch(() => buffers.delete(name));
  }
  return buffer;
}

export function configureSounds(next: Settings) {
  const restart = next.soundTheme !== settings.soundTheme || next.outputDevice !== settings.outputDevice
    || next.sounds !== settings.sounds || (next.soundVolume > 0) !== (settings.soundVolume > 0);
  settings = { sounds: next.sounds, soundVolume: next.soundVolume, soundTheme: next.soundTheme, outputDevice: next.outputDevice };
  if (restart) for (const playback of [...active]) playback.stop();
  else for (const playback of active) {
    const output = playback.output;
    output?.gain.setTargetAtTime(settings.soundVolume, output.context.currentTime, .01);
  }
  if (restart) {
    stopRing?.();
    stopRing = ringRequested && settings.sounds && settings.soundVolume > 0 ? playSound('ring', true) : undefined;
  }
  if (settings.sounds && settings.soundVolume > 0) {
    for (const kind of SOUND_KINDS) void load(settings.soundTheme, kind).catch(() => {});
  }
}

export function playSound(kind: SoundKind, loop = false): () => void {
  if (!settings.sounds || settings.soundVolume <= 0) return () => {};
  if (kind === 'test') stopPreview?.();
  const { soundTheme, outputDevice } = settings;
  let cancelled = false;
  let ctx: AudioContext | undefined;
  let source: AudioBufferSourceNode | undefined;
  const close = () => {
    cancelled = true;
    active.delete(playback);
    void ctx?.close().catch(() => {});
  };
  const playback: Playback = {
    stop() {
      if (cancelled) return;
      cancelled = true;
      active.delete(playback);
      if (source && ctx && playback.output) {
        const at = ctx.currentTime;
        playback.output.gain.cancelAndHoldAtTime(at);
        playback.output.gain.linearRampToValueAtTime(0, at + .01);
        source.stop(at + .01);
        if (ctx.state === 'suspended') close();
      } else close();
    },
  };
  active.add(playback);
  if (kind === 'test') stopPreview = playback.stop;
  void (async () => {
    try {
      const buffer = await load(soundTheme, kind);
      if (cancelled) return;
      ctx = new AudioContext();
      // Select the sink after creation so an unplugged device can fall back.
      if (outputDevice && outputDevice !== 'default' && 'setSinkId' in ctx) {
        await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(outputDevice).catch(() => {});
      }
      if (cancelled) return close();
      const output = ctx.createGain();
      output.gain.value = settings.soundVolume;
      output.connect(ctx.destination);
      playback.output = output;
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      source.connect(output);
      source.onended = close;
      source.start();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => playback.stop());
    } catch {
      close();
    }
  })();
  return playback.stop;
}

export function ringing(on: boolean) {
  ringRequested = on;
  stopRing?.();
  stopRing = on ? playSound('ring', true) : undefined;
}

window.addEventListener('tolktak:session-reset', () => {
  ringing(false);
  for (const playback of [...active]) playback.stop();
});
