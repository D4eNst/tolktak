import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { bridge, isDesktop, platform, type AppInfo, type DesktopSettings, type Hotkeys, type MediaAccess, type MediaKind } from '../bridge';
import { accelFromEvent, accelFromMouse, accelLabel, hotkeys, hotkeysAreGlobal, setHotkey } from '../keys';
import { api, errorText, logout, me, notificationsOn, serverUpdate, session, setNotifications, settingsOpen, type SettingsTab, toast } from '../state';
import type { ChainStats, Denoise, VoiceChain } from '../audio/chain';
import { call, micOn, toggleMic, chainSettings, createVoiceChain, micConstraints, micGain, micLevel, playTone, prefs, restartCamera, restartMic, setPrefs, switchDevices, applyGate, cameraOn } from '../voice';
import { Avatar, confirmDialog, Icon, Modal, type Option, Select, Slider, Toggle } from './common';
import { pickImage } from './GroupSettings';
import { intlLocale, LOCALES, locale, setLocale, t, type Locale } from '../i18n';

function useDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let unlocked = false;
    const load = async () => {
      let list = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === kind);
      // Device names stay hidden until the app has opened one.
      if (!unlocked && kind !== 'audiooutput' && list.some((d) => !d.label)) {
        unlocked = true;
        const s = await navigator.mediaDevices.getUserMedia(kind === 'videoinput' ? { video: true } : { audio: true }).catch(() => null);
        s?.getTracks().forEach((tr) => tr.stop());
        list = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === kind);
      }
      setDevices(list);
    };
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, [kind]);
  return devices;
}

function DeviceSelect({ kind, value, onChange, label }: { kind: MediaDeviceKind; value: string; onChange: (id: string) => void; label: string }) {
  const devices = useDevices(kind);
  const def = kind === 'videoinput' ? '' : 'default';
  const options: Option<string>[] = [
    { value: def, label: t().settings.devices.system },
    ...devices
      .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId)
      .map((d) => ({ value: d.deviceId, label: d.label || t().settings.devices.unnamed })),
  ];
  return <Select label={label} value={value || def} options={options} onChange={onChange} />;
}

function AccessNotice({ kind }: { kind: MediaKind }) {
  const [state, setState] = useState<MediaAccess>('granted');
  useEffect(() => {
    bridge.mediaAccess(kind, true).then(setState);
  }, [kind]);
  if (state !== 'denied' && state !== 'restricted') return null;
  const tx = t().settings.access;
  return (
    <div class="warn-box access-notice">
      <Icon name="alert" size={18} />
      <span>{kind === 'camera' ? tx.camera : tx.microphone}</span>
      <button class="secondary" onClick={() => bridge.openPrivacySettings(kind)}>
        {tx.openSettings}
      </button>
    </div>
  );
}

/** Outside a call it runs the call's processing, and `listen` plays the voice back. */
function MicMeter({ threshold, listen = false }: { threshold?: number; listen?: boolean }) {
  const [stats, setStats] = useState<ChainStats | null>(null);
  const chainRef = useRef<VoiceChain | null>(null);
  const inCall = !!call.value && !listen;
  const p = prefs.value;
  useEffect(() => {
    if (inCall) return;
    let alive = true;
    let stream: MediaStream | null = null;
    let playback: AudioContext | null = null;
    const stop = () => {
      stream?.getTracks().forEach((tr) => tr.stop());
      chainRef.current?.close();
      chainRef.current = null;
      playback?.close().catch(() => {});
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
        if (!alive) return stop();
        const chain = await createVoiceChain(stream.getAudioTracks()[0], (s) => alive && setStats(s));
        chainRef.current = chain;
        if (!alive) return stop();
        if (listen) {
          // Half a second late: you hear yourself instead of talking over it.
          playback = new AudioContext();
          const sink = prefs.value.outputDevice;
          if (sink && sink !== 'default') await (playback as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sink).catch(() => {});
          const delay = playback.createDelay(1);
          delay.delayTime.value = 0.5;
          playback.createMediaStreamSource(new MediaStream([chain.output])).connect(delay).connect(playback.destination);
        }
      } catch {
        /* no microphone */
      }
    })();
    return () => {
      alive = false;
      stop();
    };
  }, [inCall, listen, p.inputDevice, p.outputDevice, p.denoise, p.echoCancellation]);
  useEffect(() => chainRef.current?.set(chainSettings(p)), [p]);

  const l = inCall ? micLevel.value : stats ? Math.max(0, Math.min(1, (stats.level + 70) / 60)) : 0;
  const mark = threshold === undefined ? undefined : (threshold + 70) / 60;
  const open = mark === undefined || l >= mark;
  const gain = inCall ? micGain.value : stats ? Math.round(stats.gain) : null;
  return (
    <div class="meter-wrap">
      <div class="meter">
        <div class={'meter-fill' + (open ? ' open' : '')} style={{ width: `${l * 100}%` }} />
        {mark !== undefined && <div class="meter-mark" style={{ left: `${mark * 100}%` }} />}
      </div>
      {p.agc && gain !== null && (
        <span class="meter-gain" title={t().settings.meter.gainTitle}>
          {t().settings.meter.db((gain > 0 ? '+' : '') + gain)}
        </span>
      )}
    </div>
  );
}

const DENOISE: Denoise[] = ['off', 'light', 'medium', 'max'];
const denoiseOptions = (): Option<Denoise>[] => DENOISE.map((value) => ({ value, ...t().settings.voice.denoiseOptions[value] }));

function MicCheck({ listen, setListen }: { listen: boolean; setListen: (v: boolean) => void }) {
  const resume = useRef(false);
  const toggle = () => {
    if (!listen && call.value && micOn.value) {
      resume.current = true;
      toggleMic();
    } else if (listen && resume.current) {
      resume.current = false;
      if (!micOn.value) toggleMic();
    }
    setListen(!listen);
  };
  useEffect(() => () => void (resume.current && !micOn.value && toggleMic()), []);
  const tx = t().settings.micCheck;
  return (
    <div class="mic-check">
      <button class={listen ? 'primary' : 'secondary'} onClick={toggle}>
        <Icon name={listen ? 'stop' : 'headphones'} size={16} /> {listen ? tx.stop : tx.start}
      </button>
      <span class="hint">{listen ? tx.stopHint : tx.startHint}</span>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; icon?: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} class={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function KeyCapture({ name, label, hint }: { name: keyof Hotkeys; label: string; hint?: string }) {
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const value = hotkeys.value[name];
  // The listener must be in place before the next key press.
  useLayoutEffect(() => {
    if (!listening) return;
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setListening(false);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setHotkey(name, '');
        return setListening(false);
      }
      const a = accelFromEvent(e, name === 'ptt');
      if (a && (a.includes('+') || name === 'ptt' || /^F\d+$/.test(a) || a.startsWith('Num'))) {
        setHotkey(name, a);
        setListening(false);
      } else if (a) {
        toast(t().settings.keyCapture.needModifier);
      }
    };
    const mouse = (e: MouseEvent) => {
      const a = accelFromMouse(e);
      if (!a) return;
      e.preventDefault();
      setHotkey(name, a);
      setListening(false);
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', mouse, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', mouse, true);
    };
  }, [listening]);
  return (
    <div class="key-row">
      <div class="key-row-text">
        <span>{label}</span>
        {hint && <span class="hint">{hint}</span>}
      </div>
      <button ref={ref} class={'key-capture' + (listening ? ' listening' : '') + (value ? '' : ' empty')} onClick={() => setListening(!listening)}>
        {listening ? t().settings.keyCapture.listening : value ? accelLabel(value) : t().settings.keyCapture.unset}
      </button>
      {value && !listening && (
        <button class="icon-btn tiny" onClick={() => setHotkey(name, '')} aria-label={t().settings.keyCapture.reset}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

function CameraPreview() {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const p = prefs.value;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: p.cameraDevice ? { exact: p.cameraDevice } : undefined, width: p.cameraQuality === '1080p' ? 1920 : 1280 } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch((e) => {
        if (!alive) return;
        toast(t().settings.camera.unavailable(errorText(e)), 'error');
        setOn(false);
      });
    return () => {
      alive = false;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [on, p.cameraDevice, p.cameraQuality]);
  return (
    <div class={'cam-preview' + (p.mirrorCamera ? ' mirror' : '')}>
      {on ? (
        <video ref={ref} autoPlay playsInline muted />
      ) : (
        <button class="secondary" onClick={() => setOn(true)} disabled={cameraOn.value}>
          <Icon name="video" size={16} /> {cameraOn.value ? t().settings.camera.inUse : t().settings.camera.test}
        </button>
      )}
    </div>
  );
}

function ProfileTab() {
  const u = me.value!;
  const [name, setName] = useState(u.display_name);
  const [status, setStatus] = useState(u.status ?? '');
  const [about, setAbout] = useState(u.about ?? '');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [busy, setBusy] = useState(false);
  const tx = t().settings.profile;
  const save = async (patch: Parameters<ReturnType<typeof api>['updateMe']>[0], done = tx.saved) => {
    setBusy(true);
    try {
      await api().updateMe(patch);
      toast(done);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const changed = name !== u.display_name || status !== (u.status ?? '') || about !== (u.about ?? '');
  return (
    <>
      <div class="profile-edit">
        <div class="profile-banner small" style={{ '--c': u.color }} />
        <div class="avatar-edit">
          <button
            class="avatar-edit-btn round"
            disabled={busy}
            onClick={async () => {
              const f = await pickImage();
              if (f) save({ avatar: f.id }, tx.avatarUpdated);
            }}
            title={tx.changeAvatar}
          >
            <Avatar id={u.id} size={96} />
            <span class="avatar-edit-hover">
              <Icon name="image" />
            </span>
          </button>
          <div>
            <div class="strong">{u.display_name}</div>
            <div class="muted small">@{u.username}</div>
            <p class="muted small">{tx.avatarFormats}</p>
            <div class="row">
              <button
                class="secondary"
                disabled={busy}
                onClick={async () => {
                  const f = await pickImage();
                  if (f) save({ avatar: f.id }, tx.avatarUpdated);
                }}
              >
                {tx.uploadAvatar}
              </button>
              {u.avatar && (
                <button class="link" onClick={() => save({ avatar: '' }, tx.avatarRemoved)}>
                  {tx.removeAvatar}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({ display_name: name.trim(), status: status.trim(), about: about.trim() });
        }}
      >
        <label>
          {tx.name}
          <input value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          {tx.status}
          <input value={status} maxLength={80} placeholder={tx.statusPlaceholder} onInput={(e) => setStatus((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          {tx.about}
          <textarea rows={3} value={about} maxLength={300} placeholder={tx.aboutPlaceholder} onInput={(e) => setAbout((e.target as HTMLTextAreaElement).value)} />
        </label>
        <div class="modal-actions">
          <button class="primary" disabled={busy || !changed || !name.trim()}>
            {tx.save}
          </button>
        </div>
      </form>
      <h3 class="section-title">{tx.password}</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api().changePassword(oldPw, newPw);
            setOldPw('');
            setNewPw('');
            toast(tx.passwordChanged);
          } catch (err) {
            toast(errorText(err), 'error');
          }
        }}
      >
        <div class="row two">
          <label>
            {tx.currentPassword}
            <input type="password" value={oldPw} onInput={(e) => setOldPw((e.target as HTMLInputElement).value)} autoComplete="current-password" />
          </label>
          <label>
            {tx.newPassword}
            <input type="password" value={newPw} minLength={8} onInput={(e) => setNewPw((e.target as HTMLInputElement).value)} autoComplete="new-password" placeholder={tx.passwordPlaceholder} />
          </label>
        </div>
        <div class="modal-actions">
          <button class="secondary" disabled={!oldPw || newPw.length < 8}>
            {tx.changePassword}
          </button>
        </div>
      </form>
      <button
        class="danger-text logout-btn"
        onClick={async () => {
          if (!(await confirmDialog(tx.logoutConfirm, { ok: tx.logoutOk, danger: true }))) return;
          settingsOpen.value = false;
          logout();
        }}
      >
        <Icon name="logout" size={16} /> {tx.logout}
      </button>
    </>
  );
}

function ServerTab() {
  const [busy, setBusy] = useState(false);
  const tx = t().settings.server;
  useEffect(() => {
    api()
      .serverUpdate()
      .then((u) => (serverUpdate.value = u))
      .catch((e) => toast(errorText(e), 'error'));
  }, []);
  const u = serverUpdate.value;
  if (!u) return null;
  const updateNow = async () => {
    setBusy(true);
    try {
      serverUpdate.value = await api().updateServerNow();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const a = u.available;
  const applyBy = u.apply_by ? new Date(u.apply_by).toLocaleString(intlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  let status = tx.upToDate;
  let action = '';
  if (!u.enabled) {
    status = u.mode === 'off' ? tx.off : tx.devBuild;
  } else if (a && u.state === 'restarting') {
    status = tx.restarting(a.version);
  } else if (a && u.state === 'pulling') {
    status = tx.pulling(a.version);
  } else if (a && !u.agent) {
    status = tx.noAgent(a.version);
  } else if (a && u.state === 'waiting') {
    status = tx.waiting(a.version, applyBy);
    action = tx.updateNow;
  } else if (a && u.state === 'failed') {
    status = tx.failed(tx.reasons[u.error] ?? u.error);
    action = tx.retry;
  } else if (a) {
    status = tx.available(a.version);
    action = tx.updateNow;
  }
  return (
    <>
      <div class="about-card">
        <span class="logo-mark big" />
        <div>
          <b>{tx.version(u.version)}</b>
          <div class="muted small">{tx.modes[u.mode]}</div>
        </div>
      </div>
      <h3 class="section-title">{tx.updates}</h3>
      <p>{status}</p>
      <div class="row">
        {action && (
          <button class="primary" disabled={busy} onClick={updateNow}>
            {action}
          </button>
        )}
        {a && (
          <button class="link" onClick={() => bridge.openExternal(`https://github.com/D4eNst/tolktak/releases/tag/v${a.version}`)}>
            {tx.notes}
          </button>
        )}
      </div>
      <p class="hint">{tx.modeHint}</p>
    </>
  );
}

const TABS: { id: SettingsTab; icon: string }[] = [
  { id: 'profile', icon: 'user' },
  { id: 'voice', icon: 'mic' },
  { id: 'video', icon: 'video' },
  { id: 'keys', icon: 'keyboard' },
  { id: 'watch', icon: 'monitorPlay' },
  { id: 'app', icon: 'settings' },
  { id: 'server', icon: 'shield' },
];

export function SettingsDialog() {
  const tab = (settingsOpen.value || 'voice') as SettingsTab;
  const setTab = (id: SettingsTab) => (settingsOpen.value = id);
  const [desk, setDesk] = useState<DesktopSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [listen, setListen] = useState(false);
  const p = prefs.value;
  const tx = t().settings;
  const v = tx.voice;
  useEffect(() => {
    bridge.getSettings().then(setDesk);
    bridge.appInfo().then(setInfo);
  }, []);
  const close = () => (settingsOpen.value = false);
  const setDesktop = (patch: Partial<DesktopSettings>) => {
    setDesk({ ...desk!, ...patch });
    bridge.setSettings(patch);
  };
  const processing = async (patch: Partial<typeof p>) => {
    setPrefs(patch);
    await restartMic();
  };
  const gate = (patch: Partial<typeof p>) => {
    setPrefs(patch);
    applyGate();
  };

  return (
    <Modal title={tx.title} onClose={close} wide class="settings-modal">
      <div class="settings">
        <nav class="settings-nav">
          {TABS.filter((item) => item.id !== 'server' || me.value?.is_admin).map((item) => (
            <button key={item.id} class={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
              <Icon name={item.icon} size={16} /> {tx.tabs[item.id]}
            </button>
          ))}
        </nav>
        <div class="settings-body" key={tab}>
          {tab === 'profile' && <ProfileTab />}
          {tab === 'server' && <ServerTab />}
          {tab === 'voice' && (
            <>
              <AccessNotice kind="microphone" />
              <div class="row two">
                <DeviceSelect kind="audioinput" label={v.input} value={p.inputDevice} onChange={(id) => (setPrefs({ inputDevice: id }), switchDevices())} />
                <DeviceSelect kind="audiooutput" label={v.output} value={p.outputDevice} onChange={(id) => (setPrefs({ outputDevice: id }), switchDevices())} />
              </div>
              <div class="field">
                <span class="field-label">{v.micMode}</span>
                <Segmented
                  value={p.micMode}
                  onChange={(mode) => gate({ micMode: mode })}
                  options={[
                    { value: 'voice', label: v.modeVoice, icon: 'wave' },
                    { value: 'ptt', label: v.modePtt, icon: 'keyboard' },
                  ]}
                />
              </div>
              {p.micMode === 'voice' ? (
                <>
                  <Toggle checked={p.vadAuto} onChange={(on) => gate({ vadAuto: on })} hint={v.vadAutoHint}>
                    {v.vadAuto}
                  </Toggle>
                  {!p.vadAuto && (
                    <Slider
                      label={v.threshold}
                      value={p.vadThreshold}
                      min={-70}
                      max={-10}
                      step={1}
                      format={(db) => tx.meter.db(String(db))}
                      onInput={(db) => setPrefs({ vadThreshold: db })}
                    />
                  )}
                  <MicMeter threshold={p.vadAuto ? undefined : p.vadThreshold} listen={listen} />
                  <p class="hint">{p.vadAuto ? v.meterHintAuto : v.meterHintManual}</p>
                </>
              ) : (
                <>
                  <KeyCapture name="ptt" label={v.pttKey} hint={hotkeysAreGlobal ? tx.keys.pttGlobalHint : tx.keys.pttFocusedHint} />
                  <Slider label={v.pttRelease} value={p.pttRelease} min={0} max={1000} step={20} format={v.ms} onInput={(ms) => setPrefs({ pttRelease: ms })} />
                  <MicMeter listen={listen} />
                </>
              )}
              <h3 class="section-title">{v.processing}</h3>
              <Select label={v.denoise} value={p.denoise} options={denoiseOptions()} onChange={(d) => processing({ denoise: d })} />
              <Toggle checked={p.agc} onChange={(on) => setPrefs({ agc: on })} hint={v.agcHint}>
                {v.agc}
              </Toggle>
              {!p.agc && (
                <Slider label={v.inputGain} value={p.inputGain} min={-12} max={24} step={1} format={(db) => tx.meter.db(`${db > 0 ? '+' : ''}${db}`)} onInput={(db) => setPrefs({ inputGain: db })} />
              )}
              <Toggle checked={p.echoCancellation} onChange={(on) => processing({ echoCancellation: on })} hint={v.echoHint}>
                {v.echo}
              </Toggle>
              <MicCheck listen={listen} setListen={setListen} />
              <h3 class="section-title">{v.calls}</h3>
              <Slider label={v.voiceVolume} value={p.voiceVolume} onInput={(vol) => setPrefs({ voiceVolume: vol })} />
              <Toggle checked={p.startMuted} onChange={(on) => setPrefs({ startMuted: on })}>
                {v.startMuted}
              </Toggle>
              <Toggle checked={p.sounds} onChange={(on) => setPrefs({ sounds: on })} hint={v.soundsHint}>
                {v.sounds}
              </Toggle>
              <button class="secondary" onClick={() => playTone('test')}>
                <Icon name="speaker" size={16} /> {v.testSound}
              </button>
            </>
          )}
          {tab === 'video' && (
            <>
              <AccessNotice kind="camera" />
              <DeviceSelect kind="videoinput" label={tx.video.camera} value={p.cameraDevice} onChange={(id) => (setPrefs({ cameraDevice: id }), switchDevices())} />
              <Select
                label={tx.video.quality}
                value={p.cameraQuality}
                options={[
                  { value: '720p', label: '720p', hint: tx.video.q720 },
                  { value: '1080p', label: '1080p', hint: tx.video.q1080 },
                ]}
                onChange={(q) => (setPrefs({ cameraQuality: q }), restartCamera())}
              />
              <Toggle checked={p.mirrorCamera} onChange={(on) => setPrefs({ mirrorCamera: on })} hint={tx.video.mirrorHint}>
                {tx.video.mirror}
              </Toggle>
              <CameraPreview />
            </>
          )}
          {tab === 'keys' && (
            <>
              <p class="hint">
                {hotkeysAreGlobal ? tx.keys.globalHint : tx.keys.focusedHint} {tx.keys.resetHint}
              </p>
              <KeyCapture name="mute" label={tx.keys.mute} />
              <KeyCapture name="deafen" label={tx.keys.deafen} />
              <KeyCapture name="ptt" label={tx.keys.ptt} hint={p.micMode === 'ptt' ? undefined : tx.keys.pttModeHint} />
              <h3 class="section-title">{tx.keys.inApp}</h3>
              <div class="shortcut-list">
                <div>
                  <span>{tx.keys.quickSwitcher}</span>
                  <kbd>Ctrl K</kbd>
                </div>
                <div>
                  <span>{tx.keys.callMic}</span>
                  <kbd>Ctrl Shift M</kbd>
                </div>
                <div>
                  <span>{tx.keys.editLast}</span>
                  <kbd>↑</kbd>
                </div>
                <div>
                  <span>{tx.keys.formatting}</span>
                  <kbd>Ctrl B</kbd> <kbd>Ctrl I</kbd> <kbd>Ctrl Shift X</kbd>
                </div>
                <div>
                  <span>{tx.keys.newLine}</span>
                  <kbd>Shift Enter</kbd>
                </div>
              </div>
            </>
          )}
          {tab === 'watch' && (
            <>
              <Slider label={tx.watch.streamVolume} value={p.streamVolume} onInput={(vol) => setPrefs({ streamVolume: vol })} />
              <Toggle checked={p.ducking} onChange={(on) => setPrefs({ ducking: on })} hint={tx.watch.duckingHint}>
                {tx.watch.ducking}
              </Toggle>
              {p.ducking && (
                <Slider label={tx.watch.duckLevel} value={p.duckLevel} max={1} onInput={(lvl) => setPrefs({ duckLevel: lvl })} format={(lvl) => tx.watch.duckValue(Math.round(lvl * 100))} />
              )}
              <Toggle checked={p.autoWatch} onChange={(on) => setPrefs({ autoWatch: on })}>
                {tx.watch.autoWatch}
              </Toggle>
              <Toggle checked={p.streamReactions} onChange={(on) => setPrefs({ streamReactions: on })} hint={tx.watch.reactionsHint}>
                {tx.watch.reactions}
              </Toggle>
              <Toggle checked={p.backgroundSaver} onChange={(on) => setPrefs({ backgroundSaver: on })} hint={tx.watch.saverHint}>
                {tx.watch.saver}
              </Toggle>
            </>
          )}
          {tab === 'app' && desk && (
            <>
              <Select<Locale> label={tx.app.language} value={locale.value} options={LOCALES.map((l) => ({ value: l.id, label: l.name }))} onChange={setLocale} />
              {isDesktop && (
                <>
                  <Toggle checked={desk.minimizeToTray} onChange={(on) => setDesktop({ minimizeToTray: on })} hint={tx.app.trayHint}>
                    {tx.app.tray}
                  </Toggle>
                  {platform !== 'other' && (
                    <Toggle checked={desk.openAtLogin} onChange={(on) => setDesktop({ openAtLogin: on })} hint={tx.app.openAtLoginHint}>
                      {tx.app.openAtLogin(platform === 'darwin' ? 'macOS' : 'Windows')}
                    </Toggle>
                  )}
                  {platform === 'win32' && info && info.windowsBuild > 0 && info.windowsBuild < 22000 && (
                    <Toggle
                      checked={desk.allowWin10Loopback}
                      onChange={(on) => setDesktop({ allowWin10Loopback: on })}
                      hint={tx.app.win10LoopbackHint}
                    >
                      {tx.app.win10Loopback}
                    </Toggle>
                  )}
                </>
              )}
              <Toggle checked={notificationsOn.value} onChange={setNotifications} hint={tx.app.notificationsHint}>
                {tx.app.notifications}
              </Toggle>
              <div class="about-card">
                <span class="logo-mark big" />
                <div>
                  <b>TolkTak {info?.version ?? ''}</b>
                  <div class="muted small">
                    {tx.app.server(session.value?.server.name ?? '', session.value?.api.base.replace(/^https?:\/\//, '') ?? '')}
                  </div>
                  <div class="muted small">{tx.app.license}</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
