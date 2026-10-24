import { site, system, build, reducedMotion, visible, conversation, copyText } from './site.js';

const root = document.querySelector('.w-dl');
const { builds, alternative, hint, text } = site;
const $ = selector => root.querySelector(selector);
const $$ = selector => [...root.querySelectorAll(selector)];

// site.js has pointed the main button at the visitor's build; the second build of the
// same system becomes the alternative next to it.
const primary = $('[data-dl-primary]');
const alt = $('[data-dl-alt]');
let current = builds.windows[0];
if (system) {
  const [main, second] = builds[system];
  current = main;
  if (second) {
    alt.href = second.href;
    alt.textContent = alternative[system];
    alt.hidden = false;
  }
  if (hint[system]) {
    const note = $('[data-dl-hint]');
    note.textContent = hint[system];
    note.hidden = false;
  }
}
// An Intel Mac gets its build on the main button and Apple Silicon as the alternative.
build.then(found => {
  if (found !== 'intel') return;
  builds.macos.reverse();
  const [main, second] = builds.macos;
  current = main;
  primary.href = main.href;
  $('[data-download-meta]').textContent = main.meta;
  alt.href = second.href;
  alt.textContent = alternative.intel;
});

const toast = $('.w-dl-toast');
let toastTimer = 0;
function say(message) {
  toast.textContent = message;
  toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-on'), 1800);
}
root.addEventListener('click', async e => {
  const button = e.target.closest('.w-dl-sha');
  if (!button) return;
  if (!(await copyText(button.dataset.sha))) return say(text.copyFailed);
  button.classList.add('is-copied');
  setTimeout(() => button.classList.remove('is-copied'), 1600);
  say(text.copied);
});

const path = $('.w-dl-path');
const win = $('.w-dl-win');
const steps = $$('.w-dl-step');
const captions = $$('.w-dl-path-cap [data-cap]');
const fileName = $('[data-dl-file]');
const done = $('[data-dl-done]');
const signIn = $('[data-dl-signin]');
let run = 0;
path.classList.add('is-live');

const tiles = $$('.w-dl-tile .w-ava');
const talk = conversation(() => (win.classList.contains('is-in') ? tiles : []), { min: 1100, max: 2900 });
const sidebar = new Map(tiles.map(tile => [tile, $(`.w-dl-side-people [data-who="${tile.dataset.who}"]`)]));
new MutationObserver(() => sidebar.forEach((entry, tile) => entry.classList.toggle('is-speaking', tile.classList.contains('is-speaking'))))
  .observe($('.w-dl-tiles'), { subtree: true, attributeFilter: ['class'] });

function setStep(n, finished) {
  win.dataset.scene = n;
  steps.forEach((step, i) => {
    step.classList.toggle('is-on', i + 1 === n);
    step.classList.toggle('is-done', i + 1 < n || (finished && i + 1 === n));
    step.setAttribute('aria-current', i + 1 === n ? 'step' : 'false');
  });
  captions.forEach(caption => caption.classList.toggle('is-on', +caption.dataset.cap === n));
  path.style.setProperty('--dl-track', finished ? '100%' : `${((n - 1) / 3) * 100 + 16}%`);
}

const cancelled = () => new Error('cancelled');
const wait = (ms, id) => new Promise((resolve, reject) => setTimeout(() => (id === run ? resolve() : reject(cancelled())), ms));
const animate = (duration, id, step) => new Promise((resolve, reject) => {
  const start = performance.now();
  const tick = now => {
    if (id !== run) return reject(cancelled());
    const progress = Math.min(1, (now - start) / duration);
    step(progress);
    progress < 1 ? requestAnimationFrame(tick) : resolve();
  };
  requestAnimationFrame(tick);
});

const fields = scene => $$(`.w-dl-s${scene} [data-type]`);
function fill(scene, full) {
  fields(scene).forEach(field => {
    field.dataset.shown = full ? field.dataset.type : '';
    field.classList.remove('is-typing');
  });
}
async function type(field, id, speed) {
  field.classList.add('is-typing');
  const value = field.dataset.type;
  for (let i = 1; i <= value.length; i++) {
    field.dataset.shown = value.slice(0, i);
    await wait(speed + Math.random() * 40, id);
  }
  field.classList.remove('is-typing');
}
async function press(scene, id) {
  const button = $(`[data-dl-press="${scene}"]`);
  button.classList.add('is-pressed');
  await wait(170, id);
  button.classList.remove('is-pressed');
}

function showDownloaded(full) {
  fileName.textContent = current.name;
  path.style.setProperty('--dl-p', full ? '100%' : '0%');
  path.style.setProperty('--dl-ok', full ? '1' : '0');
  done.textContent = full ? current.size : `0 ${text.of} ${current.size}`;
}
function showRoom(inside) {
  win.classList.toggle('is-in', inside);
  path.style.setProperty('--dl-me', inside ? '1' : '0');
  signIn.textContent = text.signIn;
}

const megabytes = new Intl.NumberFormat(site.lang === 'ru' ? 'ru-RU' : 'en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

async function downloadScene(id) {
  setStep(1);
  showDownloaded(false);
  await wait(380, id);
  await animate(1700, id, progress => {
    const eased = 1 - Math.pow(1 - progress, 2.2);
    path.style.setProperty('--dl-p', `${eased * 100}%`);
    done.textContent = `${megabytes.format((eased * current.bytes) / 1048576)} ${text.of} ${current.size}`;
  });
  showDownloaded(true);
  await wait(1100, id);
}
async function accountScene(id) {
  setStep(2);
  fill(2, false);
  await wait(520, id);
  for (const field of fields(2)) await type(field, id, field.dataset.type.startsWith('•') ? 38 : 70);
  await wait(240, id);
  await press(2, id);
  await wait(620, id);
}
async function signInScene(id) {
  setStep(3);
  showRoom(false);
  fill(3, false);
  await wait(520, id);
  for (const field of fields(3)) await type(field, id, field.dataset.type.startsWith('•') ? 36 : 58);
  await wait(220, id);
  await press(3, id);
  signIn.textContent = text.signingIn;
  await wait(720, id);
  showRoom(true);
  setStep(3, true);
  talk.start();
}

async function play(from = 1) {
  const id = ++run;
  talk.stop();
  if (reducedMotion) {
    fill(2, true);
    fill(3, true);
    showDownloaded(true);
    showRoom(from === 3);
    setStep(from, true);
    if (from === 3) talk.start();
    return;
  }
  try {
    if (from === 1) await downloadScene(id);
    else showDownloaded(true);
    if (from <= 2) await accountScene(id);
    else fill(2, true);
    await signInScene(id);
  } catch {
    // A newer run took over.
  }
}

steps.forEach(step => {
  step.disabled = false;
  step.addEventListener('click', () => play(+step.dataset.step));
});
primary.addEventListener('click', () => {
  if (!system) return;
  current = builds[system][0];
  play(1);
});
alt.addEventListener('click', () => {
  current = builds[system][1];
  play(1);
});

showDownloaded(true);
let played = false;
visible(win, () => {
  if (!played) {
    played = true;
    play(reducedMotion ? 3 : 1);
  } else {
    talk.start();
  }
}, () => talk.stop());
