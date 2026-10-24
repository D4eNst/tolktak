import { clamp, loop, reducedMotion, visible } from '../site.js';

const section = document.getElementById('w-sound');
const copy = JSON.parse(document.getElementById('w-sound-copy').textContent);
const $ = selector => section.querySelector(selector);
const $$ = selector => [...section.querySelectorAll(selector)];
const field = $('[data-field]');
const voiceAvatar = $('.w-sound-voice');
const levelBar = $('[data-level]');
const segments = $('[data-seg]');
const radios = $$('[data-seg] input');
const thumb = $('.w-sound-thumb');
const springOut = t => 1 - Math.pow(1 - t, 3) * Math.cos(t * 4.2);

let touched = false;
let demo = [];
function noteTouch() {
  touched = true;
  demo.forEach(clearTimeout);
}

let width = 0;
let height = 0;
const measure = () => ({ width, height } = field.getBoundingClientRect());
measure();
const words = $$('.w-sound-word').map((el, i) => {
  const hx = parseFloat(el.style.left) / 100;
  const hy = parseFloat(el.style.top) / 100;
  return { el, step: +el.dataset.step, loud: +el.dataset.loud, hx, hy, x: hx * width, y: hy * height, vx: 0, vy: 0, half: 0, rot: ((i * 37) % 17) - 8, phase: i * 1.7, scale: 1, alpha: 1, out: false, anim: null };
});
const measureWords = () => words.forEach(word => (word.half = word.el.offsetWidth / 2 + 8));
measureWords();
document.fonts.ready.then(measureWords);
const render = word => {
  word.el.style.transform = `translate(${word.x.toFixed(1)}px, ${word.y.toFixed(1)}px) translate(-50%, -50%) rotate(${word.rot.toFixed(1)}deg) scale(${word.scale.toFixed(3)})`;
  word.el.style.opacity = word.alpha.toFixed(3);
};
if (!reducedMotion) {
  field.classList.add('is-live');
  words.forEach(render);
}

let pointer = null;
const local = e => {
  const box = field.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
};
field.addEventListener('pointermove', e => (pointer = local(e)));
field.addEventListener('pointerleave', () => (pointer = null));
field.addEventListener('pointerdown', e => {
  noteTouch();
  const p = local(e);
  for (const word of words) {
    const dx = word.x - p.x;
    const dy = word.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < 150) {
      word.vx += (dx / d) * (150 - d) * 6;
      word.vy += (dy / d) * (150 - d) * 6;
    }
  }
});

let level = 0;
function placeThumb(step, instant) {
  const box = segments.getBoundingClientRect();
  const option = radios[step].parentElement.getBoundingClientRect();
  if (instant) thumb.style.transition = 'none';
  thumb.style.width = option.width + 'px';
  thumb.style.transform = `translate(${option.left - box.left - 4}px, ${option.top - box.top - 4}px)`;
  if (instant) requestAnimationFrame(() => (thumb.style.transition = ''));
}
segments.classList.add('is-live');
placeThumb(0, true);
let gulp = 0;
function swallow() {
  thumb.classList.add('is-gulp');
  clearTimeout(gulp);
  gulp = setTimeout(() => thumb.classList.remove('is-gulp'), 160);
}

function setLevel(step) {
  level = step;
  radios[step].checked = true;
  placeThumb(step);
  $('[data-field-hint]').classList.toggle('is-off', step !== 0);
  const fieldBox = field.getBoundingClientRect();
  const option = radios[step].parentElement.getBoundingClientRect();
  const target = { x: option.left + option.width / 2 - fieldBox.left, y: option.top + option.height / 2 - fieldBox.top };
  words.forEach((word, i) => {
    const gone = word.step <= step;
    if (gone && !word.out) {
      word.out = true;
      if (reducedMotion) word.el.classList.add('is-out');
      else word.anim = { kind: 'suck', t: -i * 0.06, x0: word.x, y0: word.y, tx: target.x + (Math.random() - 0.5) * 24, ty: target.y, bend: (word.x < target.x ? -1 : 1) * 40 };
    } else if (!gone && word.out) {
      word.out = false;
      word.el.classList.remove('is-out');
      if (reducedMotion) return;
      const side = Math.random() < 0.5 ? -40 : width + 40;
      Object.assign(word, { x: side, y: word.hy * height, vx: side < 0 ? 380 : -380, vy: 0, scale: 0.6, alpha: 0, anim: { kind: 'back', t: -i * 0.05 } });
    }
  });
}
radios.forEach((radio, step) => radio.addEventListener('change', () => {
  noteTouch();
  setLevel(step);
}));

let hearing = false;
const hearButton = $('[data-hear]');
const hearNow = $('.w-sound-now');
const hearLater = $('.w-sound-later');
hearButton.addEventListener('click', () => {
  noteTouch();
  hearing = !hearing;
  hearButton.setAttribute('aria-pressed', String(hearing));
  $('[data-hear-label]').textContent = hearing ? copy.stop : copy.hear;
  $('.w-sound-delay').classList.toggle('is-on', hearing);
  if (!hearing) [hearNow, hearLater].forEach(el => el.classList.remove('is-speaking'));
});

const echoBox = $('[data-echo]');
const echo = $('[data-opt="echo"]');
const levelling = $('[data-opt="agc"]');
const showEcho = () => echoBox.classList.toggle('is-on', echo.checked);
showEcho();
echo.addEventListener('change', () => {
  noteTouch();
  showEcho();
});
echoBox.querySelector('i').addEventListener('animationiteration', () => {
  if (echo.checked) return;
  echoBox.classList.add('is-hit');
  setTimeout(() => echoBox.classList.remove('is-hit'), 260);
});
const bars = $$('[data-bars] i');
const raw = bars.map((_, i) => 0.25 + ((i * 53) % 10) / 12);
function paintBars() {
  bars.forEach((bar, i) => {
    const v = levelling.checked ? 0.56 + (raw[i] - 0.56) * 0.22 : raw[i];
    bar.style.transform = `scaleY(${clamp(v, 0.08, 1).toFixed(3)})`;
  });
}
paintBars();
levelling.addEventListener('change', () => {
  noteTouch();
  paintBars();
});

const key = $('[data-ptt]');
key.disabled = false;
const pttAvatar = $('.w-sound-ptt-you');
let held = false;
let release = 0;
function press(on) {
  if (on === held) return;
  held = on;
  key.setAttribute('aria-pressed', String(on));
  clearTimeout(release);
  if (on) pttAvatar.classList.add('is-speaking');
  else release = setTimeout(() => pttAvatar.classList.remove('is-speaking'), 200);
}
key.addEventListener('pointerdown', e => {
  noteTouch();
  e.preventDefault();
  key.setPointerCapture(e.pointerId);
  press(true);
});
['pointerup', 'pointercancel', 'lostpointercapture', 'blur'].forEach(type => key.addEventListener(type, () => press(false)));
key.addEventListener('keydown', e => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  e.preventDefault();
  noteTouch();
  press(true);
});
key.addEventListener('keyup', e => (e.key === ' ' || e.key === 'Enter') && press(false));
let inView = false;
const typing = e => /^(input|textarea|select)$/i.test(e.target.tagName) && !['radio', 'checkbox'].includes(e.target.type);
document.addEventListener('keydown', e => {
  if (e.code !== 'KeyV' || e.repeat || !inView || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  noteTouch();
  press(true);
});
document.addEventListener('keyup', e => e.code === 'KeyV' && press(false));

let time = 0;
let speaking = false;
let nextFlip = 0.6;
let voice = 0;
let barClock = 0;
let syllable = 0;
const voiceTrail = [];
loop(section, dt => {
  time += dt;
  if (!width) measure();
  nextFlip -= dt;
  if (nextFlip <= 0) {
    speaking = !speaking;
    nextFlip = speaking ? 0.6 + Math.random() * 1.3 : 0.4 + Math.random() * 1.2;
  }
  const envelope = speaking ? 0.55 + 0.45 * Math.abs(Math.sin(time * 11.5 + Math.sin(time * 3.1))) : 0;
  voice += (envelope - voice) * Math.min(1, dt * 18);
  const loud = voice > 0.25;
  const noise = words.reduce((sum, word) => sum + (word.out ? 0 : word.loud), 0);
  const floor = noise * 0.06 * (0.8 + 0.35 * Math.sin(time * 13.7) * Math.sin(time * 5.3));
  levelBar.style.transform = `scaleX(${clamp(voice * 0.72 + floor, 0.03, 1).toFixed(3)})`;
  voiceAvatar.classList.toggle('is-speaking', loud);

  voiceTrail.push([time, loud]);
  while (voiceTrail[0][0] < time - 1) voiceTrail.shift();
  if (hearing) {
    hearNow.classList.toggle('is-speaking', loud);
    hearLater.classList.toggle('is-speaking', !!voiceTrail.find(([t]) => t >= time - 0.5)?.[1]);
  }

  barClock += dt;
  if (barClock > 0.13) {
    barClock = 0;
    syllable += 1;
    const loudPhrase = Math.floor(syllable / 7) % 2 === 0;
    raw.shift();
    raw.push(speaking ? (loudPhrase ? 0.75 + Math.random() * 0.25 : 0.14 + Math.random() * 0.16) : 0.06);
    paintBars();
  }

  const cx = width / 2;
  const cy = height / 2;
  for (const word of words) {
    if (word.anim?.kind === 'suck') {
      const a = word.anim;
      a.t += dt;
      const p = clamp(a.t / 0.9, 0, 1);
      const e = p * p * (3 - 2 * p);
      word.x = a.x0 + (a.tx - a.x0) * e + Math.sin(p * Math.PI) * a.bend;
      word.y = a.y0 + (a.ty - a.y0) * e - Math.sin(p * Math.PI) * 30;
      word.scale = p < 0.45 ? 1 : 1 - 0.85 * ((p - 0.45) / 0.55);
      word.alpha = p < 0.8 ? 1 : 1 - (p - 0.8) / 0.2;
      render(word);
      if (p >= 1) {
        Object.assign(word, { anim: null, vx: 0, vy: 0 });
        word.el.classList.add('is-out');
        swallow();
      }
      continue;
    }
    if (word.out) continue;
    if (word.anim?.kind === 'back') {
      word.anim.t += dt;
      const p = clamp(word.anim.t / 0.5, 0, 1);
      word.scale = 0.6 + 0.4 * springOut(p);
      word.alpha = p;
      if (p >= 1) word.anim = null;
    }
    let ax = (word.hx * width - word.x) * 1.4 + Math.sin(time * 0.8 + word.phase) * 14;
    let ay = (word.hy * height - word.y) * 1.4 + Math.cos(time * 0.95 + word.phase * 1.3) * 12;
    if (pointer) {
      const dx = word.x - pointer.x;
      const dy = word.y - pointer.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 110) {
        ax += (dx / d) * ((110 - d) / 110) * 2600;
        ay += (dy / d) * ((110 - d) / 110) * 2600;
      }
    }
    const ex = (word.x - cx) / (92 + word.half);
    const ey = (word.y - cy) / 84;
    const ed = Math.hypot(ex, ey);
    if (ed < 1) {
      ax += (ex / (ed || 1)) * (1 - ed) * 2400;
      ay += (ey / (ed || 1)) * (1 - ed) * 2400;
    }
    for (const other of words) {
      if (other === word || other.out) continue;
      const dx = word.x - other.x;
      const dy = word.y - other.y;
      const overlapX = word.half + other.half - Math.abs(dx);
      const overlapY = 30 - Math.abs(dy);
      if (overlapX > 0 && overlapY > 0) {
        if (overlapX < overlapY * 2.2) ax += Math.sign(dx || 1) * overlapX * 30;
        else ay += Math.sign(dy || 1) * overlapY * 30;
      }
    }
    word.vx = (word.vx + ax * dt) * Math.pow(0.9, dt * 60);
    word.vy = (word.vy + ay * dt) * Math.pow(0.9, dt * 60);
    word.x = clamp(word.x + word.vx * dt, word.half - 4, width - word.half + 4);
    word.y = clamp(word.y + word.vy * dt, 16, height - 16);
    word.rot += (((word.phase * 37) % 17) - 8 + Math.sin(time * 9 + word.phase) * word.loud * 2.2 - word.rot) * Math.min(1, dt * 6);
    render(word);
  }
});
addEventListener('resize', () => {
  measure();
  measureWords();
  placeThumb(level, true);
});

let played = false;
visible(section, () => {
  inView = true;
  if (played || touched || reducedMotion) return;
  played = true;
  demo = [
    [1500, () => setLevel(1)],
    [2900, () => setLevel(2)],
    [4300, () => setLevel(3)],
    [5200, () => press(true)],
    [6500, () => press(false)],
    [8400, () => setLevel(0)],
  ].map(([ms, step]) => setTimeout(() => !touched && step(), ms));
}, () => {
  inView = false;
  press(false);
}, 0.35);
