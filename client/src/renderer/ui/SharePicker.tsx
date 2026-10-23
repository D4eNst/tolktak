import { useEffect, useState } from 'preact/hooks';
import { bridge, isDesktop, type AppInfo, type AudioMode, type CaptureSource } from '../bridge';
import { t } from '../i18n';
import { errorText, toast } from '../state';
import { sharing, startShare, type ShareMode, type ShareQuality } from '../voice';
import { Icon, Modal, Select, Toggle } from './common';

export function SharePicker({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<'window' | 'screen'>('window');
  const [selected, setSelected] = useState<CaptureSource | null>(null);
  const [withAudio, setWithAudio] = useState(true);
  const [allowEcho, setAllowEcho] = useState(false);
  const [mode, setMode] = useState<ShareMode>(sharing.value?.mode ?? 'motion');
  const [quality, setQuality] = useState<ShareQuality>(sharing.value?.quality ?? '1080p60');
  const [busy, setBusy] = useState(false);
  const tx = t().shell.share;

  useEffect(() => {
    bridge.appInfo().then(setInfo);
    bridge.captureSources().then(setSources);
  }, []);

  const loopbackOk = !!info?.processLoopback;
  const audioMode = (src: CaptureSource | null): AudioMode => {
    if (!withAudio) return 'none';
    if (!loopbackOk) return allowEcho ? 'system-all' : 'none';
    return src?.kind === 'window' ? 'app' : 'system';
  };

  const go = async () => {
    if (isDesktop && !selected) return;
    setBusy(true);
    try {
      await startShare({
        sourceId: selected?.id ?? '',
        sourceName: selected?.name ?? tx.defaultSource,
        audio: audioMode(selected),
        mode,
        quality,
      });
      onClose();
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotReadableError' && isDesktop) {
        // WGC returns E_ACCESSDENIED when the client runs elevated (Windows 11 25H2).
        toast(tx.elevatedError, 'error', 9000);
      } else if (name !== 'NotAllowedError') toast(tx.startFailed(errorText(e)), 'error');
      setBusy(false);
    }
  };

  const list = (sources ?? []).filter((s) => s.kind === tab);

  return (
    <Modal title={sharing.value ? tx.changeSource : tx.title} onClose={onClose} wide>
      {isDesktop ? (
        <>
          <div class="tabs">
            <button class={tab === 'window' ? 'active' : ''} onClick={() => setTab('window')}>
              {tx.windows}
            </button>
            <button class={tab === 'screen' ? 'active' : ''} onClick={() => setTab('screen')}>
              {tx.screens}
            </button>
          </div>
          <div class="source-grid">
            {sources === null && <div class="muted">{tx.loading}</div>}
            {list.map((s) => (
              <button key={s.id} class={'source' + (selected?.id === s.id ? ' selected' : '')} onClick={() => setSelected(s)} onDblClick={() => (setSelected(s), go())}>
                {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div class="thumb-empty" />}
                <span class="source-name">
                  {s.icon && <img class="source-icon" src={s.icon} alt="" />}
                  {s.name}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p class="muted">{tx.browserPicker}</p>
      )}

      <div class="share-options">
        <fieldset>
          <legend>{tx.mode}</legend>
          <label class="radio">
            <input type="radio" checked={mode === 'motion'} onChange={() => setMode('motion')} />
            <span class="radio-title">
              <Icon name="monitorPlay" size={16} /> {tx.motion}
            </span>
            <span class="muted small">{tx.motionHint}</span>
          </label>
          <label class="radio">
            <input type="radio" checked={mode === 'detail'} onChange={() => setMode('detail')} />
            <span class="radio-title">
              <Icon name="file" size={16} /> {tx.detail}
            </span>
            <span class="muted small">{tx.detailHint}</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>{tx.quality}</legend>
          <Select
            value={quality}
            onChange={setQuality}
            options={[
              { value: '720p30', label: tx.q720p30, hint: tx.slowConnection },
              { value: '1080p30', label: tx.q1080p30 },
              { value: '1080p60', label: tx.q1080p60, hint: tx.recommended },
              { value: 'source60', label: tx.qSource60, hint: tx.fastConnection },
            ]}
          />
          <p class="muted small">{tx.adaptiveHint}</p>
        </fieldset>
        <fieldset>
          <legend>{tx.audio}</legend>
          <Toggle checked={withAudio} onChange={setWithAudio}>
            {tx.shareAudio}
          </Toggle>
          {withAudio && loopbackOk && <p class="muted small">{tab === 'window' ? tx.appAudioHint : tx.systemAudioHint}</p>}
          {withAudio && !loopbackOk && (
            <div class="warn-box small">
              {tx.noLoopback}
              <Toggle checked={allowEcho} onChange={setAllowEcho}>
                {tx.shareAllAudio}
              </Toggle>
            </div>
          )}
          <p class="muted small">{tx.drmHint}</p>
        </fieldset>
      </div>
      <div class="modal-actions">
        <button class="secondary" onClick={onClose}>
          {tx.cancel}
        </button>
        <button class="primary" disabled={busy || (isDesktop && !selected)} onClick={go}>
          {busy ? tx.starting : sharing.value ? tx.switch : tx.start}
        </button>
      </div>
    </Modal>
  );
}
