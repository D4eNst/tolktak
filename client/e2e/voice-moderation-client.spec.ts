import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import type { VoicePermissions, VoiceSource } from '../src/renderer/api';
import type * as Voice from '../src/renderer/voice';

type Fixture = {
  rooms: { state: string; emit(event: string, ...args: unknown[]): void; republishAllTracks(): Promise<void>; localParticipant: { getTrackPublication(source: string): { track: { mediaStreamTrack: MediaStreamTrack; restartTrack(): Promise<void>; unmute(): Promise<unknown> } }; publishTrack(track: unknown, options: { source: string }): Promise<unknown>; unpublishTrack(track: unknown, stop?: boolean): Promise<void> } }[];
  native: MediaStreamTrack[]; captures: string[]; publishes: string[]; unpublishHeld: boolean;
  holds: Set<string>; publishWaits: { source: string; resolve(): void }[]; unpublishWaits: { resolve(): void }[];
  permissionsCalls: { signal: AbortSignal; resolve(value: VoicePermissions): void }[];
  joins: number; joinError: boolean; nextPermissions: VoicePermissions;
  chainHold: boolean; chainCalls: number; chainClosed: number; chainWaits: { resolve(): void }[];
  savedTrack?: { restartTrack(): Promise<void>; unmute(): Promise<unknown> };
  voice: typeof Voice; pending?: Promise<unknown>; toasts: string[];
  permissions(version: number, denied?: VoiceSource | 'entry'): VoicePermissions;
  event(source: VoiceSource | 'entry', action: 'off' | 'set' | 'clear' | 'kick', version: number, denied?: VoiceSource | 'entry'): void;
  switchSession(): void;
};
declare global { interface Window { voiceClientTest: Fixture } }

const mocks: Record<string, string> = {
  state: `
    import {signal} from '@preact/signals';
    import {ApiError} from '${path.join(__dirname, '../src/renderer/api.ts')}';
    const f=window.voiceClientTest={rooms:[],native:[],captures:[],publishes:[],holds:new Set(),publishWaits:[],unpublishWaits:[],permissionsCalls:[],joins:0,joinError:false,toasts:[],chainHold:false,chainCalls:0,chainClosed:0,chainWaits:[]};
    f.permissions=(version,denied)=>({room_id:10,user_id:7,rules:[],allowed:{entry:denied!=='entry',microphone:denied!=='microphone',camera:denied!=='camera',screen:denied!=='screen'},moderation_version:version,call_id:100});
    f.nextPermissions=f.permissions(1);
    const owner=()=>({joinVoice:async()=>{f.joins++;if(f.joinError)throw new ApiError(403,'forbidden','Entry denied');return{url:'wss://fake.test',token:'token',room:'test-room',permissions:f.nextPermissions}},roomPermissions:(_id,signal)=>new Promise(resolve=>f.permissionsCalls.push({signal,resolve}))});
    export const session=signal({api:owner(),me:{id:7},server:{capabilities:{moderation:1}}});
    export const me=signal({id:7});export const appActive=signal(true),windowHidden=signal(false),callEvents=new EventTarget();
    export const api=()=>session.value.api;export const errorText=e=>e.message;export const toast=s=>f.toasts.push(s);export const userName=id=>'User '+id;export const sendRealtime=()=>{};
    f.switchSession=()=>{me.value={id:8};session.value={api:owner(),me:me.value,server:{capabilities:{moderation:1}}}};
    f.event=(source,action,version,denied)=>callEvents.dispatchEvent(new CustomEvent('voice.moderation',{detail:{room_id:10,user_id:7,source,action,permissions:f.permissions(version,denied)}}));
  `,
  bridge: `export const platform='other';export const bridge={setInCall:async()=>{},selectCapture:async()=>true,lastCaptureAudio:async()=>null};`,
  i18n: `export const t=()=>({core:{voice:{micUnavailable:s=>s,cameraUnavailable:s=>s,switchDeviceFailed:s=>s,deviceError:s=>s,joinRoomFirst:'Join first',reconnected:'Reconnected',rejoined:'Rejoined',removed:'Removed',audioNone:'None',audioSystem:'System'}},moderation:{permissionDenied:s=>s+' blocked',removed:'Removed'}});`,
  chain: `export class VoiceChain {static async create(track){const f=window.voiceClientTest;f.chainCalls++;if(f.chainHold)await new Promise(resolve=>f.chainWaits.push({resolve}));return{output:track,set(){},close(){f.chainClosed++;track.stop()}}}}`,
  emoji: `export const STREAM_REACTIONS=[];`,
  livekit: `
    const f=()=>window.voiceClientTest;
    export const ConnectionState={Connected:'connected',Disconnected:'disconnected'};
    export const DisconnectReason={CLIENT_INITIATED:1,PARTICIPANT_REMOVED:2,ROOM_DELETED:3};
    export const RoomEvent=new Proxy({},{get:(_,name)=>String(name)});
    export const Track={Source:{Microphone:'microphone',Camera:'camera',ScreenShare:'screen',ScreenShareAudio:'screen-audio'},Kind:{Audio:'audio',Video:'video'}};
    export const VideoQuality={HIGH:2,MEDIUM:1,LOW:0},AudioPresets={music:{}};
    export class VideoPreset {constructor(w,h,b,f){this.resolution={width:w,height:h,frameRate:f};this.encoding={maxBitrate:b,maxFramerate:f}}}
    export const VideoPresets={h720:new VideoPreset(1280,720,1000000,30),h1080:new VideoPreset(1920,1080,2000000,30)};
    export class Participant{};export class RemoteParticipant{};export class RemoteTrackPublication{};
    class Local {constructor(track){this.mediaStreamTrack=track;this.kind=track.kind;this.isMuted=false;this.source='unknown'}stop(){this.mediaStreamTrack.stop();this.processor?.destroy();this.processor=undefined}async unmute(){this.isMuted=false;this.mediaStreamTrack.enabled=true;return this}getProcessor(){return this.processor}async setProcessor(p){this.processor=p;await p.init({track:this.mediaStreamTrack})}async stopProcessor(){await this.processor?.destroy();this.processor=undefined}async replaceTrack(track){this.mediaStreamTrack.stop();this.mediaStreamTrack=track}async restartTrack(){const stream=await navigator.mediaDevices.getUserMedia(this.kind==='audio'?{audio:true}:{video:true});const track=stream.getTracks()[0];f().native.push(track);this.mediaStreamTrack.stop();this.mediaStreamTrack=track}}
    export class LocalAudioTrack extends Local{};export class LocalVideoTrack extends Local{};
    export class Room {
      constructor(){this.state='disconnected';this.remoteParticipants=new Map();this.handlers=new Map();f().rooms.push(this);const r=this,pubs=new Map();this.localParticipant={identity:'7',name:'Test',trackPublications:pubs,getTrackPublication:s=>pubs.get(s),setMicrophoneEnabled:(on)=>this.enable('microphone',on),setCameraEnabled:(on)=>this.enable('camera',on),publishTrack:async(track,options={})=>{const source=options.source??track.source;f().publishes.push(source);if(f().holds.has(source))await new Promise(resolve=>f().publishWaits.push({source,resolve}));track.source=source;const pub={track,source,isMuted:false};pubs.set(source,pub);r.emit('LocalTrackPublished',pub);return pub},unpublishTrack:async(track,stop)=>{if(f().unpublishHeld)await new Promise(resolve=>f().unpublishWaits.push({resolve}));for(const [source,pub]of pubs)if(pub.track===track){if(stop!==false)track.stop();pubs.delete(source);r.emit('LocalTrackUnpublished',pub)}}}}
      on(event,callback){const list=this.handlers.get(event)??[];list.push(callback);this.handlers.set(event,list);return this}emit(event,...args){for(const callback of this.handlers.get(event)??[])callback(...args)}
      async connect(){this.state='connected'}async disconnect(){this.state='disconnected';for(const pub of this.localParticipant.trackPublications.values())pub.track.stop();this.emit('Disconnected',1)}
      async enable(source,on){const existing=this.localParticipant.getTrackPublication(source);if(!on){if(existing){existing.isMuted=true;existing.track.isMuted=true;existing.track.mediaStreamTrack.enabled=false}return existing}if(existing){await existing.track.unmute();existing.isMuted=false;return existing}f().captures.push(source);const stream=await navigator.mediaDevices.getUserMedia(source==='microphone'?{audio:true}:{video:true});const raw=stream.getTracks()[0];f().native.push(raw);const track=source==='microphone'?new LocalAudioTrack(raw):new LocalVideoTrack(raw);track.source=source;return this.localParticipant.publishTrack(track,{source})}
      async switchActiveDevice(kind){const source=kind==='audioinput'?'microphone':kind==='videoinput'?'camera':null;if(source)await this.localParticipant.getTrackPublication(source)?.track.restartTrack()}
      // Matches pinned LiveKit 2.23: unpublish(false), optional restart, PRIVATE republish.
      async republishAllTracks(){for(const pub of [...this.localParticipant.trackPublications.values()]){const track=pub.track;await this.localParticipant.unpublishTrack(track,false);if(!track.isMuted&&!pub.source.startsWith('screen'))await track.restartTrack();this.localParticipant.trackPublications.set(pub.source,pub);this.emit('LocalTrackPublished',pub)}}
    }
  `,
};
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: path.join(__dirname, '..'), contents: `import * as voice from './src/renderer/voice';window.voiceClientTest.voice=voice;`, loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    plugins: [{ name: 'voice-lifecycle-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'livekit-client') return { path: 'livekit', namespace: 'fixture' };
        if (args.importer.endsWith('/src/renderer/voice.ts')) {
          const name = ({ './state': 'state', './bridge': 'bridge', './i18n': 'i18n', './audio/chain': 'chain', './ui/emoji': 'emoji' } as Record<string, string>)[args.path];
          if (name) return { path: name, namespace: 'fixture' };
        }
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: mocks[args.path], loader: 'ts', resolveDir: path.join(__dirname, '..') }));
    } }],
  });
  bundle = result.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.context().grantPermissions(['microphone', 'camera']);
  await page.addInitScript(() => localStorage.setItem('tolktak.voice', JSON.stringify({ denoise: 'off', agc: false, micMuted: true, sounds: false })));
  await page.route('https://voice-client.test/**', (route) => route.fulfill({ contentType: route.request().url().endsWith('/voice.js') ? 'text/javascript' : 'text/html', body: route.request().url().endsWith('/voice.js') ? bundle : '<!doctype html><script src="/voice.js"></script>' }));
  await page.goto('https://voice-client.test/');
  await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => {
    const f = window.voiceClientTest; f.captures.push('screen');
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = new AudioContext(), oscillator = context.createOscillator(), output = context.createMediaStreamDestination();
    oscillator.connect(output); oscillator.start();
    const tracks = [...canvas.captureStream(30).getVideoTracks(), ...output.stream.getAudioTracks()];
    f.native.push(...tracks);
    return new MediaStream(tracks);
  } }));
});
async function join(page: Page) { await page.evaluate(() => window.voiceClientTest.voice.joinVoice({ room_id: 10 }, 'Test room')); }
const share = { sourceId: 'screen:0', sourceName: 'Test screen', audio: 'system', mode: 'motion', quality: '720p30' } as const;

test('denied devices cannot capture through enable/deafen/restart paths, and clearing a restriction never enables them', async ({ page }) => {
  await page.evaluate(() => { const f = window.voiceClientTest; f.nextPermissions = f.permissions(1); f.nextPermissions.allowed.microphone = f.nextPermissions.allowed.camera = f.nextPermissions.allowed.screen = false; });
  await join(page);
  await page.evaluate(async () => { const v = window.voiceClientTest.voice; await v.toggleMic(); await v.toggleDeafen(); await v.toggleDeafen(); await v.setCamera(true); await v.restartMic(); await v.restartCamera(); await v.switchDevices(); });
  expect(await page.evaluate((share) => window.voiceClientTest.voice.startShare(share).then(() => 'enabled', (e: Error) => e.message), share)).toBe('screen blocked');
  expect(await page.evaluate(() => window.voiceClientTest.captures)).toEqual([]);
  await page.evaluate(() => window.voiceClientTest.event('microphone', 'clear', 2));
  expect(await page.evaluate(() => ({ mic: window.voiceClientTest.voice.micOn.value, camera: window.voiceClientTest.voice.cameraOn.value, sharing: window.voiceClientTest.voice.sharing.value }))).toEqual({ mic: false, camera: false, sharing: null });
  await page.evaluate(() => window.voiceClientTest.voice.toggleMic());
  expect(await page.evaluate(() => window.voiceClientTest.voice.micOn.value)).toBe(true);
});

test('one-shot off stops microphone, camera and screen audio synchronously before slow unpublish, even while permission remains allowed', async ({ page }) => {
  await join(page);
  await page.evaluate(async (share) => { const v = window.voiceClientTest.voice; await v.toggleMic(); await v.setCamera(true); await v.startShare(share); }, share);
  expect(await page.evaluate(() => window.voiceClientTest.native.every((track) => track.readyState === 'live'))).toBe(true);
  const state = await page.evaluate(() => {
    const f = window.voiceClientTest; f.unpublishHeld = true;
    f.event('microphone', 'off', 2); f.event('camera', 'off', 3); f.event('screen', 'off', 4);
    return { stopped: f.native.every((track) => track.readyState === 'ended'), mic: f.voice.micOn.value, camera: f.voice.cameraOn.value, sharing: f.voice.sharing.value, allowed: f.voice.mediaAllowed('microphone') };
  });
  expect(state).toEqual({ stopped: true, mic: false, camera: false, sharing: null, allowed: true });
  await page.evaluate(() => { const f = window.voiceClientTest; f.unpublishHeld = false; for (const pending of f.unpublishWaits) pending.resolve(); f.event('microphone', 'clear', 5); });
  expect(await page.evaluate(() => window.voiceClientTest.captures)).toEqual(['microphone', 'camera', 'screen']);
  await page.evaluate(() => window.voiceClientTest.voice.toggleMic());
  await page.evaluate(() => window.voiceClientTest.event('microphone', 'off', 2));
  expect(await page.evaluate(() => window.voiceClientTest.voice.micOn.value)).toBe(true);
});

for (const source of ['microphone', 'camera', 'screen'] as const) {
  test(`a ${source} publish completing after forbid then clear cannot resurrect capture`, async ({ page }) => {
    await join(page);
    await page.evaluate(({ source, share }) => {
      const f = window.voiceClientTest; f.holds.add(source);
      f.pending = source === 'microphone' ? f.voice.toggleMic() : source === 'camera' ? f.voice.setCamera(true) : f.voice.startShare(share);
    }, { source, share });
    await expect.poll(() => page.evaluate(() => window.voiceClientTest.publishWaits.length)).toBe(1);
    expect(await page.evaluate((source) => { const f = window.voiceClientTest; f.event(source, 'set', 2, source); return f.native.every((track) => track.readyState === 'ended'); }, source)).toBe(true);
    await page.evaluate((source) => { const f = window.voiceClientTest; f.event(source, 'clear', 3); f.holds.clear(); for (const waiting of f.publishWaits) waiting.resolve(); }, source);
    await page.evaluate(() => window.voiceClientTest.pending);
    expect(await page.evaluate(() => { const f = window.voiceClientTest; return { stopped: f.native.every((track) => track.readyState === 'ended'), mic: f.voice.micOn.value, camera: f.voice.cameraOn.value, sharing: f.voice.sharing.value }; })).toEqual({ stopped: true, mic: false, camera: false, sharing: null });
  });
}

test('stale permission refresh and old-session replies cannot roll back a newer moderation event', async ({ page }) => {
  await join(page);
  await page.evaluate(() => { const f = window.voiceClientTest; f.pending = f.voice.refreshVoicePermissions(); f.event('microphone', 'set', 5, 'microphone'); f.event('microphone', 'clear', 6); f.permissionsCalls[0].resolve(f.permissions(4, 'microphone')); });
  await page.evaluate(() => window.voiceClientTest.pending);
  expect(await page.evaluate(() => window.voiceClientTest.voice.voicePermissions.value?.moderation_version)).toBe(6);
  await page.evaluate(() => { const f = window.voiceClientTest; f.pending = f.voice.refreshVoicePermissions(); f.switchSession(); });
  await expect.poll(() => page.evaluate(() => window.voiceClientTest.voice.call.value)).toBeNull();
  expect(await page.evaluate(() => window.voiceClientTest.permissionsCalls[1].signal.aborted)).toBe(true);
  await page.evaluate(() => { const f = window.voiceClientTest; f.permissionsCalls[1].resolve(f.permissions(99, 'entry')); });
  await page.evaluate(() => window.voiceClientTest.pending);
  expect(await page.evaluate(() => window.voiceClientTest.voice.voicePermissions.value)).toBeNull();
});

test('kick stops capture and auto-rejoin, while clearing entry requires a new explicit join', async ({ page }) => {
  await join(page);
  await page.evaluate(() => window.voiceClientTest.voice.toggleMic());
  expect(await page.evaluate(() => { const f = window.voiceClientTest; f.event('entry', 'kick', 2, 'entry'); return f.native.every((track) => track.readyState === 'ended'); })).toBe(true);
  await expect.poll(() => page.evaluate(() => window.voiceClientTest.voice.call.value)).toBeNull();
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => window.voiceClientTest.joins)).toBe(1);
  await page.evaluate(() => (window.voiceClientTest.joinError = true));
  expect(await page.evaluate(() => window.voiceClientTest.voice.joinVoice({ room_id: 10 }, 'Test').then(() => 'joined', (e: Error) => e.message))).toBe('Entry denied');
  await page.evaluate(() => { const f = window.voiceClientTest; f.joinError = false; f.nextPermissions = f.permissions(3); f.event('entry', 'clear', 3); });
  expect(await page.evaluate(() => window.voiceClientTest.joins)).toBe(2);
  await join(page);
  expect(await page.evaluate(() => window.voiceClientTest.voice.call.value?.status)).toBe('connected');
});

test('SFU reconnect refreshes permissions and a later clear does not allow automatic republishing', async ({ page }) => {
  await join(page);
  await page.evaluate(() => window.voiceClientTest.voice.toggleMic());
  await page.evaluate(() => window.voiceClientTest.rooms[0].emit('Reconnected'));
  await expect.poll(() => page.evaluate(() => window.voiceClientTest.permissionsCalls.length)).toBe(1);
  await page.evaluate(() => { const f = window.voiceClientTest; f.permissionsCalls[0].resolve(f.permissions(2, 'microphone')); });
  await expect.poll(() => page.evaluate(() => window.voiceClientTest.voice.micOn.value)).toBe(false);
  await page.evaluate(() => window.voiceClientTest.event('microphone', 'clear', 3));
  expect(await page.evaluate(() => { const f = window.voiceClientTest; return f.rooms[0].localParticipant.publishTrack({ source: 'microphone', stop() {}, isMuted: false }, { source: 'microphone' }).then(() => 'published', (e: Error) => e.name); })).toBe('AbortError');
  await page.evaluate(() => window.voiceClientTest.voice.toggleMic());
  expect(await page.evaluate(() => window.voiceClientTest.voice.micOn.value)).toBe(true);
});

test('SDK-internal restart and unmute cannot revive an old track after off then clear', async ({ page }) => {
  await join(page);
  await page.evaluate(async () => {
    const f = window.voiceClientTest;
    await f.voice.toggleMic();
    f.savedTrack = (f.rooms[0].localParticipant as unknown as { getTrackPublication(source: string): { track: Fixture['savedTrack'] } }).getTrackPublication('microphone').track;
    f.event('microphone', 'off', 2);
    f.event('microphone', 'clear', 3);
  });
  const before = await page.evaluate(() => window.voiceClientTest.native.length);
  expect(await page.evaluate(() => window.voiceClientTest.savedTrack!.restartTrack().then(() => 'restarted', (error: Error) => error.name))).toBe('AbortError');
  expect(await page.evaluate(() => window.voiceClientTest.savedTrack!.unmute().then(() => 'unmuted', (error: Error) => error.name))).toBe('AbortError');
  expect(await page.evaluate(() => window.voiceClientTest.native.length)).toBe(before);
  await page.evaluate(() => window.voiceClientTest.voice.toggleMic());
  expect(await page.evaluate(() => window.voiceClientTest.voice.micOn.value)).toBe(true);
});

for (const source of ['microphone', 'camera', 'screen'] as const) {
  test(`an SFU ${source} removal clears intent even if the app off event is lost`, async ({ page }) => {
    await join(page);
    await page.evaluate(async ({ source, share }) => {
      const f = window.voiceClientTest;
      if (source === 'microphone') await f.voice.toggleMic();
      else if (source === 'camera') await f.voice.setCamera(true);
      else await f.voice.startShare(share);
      const participant = f.rooms[0].localParticipant;
      f.savedTrack = participant.getTrackPublication(source).track;
      // The pinned SDK server handler calls unpublish(track) without an explicit bool.
      if (source === 'microphone') f.rooms[0].state = 'reconnecting';
      await participant.unpublishTrack(f.savedTrack);
      f.rooms[0].state = 'connected';
      f.pending = f.voice.refreshVoicePermissions();
      f.permissionsCalls[0].resolve(f.permissions(42)); // New room version from an unrelated action.
    }, { source, share });
    await page.evaluate(() => window.voiceClientTest.pending);
    expect(await page.evaluate(() => { const f = window.voiceClientTest; return { mic: f.voice.micOn.value, camera: f.voice.cameraOn.value, sharing: f.voice.sharing.value, stopped: f.native.every((track) => track.readyState === 'ended') }; })).toEqual({ mic: false, camera: false, sharing: null, stopped: true });
    const captures = await page.evaluate(() => window.voiceClientTest.native.length);
    await page.evaluate(() => window.voiceClientTest.rooms[0].republishAllTracks());
    expect(await page.evaluate(() => window.voiceClientTest.savedTrack!.restartTrack().then(() => 'restarted', (error: Error) => error.name))).toBe('AbortError');
    expect(await page.evaluate(() => window.voiceClientTest.native.length)).toBe(captures);
  });
}

test('ordinary mute, deafen, SDK republish and device restarts keep their capture intent', async ({ page }) => {
  await join(page);
  await page.evaluate(async () => {
    const f = window.voiceClientTest, v = f.voice;
    await v.toggleMic(); await v.toggleMic();
    await f.rooms[0].republishAllTracks();
    await v.toggleMic(); await v.toggleDeafen(); await v.toggleDeafen();
    await v.restartMic(); await v.setCamera(true);
    await f.rooms[0].republishAllTracks();
    await v.restartCamera();
    v.setPrefs({ cameraDevice: 'fixture-device' });
    await v.switchDevices();
  });
  expect(await page.evaluate(() => { const f = window.voiceClientTest, p = f.rooms[0].localParticipant; return { mic: f.voice.micOn.value, camera: f.voice.cameraOn.value, microphoneTrack: p.getTrackPublication('microphone').track.mediaStreamTrack.readyState, cameraTrack: p.getTrackPublication('camera').track.mediaStreamTrack.readyState }; })).toEqual({ mic: true, camera: true, microphoneTrack: 'live', cameraTrack: 'live' });
});

test('a processor setup completing after off and clear tears down instead of reviving its old microphone', async ({ page }) => {
  await join(page);
  await page.evaluate(() => { const f = window.voiceClientTest; f.voice.setPrefs({ agc: true }); f.chainHold = true; f.pending = f.voice.toggleMic(); });
  await expect.poll(() => page.evaluate(() => window.voiceClientTest.chainCalls)).toBe(1);
  expect(await page.evaluate(() => { const f = window.voiceClientTest; f.event('microphone', 'off', 2); f.event('microphone', 'clear', 3); return f.native.every((track) => track.readyState === 'ended'); })).toBe(true);
  await page.evaluate(() => { const f = window.voiceClientTest; f.chainHold = false; for (const pending of f.chainWaits) pending.resolve(); });
  await page.evaluate(() => window.voiceClientTest.pending);
  expect(await page.evaluate(() => ({ closed: window.voiceClientTest.chainClosed, mic: window.voiceClientTest.voice.micOn.value }))).toEqual({ closed: 1, mic: false });
  await page.evaluate(() => window.voiceClientTest.voice.toggleMic());
  expect(await page.evaluate(() => window.voiceClientTest.voice.micOn.value)).toBe(true);
});
