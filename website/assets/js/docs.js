import { site, icon, escape, copyText, openSwitcher, setSwitcherSearch } from './site.js';

const text = site.docs;
const page = document.querySelector('.w-doc-page');
page.classList.add('is-enhanced');

// The theme is chosen in <head> before the first paint; this only reflects and changes it.
const root = document.documentElement;
const themeButtons = [...page.querySelectorAll('[data-theme-choice]')];
const showTheme = () => themeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === root.dataset.theme)));
themeButtons.forEach(button => button.addEventListener('click', () => {
  root.dataset.theme = button.dataset.themeChoice;
  try {
    localStorage.setItem('tolktak-theme', button.dataset.themeChoice);
  } catch {}
  showTheme();
}));
showTheme();

const article = page.querySelector('.w-prose');
for (const code of article.querySelectorAll('pre > code')) {
  const pre = code.parentElement;
  const figure = document.createElement('figure');
  figure.className = 'w-code';
  figure.innerHTML = `<figcaption><span>${escape(code.className.match(/language-(\S+)/)?.[1] || '')}</span><button class="w-code-copy" type="button">${icon('copy', 14)}<span>${text.copy}</span></button></figcaption>`;
  pre.replaceWith(figure);
  figure.append(pre);
  const button = figure.querySelector('button');
  let timer = 0;
  button.addEventListener('click', async () => {
    const copied = await copyText(code.textContent.replace(/\n$/, ''));
    button.classList.toggle('is-done', copied);
    button.innerHTML = `${icon(copied ? 'check' : 'x', 14)}<span>${copied ? text.copied : text.copyFailed}</span>`;
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.classList.remove('is-done');
      button.innerHTML = `${icon('copy', 14)}<span>${text.copy}</span>`;
    }, 1600);
  });
}

const headings = [...article.querySelectorAll('h2[id], h3[id]')];
const tocLinks = [...page.querySelectorAll('.w-doc-toc nav a')];
let line = 0;
let queued = false;
const measure = () => { line = parseFloat(getComputedStyle(root).scrollPaddingTop) + 64; };
function spy() {
  queued = false;
  const atBottom = innerHeight + scrollY >= root.scrollHeight - 4;
  const current = atBottom ? headings.at(-1) : headings.filter(h => h.getBoundingClientRect().top <= line).pop();
  tocLinks.forEach(link => link.toggleAttribute('aria-current', link.getAttribute('href') === `#${current?.id}`));
}
if (headings.length) {
  measure();
  addEventListener('resize', measure);
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(spy);
  }, { passive: true });
  spy();
}
page.querySelector('.w-doc-toc-m')?.addEventListener('click', e => {
  if (e.target.closest('a')) e.currentTarget.open = false;
});

const side = page.querySelector('.w-doc-side');
const scrim = page.querySelector('.w-doc-scrim');
const menu = page.querySelector('[data-doc-open]');
function drawer(open) {
  side.classList.toggle('is-open', open);
  scrim.hidden = !open;
  menu.setAttribute('aria-expanded', String(open));
  if (open) {
    const panel = side.querySelector('.w-doc-side-in');
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
    side.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'center' });
  } else {
    menu.focus();
  }
}
menu.addEventListener('click', () => drawer(true));
page.querySelectorAll('[data-doc-close]').forEach(el => el.addEventListener('click', () => drawer(false)));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && side.classList.contains('is-open')) drawer(false);
});

const groupOf = new Map();
let group = '';
for (const el of page.querySelectorAll('.w-doc-nav > *')) {
  if (el.matches('.w-doc-cap')) group = el.textContent;
  else groupOf.set(el.getAttribute('href'), group);
}
const list = document.querySelector('.w-switch-list');
list.dataset.empty = text.noResults;
let index;
const load = () => (index ??= fetch(text.searchUrl)
  .then(response => (response.ok ? response.json() : Promise.reject()))
  .catch(() => {
    list.dataset.empty = text.error;
    return [];
  }));

// Russian is written both with and without ё, so the search treats it as е.
const fold = text => text.toLowerCase().replaceAll('ё', 'е');

// Matches are found in the raw title and escaped piece by piece, so a match never lands inside
// markup or an entity. Longer words go first so they win over their prefixes.
function highlight(title, words) {
  if (!words.length) return escape(title);
  const pattern = new RegExp([...words].sort((a, b) => b.length - a.length).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('е', '[её]')).join('|'), 'gi');
  let html = '';
  let last = 0;
  for (const match of title.matchAll(pattern)) {
    html += `${escape(title.slice(last, match.index))}<mark>${escape(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return html + escape(title.slice(last));
}

const hint = document.createElement('p');
hint.className = 'w-doc-hint';
hint.textContent = text.hint;
document.querySelector('.w-switch-field').after(hint);

setSwitcherSearch(async query => {
  hint.hidden = Boolean(query);
  const entries = await load();
  const toItem = (entry, words = []) => {
    const isPage = !entry.url.includes('#');
    return { icon: isPage ? 'file' : 'hash', label: entry.title, html: highlight(entry.title, words), note: isPage ? groupOf.get(entry.url) || '' : entry.page, href: entry.url };
  };
  if (!query) return entries.filter(entry => !entry.url.includes('#')).slice(0, 8).map(entry => toItem(entry));
  const words = fold(query).split(/\s+/).filter(Boolean);
  return entries
    .map(entry => {
      const title = fold(entry.title);
      const page = fold(entry.page);
      const text = fold(entry.text);
      if (!words.every(word => `${title} ${page} ${text}`.includes(word))) return null;
      const score = words.reduce((sum, word) => sum
        + (title.startsWith(word) ? 12 : title.includes(word) ? 8 : 0)
        + (page.includes(word) ? 3 : 0)
        + (text.includes(word) ? 1 : 0), entry.url.includes('#') ? 0 : 2);
      return { entry, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ entry }) => toItem(entry, words.filter(word => word.length > 1)));
}, text.placeholder);

document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;
  e.preventDefault();
  openSwitcher();
});
