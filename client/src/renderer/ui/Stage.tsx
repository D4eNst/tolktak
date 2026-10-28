import { effect, signal, untracked } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Track } from 'livekit-client';
import { t } from '../i18n';
import { appActive } from '../state';
import {
  call,
  cameraOn,
  collectStats,
  deafened,
  floaters,
  leaveVoice,
  lowPower,
  type MediaStats,
  micOn,
  peers,
  preview,
  previewing,
  screenHeights,
  prefs,
  setCamera,
  setPrefs,
  setUserVolume,
  sharing,
  speakingRemote,
  stopShare,
  streams,
  toggleDeafen,
  toggleMic,
  watch,
  watching,
  type PeerView,
} from '../voice';
import { Avatar, Icon, Modal, openMenu, Slider, Toggle } from './common';
import { SharePicker } from './SharePicker';

export function VideoView({ track, cover, muted = true, mirror, onEl }: { track?: Track; cover?: boolean; muted?: boolean; mirror?: boolean; onEl?: (v: HTMLVideoElement | null) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    onEl?.(ref.current);
    return () => onEl?.(null);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} class={(cover ? 'cover' : 'contain') + (mirror ? ' mirror' : '')} autoPlay playsInline muted={muted} />;
}

const GAP = 12;

/**
 * The grid for n tiles in a w×h box: a row grows by one column before another row is added
 * (1 → 1×1, 2 → 1×2, 3–4 → 2×2, 5–6 → 2×3, 7–9 → 3×3, 10–12 → 3×4), and only as many columns as fit at `min` wide.
 * When the rows outgrow the height, tiles stay as wide as the columns allow and the box scrolls.
 */
export function fitTiles(n: number, w: number, h: number, ratio = 1.6, min = 200) {
  const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(n)), Math.floor((w + GAP) / (min + GAP))));
  const rows = Math.ceil(n / cols);
  const byW = (w - GAP * (cols - 1)) / cols;
  const byH = ((h - GAP * (rows - 1)) / rows) * ratio;
  const scroll = byH < Math.min(min, byW);
  return { cols, width: Math.max(1, Math.floor(scroll ? byW : Math.min(byW, byH))), scroll };
}

/** Who to put first when not everyone fits: the ones sharing, then those talking now or a moment ago. */
function useOrder(list: PeerView[], all: boolean) {
  const spoke = useRef(new Map<string, number>());
  const now = Date.now();
  for (const p of list) if (p.speaking) spoke.current.set(p.identity, now);
  if (all) return list;
  const rank = (p: PeerView) => (p.shared ? 3 : p.speaking ? 2 : now - (spoke.current.get(p.identity) ?? 0) < 8000 ? 1 : 0);
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(b.p) - rank(a.p) || a.i - b.i)
    .map((x) => x.p);
}

function useBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    // From the element's own window: it may be drawn in a popped-out one.
    const View = (ref.current!.ownerDocument.defaultView ?? window) as typeof window;
    const ro = new View.ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

function Tiles({ peers }: { peers: PeerView[] }) {
  const [ref, box] = useBox();
  const { cols, width, scroll } = fitTiles(peers.length, box.w, box.h);
  const fits = !scroll;
  const avatar = Math.round(Math.max(28, (width / 1.6) * 0.6));
  const list = useOrder(peers, fits);
  return (
    <div ref={ref} class={'tiles' + (fits ? '' : ' scroll')}>
      <div class="tiles-grid" style={{ width: cols * width + (cols - 1) * GAP + 'px', '--tile': width + 'px' }}>
        {list.map((p) => (
          <Tile key={p.identity} p={p} avatar={avatar} />
        ))}
      </div>
    </div>
  );
}

function Tile({ p, avatar }: { p: PeerView; avatar: number }) {
  const [menu, setMenu] = useState(false);
  const vol = prefs.value.userVolume[p.identity] ?? 1;
  const tx = t().shell.stage;
  return (
    <div class={'tile' + (p.speaking ? ' speaking' : '')} onContextMenu={(e) => (e.preventDefault(), !p.isLocal && setMenu(!menu))}>
      {p.camera && !lowPower.value ? (
        <VideoView track={p.camera} cover mirror={p.isLocal && prefs.value.mirrorCamera} />
      ) : (
        <>
          <div class="tile-glow" style={{ '--c': `var(--user-${p.userId % 8})` }} />
          <Avatar id={p.userId} size={avatar} speaking={p.speaking} />
        </>
      )}
      <div class="tile-name">
        {p.micMuted && <Icon name="micOff" size={14} />} {p.name}
        {p.isLocal && <span class="muted"> {tx.you}</span>}
        {p.quality === 'poor' && (
          <span class="warn" title={tx.poorConnection}>
            {' '}
            · {tx.poorConnectionShort}
          </span>
        )}
      </div>
      {!p.isLocal && (
        <button class="tile-menu icon-btn" onClick={() => setMenu(!menu)} aria-label={tx.participantVolume}>
          <Icon name="speaker" size={16} />
        </button>
      )}
      {menu && (
        <div class="tile-pop" onMouseLeave={() => setMenu(false)}>
          <Slider label={tx.volume} value={vol} onInput={(v) => setUserVolume(p.identity, v)} />
          <button class="link" onClick={() => setUserVolume(p.identity, vol === 0 ? 1 : 0)}>
            {vol === 0 ? tx.unmute : tx.muteForMe}
          </button>
        </div>
      )}
    </div>
  );
}

const hover = (p: PeerView) => ({
  onMouseEnter: () => !p.isLocal && preview(p.identity),
  onMouseLeave: () => preview(null),
});

function StatsOverlay({ identity }: { identity: string }) {
  const [s, setS] = useState<MediaStats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const st = await collectStats();
      if (alive) setS(st);
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [identity]);
  if (!s) return null;
  const tx = t().shell.stage;
  const v = s.inbound.find((x) => x.from === identity && x.source === 'screen_share');
  const a = s.inbound.find((x) => x.from === identity && x.source === 'screen_share_audio');
  return (
    <div class="stats">
      {v && <div>{tx.videoStats(v.height ?? 0, v.fps ?? 0, ((v.bitrate ?? 0) / 1e6).toFixed(1))}</div>}
      {v?.decoder && <div>{tx.decoderStats(v.decoder, v.freezeCount ?? 0)}</div>}
      {a && <div>{tx.audioStats(Math.round((a.bitrate ?? 0) / 1000))}</div>}
    </div>
  );
}

function OwnStreamStats() {
  const [s, setS] = useState<MediaStats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!appActive.value) return;
      const st = await collectStats();
      if (alive) setS(st);
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!s) return null;
  const tx = t().shell.stage;
  const layers = s.outbound.filter((x) => x.source === 'screen_share' && x.kind === 'video');
  const top = layers.reduce<(typeof layers)[number] | undefined>((m, x) => ((x.height ?? 0) > (m?.height ?? -1) ? x : m), undefined);
  if (!top) return null;
  return (
    <div class="stats own-stats">
      <div>{tx.videoStats(top.height ?? 0, top.fps ?? 0, (layers.reduce((n, x) => n + (x.bitrate ?? 0), 0) / 1e6).toFixed(1))}</div>
      {top.encoder && <div>{tx.encoderStats(top.encoder, !!top.powerEfficient)}</div>}
      {top.limitation && top.limitation !== 'none' && <div class="warn">{tx.limitStats(top.limitation)}</div>}
      {s.uplink && <div>{tx.uplinkStats((s.uplink / 1e6).toFixed(1))}</div>}
    </div>
  );
}

function useAmbilight(video: HTMLVideoElement | null, host: HTMLElement | null) {
  useEffect(() => {
    if (!video || !host) return;
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 6;
    // Scaled down on the GPU: only 8×6 pixels are read back.
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const avg = (d: Uint8ClampedArray, xs: number[], ys: number[]) => {
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (const y of ys)
        for (const x of xs) {
          const i = (y * 8 + x) * 4;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          n++;
        }
      return `rgb(${(r / n) | 0} ${(g / n) | 0} ${(b / n) | 0})`;
    };
    const timer = setInterval(() => {
      if (video.readyState < 2 || !appActive.value) return;
      try {
        ctx.drawImage(video, 0, 0, 8, 6);
        const d = ctx.getImageData(0, 0, 8, 6).data;
        host.style.setProperty('--amb-l', avg(d, [0, 1], [1, 2, 3, 4]));
        host.style.setProperty('--amb-r', avg(d, [6, 7], [1, 2, 3, 4]));
        host.style.setProperty('--amb-t', avg(d, [2, 3, 4, 5], [0, 1]));
        host.style.setProperty('--amb-b', avg(d, [2, 3, 4, 5], [4, 5]));
      } catch {
        /* frame not ready */
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [video, host]);
}

export function Floaters() {
  return (
    <div class="floaters" aria-hidden="true">
      {floaters.value.map((f) => (
        <span key={f.id} class="floater" style={{ left: `${f.x}%` }}>
          {f.emoji}
          <small>{peers.value.find((x) => x.userId === f.from)?.name ?? ''}</small>
        </span>
      ))}
    </div>
  );
}

/** Bubbles you hid, for yourself only; the others still see them. */
const hiddenBubbles = signal<ReadonlySet<string>>(new Set());
/** All the bubbles over the streams, hidden for you only. */
const hideBubbles = signal(false);
/** The list of everyone in the call, over the room window or in a window of its own. */
export const callPeopleOpen = signal(false);

function bubbleMenu(e: MouseEvent, p: PeerView) {
  e.preventDefault();
  const tx = t().desk.room;
  openMenu(e, [
    { label: p.isLocal ? t().shell.stage.hideOwnCam : tx.hideOne(p.name), icon: 'eyeOff', run: () => (hiddenBubbles.value = new Set([...hiddenBubbles.value, p.identity])) },
    { label: tx.hideAll, icon: 'eyeOff', run: () => (hideBubbles.value = true) },
    { label: tx.showAll, icon: 'eye', run: () => ((hideBubbles.value = false), (hiddenBubbles.value = new Set())) },
  ]);
}

/** While streams are on, cameras are bubbles along the edge; people without one are in the row below. */
function Bubbles() {
  const [ref, box] = useBox();
  const pr = prefs.value;
  // The box stays when hidden: it is what gets measured.
  const cams = lowPower.value || hideBubbles.value ? [] : peers.value.filter((x) => x.camera && !hiddenBubbles.value.has(x.identity));
  const size = Math.max(56, Math.min(96, Math.floor(box.h / 5)));
  const room = Math.max(1, Math.floor((box.h + 10) / (size + 10)));
  // The «+N» bubble takes a slot too whenever someone is left out.
  const shown = cams.length <= room ? cams : cams.slice(0, room - 1);
  const more = cams.length - shown.length;
  return (
    <div ref={ref} class="cam-bubbles" style={{ '--bubble': size + 'px' }}>
      {shown.map((x) => (
        <div key={x.identity} class={'cam-bubble' + (x.speaking ? ' speaking' : '')} title={x.name} onContextMenu={(e) => bubbleMenu(e, x)}>
          <VideoView track={x.camera} cover mirror={x.isLocal && pr.mirrorCamera} />
        </div>
      ))}
      {more > 0 && (
        <button class="cam-bubble more" onClick={() => (callPeopleOpen.value = true)} title={t().desk.room.people} aria-label={t().desk.room.people}>
          +{more}
        </button>
      )}
    </div>
  );
}

/** Everyone in one row under the streams; the last place is «+N», which opens the list. */
function PeopleRow() {
  const [ref, box] = useBox();
  const list = useOrder(peers.value, false);
  const fit = Math.max(1, Math.floor((box.w + 8) / 40));
  const shown = list.length <= fit ? list : list.slice(0, fit - 1);
  const more = list.length - shown.length;
  return (
    <div ref={ref} class="people-row">
      {shown.map((x) => (
        <div class={'mini' + (x.speaking ? ' speaking' : '')} key={x.identity} title={x.name}>
          <Avatar id={x.userId} size={32} speaking={x.speaking} />
          {x.micMuted && (
            <span class="mini-muted">
              <Icon name="micOff" size={11} />
            </span>
          )}
        </div>
      ))}
      {more > 0 && (
        <button class="mini more" onClick={() => (callPeopleOpen.value = true)} title={t().desk.room.people} aria-label={t().desk.room.people}>
          +{more}
        </button>
      )}
    </div>
  );
}

function SoundPopover() {
  const [open, setOpen] = useState(false);
  const pr = prefs.value;
  const tx = t().shell.stage;
  return (
    <div class="sound-pop-wrap">
      <button class={'icon-btn' + (open ? ' active' : '')} onClick={() => setOpen(!open)} title={t().desk.room.sound} aria-label={t().desk.room.sound} aria-expanded={open}>
        <Icon name="speaker" />
      </button>
      {open && (
        <div class="sound-pop" onMouseLeave={() => setOpen(false)}>
          <Slider label={tx.streamVolume} value={pr.streamVolume} onInput={(v) => setPrefs({ streamVolume: v })} />
          <Slider label={tx.voiceVolume} value={pr.voiceVolume} onInput={(v) => setPrefs({ voiceVolume: v })} />
          <label class="check" title={tx.duckTitle}>
            <input type="checkbox" checked={pr.ducking} onChange={(e) => setPrefs({ ducking: (e.target as HTMLInputElement).checked })} /> {tx.duck}
          </label>
        </div>
      )}
    </div>
  );
}

function BubblesToggle() {
  const tx = t().desk.room;
  const label = hideBubbles.value ? tx.showBubbles : tx.hideBubbles;
  return (
    <button class={'icon-btn' + (hideBubbles.value ? ' active' : '')} onClick={() => (hideBubbles.value = !hideBubbles.value)} title={label} aria-label={label} aria-pressed={hideBubbles.value}>
      <Icon name={hideBubbles.value ? 'eye' : 'eyeOff'} />
    </button>
  );
}

/** The strip under the streams, the same in both views: whose stream, sound, bubbles, quality, full screen; then the people. */
function ShareBar({ p, stats, setStats, fullscreen }: { p?: PeerView; stats?: boolean; setStats?: (v: boolean) => void; fullscreen: () => void }) {
  const tx = t().shell.stage;
  return (
    <div class="share-foot">
      <div class="theater-bar">
        <span class="live">LIVE</span>
        <span class="theater-title ellipsis">{p ? (p.isLocal ? tx.yourStream : p.name) : t().desk.room.streams(streams.value.length)}</span>
        <SoundPopover />
        <BubblesToggle />
        {setStats && (
          <button class={'icon-btn' + (stats ? ' active' : '')} onClick={() => setStats(!stats)} title={tx.streamQualityTitle} aria-label={tx.streamQuality}>
            <Icon name="info" />
          </button>
        )}
        <button class="icon-btn" onClick={fullscreen} title={tx.fullscreenTitle} aria-label={tx.fullscreen}>
          <Icon name="maximize" />
        </button>
      </div>
      <PeopleRow />
    </div>
  );
}

const toggleFullscreen = (el: HTMLElement | null) => {
  const d = el?.ownerDocument ?? document;
  return d.fullscreenElement ? d.exitFullscreen() : el?.requestFullscreen();
};

function Theater({ p }: { p: PeerView }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState(false);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useAmbilight(videoEl, host);
  const pr = prefs.value;
  const tx = t().shell.stage;
  const rest = streams.value.filter((x) => x.identity !== p.identity);
  const fullscreen = () => toggleFullscreen(ref.current);
  return (
    <div class="theater" ref={ref}>
      {rest.length > 0 && (
        <div class="theater-previews">
          {rest.map((x) => (
            <button key={x.identity} {...hover(x)} class="theater-preview" onClick={() => !x.isLocal && watch(x.identity)} disabled={x.isLocal}>
              {x.screen && !lowPower.value && <VideoView track={x.screen} cover />}
              <span class="work-name">
                {x.isLocal ? tx.yourStream : x.name}
                {previewing.value === x.identity && <Icon name="speaker" size={12} />}
              </span>
            </button>
          ))}
        </div>
      )}
      <div class="theater-video" ref={setHost} onDblClick={fullscreen}>
        <div class="ambilight" aria-hidden="true" />
        <VideoView track={p.screen} onEl={setVideoEl} />
        {stats && (p.isLocal ? <OwnStreamStats /> : <StatsOverlay identity={p.identity} />)}
        {speakingRemote.value && pr.ducking && !p.isLocal && <div class="duck-hint">{tx.duckHint}</div>}
        <Floaters />
        <Bubbles />
      </div>
      <ShareBar p={p} stats={stats} setStats={setStats} fullscreen={fullscreen} />
    </div>
  );
}

/** Everyone in the call: search, you, then who shares and who talks; each with your own volume for them. */
export function CallPeople() {
  const [q, setQ] = useState('');
  const tx = t().shell.stage;
  const tr = t().desk.room;
  if (!call.value) return null;
  const query = q.trim().toLowerCase();
  const self = peers.value.find((p) => p.isLocal);
  const others = peers.value
    .filter((p) => !p.isLocal && (!query || p.name.toLowerCase().includes(query)))
    .sort((a, b) => Number(b.shared) - Number(a.shared) || Number(b.speaking) - Number(a.speaking) || a.name.localeCompare(b.name));
  // Every row has the same slots in the same places, filled or not: mic and sound on the top right, camera after the volume.
  const row = (p: PeerView) => {
    const vol = prefs.value.userVolume[p.identity] ?? 1;
    const muted = vol === 0;
    return (
      <div key={p.identity} class={'cp-row' + (p.speaking ? ' speaking' : '') + (p.isLocal ? ' self' : '')}>
        <Avatar id={p.userId} size={36} speaking={p.speaking} />
        <div class="cp-line">
          <span class="cp-name ellipsis">
            {p.name}
            {p.isLocal && <span class="muted"> {tx.you}</span>}
          </span>
          {p.shared && <span class="live">LIVE</span>}
          <span class="cp-slot" title={p.micMuted ? tr.micOff : tr.micOn}>
            <Icon name={p.micMuted ? 'micOff' : 'mic'} size={15} class={p.micMuted ? 'off' : 'dim'} />
          </span>
          <span class="cp-slot">
            {!p.isLocal && (
              <button class={'icon-btn tiny' + (muted ? ' off' : '')} onClick={() => setUserVolume(p.identity, muted ? 1 : 0)} title={muted ? tx.unmute : tx.muteForMe} aria-label={muted ? tx.unmute : tx.muteForMe}>
                <Icon name={muted ? 'speakerOff' : 'speaker'} size={15} />
              </button>
            )}
          </span>
        </div>
        {!p.isLocal && (
          <div class="cp-line">
            <input
              class="cp-volume"
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={vol}
              onInput={(e) => setUserVolume(p.identity, Number(e.currentTarget.value))}
              aria-label={tx.participantVolume + ': ' + p.name}
            />
            <span class="cp-pct">{Math.round(vol * 100)}%</span>
            <span class="cp-slot" title={p.camera ? tr.camOn : undefined}>
              {p.camera && <Icon name="video" size={15} />}
            </span>
          </div>
        )}
      </div>
    );
  };
  return (
    <div class="call-people">
      {self && row(self)}
      <div class="cp-head">
        <div class="cp-search">
          <Icon name="search" size={15} />
          <input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={tr.findPerson} aria-label={tr.findPerson} />
          {q && (
            <button class="icon-btn tiny" onClick={() => setQ('')} aria-label={t().common.cancel}>
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
      </div>
      <div class="cp-sec">{tr.inCall(peers.value.length - 1)}</div>
      {others.map(row)}
      {query && !others.length && <div class="muted small cp-empty">{t().desk.nav.noMatch}</div>}
    </div>
  );
}

/** A look at your camera before the others see it. */
function CameraCheck({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const p = prefs.value;
  const tx = t().desk.room;
  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: p.cameraDevice ? { exact: p.cameraDevice } : undefined } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch(() => {
        // No preview: the camera still gets its own chance below.
      });
    return () => {
      alive = false;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);
  return (
    <Modal title={tx.cameraCheck} onClose={onClose}>
      <div class={'cam-preview' + (p.mirrorCamera ? ' mirror' : '')}>
        <video ref={ref} autoPlay playsInline muted />
      </div>
      <Toggle checked={!p.cameraPreview} onChange={(skip) => setPrefs({ cameraPreview: !skip })} hint={tx.cameraSkipHint}>
        {tx.cameraSkip}
      </Toggle>
      <div class="modal-actions">
        <button class="secondary" onClick={onClose}>
          {t().common.cancel}
        </button>
        <button
          class="primary"
          onClick={() => {
            onClose();
            setCamera(true);
          }}
        >
          <Icon name="video" size={16} /> {tx.cameraOn}
        </button>
      </div>
    </Modal>
  );
}

export function CallControls() {
  const [picker, setPicker] = useState(false);
  const [check, setCheck] = useState(false);
  const tx = t().shell.controls;
  return (
    <div class="call-controls">
      <button
        class={'round' + (micOn.value ? '' : ' off')}
        onClick={toggleMic}
        title={tx.mic}
        aria-label={tx.micLabel}
      >
        <Icon name={micOn.value ? 'mic' : 'micOff'} />
      </button>
      <button class={'round' + (deafened.value ? ' off' : '')} onClick={toggleDeafen} title={tx.deafen} aria-label={tx.soundLabel}>
        <Icon name={deafened.value ? 'headphonesOff' : 'headphones'} />
      </button>
      <button
        class={'round' + (cameraOn.value ? ' on' : '')}
        onClick={() => (cameraOn.value || !prefs.value.cameraPreview ? setCamera(!cameraOn.value) : setCheck(true))}
        title={tx.camera}
        aria-label={tx.camera}
      >
        <Icon name={cameraOn.value ? 'video' : 'videoOff'} />
      </button>
      <button class={'round' + (sharing.value ? ' on' : '')} onClick={() => setPicker(true)} title={tx.share} aria-label={tx.shareLabel}>
        <Icon name="screen" />
      </button>
      {sharing.value && (
        <button class="secondary stop-share" onClick={stopShare}>
          <Icon name="stop" size={14} /> {tx.stopShare}
        </button>
      )}
      <button class="round danger" onClick={leaveVoice} title={tx.leave} aria-label={tx.leaveRoom}>
        <Icon name="phoneOff" />
      </button>
      {picker && <SharePicker onClose={() => setPicker(false)} />}
      {check && <CameraCheck onClose={() => setCheck(false)} />}
    </div>
  );
}

// Per room on this device: the room's view of streams.
type RoomMode = 'kino' | 'work';
const MODES_KEY = 'tolktak.roomModes';
const roomModes = signal<Record<string, RoomMode>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(MODES_KEY) || '{}');
    } catch {
      return {};
    }
  })(),
);
/** One stream: big; several: side by side; unless chosen for this room. */
const roomMode = (): RoomMode => (call.value && roomModes.value[call.value.room]) || (streams.value.length > 1 ? 'work' : 'kino');
function setRoomMode(m: RoomMode) {
  if (!call.value) return;
  roomModes.value = { ...roomModes.value, [call.value.room]: m };
  try {
    localStorage.setItem(MODES_KEY, JSON.stringify(roomModes.value));
  } catch {
    /* storage unavailable */
  }
  if (m === 'kino' && !streams.value.some((p) => p.identity === watching.value)) {
    const last = streams.value.filter((p) => !p.isLocal).pop();
    if (last) watch(last.identity);
  }
}
export const toggleRoomMode = () => setRoomMode(roomMode() === 'kino' ? 'work' : 'kino');

// Кино: the stream started last becomes the one on screen, with sound (spec «Голос, показы и камеры»).
let seenStreams = new Set<string>();
effect(() => {
  const ids = streams.value.filter((p) => !p.isLocal).map((p) => p.identity);
  const fresh = ids.filter((id) => !seenStreams.has(id));
  seenStreams = new Set(ids);
  // The big one keeps its sound: a new stream takes it, and so does the newest when the watched one ends.
  const gone = !ids.includes(untracked(() => watching.value) ?? '');
  if (ids.length && call.value && untracked(roomMode) === 'kino' && (fresh.length || gone)) watch(ids[ids.length - 1]);
});

export function RoomModeToggle() {
  const m = roomMode();
  const tx = t().desk.room;
  if (!call.value || !streams.value.length) return null;
  return (
    <div class="seg-toggle" role="radiogroup" aria-label={tx.mode}>
      {(['kino', 'work'] as const).map((x) => (
        <button key={x} role="radio" aria-checked={m === x} class={m === x ? 'on' : ''} onClick={() => setRoomMode(x)} title={tx[x === 'kino' ? 'kinoHint' : 'workHint']} aria-label={tx[x]}>
          <Icon name={x === 'kino' ? 'layoutBig' : 'layoutGrid'} size={16} />
        </button>
      ))}
    </div>
  );
}

/** Рядом: every stream side by side; the one you click gets sound and full quality. */
function WorkScreens() {
  const [ref, box] = useBox();
  const wrap = useRef<HTMLDivElement>(null);
  const { cols, width } = fitTiles(streams.value.length, box.w, box.h, 16 / 9, 240);
  // Camera bubbles get their own strip on the right instead of covering a screen.
  const cams = !hideBubbles.value && !lowPower.value && peers.value.some((p) => p.camera && !hiddenBubbles.value.has(p.identity));
  const main = streams.value.find((p) => p.identity === watching.value);
  const ids = streams.value.map((p) => p.identity).join();
  useEffect(() => {
    const h = Math.round(((width * 9) / 16) * devicePixelRatio);
    screenHeights.value = Object.fromEntries(streams.value.map((p) => [p.identity, h]));
  }, [width, ids]);
  useEffect(() => () => (screenHeights.value = {}), []);
  return (
    <div class="theater work" ref={wrap}>
      <div ref={ref} class={'work-grid' + (cams ? ' with-bubbles' : '')}>
        <div class="work-grid-in" style={{ width: cols * width + (cols - 1) * GAP + 'px', '--tile': width + 'px' }}>
          {streams.value.map((p) => (
            <button
              key={p.identity}
              {...hover(p)}
              class={'work-screen' + (watching.value === p.identity ? ' main' : '')}
              onClick={() => !p.isLocal && watch(p.identity)}
              onDblClick={(e) => toggleFullscreen(e.currentTarget as HTMLElement)}
            >
              {p.screen && !lowPower.value && <VideoView track={p.screen} />}
              <span class="work-name">
                <span class="live">LIVE</span> {p.isLocal ? t().shell.stage.yourStream : p.name}
                {previewing.value === p.identity && <Icon name="speaker" size={13} />}
              </span>
            </button>
          ))}
        </div>
        <Bubbles />
      </div>
      <ShareBar p={main} fullscreen={() => toggleFullscreen(wrap.current)} />
    </div>
  );
}

export function Stage() {
  const c = call.value;
  if (!c) return null;
  const work = roomMode() === 'work';
  const list = streams.value;
  // «Крупно» always shows one big: the one you picked, else the newest, else your own.
  const main = !work && list.length ? (list.find((p) => p.identity === watching.value) ?? list.filter((p) => !p.isLocal).pop() ?? list[0]) : undefined;
  return (
    <section class="stage">
      {main ? (
        <Theater p={main} />
      ) : (
        list.length > 0 ? (
          <WorkScreens />
        ) : (
          <div class="stage-body">
            <Tiles peers={peers.value} />
            <Floaters />
          </div>
        )
      )}
      <CallControls />
    </section>
  );
}
