import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
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
  prefs,
  setCamera,
  setPrefs,
  setUserVolume,
  sharing,
  speakingRemote,
  stopShare,
  sendFloater,
  streams,
  toggleDeafen,
  toggleMic,
  watch,
  watching,
  type PeerView,
} from '../voice';
import { Avatar, Icon, Slider } from './common';
import { STREAM_REACTIONS } from './emoji';
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

function Tile({ p }: { p: PeerView }) {
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
          <Avatar id={p.userId} size={84} speaking={p.speaking} />
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

function StreamCard({ p }: { p: PeerView }) {
  const tx = t().shell.stage;
  return (
    <button class="stream-card" onClick={() => watch(p.identity)} disabled={p.isLocal}>
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

const reactionsOpen = signal(localStorage.getItem('tolktak.reactions') === '1');

function ReactionBar() {
  const open = reactionsOpen.value;
  const tx = t().shell.stage;
  const toggle = () => {
    reactionsOpen.value = !open;
    localStorage.setItem('tolktak.reactions', open ? '0' : '1');
  };
  return (
    <div class={'reaction-bar' + (open ? ' open' : '')}>
      {open &&
        STREAM_REACTIONS.map((e) => (
          <button key={e} onClick={() => sendFloater(e)} title={tx.sendToAll}>
            {e}
          </button>
        ))}
      <button class="reaction-toggle" onClick={toggle} title={open ? tx.hideReactions : tx.reactions} aria-label={tx.reactions}>
        <Icon name={open ? 'x' : 'smile'} size={18} />
      </button>
    </div>
  );
}

function Theater({ p }: { p: PeerView }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState(false);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useAmbilight(videoEl, host);
  const pr = prefs.value;
  const tx = t().shell.stage;
  const others = peers.value;
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
        <ReactionBar />
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
      {!watching.value && <ReactionBar />}
      <button class="round danger" onClick={leaveVoice} title={tx.leave} aria-label={tx.leaveRoom}>
        <Icon name="phoneOff" />
      </button>
      {picker && <SharePicker onClose={() => setPicker(false)} />}
    </div>
  );
}

export function Stage({ extra }: { extra?: ComponentChildren } = {}) {
  const c = call.value;
  if (!c) return null;
  const tx = t().shell.stage;
  const watched = watching.value ? peers.value.find((p) => p.identity === watching.value && p.shared) : undefined;
  return (
    <section class="stage">
      <header class="main-head">
        <div>
          <h1>{c.label}</h1>
          <span class="muted small">
            {c.status === 'connecting' && tx.connecting}
            {c.status === 'ringing' && tx.ringing}
            {c.status === 'reconnecting' && tx.reconnecting}
            {c.status === 'connected' && tx.inRoom(peers.value.length)}
            {sharing.value && tx.sharingInfo(sharing.value.sourceName, sharing.value.audioInfo)}
          </span>
        </div>
        <div class="head-actions">{extra}</div>
      </header>
      {watched ? (
        <Theater p={watched} />
      ) : (
        <div class="stage-body">
          {streams.value.length > 0 && (
            <div class="streams">
              {streams.value.map((p) => (
                <StreamCard key={p.identity} p={p} />
              ))}
            </div>
          )}
          <div class={'tiles n' + Math.min(peers.value.length, 9)}>
            {peers.value.map((p) => (
              <Tile key={p.identity} p={p} />
            ))}
          </div>
          <Floaters />
        </div>
      )}
      <CallControls />
    </section>
  );
}
