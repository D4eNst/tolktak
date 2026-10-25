import { batch, computed, effect, signal } from '@preact/signals';
import {
  AudioPresets,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Participant,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoPresets,
  VideoQuality,
} from 'livekit-client';
import { VoiceChain, type ChainSettings, type ChainStats, type Denoise } from './audio/chain';
import { bridge, platform, type AudioMode } from './bridge';
import { t } from './i18n';
import { api, appActive, callEvents, errorText, me, sendRealtime, session, toast, userName, windowHidden } from './state';
import { STREAM_REACTIONS } from './ui/emoji';

export type Prefs = {
  inputDevice: string;
  outputDevice: string;
  cameraDevice: string;
  echoCancellation: boolean;
  noiseSuppression: boolean; // legacy, replaced by `denoise`
  autoGainControl: boolean; // legacy, replaced by `agc`
  denoise: Denoise;
  agc: boolean;
  inputGain: number; // dB, manual gain when the leveller is off
  agcGain: Record<string, number>; // input device -> gain the leveller learned
  startMuted: boolean;
  voiceVolume: number; // 0..2
  streamVolume: number; // 0..2
  ducking: boolean;
  duckLevel: number; // 0..1, stream volume factor while someone talks
  autoWatch: boolean;
  userVolume: Record<string, number>; // identity -> 0..2
  sounds: boolean;
  micMuted: boolean;
  deafened: boolean;
  micMode: 'voice' | 'ptt';
  vadAuto: boolean; // false: open the mic only above vadThreshold
  vadThreshold: number; // dBFS, -80..0
  pttRelease: number; // ms the mic stays open after the key is released
  cameraQuality: '720p' | '1080p';
  mirrorCamera: boolean;
  streamReactions: boolean;
  backgroundSaver: boolean;
};

const PREFS_KEY = 'tolktak.voice';
const defaultPrefs: Prefs = {
  inputDevice: 'default',
  outputDevice: 'default',
  cameraDevice: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  denoise: 'medium',
  agc: true,
  inputGain: 0,
  agcGain: {},
  startMuted: false,
  voiceVolume: 1,
  streamVolume: 1,
  ducking: true,
  duckLevel: 0.4,
  autoWatch: false,
  userVolume: {},
  sounds: true,
  micMuted: false,
  deafened: false,
  micMode: 'voice',
  vadAuto: true,
  vadThreshold: -50,
  pttRelease: 200,
  cameraQuality: '720p',
  mirrorCamera: true,
  streamReactions: true,
  backgroundSaver: true,
};

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    // Older settings: keep what the user switched off.
    if (saved.denoise === undefined && saved.noiseSuppression === false) saved.denoise = 'off';
    saved.denoise = ({ webrtc: 'light', rnnoise: 'light', gtcrn: 'medium' } as Record<string, Denoise>)[saved.denoise] ?? saved.denoise;
    if (saved.agc === undefined && saved.autoGainControl === false) saved.agc = false;
    return { ...defaultPrefs, ...saved };
  } catch {
    return { ...defaultPrefs };
  }
}

export const prefs = signal<Prefs>(loadPrefs());

export const lowPower = computed(() => prefs.value.backgroundSaver && !appActive.value);
effect(() => {
  document.documentElement.classList.toggle('app-inactive', lowPower.value);
});
export function setPrefs(patch: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
  } catch {
    /* storage unavailable */
  }
  applyVolumes();
}

export type CallTarget = { room_id: number } | { channel_id: number };
export type CallInfo = {
  room: string;
  label: string;
  target: CallTarget;
  status: 'connecting' | 'connected' | 'reconnecting' | 'ringing';
};
export type PeerView = {
  identity: string;
  userId: number;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  camera?: Track;
  screen?: Track;
  screenAudio: boolean;
  quality: string;
};
export type ShareMode = 'motion' | 'detail';
export type ShareQuality = '720p30' | '1080p30' | '1080p60' | 'source60';
export type ShareOptions = { sourceId: string; sourceName: string; audio: AudioMode; mode: ShareMode; quality: ShareQuality; singleLayer?: boolean };

// Asking for H.264 where the build lacks it collapses the bandwidth estimate.
// Only a hardware encoder offers H.264 High (profile-level-id 64).
const VIDEO_CAPS = (() => {
  try {
    return RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  } catch {
    return [];
  }
})();
const isH264 = (c: RTCRtpCodec) => c.mimeType.toLowerCase() === 'video/h264';
const isHwH264 = (c: RTCRtpCodec) => isH264(c) && /profile-level-id=64/i.test(c.sdpFmtpLine ?? '') && /packetization-mode=1/.test(c.sdpFmtpLine ?? '');
export const HW_H264 = VIDEO_CAPS.some(isHwH264);
const VIDEO_CODEC: 'h264' | 'vp8' = VIDEO_CAPS.some(isH264) ? 'h264' : 'vp8';

export const call = signal<CallInfo | null>(null);
export const peers = signal<PeerView[]>([]);
// Outside a call: the state the next call starts with.
export const micOn = signal(!prefs.value.micMuted && !prefs.value.deafened);
export const deafened = signal(prefs.value.deafened);
export const micOpen = signal(false);
export const micLevel = signal(0);
export const micGain = signal<number | null>(null);
export type Floater = { id: number; emoji: string; from: number; x: number };
export const floaters = signal<Floater[]>([]);
export const cameraOn = signal(false);
export const sharing = signal<(ShareOptions & { audioInfo: string }) | null>(null);
export const watching = signal<string | null>(null);
export const speakingRemote = signal(false);
export const speaking = signal<ReadonlySet<string>>(new Set());

export const streams = computed(() => peers.value.filter((p) => p.screen));

let room: Room | null = null;
let leaving = false;
// Room of the running rejoin loop: a call joined later gets its own.
let rejoining = '';
let screenTracks: { video?: LocalVideoTrack; audio?: LocalAudioTrack } = {};

// For tests and diagnostics.
(globalThis as unknown as Record<string, unknown>).__tolktak = {
  get room() {
    return room;
  },
  stats: () => collectStats(),
  lk: { LocalVideoTrack, LocalAudioTrack, Track },
  share: (o: ShareOptions) => startShare(o),
  stopShare: () => stopShare(),
  prefs: () => prefs.value,
  setPrefs: (p: Partial<Prefs>) => setPrefs(p),
  restartMic: () => restartMic(),
  toggleDeafen: () => toggleDeafen(),
  speaking: () => [...speaking.value],
  levels: () => (room ? [...room.remoteParticipants.values()].map((p) => [p.identity, Math.round(remoteLevelDb(p))]) : []),
};

export async function joinVoice(target: CallTarget, label: string, opts: { ringing?: boolean } = {}) {
  if (call.value) {
    if (sameTarget(call.value.target, target)) return;
    await leaveVoice();
  }
  leaving = false;
  const { url, token, room: roomName } = await api().joinVoice(target);
  call.value = { room: roomName, label, target, status: opts.ringing ? 'ringing' : 'connecting' };
  bridge.setInCall(true);
  try {
    await connect(url, token, false);
  } catch (e) {
    call.value = null;
    bridge.setInCall(false);
    room = null;
    throw e;
  }
  sendRealtime({ type: 'voice.joined', room: roomName, muted: !micOn.value, deafened: deafened.value });
  playTone('join');
}

function sameTarget(a: CallTarget, b: CallTarget) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function connect(url: string, token: string, isRejoin: boolean) {
  const r = new Room({
    // adaptiveStream picks the layer by <video> size: narrow windows got blurry 720p.
    adaptiveStream: false,
    dynacast: true,
    webAudioMix: true, // allows per-user gain above 100 %
    stopLocalTrackOnUnpublish: true,
    publishDefaults: {
      videoCodec: VIDEO_CODEC,
      simulcast: true,
      dtx: true,
      red: true,
      audioPreset: AudioPresets.music,
    },
    audioCaptureDefaults: micConstraints(),
    audioOutput: { deviceId: prefs.value.outputDevice || 'default' },
  });
  room = r;
  wire(r);
  startSpeakingLoop();
  // Stream audio is fetched only for the watched stream.
  await r.connect(url, token, { autoSubscribe: false });
  if (r !== room) return;
  syncSubscriptions(r);
  if (call.value) call.value = { ...call.value, status: call.value.status === 'ringing' ? 'ringing' : 'connected' };
  if (!isRejoin && prefs.value.startMuted) setPrefs({ micMuted: true });
  const wantMic = !prefs.value.micMuted && !deafened.value;
  try {
    await r.localParticipant.setMicrophoneEnabled(wantMic, micConstraints());
    micOn.value = wantMic;
    await applyGate();
    await applyOutputDevice(r);
  } catch (e) {
    micOn.value = false;
    toast(t().core.voice.micUnavailable(errorText(e)), 'error');
  }
  if (screenTracks.video) await publishScreen(r, sharing.value!, screenTracks.video, screenTracks.audio);
  if (cameraOn.value) await setCamera(true);
  refresh();
}

export function micConstraints() {
  const p = prefs.value;
  return {
    deviceId: p.inputDevice && p.inputDevice !== 'default' ? { exact: p.inputDevice } : undefined,
    echoCancellation: p.echoCancellation,
    // The browser's filters are only a fallback: its AGC makes voices pump.
    noiseSuppression: chainBroken && p.denoise !== 'off',
    autoGainControl: chainBroken && p.agc,
    channelCount: 1,
  };
}

export async function leaveVoice() {
  const c = call.value;
  leaving = true;
  stopScreenTracks();
  const r = room;
  room = null;
  batch(() => {
    call.value = null;
    peers.value = [];
    watching.value = null;
    sharing.value = null;
    cameraOn.value = false;
    speakingRemote.value = false;
    speaking.value = new Set();
    micOpen.value = false;
    micLevel.value = 0;
    floaters.value = [];
    micOn.value = !prefs.value.micMuted && !deafened.value;
  });
  bridge.setInCall(false);
  if (r) await r.disconnect();
  audioSink().replaceChildren();
  if (c) {
    playTone('leave');
    session.value?.api.leaveVoice(c.room).catch(() => {});
  }
}

effect(() => {
  if (!session.value && call.value) leaveVoice();
});

function wantSubscribed(source: Track.Source, identity: string) {
  return source !== Track.Source.ScreenShareAudio || watching.value === identity;
}

/** The SFU stops forwarding voices: resubscribing brought them back silent. */
function applyDeafen(r: Room) {
  for (const p of r.remoteParticipants.values()) {
    const pub = p.getTrackPublication(Track.Source.Microphone) as RemoteTrackPublication | undefined;
    if (pub?.isSubscribed && pub.isEnabled === deafened.value) pub.setEnabled(!deafened.value);
  }
}

function syncSubscriptions(r: Room) {
  for (const p of r.remoteParticipants.values())
    for (const pub of p.trackPublications.values()) {
      const want = wantSubscribed(pub.source, p.identity);
      if (pub.isSubscribed !== want) (pub as RemoteTrackPublication).setSubscribed(want);
    }
}

// Room's audioOutput is applied before the webAudioMix context exists.
// The default device stays unset to follow the system default.
async function applyOutputDevice(r: Room) {
  const want = prefs.value.outputDevice;
  const ctx = (r as unknown as { audioContext?: AudioContext & { sinkId?: unknown } }).audioContext;
  if (!want || want === 'default' || !ctx || !('setSinkId' in ctx) || ctx.sinkId === want) return;
  try {
    await r.switchActiveDevice('audiooutput', want);
  } catch (e) {
    console.warn('audio output', e);
  }
}

function wire(r: Room) {
  const update = () => r === room && scheduleRefresh();
  const reconnecting = () => {
    if (call.value) call.value = { ...call.value, status: 'reconnecting' };
  };
  r.on(RoomEvent.ParticipantConnected, (p) => {
    update();
    if (call.value?.status === 'ringing') call.value = { ...call.value, status: 'connected' };
    if (p.identity !== String(me.value?.id)) playTone('join');
  })
    .on(RoomEvent.ParticipantDisconnected, () => {
      update();
      playTone('leave');
    })
    .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      if (track.kind === Track.Kind.Audio) {
        // livekit-client plays remote audio only once it is attached.
        const el = track.attach();
        el.dataset.identity = p.identity;
        audioSink().appendChild(el);
        applyVolumeFor(p as RemoteParticipant);
        if (deafened.value && pub.source === Track.Source.Microphone) (pub as RemoteTrackPublication).setEnabled(false);
        void applyOutputDevice(r);
      } else applyVideoPolicy();
      update();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
      update();
    })
    .on(RoomEvent.TrackMuted, update)
    .on(RoomEvent.TrackUnmuted, update)
    .on(RoomEvent.LocalTrackPublished, update)
    .on(RoomEvent.LocalTrackUnpublished, update)
    .on(RoomEvent.TrackPublished, (pub, p) => {
      (pub as RemoteTrackPublication).setSubscribed(wantSubscribed(pub.source, p.identity));
      if (pub.source === Track.Source.ScreenShare) {
        toast(t().core.voice.streamStarted(p.name || userName(Number(p.identity))));
        if (prefs.value.autoWatch && !watching.value) watch(p.identity);
      }
      update();
    })
    .on(RoomEvent.TrackUnpublished, (pub, p) => {
      if (pub.source === Track.Source.ScreenShare && watching.value === p.identity) {
        watching.value = null;
        toast(t().core.voice.streamEnded);
      }
      update();
    })
    .on(RoomEvent.ConnectionQualityChanged, update)
    .on(RoomEvent.Reconnecting, reconnecting)
    .on(RoomEvent.SignalReconnecting, reconnecting)
    .on(RoomEvent.Reconnected, () => {
      if (call.value) call.value = { ...call.value, status: 'connected' };
      toast(t().core.voice.reconnected);
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (r !== room || leaving) return;
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
        toast(t().core.voice.removed, 'error');
        leaveVoice();
        return;
      }
      // Past LiveKit's own resume window.
      rejoin();
    })
    .on(RoomEvent.MediaDevicesError, (e: Error) => toast(t().core.voice.deviceError(e.message), 'error'))
    .on(RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== 'react' || !p) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.t === 'react' && STREAM_REACTIONS.includes(msg.e)) showFloater(msg.e, Number(p.identity));
      } catch {
        /* malformed */
      }
    });
}

// A failed connect also fires Disconnected: one loop retries until it gets back in.
async function rejoin() {
  const c = call.value;
  if (!c || rejoining === c.room) return;
  rejoining = c.room;
  call.value = { ...c, status: 'reconnecting' };
  for (let attempt = 0; ; attempt++) {
    await new Promise((res) => setTimeout(res, Math.min(30000, 1000 * 2 ** attempt)));
    if (call.value?.room !== c.room) break;
    try {
      const { url, token } = await api().joinVoice(c.target);
      await room?.disconnect().catch(() => {});
      await connect(url, token, true);
      toast(t().core.voice.rejoined);
      break;
    } catch {
      /* try again */
    }
  }
  if (rejoining === c.room) rejoining = '';
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  // A hidden window gets no animation frames, hence the timer.
  const run = () => {
    if (!refreshQueued) return;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    refreshQueued = false;
    refresh();
  };
  const frame = requestAnimationFrame(run);
  const timer = setTimeout(run, 100);
}

function viewOf(p: Participant, isLocal: boolean): PeerView {
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const cam = p.getTrackPublication(Track.Source.Camera);
  const scr = p.getTrackPublication(Track.Source.ScreenShare);
  const scrA = p.getTrackPublication(Track.Source.ScreenShareAudio);
  return {
    identity: p.identity,
    userId: Number(p.identity),
    name: p.name || userName(Number(p.identity)),
    isLocal,
    speaking: speaking.value.has(p.identity),
    micMuted: !mic || mic.isMuted,
    camera: cam && !cam.isMuted ? cam.track : undefined,
    screen: scr ? (scr.track ?? (isLocal ? undefined : placeholderTrack)) : undefined,
    screenAudio: !!scrA,
    quality: p.connectionQuality,
  };
}

// Unsubscribed shares still need a "watch" card.
const placeholderTrack = {} as Track;

function refresh() {
  const r = room;
  if (!r) {
    peers.value = [];
    return;
  }
  const list = [viewOf(r.localParticipant, true), ...[...r.remoteParticipants.values()].map((p) => viewOf(p, false))];
  peers.value = list;
  if (watching.value && !list.some((p) => p.identity === watching.value && p.screen)) watching.value = null;
}

export async function toggleMic() {
  const next = !micOn.value;
  if (next && deafened.value) {
    // Unmuting also undeafens.
    deafened.value = false;
    setPrefs({ deafened: false });
    if (room) applyDeafen(room);
  }
  setPrefs({ micMuted: !next });
  if (!room) {
    micOn.value = next;
    playTone(next ? 'unmute' : 'mute');
    return;
  }
  try {
    await room.localParticipant.setMicrophoneEnabled(next, micConstraints());
    micOn.value = next;
    if (next) await applyGate();
    playTone(next ? 'unmute' : 'mute');
  } catch (e) {
    toast(t().core.voice.micUnavailable(errorText(e)), 'error');
  }
  reportState();
}

export async function toggleDeafen() {
  const next = !deafened.value;
  deafened.value = next;
  setPrefs({ deafened: next });
  if (next) {
    if (room && micOn.value) await room.localParticipant.setMicrophoneEnabled(false);
    micOn.value = false;
  } else {
    const want = !prefs.value.micMuted;
    if (room && want) {
      await room.localParticipant.setMicrophoneEnabled(true, micConstraints()).catch(() => {});
      await applyGate();
    }
    micOn.value = want;
  }
  playTone(next ? 'mute' : 'unmute');
  if (room) applyDeafen(room);
  applyVolumes();
  reportState();
}

// A track processor: the gate opens and closes without mute signalling.

let pttHeld = false;
export function setPushToTalk(down: boolean) {
  if (pttHeld === down) return;
  pttHeld = down;
  activeChain?.set({ ptt: down });
  if (prefs.value.micMode === 'ptt' && call.value && micOn.value) playTone(down ? 'ptt-on' : 'ptt-off');
}

let chainBroken = false;
let activeChain: VoiceChain | null = null;

export function chainSettings(p = prefs.value): ChainSettings {
  return {
    agc: p.agc,
    inputGain: p.inputGain,
    mode: p.micMode === 'ptt' ? 'ptt' : p.vadAuto ? 'open' : 'threshold',
    threshold: p.vadThreshold,
    hold: p.micMode === 'ptt' ? p.pttRelease : 350,
    ptt: pttHeld,
  };
}

const deviceKey = (p = prefs.value) => p.inputDevice || 'default';

export function createVoiceChain(track: MediaStreamTrack, onStats: (s: ChainStats) => void) {
  const p = prefs.value;
  return VoiceChain.create(track, p.denoise, chainSettings(p), p.agcGain[deviceKey(p)], onStats);
}

let lastGain: number | undefined;
let gainSaved = 0;
function rememberGain(force = false) {
  if (lastGain === undefined || !prefs.value.agc) return;
  const now = Date.now();
  if (!force && now - gainSaved < 30_000) return;
  gainSaved = now;
  const key = deviceKey();
  if (Math.abs((prefs.value.agcGain[key] ?? 99) - lastGain) < 0.5) return;
  setPrefs({ agcGain: { ...prefs.value.agcGain, [key]: Math.round(lastGain * 10) / 10 } });
}

class VoiceProcessor {
  name = 'tolktak-voice';
  processedTrack?: MediaStreamTrack;
  private chain?: VoiceChain;

  async init(opts: { track: MediaStreamTrack }) {
    await this.setup(opts.track);
  }
  async restart(opts: { track: MediaStreamTrack }) {
    this.teardown();
    await this.setup(opts.track);
  }
  async destroy() {
    this.teardown();
  }
  private async setup(track: MediaStreamTrack) {
    const chain = await createVoiceChain(track, (s) => {
      lastGain = s.gain;
      rememberGain();
      const g = Math.round(s.gain);
      if (micGain.value !== g) micGain.value = g;
      const open = s.open && (prefs.value.micMode === 'ptt' || !prefs.value.vadAuto || s.speech);
      if (micOpen.value !== open) micOpen.value = open;
      micLevel.value = Math.max(0, Math.min(1, (s.level + 70) / 60));
      localOut = { db: s.out, at: performance.now() };
    });
    this.chain = chain;
    activeChain = chain;
    this.processedTrack = chain.output;
  }
  private teardown() {
    rememberGain(true);
    if (activeChain === this.chain) activeChain = null;
    this.chain?.close();
    this.chain = undefined;
    micOpen.value = false;
  }
}

function wantsChain(p = prefs.value) {
  return !chainBroken && (p.denoise !== 'off' || p.agc || p.inputGain !== 0 || p.micMode === 'ptt' || !p.vadAuto);
}

export async function applyGate() {
  const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track as LocalAudioTrack | undefined;
  if (!track) return;
  const want = wantsChain();
  const current = track.getProcessor() as VoiceProcessor | undefined;
  try {
    if (want && !current) await track.setProcessor(new VoiceProcessor() as never);
    if (!want && current) {
      await track.stopProcessor();
      micOpen.value = false;
    }
  } catch (e) {
    console.warn('voice processing unavailable', e);
    chainBroken = true;
    await track.stopProcessor().catch(() => {});
    await restartMic();
  }
}

// Settings apply live, only a new noise model needs a new chain.
effect(() => {
  const s = chainSettings(prefs.value);
  activeChain?.set(s);
});

// Levels are measured here: LiveKit's active-speaker events arrive late and smoothed.
const SPEAK_ON_DB = -45;
const SPEAK_OFF_DB = -52;
const SPEAK_HOLD = 450;
const SPEAK_POLL = 50;

let localOut: { db: number; at: number } | null = null;
let speakTimer: number | undefined;
const lastVoice = new Map<string, number>();

type Meter = { track: MediaStreamTrack; src: MediaStreamAudioSourceNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer> };
let meterCtx: AudioContext | null = null;
let ownMeterCtx = false;
const meters = new Map<string, Meter>();

function meterFor(identity: string, track: MediaStreamTrack): Meter | null {
  const m = meters.get(identity);
  if (m?.track === track) return m;
  if (m) m.src.disconnect();
  try {
    if (!meterCtx || meterCtx.state === 'closed') {
      // Each AudioContext is another audio thread: reuse the room's.
      const shared = (room as unknown as { audioContext?: AudioContext } | null)?.audioContext;
      ownMeterCtx = !shared || shared.state === 'closed';
      meterCtx = ownMeterCtx ? new AudioContext({ latencyHint: 'playback' }) : shared!;
    }
    if (meterCtx.state === 'suspended') meterCtx.resume().catch(() => {});
    const src = meterCtx.createMediaStreamSource(new MediaStream([track]));
    const an = meterCtx.createAnalyser();
    an.fftSize = 1024; // ~21 ms window
    src.connect(an);
    const next = { track, src, an, buf: new Float32Array(an.fftSize) };
    meters.set(identity, next);
    return next;
  } catch {
    return null;
  }
}

function closeMeters() {
  for (const m of meters.values()) m.src.disconnect();
  meters.clear();
  if (ownMeterCtx) meterCtx?.close().catch(() => {});
  meterCtx = null;
}

function remoteLevelDb(p: RemoteParticipant): number {
  const pub = p.getTrackPublication(Track.Source.Microphone);
  if (pub?.isMuted) return -127;
  // Deafened, nothing is forwarded: use the SFU's speaker flag.
  const track = pub?.track?.mediaStreamTrack;
  if (!track || !(pub as RemoteTrackPublication).isEnabled) return p.isSpeaking ? 0 : -127;
  const m = meterFor(p.identity, track);
  if (!m) return p.isSpeaking ? 0 : -127;
  m.an.getFloatTimeDomainData(m.buf);
  let e = 0;
  for (let i = 0; i < m.buf.length; i++) e += m.buf[i] * m.buf[i];
  return 10 * Math.log10(e / m.buf.length + 1e-13);
}

function localLevelDb(): number {
  if (!micOn.value) return -127;
  if (localOut && performance.now() - localOut.at < 500) return localOut.db;
  return room?.localParticipant.isSpeaking ? 0 : -127;
}

function pollSpeaking() {
  const r = room;
  if (!r) return;
  const now = performance.now();
  const next = new Set<string>();
  const was = speaking.value;
  const judge = (identity: string, db: number) => {
    const on = was.has(identity);
    if (db > (on ? SPEAK_OFF_DB : SPEAK_ON_DB)) lastVoice.set(identity, now);
    if (now - (lastVoice.get(identity) ?? -1e9) < (on ? SPEAK_HOLD : SPEAK_POLL)) next.add(identity);
  };
  judge(r.localParticipant.identity, localLevelDb());
  let remote = false;
  for (const [id, m] of meters) {
    if (r.remoteParticipants.has(id)) continue;
    m.src.disconnect();
    meters.delete(id);
  }
  for (const p of r.remoteParticipants.values()) {
    judge(p.identity, remoteLevelDb(p));
    if (next.has(p.identity)) remote = true;
  }
  if (next.size !== was.size || [...next].some((x) => !was.has(x))) {
    speaking.value = next;
    scheduleRefresh();
  }
  if (remote !== speakingRemote.value) setDucked(remote);
}

function startSpeakingLoop() {
  window.clearInterval(speakTimer);
  closeMeters();
  lastVoice.clear();
  localOut = null;
  speakTimer = window.setInterval(() => {
    if (!room) {
      window.clearInterval(speakTimer);
      closeMeters();
      speaking.value = new Set();
      return;
    }
    pollSpeaking();
  }, SPEAK_POLL);
}

let floaterSeq = 0;
function showFloater(emoji: string, from: number) {
  if (!prefs.value.streamReactions) return;
  const f = { id: ++floaterSeq, emoji, from, x: 8 + Math.random() * 84 };
  floaters.value = [...floaters.value.slice(-30), f];
  setTimeout(() => (floaters.value = floaters.value.filter((x) => x.id !== f.id)), 3200);
}
export function sendFloater(emoji: string) {
  if (!room) return;
  showFloater(emoji, me.value?.id ?? 0);
  const data = new TextEncoder().encode(JSON.stringify({ t: 'react', e: emoji.slice(0, 16) }));
  room.localParticipant.publishData(data, { reliable: false, topic: 'react' }).catch(() => {});
}

function reportState() {
  if (call.value) sendRealtime({ type: 'voice.state', room: call.value.room, muted: !micOn.value, deafened: deafened.value });
}

export async function setCamera(on: boolean) {
  if (!room) return;
  try {
    if (!on) {
      // Unpublish, not mute: the camera light goes off.
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (pub?.track) await room.localParticipant.unpublishTrack(pub.track as LocalVideoTrack);
      cameraOn.value = false;
      scheduleRefresh();
      return;
    }
    await room.localParticipant.setCameraEnabled(
      on,
      { resolution: camPreset().resolution, deviceId: prefs.value.cameraDevice || undefined },
      { simulcast: true, videoCodec: VIDEO_CODEC, backupCodec: false, videoEncoding: camPreset().encoding },
    );
    cameraOn.value = on;
  } catch (e) {
    cameraOn.value = false;
    toast(t().core.voice.cameraUnavailable(errorText(e)), 'error');
  }
  scheduleRefresh();
}

function camPreset() {
  return prefs.value.cameraQuality === '1080p' ? VideoPresets.h1080 : VideoPresets.h720;
}

export async function restartCamera() {
  if (!room || !cameraOn.value) return;
  await setCamera(false);
  await setCamera(true);
}

export async function switchDevices() {
  if (!room) return;
  const p = prefs.value;
  try {
    if (micOn.value) await room.switchActiveDevice('audioinput', p.inputDevice || 'default');
    await room.switchActiveDevice('audiooutput', p.outputDevice || 'default');
    if (cameraOn.value && p.cameraDevice) await room.switchActiveDevice('videoinput', p.cameraDevice);
  } catch (e) {
    toast(t().core.voice.switchDeviceFailed(errorText(e)), 'error');
  }
}

export async function restartMic() {
  if (!room || !micOn.value) return;
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
  if (!track) return;
  try {
    if (track.getProcessor()) await track.stopProcessor();
    await track.restartTrack(micConstraints());
  } catch (e) {
    toast(t().core.voice.micUnavailable(errorText(e)), 'error');
  }
  await applyGate();
}

let duckFactor = 1;
let duckTarget = 1;
let duckTimer: number | undefined;
let releaseTimer: number | undefined;

function setDucked(talking: boolean) {
  speakingRemote.value = talking;
  if (!prefs.value.ducking) {
    duckTarget = 1;
  } else if (talking) {
    window.clearTimeout(releaseTimer);
    duckTarget = prefs.value.duckLevel;
  } else {
    // Pauses between words must not pump the volume.
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(() => {
      duckTarget = 1;
      rampDuck();
    }, 700);
    return;
  }
  rampDuck();
}

function rampDuck() {
  window.clearInterval(duckTimer);
  duckTimer = window.setInterval(() => {
    const step = 0.08;
    if (Math.abs(duckFactor - duckTarget) <= step) {
      duckFactor = duckTarget;
      window.clearInterval(duckTimer);
    } else duckFactor += duckFactor < duckTarget ? step : -step;
    applyVolumes();
  }, 25);
}

function audioSink(): HTMLElement {
  let el = document.getElementById('tolktak-audio');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tolktak-audio';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function applyVolumeFor(p: RemoteParticipant) {
  const pr = prefs.value;
  const deaf = deafened.value;
  const user = pr.userVolume[p.identity] ?? 1;
  p.setVolume(deaf ? 0 : pr.voiceVolume * user, Track.Source.Microphone);
  p.setVolume(deaf ? 0 : pr.streamVolume * duckFactor, Track.Source.ScreenShareAudio);
}

export function applyVolumes() {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) applyVolumeFor(p);
}

export function setUserVolume(identity: string, v: number) {
  setPrefs({ userVolume: { ...prefs.value.userVolume, [identity]: v } });
}

export function watch(identity: string | null) {
  const r = room;
  watching.value = identity;
  if (!r) return;
  for (const p of r.remoteParticipants.values()) {
    const a = p.getTrackPublication(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
    a?.setSubscribed(p.identity === identity);
  }
  applyVideoPolicy();
  applyVolumes();
}

function applyVideoPolicy() {
  const r = room;
  if (!r) return;
  const front = !lowPower.value;
  for (const p of r.remoteParticipants.values()) {
    const scr = p.getTrackPublication(Track.Source.ScreenShare) as RemoteTrackPublication | undefined;
    if (scr?.isSubscribed) {
      const watched = watching.value === p.identity;
      scr.setEnabled(watched ? !windowHidden.value || !prefs.value.backgroundSaver : front);
      scr.setVideoQuality(watched ? VideoQuality.HIGH : VideoQuality.LOW);
    }
    const cam = p.getTrackPublication(Track.Source.Camera) as RemoteTrackPublication | undefined;
    if (cam?.isSubscribed) cam.setEnabled(front);
  }
}
// Focus is usually lost before the window is hidden: lowPower alone misses that.
effect(() => {
  void lowPower.value;
  void windowHidden.value;
  applyVideoPolicy();
});

// Detail needs nearly as many bits as motion, or game scenes stutter.
const QUALITY: Record<ShareQuality, { w: number; h: number; fps: number; motion: number; detail: number }> = {
  '720p30': { w: 1280, h: 720, fps: 30, motion: 3_000_000, detail: 3_000_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, motion: 6_000_000, detail: 6_000_000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, motion: 9_000_000, detail: 6_000_000 },
  source60: { w: 3840, h: 2160, fps: 60, motion: 16_000_000, detail: 10_000_000 },
};

const shareFps = (o: ShareOptions) => (o.mode === 'detail' ? Math.min(QUALITY[o.quality].fps, 30) : QUALITY[o.quality].fps);

export async function startShare(opts: ShareOptions) {
  if (!room) throw new Error(t().core.voice.joinRoomFirst);
  const q = QUALITY[opts.quality];
  const fps = shareFps(opts);
  await bridge.selectCapture({ id: opts.sourceId, audio: opts.audio });
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: fps, max: fps } },
    audio:
      opts.audio === 'none'
        ? false
        : ({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
          } as MediaTrackConstraints),
    selfBrowserSurface: 'exclude',
    systemAudio: opts.audio === 'none' ? 'exclude' : 'include',
  } as DisplayMediaStreamOptions);
  const [raw] = stream.getVideoTracks();
  const [a] = stream.getAudioTracks();
  raw.contentHint = opts.mode === 'motion' ? 'motion' : 'detail';
  // Stop the previous capture only after switching.
  const previous = rawCapture;
  rawCapture = raw;
  let v = raw;
  if (platform === 'win32' && opts.sourceId.startsWith('window:')) {
    v = redrawFrames(raw);
    v.contentHint = raw.contentHint;
  } else {
    await alignFrameSize(raw, fps);
    const { width = 0, height = 0 } = raw.getSettings();
    captureSize = { width, height };
  }
  const audioInfo = await describeAudio(opts.audio, !!a);

  // Same publication: viewers stay in the stream.
  if (screenTracks.video && sharing.value) {
    await screenTracks.video.replaceTrack(v, true).finally(() => previous?.stop());
    if (screenTracks.audio && a) await screenTracks.audio.replaceTrack(a, true);
    else if (screenTracks.audio && !a) {
      await room.localParticipant.unpublishTrack(screenTracks.audio);
      screenTracks.audio = undefined;
    } else if (!screenTracks.audio && a) {
      screenTracks.audio = new LocalAudioTrack(a, undefined, true);
      await publishScreenAudio(room, screenTracks.audio);
    }
    raw.addEventListener('ended', () => stopShare());
    sharing.value = { ...opts, audioInfo };
    scheduleRefresh();
    return;
  }

  previous?.stop();
  const video = new LocalVideoTrack(v, undefined, true);
  const audio = a ? new LocalAudioTrack(a, undefined, true) : undefined;
  screenTracks = { video, audio };
  sharing.value = { ...opts, audioInfo };
  raw.addEventListener('ended', () => stopShare());
  try {
    await publishScreen(room, sharing.value, video, audio);
  } catch (e) {
    stopScreenTracks();
    sharing.value = null;
    throw e;
  }
  scheduleRefresh();
}

// Hardware H.264 needs even sizes, and the half-size layer must be even too.
async function alignFrameSize(v: MediaStreamTrack, fps: number) {
  const { width, height } = v.getSettings();
  if (!width || !height || (width % 4 === 0 && height % 4 === 0)) return;
  try {
    await v.applyConstraints({ width: { exact: width & ~3 }, height: { exact: height & ~3 }, frameRate: { ideal: fps, max: fps }, resizeMode: 'crop-and-scale' } as MediaTrackConstraints);
  } catch (e) {
    console.warn('frame size', e);
  }
}

// Chromium 156 crashes cropping odd-sized WGC GPU frames: draw into a multiple-of-4 canvas.
let rawCapture: MediaStreamTrack | null = null;
let captureSize = { width: 0, height: 0 };

function stopRawCapture() {
  rawCapture?.stop();
  rawCapture = null;
}

function redrawFrames(raw: MediaStreamTrack): MediaStreamTrack {
  const W = globalThis as unknown as {
    MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
    MediaStreamTrackGenerator: new (o: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
    ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> };
  };
  const reader = new W.MediaStreamTrackProcessor({ track: raw }).readable.getReader();
  const out = new W.MediaStreamTrackGenerator({ kind: 'video' });
  const writer = out.writable.getWriter();
  const mult4 = (n: number) => Math.max(4, n & ~3);
  const { width = 4, height = 4 } = raw.getSettings();
  const canvas = new OffscreenCanvas(mult4(width), mult4(height));
  captureSize = { width: canvas.width, height: canvas.height };
  const ctx = canvas.getContext('2d', { alpha: false })!;
  let drawn = false;
  let lastWrite = 0;
  let writing = Promise.resolve();
  let ended = false;
  const draw = (src: VideoFrame | ImageBitmap, sw: number, sh: number) => {
    const w = mult4(sw);
    const h = mult4(sh);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      captureSize = { width: w, height: h };
    }
    ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
    drawn = true;
  };
  // Repeated frames need monotonic timestamps.
  const emit = () => {
    if (ended) return;
    const f = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
    lastWrite = performance.now();
    writing = writing.then(() => writer.write(f)).catch(() => {}).finally(() => f.close());
  };
  // A static window delivers no frames: grab one and repeat it every second.
  const keepAlive = window.setInterval(() => {
    if (ended) return;
    if (!drawn && W.ImageCapture) {
      new W.ImageCapture(raw)
        .grabFrame()
        .then((bmp) => {
          if (!drawn) {
            draw(bmp, bmp.width, bmp.height);
            emit();
          }
          bmp.close();
        })
        .catch(() => {});
    } else if (drawn && performance.now() - lastWrite > 1000) emit();
  }, 500);
  (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        draw(frame, frame.displayWidth, frame.displayHeight);
        frame.close();
        emit();
        await writing;
      }
    } catch {
      /* the share was stopped */
    }
    ended = true;
    window.clearInterval(keepAlive);
    writer.close().catch(() => {});
    out.stop();
  })();
  return out;
}

async function describeAudio(mode: AudioMode, got: boolean): Promise<string> {
  const v = t().core.voice;
  if (mode === 'none' || !got) return v.audioNone;
  const info = await bridge.lastCaptureAudio();
  return info?.device === 'applicationLoopback' ? v.audioApp : v.audioSystem;
}

async function publishScreen(r: Room, o: ShareOptions, video: LocalVideoTrack, audio?: LocalAudioTrack) {
  const q = QUALITY[o.quality];
  const fps = shareFps(o);
  const bitrate = o.mode === 'motion' ? q.motion : q.detail;
  // One half-size layer for previews: extra layers only split the upload.
  // Odd or sub-360p sizes fall back to the software encoder.
  const { width, height } = captureSize;
  const half = { w: Math.max(width, height) / 2, h: Math.min(width, height) / 2 };
  const layers = half.h >= 360 ? [new VideoPreset(half.w, half.h, o.mode === 'motion' ? 1_000_000 : 600_000, o.mode === 'motion' ? 30 : 15)] : [];
  // Simulcast stalls the bandwidth estimate of 1440p/4K streams.
  const single = o.singleLayer || o.quality === 'source60' || layers.length === 0;
  await r.localParticipant.publishTrack(video, {
    source: Track.Source.ScreenShare,
    name: 'screen',
    videoCodec: VIDEO_CODEC,
    // A backup codec is a second software encoder on the streamer's PC.
    backupCodec: false,
    simulcast: !single,
    screenShareSimulcastLayers: single ? [] : layers,
    screenShareEncoding: { maxBitrate: bitrate, maxFramerate: fps, priority: 'high' },
    videoEncoding: { maxBitrate: bitrate, maxFramerate: fps, priority: 'high' },
    degradationPreference: o.mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
  });
  if (audio) await publishScreenAudio(r, audio);
}

async function publishScreenAudio(r: Room, audio: LocalAudioTrack) {
  await r.localParticipant.publishTrack(audio, {
    source: Track.Source.ScreenShareAudio,
    name: 'screen-audio',
    dtx: false, // not speech
    red: false,
    forceStereo: true,
    audioPreset: { maxBitrate: 160_000, priority: 'high' },
  });
}

function stopScreenTracks() {
  stopRawCapture();
  screenTracks.video?.stop();
  screenTracks.audio?.stop();
  screenTracks = {};
}

export async function stopShare() {
  const r = room;
  const tracks = screenTracks;
  screenTracks = {};
  sharing.value = null;
  if (r) {
    if (tracks.video) await r.localParticipant.unpublishTrack(tracks.video).catch(() => {});
    if (tracks.audio) await r.localParticipant.unpublishTrack(tracks.audio).catch(() => {});
  }
  tracks.video?.stop();
  tracks.audio?.stop();
  stopRawCapture();
  scheduleRefresh();
}

let ringTimeout: number | undefined;

export async function startCall(channelId: number, label: string) {
  await joinVoice({ channel_id: channelId }, label, { ringing: true });
  await api().ring(channelId);
  window.clearTimeout(ringTimeout);
  ringTimeout = window.setTimeout(() => {
    if (call.value?.status === 'ringing') {
      toast(t().core.voice.noAnswer);
      api()
        .cancelCall(channelId)
        .catch(() => {});
      leaveVoice();
    }
  }, 45000);
}

callEvents.addEventListener('call.declined', (e) => {
  const d = (e as CustomEvent).detail as { channel_id: number; by: number };
  const c = call.value;
  if (c && 'channel_id' in c.target && c.target.channel_id === d.channel_id && d.by !== me.value?.id && c.status === 'ringing') {
    toast(t().core.voice.declined);
    leaveVoice();
  }
});

export type MediaStats = {
  /** Allowed upload, bit/s. */
  uplink?: number;
  outbound: { kind: string; source: string; width?: number; height?: number; fps?: number; bitrate?: number; encoder?: string; powerEfficient?: boolean; limitation?: string; codec?: string }[];
  inbound: {
    kind: string;
    source: string;
    from: string;
    width?: number;
    height?: number;
    fps?: number;
    bitrate?: number;
    decoder?: string;
    framesDecoded?: number;
    freezeCount?: number;
    totalSamplesReceived?: number;
    audioLevel?: number;
    jitterBufferMs?: number;
    packetsLost?: number;
    packetsReceived?: number;
    bytesReceived?: number;
  }[];
};

const lastBytes = new Map<string, { bytes: number; t: number }>();

function rate(key: string, bytes: number, at: number) {
  const prev = lastBytes.get(key);
  lastBytes.set(key, { bytes, t: at });
  if (!prev || at <= prev.t) return undefined;
  return Math.round(((bytes - prev.bytes) * 8 * 1000) / (at - prev.t));
}

export async function collectStats(): Promise<MediaStats> {
  const out: MediaStats = { outbound: [], inbound: [] };
  const r = room;
  if (!r) return out;
  for (const pub of r.localParticipant.trackPublications.values()) {
    const sender = pub.track?.sender;
    if (!sender) continue;
    const report = await sender.getStats();
    report.forEach((s: any) => {
      if (s.type === 'candidate-pair' && s.nominated && s.availableOutgoingBitrate) out.uplink = s.availableOutgoingBitrate;
      if (s.type !== 'outbound-rtp') return;
      out.outbound.push({
        kind: s.kind,
        source: pub.source,
        width: s.frameWidth,
        height: s.frameHeight,
        fps: s.framesPerSecond,
        bitrate: rate('o' + s.id, s.bytesSent, s.timestamp),
        encoder: s.encoderImplementation,
        powerEfficient: s.powerEfficientEncoder,
        limitation: s.qualityLimitationReason,
        codec: s.codecId ? `${report.get(s.codecId)?.mimeType ?? ''} ${report.get(s.codecId)?.sdpFmtpLine ?? ''}`.trim() : undefined,
      });
    });
  }
  for (const p of r.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      const receiver = (pub.track as { receiver?: RTCRtpReceiver } | undefined)?.receiver;
      if (!receiver) continue;
      const report = await receiver.getStats();
      report.forEach((s: any) => {
        if (s.type !== 'inbound-rtp') return;
        out.inbound.push({
          kind: s.kind,
          source: pub.source,
          from: p.identity,
          width: s.frameWidth,
          height: s.frameHeight,
          fps: s.framesPerSecond,
          bitrate: rate('i' + s.id, s.bytesReceived, s.timestamp),
          decoder: s.decoderImplementation,
          framesDecoded: s.framesDecoded,
          freezeCount: s.freezeCount,
          totalSamplesReceived: s.totalSamplesReceived,
          audioLevel: s.audioLevel,
          jitterBufferMs: s.jitterBufferEmittedCount ? (1000 * s.jitterBufferDelay) / s.jitterBufferEmittedCount : undefined,
          packetsLost: s.packetsLost,
          packetsReceived: s.packetsReceived,
          bytesReceived: s.bytesReceived,
        });
      });
    }
  }
  return out;
}

export function connectionState(): ConnectionState | null {
  return room?.state ?? null;
}

const TONES = {
  join: [523, 784],
  leave: [784, 523],
  mute: [440],
  unmute: [660],
  ring: [660, 880, 660, 880],
  'ptt-on': [990],
  'ptt-off': [740],
  test: [523, 659, 784, 1047],
};

let actx: AudioContext | null = null;
export function playTone(kind: keyof typeof TONES) {
  if (!prefs.value.sounds) return;
  try {
    actx ??= new AudioContext();
    let at = actx.currentTime;
    for (const f of TONES[kind]) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      o.connect(g).connect(actx.destination);
      o.start(at);
      o.stop(at + 0.15);
      at += 0.12;
    }
  } catch {
    /* audio unavailable */
  }
}

let ringLoop: number | undefined;
export function ringing(on: boolean) {
  window.clearInterval(ringLoop);
  if (on) {
    playTone('ring');
    ringLoop = window.setInterval(() => playTone('ring'), 2000);
  }
}
