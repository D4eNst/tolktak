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
  type LocalTrack,
  type TrackPublishOptions,
} from 'livekit-client';
import { VoiceChain, type ChainSettings, type ChainStats, type Denoise } from './audio/chain';
import { configureSounds, playSound as playTone } from './audio/sounds';
import { SOUND_THEMES, type SoundTheme } from '../sounds';
import { ApiError, type Api, type VoiceModerationEvent, type VoicePermissions, type VoiceSource } from './api';
import { bridge, platform, type AudioMode } from './bridge';
import { t } from './i18n';
import { api, appActive, callEvents, errorText, me, sendRealtime, session, toast, userName, windowHidden } from './state';
import { STREAM_REACTIONS } from './ui/emoji';

export type Prefs = {
  inputDevice: string;
  outputDevice: string;
  cameraDevice: string;
  echoCancellation: boolean;
  denoise: Denoise;
  agc: boolean;
  inputGain: number; // dB, manual gain when the leveller is off
  agcGain: Record<string, number>; // input device -> gain the leveller learned
  startMuted: boolean;
  voiceVolume: number; // 0..2
  streamVolume: number; // 0..2
  ducking: boolean;
  duckLevel: number; // 0..1, stream volume factor while someone talks
  userVolume: Record<string, number>; // identity -> 0..2
  sounds: boolean;
  soundVolume: number;
  soundTheme: SoundTheme;
  micMuted: boolean;
  deafened: boolean;
  micMode: 'voice' | 'ptt';
  vadAuto: boolean; // false: open the mic only above vadThreshold
  vadThreshold: number; // dBFS, -80..0
  pttRelease: number; // ms the mic stays open after the key is released
  cameraQuality: '720p' | '1080p';
  mirrorCamera: boolean;
  cameraPreview: boolean; // a look at the camera before turning it on
  streamReactions: boolean;
  backgroundSaver: boolean;
};

const PREFS_KEY = 'tolktak.voice';
const defaultPrefs: Prefs = {
  inputDevice: 'default',
  outputDevice: 'default',
  cameraDevice: '',
  echoCancellation: true,
  denoise: 'medium',
  agc: true,
  inputGain: 0,
  agcGain: {},
  startMuted: false,
  voiceVolume: 1,
  streamVolume: 1,
  ducking: true,
  duckLevel: 0.4,
  userVolume: {},
  sounds: true,
  soundVolume: 0.7,
  soundTheme: 'tok-tak',
  micMuted: false,
  deafened: false,
  micMode: 'voice',
  vadAuto: true,
  vadThreshold: -50,
  pttRelease: 200,
  cameraQuality: '720p',
  cameraPreview: true,
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
    const soundVolume = typeof saved.soundVolume === 'number' && Number.isFinite(saved.soundVolume)
      ? Math.max(0, Math.min(1, saved.soundVolume)) : defaultPrefs.soundVolume;
    const soundTheme = SOUND_THEMES.includes(saved.soundTheme) ? saved.soundTheme : defaultPrefs.soundTheme;
    return { ...defaultPrefs, ...saved, soundVolume, soundTheme };
  } catch {
    return { ...defaultPrefs };
  }
}

export const prefs = signal<Prefs>(loadPrefs());
effect(() => configureSounds(prefs.value));
export { playTone };
export { ringing } from './audio/sounds';

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
  shared: boolean;
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
export const voicePermissions = signal<VoicePermissions | null>(null);
export const watching = signal<string | null>(null);
// Hover previews play at reduced volume.
export const previewing = signal<string | null>(null);
// Rendered screen heights in device pixels determine the subscribed layer.
export const screenHeights = signal<Record<string, number>>({});
export const speakingRemote = signal(false);
export const speaking = signal<ReadonlySet<string>>(new Set());

export const streams = computed(() => peers.value.filter((p) => p.shared));

let room: Room | null = null;
let callApi: Api | null = null;
let callGeneration = 0;
let voiceCleanup = Promise.resolve();
let leaving = false;
let rejoining = 0;
let screenTracks: { video?: LocalVideoTrack; audio?: LocalAudioTrack } = {};
let shareGeneration = 0;
let joiningTarget: CallTarget | null = null;
let permissionsOwner: Api | null = null;
let permissionsUser = 0;
const permissionCache = new Map<number, VoicePermissions>();
const moderationSeen = new Map<number, number>();
let permissionRefresh: { owner: Api; generation: number; roomID: number; controller: AbortController; promise: Promise<void> } | null = null;
const captureEpoch: Record<VoiceSource, number> = { microphone: 0, camera: 0, screen: 0 };
const captureIntent: Record<VoiceSource, boolean> = { microphone: false, camera: false, screen: false };
const sourceQueues = new WeakMap<Room, Partial<Record<VoiceSource, Promise<unknown>>>>();
const publishingEpoch = new WeakMap<Room, Partial<Record<VoiceSource, number>>>();
const pendingTracks = new Map<Room, Set<{ source: VoiceSource; track: LocalTrack | MediaStreamTrack }>>();
const pendingDisplays = new Set<MediaStream>();
const guardedTracks = new WeakMap<LocalTrack, { room: Room; source: VoiceSource }>();
const expectedUnpublishes = new WeakMap<Room, Map<LocalTrack | MediaStreamTrack, number>>();
const sourceOf = (source?: Track.Source): VoiceSource | undefined => source === Track.Source.Microphone ? 'microphone' : source === Track.Source.Camera ? 'camera' : source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio ? 'screen' : undefined;
const roomID = (target?: CallTarget | null) => target && 'room_id' in target ? target.room_id : null;

function bindPermissions(owner: Api | null, uid: number) {
  if (permissionsOwner === owner && permissionsUser === uid) return;
  permissionRefresh?.controller.abort();
  permissionRefresh = null;
  permissionsOwner = owner;
  permissionsUser = uid;
  permissionCache.clear();
  moderationSeen.clear();
  voicePermissions.value = null;
}

export function mediaAllowed(source: VoiceSource): boolean {
  const c = call.value;
  const s = session.value;
  if (!c || !s || callApi !== s.api) return true;
  const permissions = voicePermissions.value;
  return !permissions || permissionsOwner !== s.api || permissions.user_id !== s.me.id || permissions.room_id !== roomID(c.target) || (permissions.allowed.entry && permissions.allowed[source]);
}

function blocked(source: VoiceSource) { toast(t().moderation.permissionDenied(source), 'error'); }
function sourceCurrent(r: Room, source: VoiceSource, epoch: number) {
  return currentRoom(r) && captureEpoch[source] === epoch && captureIntent[source] && mediaAllowed(source);
}
function queueSource<T>(r: Room, source: VoiceSource, task: () => Promise<T>): Promise<T> {
  let queues = sourceQueues.get(r);
  if (!queues) sourceQueues.set(r, queues = {});
  const next = (queues[source] ?? Promise.resolve()).catch(() => {}).then(task);
  queues[source] = next;
  return next;
}
function waitForStop(r: Room, source: VoiceSource, stopping: Promise<unknown>) {
  let queues = sourceQueues.get(r);
  if (!queues) sourceQueues.set(r, queues = {});
  queues[source] = Promise.allSettled([queues[source], stopping]);
  return queues[source]!.then(() => {});
}
async function retireTrack(r: Room, track: LocalTrack | MediaStreamTrack) {
  track.stop();
  await unpublishOwned(r, track).catch(() => {});
}

async function expectingUnpublish<T>(r: Room, track: LocalTrack | MediaStreamTrack, action: () => Promise<T>): Promise<T> {
  let expected = expectedUnpublishes.get(r);
  if (!expected) expectedUnpublishes.set(r, expected = new Map());
  expected.set(track, (expected.get(track) ?? 0) + 1);
  try { return await action(); }
  finally {
    const count = (expected.get(track) ?? 1) - 1;
    if (count) expected.set(track, count);
    else expected.delete(track);
  }
}
function unpublishOwned(r: Room, track: LocalTrack | MediaStreamTrack) {
  return expectingUnpublish(r, track, () => r.localParticipant.unpublishTrack(track));
}

/** LiveKit's internal republish bypasses publishTrack and may restart an old device track. */
function guardTrack(r: Room, source: VoiceSource, candidate: LocalTrack | MediaStreamTrack) {
  if (!('mediaStreamTrack' in candidate)) return;
  const track = candidate as LocalTrack;
  const old = guardedTracks.get(track);
  guardedTracks.set(track, { room: r, source });
  if (old) return;
  for (const method of ['restartTrack', 'unmute'] as const) {
    const original = track[method].bind(track) as (...args: unknown[]) => Promise<unknown>;
    const guarded = async (...args: unknown[]) => {
      const context = guardedTracks.get(track)!;
      const epoch = publishingEpoch.get(context.room)?.[context.source];
      const current = () => epoch !== undefined && sourceCurrent(context.room, context.source, epoch) &&
        (context.source !== 'microphone' || (!prefs.value.micMuted && !deafened.value));
      if (!current()) { track.stop(); throw new DOMException('Capture cancelled', 'AbortError'); }
      let pending = pendingTracks.get(context.room);
      if (!pending) pendingTracks.set(context.room, pending = new Set());
      const entry = { source: context.source, track };
      pending.add(entry);
      try {
        const result = await original(...args);
        if (!current()) { await retireTrack(context.room, track); throw new DOMException('Capture cancelled', 'AbortError'); }
        return result;
      } finally {
        pending.delete(entry);
        if (!pending.size && pendingTracks.get(context.room) === pending) pendingTracks.delete(context.room);
      }
    };
    (track as unknown as Record<string, unknown>)[method] = guarded;
  }
}

function retireSource(r: Room, source: VoiceSource): Promise<void> {
  const tracks = new Set<LocalTrack | MediaStreamTrack>();
  for (const publication of r.localParticipant.trackPublications.values()) if (sourceOf(publication.source) === source && publication.track) tracks.add(publication.track);
  for (const pending of pendingTracks.get(r) ?? []) if (pending.source === source) tracks.add(pending.track);
  for (const track of tracks) track.stop();
  return Promise.all([...tracks].map((track) => retireTrack(r, track))).then(() => {});
}
function stopSource(source: VoiceSource): Promise<void> {
  if (source === 'screen') return stopShare();
  ++captureEpoch[source];
  captureIntent[source] = false;
  if (source === 'microphone') {
    if (!prefs.value.micMuted) setPrefs({ micMuted: true });
    micOn.value = false;
    micOpen.value = false;
    micLevel.value = 0;
  } else cameraOn.value = false;
  const r = room;
  const stopped = r ? waitForStop(r, source, retireSource(r, source)) : Promise.resolve();
  reportState();
  scheduleRefresh();
  return stopped;
}

/** Guard SDK-internal publishes too, including reconnect republishing after a one-shot off. */
function guardPublishing(r: Room) {
  const unpublish = r.localParticipant.unpublishTrack.bind(r.localParticipant);
  // SDK 2.23 supplies an explicit bool for republish/disconnect, unlike server source removal.
  r.localParticipant.unpublishTrack = (track, stopOnUnpublish) => stopOnUnpublish === undefined
    ? unpublish(track)
    : expectingUnpublish(r, track, () => unpublish(track, stopOnUnpublish));
  const original = r.localParticipant.publishTrack.bind(r.localParticipant);
  r.localParticipant.publishTrack = async (track: LocalTrack | MediaStreamTrack, options?: TrackPublishOptions) => {
    const source = sourceOf(options?.source ?? (track as LocalTrack).source);
    if (!source) return original(track, options);
    guardTrack(r, source, track);
    // Ordinary mute keeps an existing muted microphone warm; moderation off stops it entirely.
    const mutedMic = () => source === 'microphone' && (track as LocalTrack).isMuted && (track as LocalTrack).mediaStreamTrack?.readyState === 'live' && (prefs.value.micMuted || deafened.value);
    const epoch = mutedMic() ? captureEpoch[source] : publishingEpoch.get(r)?.[source];
    const current = () => epoch !== undefined && currentRoom(r) && captureEpoch[source] === epoch && mediaAllowed(source) && (captureIntent[source] || mutedMic());
    if (!current()) { track.stop(); throw new DOMException('Capture cancelled', 'AbortError'); }
    let pending = pendingTracks.get(r);
    if (!pending) pendingTracks.set(r, pending = new Set());
    const entry = { source, track };
    pending.add(entry);
    try {
      const publication = await original(track, options);
      if (!current()) {
        await retireTrack(r, track);
        throw new DOMException('Capture cancelled', 'AbortError');
      }
      return publication;
    } finally {
      pending.delete(entry);
      if (!pending.size && pendingTracks.get(r) === pending) pendingTracks.delete(r);
    }
  };
}
function allowPublishing(r: Room, source: VoiceSource, epoch = captureEpoch[source]) {
  let epochs = publishingEpoch.get(r);
  if (!epochs) publishingEpoch.set(r, epochs = {});
  epochs[source] = epoch;
}

function rememberPermissions(permissions: VoicePermissions, owner: Api): boolean {
  const s = session.value;
  if (!s || s.api !== owner || permissions.user_id !== s.me.id) return false;
  bindPermissions(owner, s.me.id);
  const rid = permissions.room_id;
  if (rid !== null) {
    const old = permissionCache.get(rid);
    if (old && old.moderation_version > permissions.moderation_version) return false;
    permissionCache.delete(rid);
    permissionCache.set(rid, permissions);
    while (permissionCache.size > 100) {
      const expired = permissionCache.keys().next().value!;
      permissionCache.delete(expired); moderationSeen.delete(expired);
    }
  }
  const target = call.value?.target ?? joiningTarget;
  if (target && roomID(target) !== rid) return true;
  voicePermissions.value = permissions;
  if (!target || callApi !== owner) return true;
  if (!permissions.allowed.entry) {
    toast(t().moderation.removed, 'error');
    void leaveVoice();
    return true;
  }
  for (const source of ['microphone', 'camera', 'screen'] as const) if (!permissions.allowed[source]) void stopSource(source);
  return true;
}

export function handleVoiceModeration(event: VoiceModerationEvent): void {
  const s = session.value;
  if (!s || event.user_id !== s.me.id || event.permissions.user_id !== s.me.id || event.permissions.room_id !== event.room_id) return;
  bindPermissions(s.api, s.me.id);
  const version = event.permissions.moderation_version;
  if (version < (permissionCache.get(event.room_id)?.moderation_version ?? -1) || version <= (moderationSeen.get(event.room_id) ?? -1)) return;
  moderationSeen.set(event.room_id, version);
  const applies = callApi === s.api && roomID(call.value?.target ?? joiningTarget) === event.room_id;
  if (!rememberPermissions(event.permissions, s.api) || !applies) return;
  if (event.action === 'off' && event.source !== 'entry') void stopSource(event.source);
  if (event.action === 'set' && event.source !== 'entry' && !event.permissions.allowed[event.source]) blocked(event.source);
}

export async function refreshVoicePermissions(): Promise<void> {
  const s = session.value;
  const c = call.value;
  const rid = roomID(c?.target) ?? (!c ? voicePermissions.value?.room_id : null);
  if (!s || rid === null || rid === undefined || !s.server.capabilities?.moderation) return;
  bindPermissions(s.api, s.me.id);
  const generation = callGeneration;
  if (permissionRefresh?.owner === s.api && permissionRefresh.generation === generation && permissionRefresh.roomID === rid) return permissionRefresh.promise;
  permissionRefresh?.controller.abort();
  const controller = new AbortController();
  const task = (async () => {
    const permissions = await s.api.roomPermissions(rid, controller.signal);
    if (controller.signal.aborted || session.value?.api !== s.api || session.value.me.id !== s.me.id || callGeneration !== generation || (c && call.value !== c && roomID(call.value?.target) !== rid)) return;
    rememberPermissions(permissions, s.api);
  })();
  const request = { owner: s.api, generation, roomID: rid, controller, promise: task };
  permissionRefresh = request;
  try { await task; }
  finally { if (permissionRefresh === request) permissionRefresh = null; }
}

callEvents.addEventListener('voice.moderation', (event) => handleVoiceModeration((event as CustomEvent<VoiceModerationEvent>).detail));
callEvents.addEventListener('voice.resync', () => { void refreshVoicePermissions().catch(() => {}); });

// For tests and diagnostics.
(globalThis as unknown as Record<string, unknown>).__tolktak = {
  get room() {
    return room;
  },
  stats: () => collectStats(),
  // Layout fixture without an SFU connection.
  mock: (c: typeof call.value, list: PeerView[]) => {
    call.value = c;
    peers.value = list;
  },
  share: (o: ShareOptions) => startShare(o),
  stopShare: () => stopShare(),
  setPrefs: (p: Partial<Prefs>) => setPrefs(p),
  restartMic: () => restartMic(),
  toggleDeafen: () => toggleDeafen(),
};

export async function joinVoice(target: CallTarget, label: string, opts: { ringing?: boolean } = {}) {
  const owner = api();
  if (call.value && callApi === owner && sameTarget(call.value.target, target)) return callGeneration;
  const generation = ++callGeneration;
  const current = () => generation === callGeneration && session.value?.api === owner;
  if (call.value) await clearVoice();
  else await voiceCleanup;
  if (!current()) return;
  callApi = owner;
  joiningTarget = target;
  bindPermissions(owner, session.value!.me.id);
  voicePermissions.value = roomID(target) === null ? null : permissionCache.get(roomID(target)!) ?? null;
  leaving = false;
  try {
    const { url, token, room: roomName, permissions } = await owner.joinVoice(target);
    if (!current()) return;
    if (permissions) rememberPermissions(permissions, owner);
    else voicePermissions.value = null; // Older servers have no moderation contract.
    if (!current()) return;
    call.value = { room: roomName, label, target, status: opts.ringing ? 'ringing' : 'connecting' };
    joiningTarget = null;
    bridge.setInCall(true);
    if (!(await connect(url, token, false, current))) return;
    sendRealtime({ type: 'voice.joined', room: roomName, muted: !micOn.value, deafened: deafened.value });
    playTone('join');
    return generation;
  } catch (e) {
    if (!current()) return;
    await clearVoice();
    throw e;
  }
}

function sameTarget(a: CallTarget, b: CallTarget) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function currentRoom(r: Room) {
  return r === room && callApi === session.value?.api;
}

async function connect(url: string, token: string, isRejoin: boolean, current: () => boolean) {
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
  guardPublishing(r);
  wire(r);
  startSpeakingLoop();
  try {
    // Stream audio is fetched only for the watched stream.
    await r.connect(url, token, { autoSubscribe: false });
    if (!current() || !currentRoom(r)) return false;
    syncSubscriptions(r);
    if (call.value) call.value = { ...call.value, status: call.value.status === 'ringing' ? 'ringing' : 'connected' };
    if (!isRejoin && prefs.value.startMuted) setPrefs({ micMuted: true });
    const wantMic = !prefs.value.micMuted && !deafened.value && mediaAllowed('microphone');
    try {
      if (wantMic) await enableMicrophone(r);
      else micOn.value = false;
      if (!current() || !currentRoom(r)) return false;
      await applyOutputDevice(r);
    } catch (e) {
      if (!current() || !currentRoom(r)) return false;
      micOn.value = false;
      toast(t().core.voice.micUnavailable(errorText(e)), 'error');
    }
    if (!current() || !currentRoom(r)) return false;
    if (screenTracks.video?.mediaStreamTrack.readyState === 'ended') { stopScreenTracks(); sharing.value = null; }
    if (screenTracks.video && sharing.value && mediaAllowed('screen')) {
      captureIntent.screen = true;
      allowPublishing(r, 'screen');
      await publishScreen(r, sharing.value, screenTracks.video, screenTracks.audio);
    }
    if (!current() || !currentRoom(r)) return false;
    if (cameraOn.value) await setCamera(true);
    if (!current() || !currentRoom(r)) return false;
    refresh();
    return true;
  } finally {
    if (!current() || !currentRoom(r)) await r.disconnect().catch(() => {});
  }
}

export function micConstraints() {
  const p = prefs.value;
  return {
    deviceId: p.inputDevice && p.inputDevice !== 'default' ? { ideal: p.inputDevice } : undefined,
    echoCancellation: p.echoCancellation,
    // Browser AGC can cause volume pumping; prefer the worklet chain.
    noiseSuppression: chainBroken && p.denoise !== 'off',
    autoGainControl: chainBroken && p.agc,
    channelCount: 1,
  };
}

export async function leaveVoice() {
  ++callGeneration;
  await clearVoice();
}

function clearVoice() {
  const c = call.value;
  callApi = null;
  joiningTarget = null;
  permissionRefresh?.controller.abort();
  permissionRefresh = null;
  for (const source of ['microphone', 'camera', 'screen'] as const) { captureEpoch[source]++; captureIntent[source] = false; }
  leaving = true;
  window.clearTimeout(ringTimeout);
  stopScreenTracks();
  const r = room;
  if (r) {
    for (const pub of r.localParticipant.trackPublications.values()) pub.track?.stop();
    for (const pending of pendingTracks.get(r) ?? []) pending.track.stop();
    pendingTracks.delete(r);
  }
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
  audioSink().replaceChildren();
  lastBytes.clear();
  if (c) playTone('leave');
  const cleanup = r?.disconnect().catch(() => {});
  // Close the old transport before reconnecting with the same identity.
  voiceCleanup = Promise.all([voiceCleanup, cleanup]).then(() => {});
  return voiceCleanup;
}

effect(() => {
  const s = session.value;
  const owner = s?.api;
  if (callApi && owner !== callApi) void leaveVoice();
  bindPermissions(owner ?? null, s?.me.id ?? 0);
});

function wantSubscribed(source: Track.Source, identity: string) {
  return source !== Track.Source.ScreenShareAudio || watching.value === identity || previewing.value === identity;
}

// Use the SFU forwarding flag; resubscribing can leave tracks silent.
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
  const update = () => currentRoom(r) && scheduleRefresh();
  const reconnecting = () => {
    if (!currentRoom(r)) return;
    if (call.value) call.value = { ...call.value, status: 'reconnecting' };
  };
  r.on(RoomEvent.ParticipantConnected, (p) => {
    if (!currentRoom(r)) return;
    update();
    if (call.value?.status === 'ringing') call.value = { ...call.value, status: 'connected' };
    if (p.identity !== String(me.value?.id)) playTone('peer-join');
  })
    .on(RoomEvent.ParticipantDisconnected, () => {
      if (!currentRoom(r)) return;
      update();
      playTone('peer-leave');
    })
    .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      if (!currentRoom(r)) return;
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
    .on(RoomEvent.LocalTrackPublished, (publication) => {
      if (!currentRoom(r)) { publication.track?.stop(); return; }
      const source = sourceOf(publication.source);
      if (source && publication.track) {
        guardTrack(r, source, publication.track);
        const epoch = publishingEpoch.get(r)?.[source];
        const mutedMic = source === 'microphone' && publication.isMuted && (prefs.value.micMuted || deafened.value) && publication.track.mediaStreamTrack.readyState === 'live';
        if (!mediaAllowed(source) || (epoch === undefined || !sourceCurrent(r, source, epoch)) && !mutedMic) {
          void retireTrack(r, publication.track);
          return;
        }
      }
      update();
    })
    .on(RoomEvent.LocalTrackUnpublished, (publication) => {
      const source = sourceOf(publication.source);
      const track = publication.track;
      const expected = expectedUnpublishes.get(r);
      const owned = track && (expected?.has(track) || expected?.has(track.mediaStreamTrack));
      if (currentRoom(r) && source && track && !owned && captureIntent[source]) {
        // A server one-shot off may arrive even if the app websocket event was lost.
        track.stop();
        void stopSource(source);
      }
      update();
    })
    .on(RoomEvent.TrackPublished, (pub, p) => {
      if (!currentRoom(r)) return;
      (pub as RemoteTrackPublication).setSubscribed(wantSubscribed(pub.source, p.identity));
      if (pub.source === Track.Source.ScreenShare) {
        toast(t().core.voice.streamStarted(p.name || userName(Number(p.identity))));
      }
      update();
    })
    .on(RoomEvent.TrackUnpublished, (pub, p) => {
      if (!currentRoom(r)) return;
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
      if (!currentRoom(r)) return;
      if (call.value) call.value = { ...call.value, status: 'connected' };
      void refreshVoicePermissions().catch(() => {});
      toast(t().core.voice.reconnected);
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (!currentRoom(r) || leaving) return;
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
        toast(t().core.voice.removed, 'error');
        leaveVoice();
        return;
      }
      // Past LiveKit's own resume window.
      rejoin();
    })
    .on(RoomEvent.MediaDevicesError, (e: Error) => {
      if (currentRoom(r)) toast(t().core.voice.deviceError(e.message), 'error');
    })
    .on(RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (!currentRoom(r) || topic !== 'react' || !p) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.t === 'react' && STREAM_REACTIONS.includes(msg.e)) showFloater(msg.e, Number(p.identity));
      } catch {
        /* malformed */
      }
    });
}

// Connect failures also emit Disconnected; keep one retry loop.
async function rejoin() {
  const c = call.value;
  const owner = callApi;
  const generation = callGeneration;
  if (!c || !owner || rejoining === generation) return;
  const current = () => generation === callGeneration && session.value?.api === owner && call.value?.room === c.room;
  rejoining = generation;
  call.value = { ...c, status: 'reconnecting' };
  for (let attempt = 0; ; attempt++) {
    await new Promise((res) => setTimeout(res, Math.min(30000, 1000 * 2 ** attempt)));
    if (!current()) break;
    try {
      const { url, token, permissions } = await owner.joinVoice(c.target);
      if (!current()) break;
      if (permissions) rememberPermissions(permissions, owner);
      if (!current()) break;
      await room?.disconnect().catch(() => {});
      if (!current()) break;
      if (!(await connect(url, token, true, current))) break;
      if (!current()) break;
      if (room?.state === ConnectionState.Disconnected) continue;
      toast(t().core.voice.rejoined);
      break;
    } catch (error) {
      if (!current()) break;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        toast(errorText(error), 'error');
        await leaveVoice();
        break;
      }
      /* try again */
    }
  }
  if (rejoining === generation) rejoining = 0;
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  // Hidden windows require timer-based updates.
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
    screen: scr?.track,
    shared: !!scr,
    screenAudio: !!scrA,
    quality: p.connectionQuality,
  };
}

function refresh() {
  const r = room;
  if (!r) {
    peers.value = [];
    return;
  }
  const list = [viewOf(r.localParticipant, true), ...[...r.remoteParticipants.values()].map((p) => viewOf(p, false))];
  peers.value = list;
  if (watching.value && !list.some((p) => p.identity === watching.value && p.shared)) watching.value = null;
}

async function enableMicrophone(r: Room): Promise<boolean> {
  const epoch = captureEpoch.microphone;
  captureIntent.microphone = true;
  return queueSource(r, 'microphone', async () => {
    const current = () => sourceCurrent(r, 'microphone', epoch) && !prefs.value.micMuted && !deafened.value;
    if (!current()) return false;
    allowPublishing(r, 'microphone', epoch);
    try {
      const publication = await r.localParticipant.setMicrophoneEnabled(true, micConstraints());
      if (!current()) {
        if (publication?.track) await retireTrack(r, publication.track);
        return false;
      }
      if (!publication?.track || publication.track.mediaStreamTrack.readyState === 'ended') return false;
      micOn.value = true;
      await applyGate(r);
      if (!current()) { await retireTrack(r, publication.track); return false; }
      return true;
    } catch (error) {
      if (!current()) return false;
      micOn.value = false;
      throw error;
    }
  });
}

function muteMicrophone(r: Room): Promise<void> {
  ++captureEpoch.microphone;
  captureIntent.microphone = false;
  micOn.value = false;
  micOpen.value = false;
  const stopping = r.localParticipant.setMicrophoneEnabled(false).then(() => {}).catch(() => {});
  return waitForStop(r, 'microphone', stopping);
}

export async function toggleMic() {
  const r = room;
  const next = !micOn.value;
  if (next && !mediaAllowed('microphone')) { blocked('microphone'); return; }
  if (next && deafened.value) {
    // Unmuting also undeafens.
    deafened.value = false;
    setPrefs({ deafened: false });
    if (r) applyDeafen(r);
  }
  setPrefs({ micMuted: !next });
  if (!r) {
    micOn.value = next;
    if (micOn.value === next) playTone(next ? 'unmute' : 'mute');
    return;
  }
  try {
    if (next) await enableMicrophone(r);
    else await muteMicrophone(r);
    if (!currentRoom(r)) return;
    if (micOn.value === next) playTone(next ? 'unmute' : 'mute');
  } catch (e) {
    if (!currentRoom(r)) return;
    toast(t().core.voice.micUnavailable(errorText(e)), 'error');
  }
  reportState();
}

export async function toggleDeafen() {
  const r = room;
  const next = !deafened.value;
  deafened.value = next;
  setPrefs({ deafened: next });
  if (next) {
    if (r) await muteMicrophone(r);
    if (r && !currentRoom(r)) return;
    micOn.value = false;
  } else {
    const want = !prefs.value.micMuted && mediaAllowed('microphone');
    if (r && want) {
      await enableMicrophone(r).catch(() => undefined);
      if (!currentRoom(r)) return;
    } else micOn.value = want;
  }
  playTone(next ? 'mute' : 'unmute');
  if (r) applyDeafen(r);
  applyVolumes();
  reportState();
}

// A track processor: the gate opens and closes without mute signalling.

let pttHeld = false;
export function setPushToTalk(down: boolean) {
  if (down && call.value && !mediaAllowed('microphone')) { pttHeld = false; activeChain?.set({ ptt: false }); return; }
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
  private generation = 0;
  constructor(private current: () => boolean) {}

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
    const generation = ++this.generation;
    const chain = await createVoiceChain(track, (s) => {
      if (!this.current() || !micOn.value || generation !== this.generation) return;
      lastGain = s.gain;
      rememberGain();
      const g = Math.round(s.gain);
      if (micGain.value !== g) micGain.value = g;
      const open = s.open && (prefs.value.micMode === 'ptt' || !prefs.value.vadAuto || s.speech);
      if (micOpen.value !== open) micOpen.value = open;
      micLevel.value = Math.max(0, Math.min(1, (s.level + 70) / 60));
      localOut = { db: s.out, at: performance.now() };
    });
    if (!this.current() || generation !== this.generation || track.readyState === 'ended') {
      chain.close();
      return;
    }
    this.chain = chain;
    activeChain = chain;
    this.processedTrack = chain.output;
  }
  private teardown() {
    this.generation++;
    if (activeChain === this.chain) {
      rememberGain(true);
      activeChain = null;
      micOpen.value = false;
    }
    this.chain?.close();
    this.chain = undefined;
    this.processedTrack = undefined;
  }
}

function wantsChain(p = prefs.value) {
  return !chainBroken && (p.denoise !== 'off' || p.agc || p.inputGain !== 0 || p.micMode === 'ptt' || !p.vadAuto);
}

export async function applyGate(r = room) {
  if (!r || !currentRoom(r) || !micOn.value || !captureIntent.microphone || !mediaAllowed('microphone')) return;
  const pub = r.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track as LocalAudioTrack | undefined;
  if (!track) return;
  const want = wantsChain();
  const current = track.getProcessor() as VoiceProcessor | undefined;
  try {
    if (want && !current) await track.setProcessor(new VoiceProcessor(() => currentRoom(r) && captureIntent.microphone && mediaAllowed('microphone')) as never);
    if (!want && current) {
      await track.stopProcessor();
      if (r === room) micOpen.value = false;
    }
  } catch (e) {
    if (!currentRoom(r) || !mediaAllowed('microphone') || !captureIntent.microphone || track.mediaStreamTrack.readyState === 'ended') return;
    console.warn('voice processing unavailable', e);
    chainBroken = true;
    await track.stopProcessor().catch(() => {});
    if (!currentRoom(r)) return;
    // Processor recovery runs after the current source operation leaves its queue.
    void restartMic().catch(() => {});
  }
}

// Settings apply live, only a new noise model needs a new chain.
effect(() => {
  const s = chainSettings(prefs.value);
  activeChain?.set(s);
});

// Measure levels locally; LiveKit speaker events are delayed and smoothed.
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
      // Reuse the room context to avoid another audio thread.
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
function reportState() {
  if (call.value) sendRealtime({ type: 'voice.state', room: call.value.room, muted: !micOn.value, deafened: deafened.value });
}

export async function setCamera(on: boolean) {
  const r = room;
  if (!r) return;
  if (!on) return stopSource('camera');
  if (!mediaAllowed('camera')) { blocked('camera'); return; }
  const epoch = captureEpoch.camera;
  captureIntent.camera = true;
  await queueSource(r, 'camera', async () => {
    if (!sourceCurrent(r, 'camera', epoch)) return;
    allowPublishing(r, 'camera', epoch);
    try {
      const camera = await r.localParticipant.setCameraEnabled(true,
        { resolution: camPreset().resolution, deviceId: prefs.value.cameraDevice || undefined },
        { simulcast: true, videoCodec: VIDEO_CODEC, backupCodec: false, videoEncoding: camPreset().encoding });
      if (!sourceCurrent(r, 'camera', epoch)) {
        if (camera?.track) await retireTrack(r, camera.track);
        return;
      }
      cameraOn.value = !!camera?.track && camera.track.mediaStreamTrack.readyState !== 'ended';
    } catch (error) {
      if (!sourceCurrent(r, 'camera', epoch)) return;
      cameraOn.value = false;
      toast(t().core.voice.cameraUnavailable(errorText(error)), 'error');
    }
    scheduleRefresh();
  });
}

function camPreset() {
  return prefs.value.cameraQuality === '1080p' ? VideoPresets.h1080 : VideoPresets.h720;
}

export async function restartCamera() {
  const r = room;
  if (!r || !cameraOn.value) return;
  const epoch = captureEpoch.camera;
  await setCamera(false);
  if (!currentRoom(r) || captureEpoch.camera !== epoch + 1 || !mediaAllowed('camera')) return;
  await setCamera(true);
}

export async function switchDevices() {
  const r = room;
  if (!r) return;
  const p = prefs.value;
  const micEpoch = captureEpoch.microphone, cameraEpoch = captureEpoch.camera;
  try {
    if (micOn.value && mediaAllowed('microphone')) await queueSource(r, 'microphone', async () => {
      if (!sourceCurrent(r, 'microphone', micEpoch)) return;
      await r.switchActiveDevice('audioinput', p.inputDevice || 'default');
      if (!sourceCurrent(r, 'microphone', micEpoch)) await retireSource(r, 'microphone');
    });
    if (!currentRoom(r)) return;
    await r.switchActiveDevice('audiooutput', p.outputDevice || 'default');
    if (!currentRoom(r)) return;
    if (cameraOn.value && p.cameraDevice && mediaAllowed('camera')) await queueSource(r, 'camera', async () => {
      if (!sourceCurrent(r, 'camera', cameraEpoch)) return;
      await r.switchActiveDevice('videoinput', p.cameraDevice);
      if (!sourceCurrent(r, 'camera', cameraEpoch)) await retireSource(r, 'camera');
    });
  } catch (e) {
    if (!currentRoom(r)) return;
    toast(t().core.voice.switchDeviceFailed(errorText(e)), 'error');
  } finally {
    if (!currentRoom(r)) for (const pub of r.localParticipant.trackPublications.values()) pub.track?.stop();
  }
}

export async function restartMic() {
  const r = room;
  if (!r || !micOn.value || !mediaAllowed('microphone')) return;
  const epoch = captureEpoch.microphone;
  await queueSource(r, 'microphone', async () => {
    const track = r.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
    if (!track || !sourceCurrent(r, 'microphone', epoch)) return;
    try {
      if (track.getProcessor()) await track.stopProcessor();
      if (!sourceCurrent(r, 'microphone', epoch)) { track.stop(); return; }
      await track.restartTrack(micConstraints());
      if (!sourceCurrent(r, 'microphone', epoch)) { await retireTrack(r, track); return; }
    } catch (error) {
      if (!sourceCurrent(r, 'microphone', epoch)) { track.stop(); return; }
      toast(t().core.voice.micUnavailable(errorText(error)), 'error');
    }
    await applyGate(r);
  });
}

// LiveKit ramps each volume change through the web audio mix.
let duckFactor = 1;
let releaseTimer: number | undefined;

function setDucked(talking: boolean) {
  speakingRemote.value = talking;
  if (!prefs.value.ducking) {
    duckFactor = 1;
  } else if (talking) {
    window.clearTimeout(releaseTimer);
    duckFactor = prefs.value.duckLevel;
  } else {
    // Pauses between words must not pump the volume.
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(() => {
      duckFactor = 1;
      applyVolumes();
    }, 700);
    return;
  }
  applyVolumes();
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
  const quiet = p.identity === watching.value ? 1 : 0.3;
  p.setVolume(deaf ? 0 : pr.streamVolume * duckFactor * quiet, Track.Source.ScreenShareAudio);
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
  previewing.value = null;
  if (!r) return;
  syncSubscriptions(r);
  applyVideoPolicy();
  applyVolumes();
}

export function preview(identity: string | null) {
  if (previewing.value === identity) return;
  previewing.value = identity;
  if (!room) return;
  syncSubscriptions(room);
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
      // Request full quality above the half-size layer's height.
      scr.setVideoQuality(watched || (screenHeights.value[p.identity] ?? 0) > 540 ? VideoQuality.HIGH : VideoQuality.LOW);
    }
    const cam = p.getTrackPublication(Track.Source.Camera) as RemoteTrackPublication | undefined;
    if (cam?.isSubscribed) cam.setEnabled(front);
  }
}
// Focus is usually lost before the window is hidden: lowPower alone misses that.
effect(() => {
  void lowPower.value;
  void windowHidden.value;
  void screenHeights.value;
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
  const r = room;
  if (!r) throw new Error(t().core.voice.joinRoomFirst);
  if (!mediaAllowed('screen')) throw new Error(t().moderation.permissionDenied('screen'));
  const generation = ++shareGeneration;
  const epoch = captureEpoch.screen;
  captureIntent.screen = true;
  allowPublishing(r, 'screen', epoch);
  const current = () => sourceCurrent(r, 'screen', epoch) && generation === shareGeneration;
  const q = QUALITY[opts.quality];
  const fps = shareFps(opts);
  let stream: MediaStream | undefined;
  let v: MediaStreamTrack | undefined;
  let published: { video: LocalVideoTrack; audio?: LocalAudioTrack } | undefined;
  try {
    await bridge.selectCapture({ id: opts.sourceId, audio: opts.audio });
    if (!current()) return;
    stream = await navigator.mediaDevices.getDisplayMedia({
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
    pendingDisplays.add(stream);
    if (!current()) return;
    const [raw] = stream.getVideoTracks();
    const [a] = stream.getAudioTracks();
    raw.contentHint = opts.mode === 'motion' ? 'motion' : 'detail';
    // Stop the previous capture only after switching.
    const previous = rawCapture;
    rawCapture = raw;
    v = raw;
    if (platform === 'win32' && opts.sourceId.startsWith('window:')) {
      const redrawn = redrawFrames(raw);
      // Size layers after the first frame; capture initially reports screen dimensions.
      await Promise.race([redrawn.firstFrame, new Promise((res) => setTimeout(res, 1000))]);
      v = redrawn.track;
      if (!current()) return;
      v.contentHint = raw.contentHint;
    } else {
      await alignFrameSize(raw, fps);
      if (!current()) return;
      const { width = 0, height = 0 } = raw.getSettings();
      captureSize = { width, height };
    }
    const audioInfo = await describeAudio(opts.audio, !!a);
    if (!current()) return;

    // Preserve the publication when replacing its capture track.
    const tracks = screenTracks;
    if (tracks.video && sharing.value) {
      await tracks.video.replaceTrack(v, true).finally(() => previous?.stop());
      if (!current()) return;
      if (tracks.audio && a) await tracks.audio.replaceTrack(a, true);
      else if (tracks.audio && !a) {
        await unpublishOwned(r, tracks.audio);
        if (!current()) return;
        tracks.audio = undefined;
      } else if (!tracks.audio && a) {
        tracks.audio = new LocalAudioTrack(a, undefined, true);
        await publishScreenAudio(r, tracks.audio);
      }
      if (!current()) return;
    } else {
      previous?.stop();
      const video = new LocalVideoTrack(v, undefined, true);
      const audio = a ? new LocalAudioTrack(a, undefined, true) : undefined;
      published = { video, audio };
      await publishScreen(r, opts, video, audio);
      if (!current()) return;
      screenTracks = published;
    }
    raw.addEventListener('ended', () => {
      if (rawCapture === raw) void stopShare();
    });
    sharing.value = { ...opts, audioInfo };
    scheduleRefresh();
  } catch (e) {
    if (!current()) return;
    if (published) {
      stopScreenTracks();
      sharing.value = null;
    }
    throw e;
  } finally {
    if (stream) pendingDisplays.delete(stream);
    if (!current()) {
      if (rawCapture && stream?.getVideoTracks().includes(rawCapture)) stopRawCapture();
      stream?.getTracks().forEach((track) => track.stop());
      v?.stop();
      if (published && screenTracks.video !== published.video) {
        await unpublishOwned(r, published.video).catch(() => {});
        if (published.audio) await unpublishOwned(r, published.audio).catch(() => {});
      }
    }
  }
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

function redrawFrames(raw: MediaStreamTrack): { track: MediaStreamTrack; firstFrame: Promise<void> } {
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
  let firstDrawn = () => {};
  const firstFrame = new Promise<void>((res) => (firstDrawn = res));
  let lastWrite = 0;
  let writing = Promise.resolve();
  let ended = false;
  const draw = (src: VideoFrame | ImageBitmap, sw: number, sh: number) => {
    if (rawCapture !== raw) return;
    const w = mult4(sw);
    const h = mult4(sh);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      captureSize = { width: w, height: h };
    }
    ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
    drawn = true;
    firstDrawn();
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
  return { track: out, firstFrame };
}

async function describeAudio(mode: AudioMode, got: boolean): Promise<string> {
  const v = t().core.voice;
  if (mode === 'none' || !got) return v.audioNone;
  const info = await bridge.lastCaptureAudio();
  return info?.device === 'applicationLoopback' ? v.audioApp : v.audioSystem;
}

async function publishScreen(r: Room, o: ShareOptions, video: LocalVideoTrack, audio?: LocalAudioTrack) {
  const epoch = captureEpoch.screen;
  if (!sourceCurrent(r, 'screen', epoch)) { video.stop(); audio?.stop(); throw new DOMException('Capture cancelled', 'AbortError'); }
  const q = QUALITY[o.quality];
  const fps = shareFps(o);
  const bitrate = o.mode === 'motion' ? q.motion : q.detail;
  // One half-size preview layer limits upload overhead.
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
  if (!sourceCurrent(r, 'screen', epoch)) { await retireTrack(r, video); audio?.stop(); throw new DOMException('Capture cancelled', 'AbortError'); }
  if (audio) await publishScreenAudio(r, audio);
}

async function publishScreenAudio(r: Room, audio: LocalAudioTrack) {
  const epoch = captureEpoch.screen;
  if (!sourceCurrent(r, 'screen', epoch)) { audio.stop(); throw new DOMException('Capture cancelled', 'AbortError'); }
  await r.localParticipant.publishTrack(audio, {
    source: Track.Source.ScreenShareAudio,
    name: 'screen-audio',
    dtx: false, // not speech
    red: false,
    forceStereo: true,
    audioPreset: { maxBitrate: 160_000, priority: 'high' },
  });
  if (!sourceCurrent(r, 'screen', epoch)) { await retireTrack(r, audio); throw new DOMException('Capture cancelled', 'AbortError'); }
}

function stopScreenTracks() {
  ++shareGeneration;
  ++captureEpoch.screen;
  captureIntent.screen = false;
  for (const stream of pendingDisplays) stream.getTracks().forEach((track) => track.stop());
  pendingDisplays.clear();
  stopRawCapture();
  screenTracks.video?.stop();
  screenTracks.audio?.stop();
  screenTracks = {};
}

export async function stopShare() {
  ++shareGeneration;
  ++captureEpoch.screen;
  captureIntent.screen = false;
  const r = room;
  const tracks = screenTracks;
  screenTracks = {};
  sharing.value = null;
  stopRawCapture();
  for (const stream of pendingDisplays) stream.getTracks().forEach((track) => track.stop());
  pendingDisplays.clear();
  tracks.video?.stop();
  tracks.audio?.stop();
  if (r) {
    if (tracks.video) await unpublishOwned(r, tracks.video).catch(() => {});
    if (tracks.audio) await unpublishOwned(r, tracks.audio).catch(() => {});
  }
  tracks.video?.stop();
  tracks.audio?.stop();
  scheduleRefresh();
}

let ringTimeout: number | undefined;

export async function startCall(channelId: number, label: string) {
  const owner = api();
  const generation = await joinVoice({ channel_id: channelId }, label, { ringing: true });
  if (generation === undefined) return;
  const current = () => session.value?.api === owner && callApi === owner && callGeneration === generation && call.value?.target && 'channel_id' in call.value.target && call.value.target.channel_id === channelId;
  if (!current()) return;
  await owner.ring(channelId);
  if (!current()) return;
  window.clearTimeout(ringTimeout);
  ringTimeout = window.setTimeout(() => {
    if (current() && call.value?.status === 'ringing') {
      toast(t().core.voice.noAnswer);
      owner.cancelCall(channelId).catch(() => {});
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
