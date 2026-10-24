import { intlLocale, t } from '../renderer/i18n';
import './launch.css';
import type { LaunchAction, LaunchState } from './state';

declare global {
  interface Window {
    launch: { onState(fn: (state: LaunchState) => void): void; act(action: LaunchAction): Promise<void> };
  }
}

const N = 38;
const DOT = 'rgba(255, 240, 255, 0.16)';
const GRADIENT = [
  [255, 106, 99],
  [255, 138, 76],
  [255, 190, 75],
];
const $ = (id: string) => document.getElementById(id)!;
const bars = Array.from({ length: N }, () => $('bars').appendChild(document.createElement('i')));
// A fixed voice-message waveform: what the download "records".
const shape = bars.map((_, i) => 10 + 52 * Math.abs(Math.sin(i * 0.47 + 0.3)) * (0.55 + 0.45 * Math.sin(i * 0.19 + 0.8)) * (0.7 + 0.3 * Math.sin(i * 1.3)));
const colors = bars.map((_, i) => brandColor(i / (N - 1), 1));
const faded = bars.map((_, i) => brandColor(i / (N - 1), 0.45));
const mb = (bytes: number) => (bytes / 1048576).toLocaleString(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

let state: LaunchState = { kind: 'check', from: '' };
let lastPercent = 0;
let framePending = false;

function brandColor(x: number, alpha: number) {
  const seg = x < 0.5 ? 0 : 1;
  const f = x < 0.5 ? x * 2 : (x - 0.5) * 2;
  const rgb = GRADIENT[seg].map((v, k) => Math.round(v + (GRADIENT[seg + 1][k] - v) * f));
  return `rgba(${rgb.join(', ')}, ${alpha})`;
}

function render() {
  const tx = t().launch;
  const s = state;
  let status = '';
  let detail = '';
  let percent = '';
  const buttons: [LaunchAction, string, boolean][] = [];
  switch (s.kind) {
    case 'check':
      status = tx.checking;
      detail = tx.checkingDetail;
      break;
    case 'offline':
      status = tx.offline;
      detail = tx.offlineDetail;
      break;
    case 'start':
      status = tx.starting;
      break;
    case 'download':
      status = tx.downloading(s.to);
      percent = `${Math.floor(s.percent)}%`;
      if (s.total) detail = tx.progress(mb(s.transferred), mb(s.total), mb(s.speed));
      break;
    case 'install':
      status = tx.installing;
      detail = tx.installingDetail;
      break;
    case 'failed':
      status = tx.failed;
      detail = tx.required(s.to);
      buttons.push(['retry', tx.retry, true], ['download', tx.downloadManually, false]);
      break;
    case 'manual':
      status = tx.available(s.to);
      detail = s.required ? tx.required(s.to) : s.platform === 'darwin' ? tx.manualMac : tx.manualOther;
      buttons.push(['download', tx.download, true], s.required ? ['quit', tx.quit, false] : ['later', tx.later, false]);
      break;
  }
  $('version').textContent = 'to' in s ? `${s.from} → ${s.to}` : s.from;
  $('status').textContent = status;
  $('status').classList.toggle('bad', s.kind === 'failed');
  $('percent').textContent = percent;
  $('detail').textContent = detail;
  $('buttons').replaceChildren(
    ...buttons.map(([action, label, primary]) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.onclick = () => window.launch.act(action);
      return b;
    }),
  );
  $('card').classList.toggle('has-buttons', buttons.length > 0);
  $('card').classList.toggle('leaving', s.kind === 'start');
}

function bar(i: number, height: number, color: string, glow = '') {
  const b = bars[i].style;
  b.height = `${Math.max(3, height)}px`;
  b.background = color;
  b.boxShadow = glow;
}

function frame(now: number) {
  framePending = false;
  const s = now / 1000;
  for (let i = 0; i < N; i++) {
    switch (state.kind) {
      case 'check': {
        // Syllables: a loudness envelope rolling across a bell-shaped row, like someone talking.
        const env = Math.max(0, Math.sin(s * 6.1 - i * 0.09) * 0.6 + Math.sin(s * 2.7 + 1.3 - i * 0.05) * 0.5);
        const bell = Math.exp(-(((i - N / 2) / (N / 3.2)) ** 2));
        bar(i, 3 + 54 * bell * env * (0.55 + 0.45 * Math.sin(i * 1.7 + s * 13)), 'rgba(255, 240, 255, 0.28)');
        break;
      }
      case 'download': {
        const head = (state.percent / 100) * N;
        if (i < head - 1) bar(i, shape[i] * (0.86 + 0.14 * Math.sin(s * 3.2 + i * 0.7)), colors[i]);
        else if (i < head) bar(i, Math.min(68, shape[i] * 1.18), '#ffd38a', '0 0 10px rgba(255, 190, 75, 0.9)');
        else bar(i, 3, DOT);
        break;
      }
      case 'install': {
        const wave = Math.max(0, Math.sin(i * 0.32 - s * 7));
        bar(i, shape[i] * (0.62 + 0.38 * wave), colors[i], wave > 0.92 ? '0 0 8px rgba(255, 190, 75, 0.7)' : '');
        break;
      }
      case 'failed': {
        const reached = i < (lastPercent / 100) * N;
        bar(i, reached ? shape[i] * 0.62 : 3, reached ? faded[i] : DOT);
        break;
      }
      case 'manual':
        bar(i, shape[i] * 0.5, DOT);
        break;
      default:
        bar(i, 3, DOT);
    }
  }
  if (state.kind === 'check' || state.kind === 'download' || state.kind === 'install') requestFrame();
}

function requestFrame() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(frame);
}

window.launch.onState((s) => {
  if (s.kind === 'download') lastPercent = s.percent;
  state = s;
  render();
  requestFrame();
});
render();
requestFrame();
