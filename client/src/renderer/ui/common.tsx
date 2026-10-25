import type { ComponentChildren } from 'preact';
import { signal } from '@preact/signals';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { intlLocale, t } from '../i18n';
import { avatarUrl, groups, online, users } from '../state';

const paths: Record<string, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.9-.8M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z',
  headphonesOff: 'M4 15v-3a8 8 0 0 1 13.7-5.6M20 12v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM17 13h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1zM3 3l18 18',
  video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  videoOff: 'M3 7h9M15 11v6H3V7M15 10l6-3v10l-6-3M3 3l18 18',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  phoneOff: 'M4 14c4-4 12-4 16 0l-2 3-3-1v-2a10 10 0 0 0-6 0v2l-3 1z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  plus: 'M12 5v14M5 12h14',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  speaker: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  maximize: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  x: 'M18 6 6 18M6 6l12 12',
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  reply: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  smile: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  smilePlus: 'M22 11v1a10 10 0 1 1-9-10M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6',
  clip: 'M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  pin: 'M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  play: 'M6 4l14 8-14 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  crown: 'M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  userPlus: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  bellOff: 'M8.7 3A6 6 0 0 1 18 8c0 2.8.5 4.8 1.1 6.2M17 17H3s3-2 3-9c0-.8.1-1.5.4-2.2M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  sticker: 'M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9.5L21 14.5V5a2 2 0 0 0-2-2zM14 21v-5a2 2 0 0 1 2-2h5M8 10h.01M14 10h.01M8.5 14.5s1.5 1.5 3.5 1.5',
  stop: 'M6 6h12v12H6z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z',
  wave: 'M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  quote: 'M3 21c3 0 7-1 7-8V5H3v8h4M14 21c3 0 7-1 7-8V5h-7v8h4',
  bold: 'M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9M14 20H5M15 4 9 20',
  strike: 'M16 4H9a3 3 0 0 0-2.8 4M14 12a4 4 0 0 1 0 8H6M4 12h16',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  monitorPlay: 'M3 4h18v12H3zM8 20h8M12 16v4M10 7.5v5l4-2.5z',
  door: 'M13 4h3a2 2 0 0 1 2 2v14M2 20h3M13 20h9M10 12v.01M13 4.6v16.5L6 20V5.5z',
};

export function Icon({ name, size = 20, class: cls }: { name: keyof typeof paths | string; size?: number; class?: string }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? '')
    .join('');
}

export function Avatar({
  id,
  size = 32,
  speaking = false,
  showPresence = false,
}: {
  id: number;
  size?: number;
  speaking?: boolean;
  showPresence?: boolean;
}) {
  const u = users.value.get(id);
  const name = u?.display_name ?? '?';
  const src = u?.avatar ? avatarUrl(u.avatar) : '';
  return (
    <span
      class={'avatar' + (speaking ? ' speaking' : '') + (src ? ' has-img' : '')}
      style={{ width: size, height: size, '--c': u?.color ?? '#7a6f86', fontSize: size * 0.4 }}
      title={name}
    >
      {src ? <img src={src} alt="" draggable={false} /> : initials(name)}
      {showPresence && <span class={'presence ' + (online.value.has(id) ? 'on' : 'off')} />}
    </span>
  );
}

export function GroupAvatar({ id, size = 44 }: { id: number; size?: number }) {
  const g = groups.value.get(id);
  if (!g) return null;
  const src = g.avatar ? avatarUrl(g.avatar) : '';
  return (
    <span class={'group-avatar' + (src ? ' has-img' : '')} style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {src ? <img src={src} alt="" draggable={false} /> : g.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  class: cls = '',
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
  class?: string;
}) {
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 140);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Escape closes only the top layer: menus and popovers sit above modals, and a later modal above an earlier one.
      const top = !document.querySelector('.menu, .popover') && ref.current === [...document.querySelectorAll('.modal')].at(-1);
      if (e.key === 'Escape' && !e.defaultPrevented && top) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  // In <body>: an ancestor with a transform would become the containing block.
  return createPortal(
    <div class={'modal-backdrop' + (closing ? ' closing' : '')} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class={'modal' + (wide ? ' wide' : '') + ' ' + cls} ref={ref} role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button class="icon-btn" onClick={close} aria-label={t().common.close}>
            <Icon name="x" />
          </button>
        </header>
        <div class="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

type Ask =
  | { kind: 'confirm'; title: string; text?: string; ok: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; label: string; initial: string; ok: string; max: number; resolve: (v: string | null) => void };
const asking = signal<Ask | null>(null);

export function confirmDialog(title: string, opts: { text?: string; ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => (asking.value = { kind: 'confirm', title, text: opts.text, ok: opts.ok ?? t().common.yes, danger: opts.danger, resolve }));
}
export function promptDialog(title: string, opts: { label?: string; initial?: string; ok?: string; max?: number } = {}): Promise<string | null> {
  return new Promise((resolve) =>
    (asking.value = { kind: 'prompt', title, label: opts.label ?? t().common.name, initial: opts.initial ?? '', ok: opts.ok ?? t().common.save, max: opts.max ?? 60, resolve }),
  );
}

export function AskHost() {
  const a = asking.value;
  const [v, setV] = useState('');
  useEffect(() => {
    if (a?.kind === 'prompt') setV(a.initial);
  }, [a]);
  if (!a) return null;
  const done = (val: boolean | string | null) => {
    asking.value = null;
    (a.resolve as (x: unknown) => void)(val);
  };
  if (a.kind === 'confirm') {
    return (
      <Modal title={a.title} onClose={() => done(false)} class="ask">
        {a.text && <p class="ask-text">{a.text}</p>}
        <div class="modal-actions">
          <button class="secondary" onClick={() => done(false)}>
            {t().common.cancel}
          </button>
          <button class={a.danger ? 'danger-btn' : 'primary'} onClick={() => done(true)} autoFocus>
            {a.ok}
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={a.title} onClose={() => done(null)} class="ask">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) done(v.trim());
        }}
      >
        <label>
          {a.label}
          <input value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} autoFocus maxLength={a.max} />
        </label>
        <div class="modal-actions">
          <button type="button" class="secondary" onClick={() => done(null)}>
            {t().common.cancel}
          </button>
          <button class="primary" disabled={!v.trim()}>
            {a.ok}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Toggle({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: ComponentChildren; hint?: string }) {
  return (
    <label class="toggle">
      <span class="toggle-text">
        <span>{children}</span>
        {hint && <span class="hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="switch" aria-hidden="true" />
    </label>
  );
}

export function Slider({
  value,
  min = 0,
  max = 2,
  step = 0.01,
  onInput,
  label,
  format = (v: number) => Math.round(v * 100) + '%',
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onInput: (v: number) => void;
  label: string;
  format?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label class="slider">
      <span class="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--p': pct + '%' }}
        onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))}
        aria-label={label}
      />
      <span class="slider-val">{format(value)}</span>
    </label>
  );
}

export type Option<T extends string> = { value: T; label: string; hint?: string };

/** Native <select> popups cannot be styled. */
export function Select<T extends string>({ value, options, onChange, label }: { value: T; options: Option<T>[]; onChange: (v: T) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);
  const cur = options.find((o) => o.value === value) ?? options[0];
  return (
    <div class="field">
      {label && <span class="field-label">{label}</span>}
      <div class={'select' + (open ? ' open' : '')} ref={ref}>
        <button
          type="button"
          class="select-btn"
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => {
            const i = options.findIndex((o) => o.value === value);
            if (e.key === 'ArrowDown') (e.preventDefault(), onChange(options[Math.min(i + 1, options.length - 1)].value));
            if (e.key === 'ArrowUp') (e.preventDefault(), onChange(options[Math.max(i - 1, 0)].value));
            if (e.key === 'Escape' && open) (e.preventDefault(), setOpen(false));
          }}
          aria-haspopup="listbox"
          aria-label={label}
        >
          <span class="ellipsis">{cur?.label ?? '—'}</span>
          <Icon name="chevronDown" size={16} />
        </button>
        {open && (
          <div class="select-menu" role="listbox">
            {options.map((o) => (
              <button
                type="button"
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                class={o.value === value ? 'selected' : ''}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span class="ellipsis">
                  {o.label}
                  {o.hint && <span class="hint"> · {o.hint}</span>}
                </span>
                {o.value === value && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export type MenuItem = { label: string; icon?: string; danger?: boolean; run: () => void; hint?: string } | 'sep';
type MenuState = { x: number; y: number; items: MenuItem[]; header?: ComponentChildren };
const menuState = signal<MenuState | null>(null);

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[], header?: ComponentChildren) {
  e.preventDefault?.();
  e.stopPropagation?.();
  menuState.value = { x: e.clientX, y: e.clientY, items, header };
}
export function openMenuAt(el: Element, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  menuState.value = { x: r.left, y: r.bottom + 4, items };
}

function useClampedPosition(x: number, y: number, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
  }, deps);
  return { ref, pos };
}

export function MenuHost() {
  const m = menuState.value;
  const { ref, pos } = useClampedPosition(m?.x ?? 0, m?.y ?? 0, [m]);
  useEffect(() => {
    if (!m) return;
    const close = () => (menuState.value = null);
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', k);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', k);
      window.removeEventListener('resize', close);
    };
  }, [m]);
  if (!m) return null;
  return (
    <div class="menu pop-in" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {m.header}
      {m.items.map((it, i) =>
        it === 'sep' ? (
          <div class="menu-sep" key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            class={it.danger ? 'danger' : ''}
            onClick={() => {
              menuState.value = null;
              it.run();
            }}
          >
            {it.icon && <Icon name={it.icon} size={16} />}
            <span>{it.label}</span>
            {it.hint && <span class="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export function Popover({ x, y, onClose, children, class: cls = '' }: { x: number; y: number; onClose: () => void; children: ComponentChildren; class?: string }) {
  const { ref, pos } = useClampedPosition(x, y, [x, y]);
  useEffect(() => {
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.menu')) {
        e.preventDefault();
        onClose();
      }
    };
    setTimeout(() => window.addEventListener('mousedown', off));
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', k);
    };
  }, [onClose]);
  return (
    <div class={'popover pop-in ' + cls} ref={ref} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>
  );
}

function isYesterday(d: Date, now: Date) {
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  return d.toDateString() === y.toDateString();
}

export function timeLabel(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  if (isYesterday(d, now)) return t().common.time.yesterdayAt(hm);
  return d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' }) + ' ' + hm;
}

export function dayLabel(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t().common.time.today;
  if (isYesterday(d, now)) return t().common.time.yesterday;
  return d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function sizeLabel(n: number) {
  const u = t().common.size;
  if (n < 1024) return n + ' ' + u.b;
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' ' + u.kb;
  return (n / 1024 / 1024).toFixed(1) + ' ' + u.mb;
}
