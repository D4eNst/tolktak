import { signal } from '@preact/signals';
import { bridge } from './bridge';

export const THEMES = [
  { id: 'petrol', light: false },
  { id: 'midnight', light: false },
  { id: 'embers', light: false },
  { id: 'clay', light: false },
  { id: 'moss', light: false },
  { id: 'wine', light: false },
  { id: 'blue', light: false },
  { id: 'paper', light: true },
  { id: 'frost', light: true },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'] | 'custom';

export type Custom = { light: boolean; hue: number; tint: number; depth: number; contrast: number; accent: string };
export const CUSTOM_DEFAULT: Custom = { light: false, hue: 190, tint: 40, depth: 50, contrast: 50, accent: '#e6b25c' };
export const ACCENTS = ['#e6b25c', '#ff8a4c', '#ff6b78', '#ec6fb0', '#9b87ff', '#5b9bff', '#3cc6b8', '#3ddc97', '#c9e265'];

type Saved = { id: ThemeId; custom: Custom };
const KEY = 'tolktak.theme';

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { id: s.id ?? 'petrol', custom: { ...CUSTOM_DEFAULT, ...s.custom } };
  } catch {
    return { id: 'petrol', custom: CUSTOM_DEFAULT };
  }
}

export const theme = signal<Saved>(load());

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function customVars(c: Custom): Record<string, string> {
  const { hue: h, light } = c;
  const s = c.tint * 0.5;
  const step = 0.5 + c.contrast / 100;
  const hsl = (sat: number, l: number) => `hsl(${h} ${sat.toFixed(1)}% ${l.toFixed(1)}%)`;
  const base = light ? 80 + c.depth * 0.12 : 2 + c.depth * 0.12;
  const layer = (n: number) => hsl(s, light ? Math.min(99, base + n * step) : base + n * step);
  const ink = (l: number) => hsl(Math.min(s, 22), l);
  const a = c.accent;
  return {
    'color-scheme': light ? 'light' : 'dark',
    '--bg-app': layer(0),
    '--bg-sunk': layer(light ? 4 : 2.5),
    '--bg-island': layer(light ? 9 : 4.5),
    '--bg-raised': layer(light ? 5 : 8),
    '--bg-hover': layer(light ? 3 : 10.5),
    '--bg-active': `color-mix(in srgb, ${a} ${light ? 18 : 24}%, ${layer(light ? 9 : 4.5)})`,
    '--bg-input': light ? '#ffffff' : layer(8),
    '--line': `hsl(${h} 30% ${light ? 20 : 92}% / ${light ? 0.09 : 0.06})`,
    '--line-strong': `hsl(${h} 30% ${light ? 20 : 92}% / ${light ? 0.16 : 0.12})`,
    '--text': ink(light ? 11 : 94),
    '--text-2': ink(light ? 27 : 82),
    '--muted': ink(light ? 45 : 63),
    '--faint': ink(light ? 62 : 46),
    '--accent': a,
    '--accent-2': `color-mix(in srgb, ${a}, white 30%)`,
    '--accent-ink': luminance(a) > 0.55 ? '#1a1206' : '#ffffff',
    '--grad': `linear-gradient(135deg, color-mix(in srgb, ${a}, #ff3b5c 22%) 0%, ${a} 50%, color-mix(in srgb, ${a}, white 32%) 100%)`,
    '--accent-soft': `color-mix(in srgb, ${a} 14%, transparent)`,
    '--accent-line': `color-mix(in srgb, ${a} 45%, transparent)`,
    '--link': `color-mix(in srgb, ${a}, ${light ? 'black 22%' : 'white 30%'})`,
    ...(light
      ? { '--shadow': '0 14px 44px rgba(20, 20, 30, 0.16), 0 2px 8px rgba(20, 20, 30, 0.08)', '--shadow-sm': '0 4px 16px rgba(20, 20, 30, 0.12)', '--ok': '#17a062', '--warn': '#c7860c', '--danger': '#d6404f' }
      : {}),
  };
}

const CUSTOM_KEYS = new Set([...Object.keys(customVars(CUSTOM_DEFAULT)), ...Object.keys(customVars({ ...CUSTOM_DEFAULT, light: true }))]);

// Apply the same theme to the main document and popouts.
export function paint(doc: Document) {
  const root = doc.documentElement;
  const t = theme.value;
  root.setAttribute('data-theme', t.id);
  for (const k of CUSTOM_KEYS) root.style.removeProperty(k);
  if (t.id === 'custom') for (const [k, v] of Object.entries(customVars(t.custom))) root.style.setProperty(k, v);
  if (doc === document) bridge.windowColors({ app: resolve('--bg-app'), island: resolve('--bg-island'), symbol: resolve('--muted') }).catch(() => {});
}

// Native title bars require resolved hex colors.
function resolve(token: string) {
  const el = document.createElement('i');
  el.style.color = `var(${token})`;
  document.documentElement.append(el);
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = getComputedStyle(el).color;
  el.remove();
  return ctx.fillStyle;
}

export function setTheme(patch: Partial<Saved>) {
  const next = { ...theme.value, ...patch };
  const swap = () => {
    theme.value = next;
    paint(document);
  };
  // Switching themes cross-fades; dragging a dial repaints at once.
  if (patch.id && patch.id !== theme.value.id && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(swap);
  else swap();
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}
