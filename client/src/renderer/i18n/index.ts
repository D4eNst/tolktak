// UI strings. Each language is a typed object with the same shape as English, so a
// missing or misspelled string is a compile error. Strings that depend on a number or
// a name are functions. Components read `t()` during render and re-render when the
// language changes.
import { signal } from '@preact/signals';
import en from './en';
import ru from './ru';

export type Messages = typeof en;
export type Locale = 'en' | 'ru';

export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
];
const dicts: Record<Locale, Messages> = { en, ru };
const KEY = 'tolktak.locale';

function initial(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export const locale = signal<Locale>(initial());
document.documentElement.lang = locale.value;

export function setLocale(l: Locale) {
  locale.value = l;
  document.documentElement.lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage unavailable */
  }
}

export const t = (): Messages => dicts[locale.value];

/** BCP 47 tag for Intl and toLocale*String. */
export const intlLocale = () => (locale.value === 'ru' ? 'ru-RU' : 'en-US');

/** Russian plural form: one (1, 21), few (2-4, 22-24), many (5-20, 25…). */
export function ruPlural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
