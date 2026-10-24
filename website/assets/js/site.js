import { ava as avatar, escape, fill, icon, person } from './markup.js';

export { escape, fill, icon };
export const site = JSON.parse(document.getElementById('w-site').textContent);
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const ava = (id, size, cls) => avatar(id, site.lang, size, cls);
export const nameOf = id => person(id, site.lang).name;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const ease = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

// Reading offsetWidth between the class changes makes a one-shot CSS animation play again.
export function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function visible(el, on, off, threshold = 0) {
  const observer = new IntersectionObserver(entries => entries.forEach(e => (e.isIntersecting ? on?.(e) : off?.(e))), { threshold });
  observer.observe(el);
  return observer;
}

// An animation loop that runs only while `el` is on screen and the tab is visible.
export function loop(el, frame) {
  let raf = 0;
  let last = 0;
  let shown = false;
  const tick = now => {
    frame(Math.min(0.05, (now - (last || now)) / 1000), now);
    last = now;
    raf = requestAnimationFrame(tick);
  };
  const start = () => {
    if (raf || !shown || document.hidden || reducedMotion) return;
    last = 0;
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  visible(el, () => { shown = true; start(); }, () => { shown = false; stop(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
}

// Speaking rings pass between members like a conversation.
export function conversation(members, { min, max }) {
  let timer = 0;
  let running = false;
  const step = () => {
    const list = members();
    if (list.length) {
      const pick = list[Math.floor(Math.random() * list.length)];
      list.forEach(el => el !== pick && el.classList.remove('is-speaking'));
      pick.classList.add('is-speaking');
      const duration = min + Math.random() * (max - min);
      setTimeout(() => pick.classList.remove('is-speaking'), duration);
      timer = setTimeout(step, duration * (0.55 + Math.random() * 0.5));
    } else {
      timer = setTimeout(step, 600);
    }
  };
  return {
    start() {
      if (running || reducedMotion) return;
      running = true;
      step();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      members().forEach(el => el.classList.remove('is-speaking'));
    },
  };
}

const header = document.querySelector('.w-top');
const stick = () => header.classList.toggle('is-stuck', scrollY > 8);
addEventListener('scroll', stick, { passive: true });
stick();

// Download buttons point at the download page until the visitor's system is known.
// iPadOS reports itself as a Mac, so a touch screen rules macOS out.
function detectSystem() {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.userAgentData?.platform || navigator.platform || ua).toLowerCase();
  if (/android|iphone|ipad|ipod/.test(ua) || (platform.includes('mac') && navigator.maxTouchPoints > 1)) return null;
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('linux') || platform.includes('x11')) return 'linux';
  return null;
}
export const system = detectSystem();
if (system) {
  const target = site.downloads[system];
  document.querySelectorAll('[data-download]').forEach(a => (a.href = target.href));
  document.querySelectorAll('[data-download-label]').forEach(el => (el.textContent = target.label));
  document.querySelectorAll('[data-download-meta]').forEach(el => (el.textContent = target.meta));
  document.querySelectorAll('[data-os]').forEach(el => el.classList.toggle('is-yours', el.dataset.os === system));
}

// Which of the two macOS builds fits. Chromium reports the processor; other browsers only name
// the GPU, and an Apple GPU means Apple Silicon. When neither says, no build is marked.
async function detectBuild() {
  if (system === 'windows') return 'installer';
  if (system !== 'macos') return null;
  const hints = await navigator.userAgentData?.getHighEntropyValues(['architecture']).catch(() => null);
  if (hints?.architecture) return hints.architecture === 'arm' ? 'appleSilicon' : 'intel';
  const gl = document.createElement('canvas').getContext('webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  if (/intel|amd|radeon|nvidia/i.test(gpu)) return 'intel';
  return /apple/i.test(gpu) ? 'appleSilicon' : null;
}
export const build = document.querySelector('[data-build]') ? detectBuild() : Promise.resolve(null);
build.then(found => found && document.querySelectorAll(`[data-build="${found}"]`).forEach(el => el.classList.add('is-yours')));

// Quick switcher (Ctrl+K), like the app's. Pages may replace the search with their own.
const dialog = document.getElementById('w-switch');
const input = dialog.querySelector('input');
const list = dialog.querySelector('.w-switch-list');
let search = query => site.switch.filter(item => !query || `${item.label} ${item.note}`.toLowerCase().includes(query));
let results = [];
let active = 0;
let opener = null;

export function setSwitcherSearch(fn, placeholder) {
  search = fn;
  if (placeholder) input.placeholder = placeholder;
}

async function render() {
  const query = input.value.trim().toLowerCase();
  results = await search(query);
  active = Math.min(active, Math.max(0, results.length - 1));
  list.innerHTML = results.length
    ? results.map((item, i) => `<a href="${item.href}" id="w-switch-${i}" role="option" tabindex="-1" aria-selected="${i === active}" class="${i === active ? 'is-active' : ''}">${icon(item.icon, 18)}<span>${item.html || escape(item.label)}</span><small>${escape(item.note)}</small></a>`).join('')
    : `<p class="w-switch-empty">${list.dataset.empty}</p>`;
  if (results.length) input.setAttribute('aria-activedescendant', `w-switch-${active}`);
  else input.removeAttribute('aria-activedescendant');
  list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

export function openSwitcher() {
  opener = document.activeElement;
  dialog.hidden = false;
  input.value = '';
  active = 0;
  render();
  input.focus();
}

function closeSwitcher() {
  dialog.hidden = true;
  opener?.focus();
}

function go(item) {
  if (!item) return;
  closeSwitcher();
  location.href = item.href;
}

document.querySelectorAll('[data-switch-open]').forEach(button => button.addEventListener('click', openSwitcher));
input.addEventListener('input', () => { active = 0; render(); });
input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length);
    render();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    go(results[active]);
  } else if (e.key === 'Tab') {
    e.preventDefault();
  }
});
list.addEventListener('click', e => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  go(results[[...list.children].indexOf(link)]);
});
dialog.addEventListener('click', e => e.target === dialog && closeSwitcher());
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    dialog.hidden ? openSwitcher() : closeSwitcher();
  } else if (e.key === 'Escape' && !dialog.hidden) {
    closeSwitcher();
  }
});
