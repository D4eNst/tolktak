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
import { Avatar, Icon, Slider } from './common';
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

/** Columns and tile width that give the biggest 16:10 tiles for n people in a w×h box. */
export function fitTiles(n: number, w: number, h: number) {
  let best = { cols: 1, width: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const width = Math.min((w - GAP * (cols - 1)) / cols, ((h - GAP * (rows - 1)) / rows) * 1.6);
    if (width > best.width) best = { cols, width };
  }
  return { cols: best.cols, width: Math.max(96, Math.floor(best.width)) };
}

function Tiles({ peers }: { peers: PeerView[] }) {
  // More than 8: a compact list, the ones talking on top (spec «Люди в комнате»).
  if (peers.length > 8)
    return (
      <div class="tiles tiles-list">
        {[...peers]
          .sort((a, b) => Number(b.speaking) - Number(a.speaking))
          .map((p) => (
            <Tile key={p.identity} p={p} avatar={28} row />
          ))}
      </div>
    );
  return <TileGrid peers={peers} />;
}

function TileGrid({ peers }: { peers: PeerView[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  const { cols, width } = fitTiles(peers.length, box.w, box.h);
  const avatar = Math.round(Math.max(28, (width / 1.6) * 0.6));
  return (
    <div ref={ref} class="tiles">
      <div class="tiles-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${width}px)` }}>
        {peers.map((p) => (
          <Tile key={p.identity} p={p} avatar={avatar} />
        ))}
      </div>
    </div>
  );
}

function Tile({ p, avatar, row }: { p: PeerView; avatar: number; row?: boolean }) {
  const [menu, setMenu] = useState(false);
  const vol = prefs.value.userVolume[p.identity] ?? 1;
  const tx = t().shell.stage;
  return (
    <div class={'tile' + (row ? ' row' : '') + (p.speaking ? ' speaking' : '')} onContextMenu={(e) => (e.preventDefault(), !p.isLocal && setMenu(!menu))}>
      {p.camera && !lowPower.value && !row ? (
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

const hover = (p: PeerView) => ({ onMouseEnter: () => !p.isLocal && preview(p.identity), onMouseLeave: () => preview(null) });

function StreamCard({ p }: { p: PeerView }) {
  const tx = t().shell.stage;
  return (
    <button {...hover(p)} class="stream-card" onClick={() => watch(p.identity)} disabled={p.isLocal}>
      <div class="stream-preview">{p.screen && !lowPower.value && <VideoView track={p.screen} cover />}</div>
      <div class="stream-meta">
        <span class="live">LIVE</span> {p.isLocal ? tx.yourStream : p.name}
        {!p.isLocal && <span class="watch-btn">{tx.watch}</span>}
      </div>
      {p.isLocal && <OwnStreamStats />}
    </button>
  );
}

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
    <div class="own-stats small muted">
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

/** Your own camera bubble, hidden for you only; the others still see it. */
const hideOwnCam = signal(false);

function Theater({ p }: { p: PeerView }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState(false);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useAmbilight(videoEl, host);
  const pr = prefs.value;
  const tx = t().shell.stage;
  const cams = lowPower.value ? [] : peers.value.filter((x) => x.camera && !(x.isLocal && hideOwnCam.value));
  const others = peers.value.filter((x) => !cams.includes(x));
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else ref.current?.requestFullscreen();
  };
  return (
    <div class="theater" ref={ref}>
      <div class="theater-video" ref={setHost} onDblClick={fullscreen}>
        <div class="ambilight" aria-hidden="true" />
        <VideoView track={p.screen} onEl={setVideoEl} />
        {stats && <StatsOverlay identity={p.identity} />}
        {speakingRemote.value && pr.ducking && <div class="duck-hint">{tx.duckHint}</div>}
        <Floaters />
        {cams.length > 0 && (
          <div class="cam-bubbles">
            {cams.map((x) => (
              <div key={x.identity} class={'cam-bubble' + (x.speaking ? ' speaking' : '') + (x.isLocal ? ' own' : '')} title={x.name}>
                <VideoView track={x.camera} cover mirror={x.isLocal && pr.mirrorCamera} />
                {x.isLocal && (
                  <button class="cam-hide" onClick={() => (hideOwnCam.value = true)} title={tx.hideOwnCam} aria-label={tx.hideOwnCam}>
                    <Icon name="eyeOff" size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div class="theater-bar">
        <span class="live">LIVE</span>
        <span class="theater-title">{p.name}</span>
        <Slider label={tx.streamVolume} value={pr.streamVolume} onInput={(v) => setPrefs({ streamVolume: v })} />
        <Slider label={tx.voiceVolume} value={pr.voiceVolume} onInput={(v) => setPrefs({ voiceVolume: v })} />
        <label class="check pill-check" title={tx.duckTitle}>
          <input type="checkbox" checked={pr.ducking} onChange={(e) => setPrefs({ ducking: (e.target as HTMLInputElement).checked })} /> {tx.duck}
        </label>
        <button class={'icon-btn' + (stats ? ' active' : '')} onClick={() => setStats(!stats)} title={tx.streamQualityTitle} aria-label={tx.streamQuality}>
          <Icon name="info" />
        </button>
        <button class="icon-btn" onClick={fullscreen} title={tx.fullscreenTitle} aria-label={tx.fullscreen}>
          <Icon name="maximize" />
        </button>
        <button class="secondary" onClick={() => watch(null)}>
          {tx.close}
        </button>
      </div>
      <div class="theater-strip">
        {others.map((x) => (
          <div class={'mini' + (x.speaking ? ' speaking' : '')} key={x.identity} title={x.name}>
            <Avatar id={x.userId} size={32} speaking={x.speaking} />
            {x.micMuted && (
              <span class="mini-muted">
                <Icon name="micOff" size={12} />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CallControls() {
  const [picker, setPicker] = useState(false);
  const tx = t().shell.controls;
  return (
    <div class="call-controls">
      <button class={'round' + (micOn.value ? '' : ' off')} onClick={toggleMic} title={tx.mic} aria-label={tx.micLabel}>
        <Icon name={micOn.value ? 'mic' : 'micOff'} />
      </button>
      <button class={'round' + (deafened.value ? ' off' : '')} onClick={toggleDeafen} title={tx.deafen} aria-label={tx.soundLabel}>
        <Icon name={deafened.value ? 'headphonesOff' : 'headphones'} />
      </button>
      <button class={'round' + (cameraOn.value ? ' on' : '')} onClick={() => setCamera(!cameraOn.value)} title={tx.camera} aria-label={tx.camera}>
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
/** «Как у автора»: the view the author of the stream on screen (or the newest one) picked. */
const authorMode = (): RoomMode => (streams.value.find((p) => p.identity === watching.value) ?? streams.value[streams.value.length - 1])?.shareView ?? 'kino';
const roomMode = (): RoomMode => (call.value && roomModes.value[call.value.room]) || authorMode();
function setRoomMode(m: RoomMode | 'auto') {
  if (!call.value) return;
  const { [call.value.room]: _, ...rest } = roomModes.value;
  roomModes.value = m === 'auto' ? rest : { ...rest, [call.value.room]: m };
  try {
    localStorage.setItem(MODES_KEY, JSON.stringify(roomModes.value));
  } catch {
    /* storage unavailable */
  }
}
export const toggleRoomMode = () => setRoomMode(roomMode() === 'kino' ? 'work' : 'kino');

// Кино: the stream started last becomes the one on screen, with sound (spec «Голос, показы и камеры»).
let seenStreams = new Set<string>();
effect(() => {
  const ids = streams.value.filter((p) => !p.isLocal).map((p) => p.identity);
  const fresh = ids.filter((id) => !seenStreams.has(id));
  seenStreams = new Set(ids);
  if (fresh.length && call.value && untracked(roomMode) === 'kino') watch(fresh[fresh.length - 1]);
});

export function RoomModeToggle() {
  const m = roomMode();
  const tx = t().desk.room;
  if (!call.value) return null;
  const auto = !roomModes.value[call.value.room];
  return (
    <div class="seg-toggle" role="radiogroup" aria-label={tx.mode} title={tx.modeHint}>
      <button role="radio" aria-checked={auto} class={auto ? 'on' : ''} onClick={() => setRoomMode('auto')} title={tx.autoHint}>
        {tx.auto}
      </button>
      {(['kino', 'work'] as const).map((x) => (
        <button key={x} role="radio" aria-checked={!auto && m === x} class={(!auto && m === x ? 'on' : '') + (auto && m === x ? ' eff' : '')} onClick={() => setRoomMode(x)}>
          {tx[x]}
        </button>
      ))}
    </div>
  );
}

/** Работа: every stream side by side; the one you click gets sound and full quality. */
const bigScreen = signal<string | null>(null);

function WorkScreens() {
  const tx = t().desk.room;
  const big = streams.value.some((p) => p.identity === bigScreen.value) ? bigScreen.value : null;
  return (
    <div class={'work-grid n' + Math.min(streams.value.length, 4) + (big ? ' has-big' : '')}>
      {streams.value.map((p) => (
        <div
          key={p.identity}
          role="button"
          tabIndex={0}
          {...hover(p)}
          class={'work-screen' + (watching.value === p.identity ? ' main' : '') + (big === p.identity ? ' big' : '')}
          onClick={() => !p.isLocal && watch(p.identity)}
          onDblClick={(e) => (e.currentTarget as HTMLElement).requestFullscreen()}
        >
          {p.screen && !lowPower.value && <VideoView track={p.screen} />}
          <span class="work-name">
            <span class="live">LIVE</span> {p.isLocal ? t().shell.stage.yourStream : p.name}
          </span>
          {streams.value.length > 1 && (
            <button
              class="chip work-big"
              onClick={(e) => {
                e.stopPropagation();
                bigScreen.value = big === p.identity ? null : p.identity;
                if (!p.isLocal) watch(p.identity);
              }}
            >
              <Icon name="maximize" size={13} /> {big === p.identity ? tx.small : tx.big}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Stage() {
  const c = call.value;
  if (!c) return null;
  const work = roomMode() === 'work';
  const watched = !work && watching.value ? peers.value.find((p) => p.identity === watching.value && p.shared) : undefined;
  return (
    <section class="stage">
      {watched ? (
        <Theater p={watched} />
      ) : (
        <div class={'stage-body' + (work ? ' work' : '')}>
          {streams.value.length > 0 &&
            (work ? (
              <WorkScreens />
            ) : (
              <div class="streams">
                {streams.value.map((p) => (
                  <StreamCard key={p.identity} p={p} />
                ))}
              </div>
            ))}
          <Tiles peers={peers.value} />
          <Floaters />
        </div>
      )}
      <CallControls />
    </section>
  );
}
