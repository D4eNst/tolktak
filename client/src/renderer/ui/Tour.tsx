import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { keyLabel } from '../keys';
import { settingsOpen } from '../state';
import { deskPrefs } from './desk';

const SEEN_KEY = 'tolktak.tour';
const STEPS = ['nav', 'move', 'beside', 'call', 'menu'] as const;

export const tourOpen = signal(false);

export function startTour() {
  settingsOpen.value = false;
  tourOpen.value = true;
}

function seen() {
  try {
    return !!localStorage.getItem(SEEN_KEY);
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

const Msgs = () => (
  <span class="ts-msgs">
    {[70, 48, 84, 36].map((w, i) => (
      <span key={i} class="ts-msg">
        <i style={{ background: `var(--user-${i})` }} />
        <b style={{ width: w + '%' }} />
      </span>
    ))}
  </span>
);

const Nav = ({ rooms }: { rooms?: boolean }) => (
  <span class="ts-nav">
    <i class="ts-hl" />
    {[58, 44, 62, 50].map((w, i) => (
      <i key={i} class="ts-row" style={{ top: 14 + i * 18, width: w }} />
    ))}
    {[54, 40].map((w, i) => (
      <i key={'r' + i} class={'ts-row' + (rooms ? ' room' : '')} style={{ top: 94 + i * 18, width: w }} />
    ))}
  </span>
);

const Cursor = () => (
  <svg class="ts-cursor" width="14" height="18" viewBox="0 0 14 18" aria-hidden="true">
    <path d="M1 1v14l4-3.5 2.6 5.5 2.4-1.1L7.5 10.5H13z" fill="#fff" stroke="#0b1327" stroke-width="1.2" stroke-linejoin="round" />
  </svg>
);

/** A sketch of the desk for each step, played on a loop. */
function Scene({ step }: { step: (typeof STEPS)[number] }) {
  const m = t().desk.menu;
  return (
    <span class={'tour-scene t-' + step + (step === 'call' ? ' tm-' + deskPrefs.value.call : '')} aria-hidden="true">
      <span class="ts-top">
        <i class="ts-logo" />
        <i class="ts-search" />
        <i class="ts-cap">
          <i class="ts-capdot" />
        </i>
        <i class="ts-ava" />
      </span>
      <Nav rooms={step === 'call'} />
      {step === 'move' && <i class="ts-zone" />}
      {step === 'beside' && <i class="ts-zone" />}
      <span class="ts-win ts-a">
        <i class="ts-name" />
        {step === 'menu' && <i class="ts-dots" />}
        <Msgs />
      </span>
      {step === 'move' && (
        <span class="ts-win ts-b">
          <i class="ts-name" />
          <Msgs />
        </span>
      )}
      {step === 'beside' && (
        <>
          <span class="ts-win ts-c">
            <i class="ts-name" />
            <Msgs />
          </span>
          <i class="ts-chip" />
        </>
      )}
      {step === 'call' && (
        <span class="ts-win ts-call">
          <i class="ts-name" />
          <span class="ts-tiles">
            <i />
            <i />
          </span>
        </span>
      )}
      {step === 'menu' && (
        <>
          <span class="ts-menu">
            <i class="ts-mhl" />
            {[m.pin, m.float, m.toEdge, m.popOut].map((x) => (
              <span key={x}>{x}</span>
            ))}
          </span>
          <i class="ts-edgetab" />
        </>
      )}
      <Cursor />
    </span>
  );
}

export function Tour() {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [closing, setClosing] = useState(false);
  const open = tourOpen.value;

  useEffect(() => {
    if (seen()) return;
    const timer = setTimeout(() => (tourOpen.value = true), 900);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (open) {
      setStep(0);
      setClosing(false);
    }
  }, [open]);

  const go = (n: number) => {
    if (n < 0 || n >= STEPS.length) return;
    setDir(n > step ? 1 : -1);
    setStep(n);
  };
  const close = () => {
    markSeen();
    setClosing(true);
    setTimeout(() => (tourOpen.value = false), 200);
  };

  useEffect(() => {
    if (!open) return;
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(step + 1);
      else if (e.key === 'ArrowLeft') go(step - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  });

  if (!open) return null;
  const tx = t().desk.tour;
  const id = STEPS[step];
  const last = step === STEPS.length - 1;
  const text = id === 'beside' ? tx.steps.beside.text(keyLabel('Mod K'), keyLabel('Mod Enter')) : tx.steps[id].text;
  return (
    <div class={'tour-backdrop' + (closing ? ' closing' : '')} onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">
        <div key={id} class="tour-step" style={{ '--dir': dir }}>
          <Scene step={id} />
          <h2 id="tour-title">{tx.steps[id].title}</h2>
          <p id="tour-text">{text}</p>
        </div>
        <div class="tour-foot">
          <button class="tour-skip" onClick={close}>
            {tx.skip}
          </button>
          <div class="tour-dots">
            {STEPS.map((s, i) => (
              <button key={s} class={i === step ? 'on' : ''} onClick={() => go(i)} aria-label={tx.stepOf(i + 1, STEPS.length)} aria-current={i === step ? 'step' : undefined} />
            ))}
          </div>
          <button class="primary" onClick={() => (last ? close() : go(step + 1))} autoFocus>
            {last ? tx.start : tx.next}
          </button>
        </div>
      </div>
    </div>
  );
}
