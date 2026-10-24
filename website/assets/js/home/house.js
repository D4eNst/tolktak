import { people, plan } from '../markup.js';
import { ava, clamp, ease, escape, fill, icon, nameOf, reducedMotion, replay, visible } from '../site.js';

const section = document.getElementById('w-house');
const stage = section.querySelector('.w-house-stage');
const world = stage.querySelector('.w-house-world');
const meEl = stage.querySelector('.w-house-me');
const meShadow = stage.querySelector('.w-house-me-shadow');
const hint = stage.querySelector('.w-house-hint');
const card = stage.querySelector('.w-house-card');
const pop = stage.querySelector('.w-house-pop');
const note = stage.querySelector('.w-house-note');
const noteWhere = stage.querySelector('.w-house-note-where');
const copy = JSON.parse(document.getElementById('w-house-copy').textContent);
const coarse = matchMedia('(pointer: coarse)').matches;
const rand = (a, b) => a + Math.random() * (b - a);

// The world is drawn in CSS 3D: rotateX(55deg) rotateZ(-45deg) around a 360×300 floor plan.
// proj() maps a plan point (x, y) at height z to stage pixels, unproj() goes back at a given height.
const C = Math.SQRT1_2;
const CA = Math.cos((55 * Math.PI) / 180);
const SA = Math.sin((55 * Math.PI) / 180);
const FLOOR = 40;
const STAND = 46;

const ME_SEAT = { lounge: plan.seats.lounge[4], game: plan.seats.game[4] };
const rooms = {
  game: { x: 0, y: 0, w: 160, d: 170, voice: true },
  lounge: { x: 160, y: 0, w: 200, d: 170, voice: true },
  general: { x: 0, y: 170, w: 150, d: 130, seat: [122, 266] },
  shots: { x: 150, y: 170, w: 110, d: 130, seat: [238, 274] },
  links: { x: 260, y: 170, w: 100, d: 130, seat: [340, 274] },
};
const PORCH = [-14, 314];

const tokens = Object.fromEntries([...world.querySelectorAll('.w-house-tok')].map(el => [el.dataset.who, el]));
const tiles = [...world.querySelectorAll('.w-house-tile')];
const roomButtons = Object.fromEntries([...world.querySelectorAll('.w-house-room')].map(el => [el.dataset.room, el]));

let occupancy = { lounge: plan.people.lounge.slice(), game: plan.people.game.slice() };
const seatOf = {};
const tileOf = {};
const isIn = id => tokens[id]?.classList.contains('is-in');

let scale = 1.3;
let origin = { x: 0, y: 0 };
let stageWidth = 0;
let wide = true;
const boxes = new Map();
const measureBox = el => boxes.set(el, [el.offsetWidth, el.offsetHeight]);
let yaw = 0;
let yawVel = 0;
let yawTarget = 0;
let rotating = false;
let raf = 0;
const me = { x: PORCH[0], y: PORCH[1], z: 44 };
let here = null;
let hover = null;
let moved = false;

function fit() {
  const cap = innerWidth > 1000 ? 1.3 : 1.15;
  const hs = clamp((stage.clientWidth - 24) / 590, 0.5, cap);
  if (Math.abs(hs - parseFloat(getComputedStyle(stage).getPropertyValue('--hs'))) > 0.005) stage.style.setProperty('--hs', hs.toFixed(3));
}
function measure() {
  scale = parseFloat(getComputedStyle(stage).getPropertyValue('--hs')) || 1;
  origin = { x: world.offsetLeft, y: world.offsetTop };
  stageWidth = stage.clientWidth;
  wide = innerWidth > 760;
  [hint, card, pop].forEach(measureBox);
}
function proj(x, y, z) {
  const a = (yaw * Math.PI) / 180;
  const dx = x - 180;
  const dy = y - 150;
  const x0 = 180 + dx * Math.cos(a) - dy * Math.sin(a);
  const y0 = 150 + dx * Math.sin(a) + dy * Math.cos(a);
  return [origin.x + scale * C * (x0 + y0), origin.y + scale * (C * (y0 - x0) * CA - z * SA)];
}
function unproj(X, Y, z) {
  const x1 = (X - origin.x) / scale;
  const y1 = ((Y - origin.y) / scale + z * SA) / CA;
  const dx = C * (x1 - y1) - 180;
  const dy = C * (x1 + y1) - 150;
  const a = (yaw * Math.PI) / 180;
  return [180 + dx * Math.cos(a) + dy * Math.sin(a), 150 - dx * Math.sin(a) + dy * Math.cos(a)];
}
function roomAt(x, y) {
  return Object.keys(rooms).find(key => {
    const r = rooms[key];
    return x >= r.x + 4 && x <= r.x + r.w - 4 && y >= r.y + 4 && y <= r.y + r.d - 4;
  }) || null;
}
const onPlinth = (x, y) => x > -36 && x < 376 && y > -16 && y < 336;

function place() {
  for (const key of Object.keys(seatOf)) delete seatOf[key];
  for (const key of Object.keys(tileOf)) delete tileOf[key];
  occupancy.lounge.forEach((id, n) => {
    seatOf[id] = plan.seats.lounge[plan.order.lounge[n]];
    tileOf[id] = plan.order.lounge[n];
  });
  occupancy.game.forEach((id, n) => (seatOf[id] = plan.seats.game[plan.order.game[n]]));
  for (const [id, [x, y]] of Object.entries(seatOf)) {
    tokens[id].style.setProperty('--x', x);
    tokens[id].style.setProperty('--y', y);
  }
}
// The people gathered in the hero take the lounge; the rest go to the game night, Dave first
// because he shares the screen there.
function assign(gathered) {
  if (gathered.length < 3) {
    occupancy = { lounge: plan.people.lounge.slice(), game: plan.people.game.slice() };
  } else {
    const lounge = gathered.slice(0, 5);
    const rest = people.map(p => p.id).filter(id => !lounge.includes(id)).sort((a, b) => (a === 'dima' ? -1 : b === 'dima' ? 1 : 0));
    const game = rest.slice(0, 4);
    rest.slice(4).forEach(id => lounge.length < 5 && lounge.push(id));
    occupancy = { lounge, game };
  }
  place();
}

function setMe(x, y, z) {
  Object.assign(me, { x, y, z });
  for (const el of [meEl, meShadow]) {
    el.style.setProperty('--x', x.toFixed(2));
    el.style.setProperty('--y', y.toFixed(2));
  }
  meEl.style.setProperty('--z', z.toFixed(2));
  const lift = Math.max(0, z - 44);
  meShadow.style.opacity = String(Math.max(0.25, 1 - lift / 60));
  meShadow.style.transform = `translateZ(${roomAt(x, y) ? 40.6 : 40.4}px) scale(${Math.max(0.55, 1 - lift / 90)})`;
  placeOverlays();
}

const popAlign = { general: 0.88, shots: 0.5, links: 0.12 };
function placeAt(el, room, z) {
  if (el.hidden) return;
  const r = rooms[room];
  const [X, Y] = proj(r.x + r.w / 2, r.y + r.d / 2, z);
  const [width, height] = boxes.get(el);
  const a = el === pop ? popAlign[room] ?? 0.5 : 0.5;
  el.style.setProperty('--tx', `${-a * 100}%`);
  el.style.left = `${Math.min(Math.max(X, a * width + 8), stageWidth - (1 - a) * width - 8)}px`;
  el.style.top = `${Math.max(Y, height + 22)}px`;
}
function placeOverlays() {
  if (hover) placeAt(card, hover, rooms[hover].voice ? 150 : 96);
  if (here && !pop.hidden) placeAt(pop, here, 70);
  if (!hint.classList.contains('is-gone') && wide) {
    const [X, Y] = proj(me.x, me.y, me.z);
    const [width, height] = boxes.get(hint);
    const left = X - 30 * scale - width;
    hint.style.left = `${left > -150 ? left : X + 26 * scale}px`;
    hint.style.top = `${Y - 18 * scale - height / 2}px`;
  }
}

const occupants = room => (occupancy[room] || []).filter(isIn).concat(here === room ? ['me'] : []);
const sharer = () => occupancy.game.find(isIn);
function cardHTML(room) {
  if (rooms[room].voice) {
    const ids = occupants(room);
    const sh = sharer();
    const sharing = room === 'game' && sh ? ` · ${fill(copy.sharing, { who: nameOf(sh) })}` : '';
    return `<span class="w-house-card-ico">${icon('speaker', 16)}</span><span><b>${copy.rooms[room]}</b><small>${fill(copy.inRoom, { n: ids.length })}${sharing}</small></span>${ids.length ? `<span class="w-house-avs">${ids.map(id => ava(id, 26)).join('')}</span>` : ''}`;
  }
  return `<span class="w-house-card-ico">${icon('hash', 16)}</span><span><b>${copy.rooms[room]}</b><small>${escape(copy.last[room])}</small></span>`;
}
function showCard(room) {
  if (hover === room) return;
  hover = room;
  Object.values(roomButtons).forEach(b => b.classList.toggle('is-hover', b.dataset.room === room));
  if (!room || (room === here && !pop.hidden)) {
    card.hidden = true;
    return;
  }
  card.innerHTML = cardHTML(room);
  card.hidden = false;
  replay(card, 'is-in');
  measureBox(card);
  placeOverlays();
}

const message = (who, time, text, extra = '') =>
  `<div class="w-house-m">${ava(who, 36)}<div><p class="w-house-m-head"><b>${nameOf(who)}</b><time>${time}</time></p><p>${escape(text)}</p>${extra}</div></div>`;
const popExtras = {
  general: ['', '<p class="w-house-reacts"><span class="w-house-react is-mine">👍 <b>3</b></span></p>'],
  shots: ['<p class="w-house-pop-imgs"><i></i><i></i></p>'],
  links: [''],
};
function popHTML(room) {
  const head = room === 'links'
    ? `${icon('pin', 16)}${copy.pinned} <span>· #${copy.rooms.links}</span>`
    : `${icon('hash', 16)}${copy.rooms[room]} <span>· ${copy.group}</span>`;
  return `<p class="w-house-pop-head">${head}</p>${copy.messages[room].map(([who, time, text], i) => message(who, time, text, popExtras[room][i])).join('')}`;
}

function updateLit() {
  const lit = ['lounge', 'game'].filter(room => occupants(room).length);
  if (here && !rooms[here].voice) lit.push(here);
  world.dataset.lit = lit.join(' ');
  world.dataset.here = here || '';
  const sh = sharer();
  roomButtons.lounge.setAttribute('aria-label', fill(copy.voiceRoom, { name: copy.rooms.lounge, n: occupants('lounge').length }));
  roomButtons.game.setAttribute('aria-label', fill(copy.voiceRoom, { name: copy.rooms.game, n: occupants('game').length }) + (sh ? `, ${fill(copy.sharing, { who: nameOf(sh) })}` : ''));
}
function ripple(x, y) {
  if (reducedMotion) return;
  const el = document.createElement('i');
  el.className = 'w-house-p w-house-ripple';
  el.style.cssText = `--x:${x - 30};--y:${y - 30};--w:60;--d:60;--z:44.6`;
  world.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}
function arrive(room) {
  here = room;
  const voice = room && rooms[room].voice;
  if (voice) ripple(me.x, me.y);
  updateLit();
  hint.classList.add('is-gone');
  note.hidden = !voice;
  if (voice) noteWhere.textContent = `${copy.rooms[room]} · ${copy.group}`;
  pop.hidden = !room || voice;
  if (!pop.hidden) {
    pop.innerHTML = popHTML(room);
    replay(pop, 'is-in');
    measureBox(pop);
  }
  if (hover === room) {
    hover = null;
    card.hidden = true;
  }
  placeOverlays();
  speakNow();
}

let tween = 0;
function moveMe(tx, ty, { hop = 34, duration = 620, tz = 44, then } = {}) {
  cancelAnimationFrame(tween);
  if (reducedMotion) {
    setMe(tx, ty, tz);
    then?.();
    return;
  }
  const { x: sx, y: sy, z: sz } = me;
  const t0 = performance.now();
  const step = now => {
    const t = Math.min(1, (now - t0) / duration);
    const e = ease(t);
    const bounce = t < 1 ? Math.sin(Math.PI * t) * hop : 0;
    setMe(sx + (tx - sx) * e, sy + (ty - sy) * e, sz + (tz - sz) * (1 - Math.pow(1 - t, 3)) + bounce);
    if (t < 1) tween = requestAnimationFrame(step);
    else then?.();
  };
  tween = requestAnimationFrame(step);
}
const seatForMe = room => (rooms[room].voice ? ME_SEAT[room] : rooms[room].seat);
function goTo(room) {
  if (room && room === here) return;
  pop.hidden = true;
  if (here && rooms[here].voice) note.hidden = true;
  here = null;
  updateLit();
  const [tx, ty] = room ? seatForMe(room) : PORCH;
  moveMe(tx, ty, { then: () => arrive(room) });
}

let speaker = null;
let speakTimer = 0;
let shown = false;
function setSpeaking(id) {
  speaker = id;
  for (const [key, el] of Object.entries(tokens)) el.classList.toggle('is-speaking', key === id);
  meEl.classList.toggle('is-speaking', id === 'me');
  const tile = id === 'me' && here === 'lounge' ? 4 : tileOf[id];
  tiles.forEach(el => el.classList.toggle('is-speaking', tile === +el.dataset.seat));
}
// Not conversation() from site.js: a lounge speaker also lights their tile, «You» can speak,
// and the screen sharer gets extra turns.
function speakNow() {
  clearTimeout(speakTimer);
  if (!shown || reducedMotion) return;
  const pool = occupants('lounge');
  const sh = sharer();
  if (here === 'game') pool.push(...(sh ? [sh, sh] : []), 'me');
  else if (sh) pool.push(sh);
  if (!pool.length) {
    setSpeaking(null);
    speakTimer = setTimeout(speakNow, 700);
    return;
  }
  let next = pool[Math.floor(Math.random() * pool.length)];
  if (next === speaker) next = Math.random() < 0.4 ? null : pool[(pool.indexOf(next) + 1) % pool.length];
  setSpeaking(next);
  speakTimer = setTimeout(speakNow, next ? rand(1100, 2300) : rand(500, 900));
}

function frame() {
  if (!rotating) {
    yawVel = (yawVel + (yawTarget - yaw) * 0.075) * 0.8;
    yaw += yawVel;
  }
  world.style.setProperty('--yaw', `${yaw.toFixed(3)}deg`);
  placeOverlays();
  bridge?.onMove();
  raf = rotating || Math.abs(yawVel) > 0.003 || Math.abs(yawTarget - yaw) > 0.01 ? requestAnimationFrame(frame) : 0;
}
const kick = () => {
  if (!raf) raf = requestAnimationFrame(frame);
};

function local(e) {
  const r = stage.getBoundingClientRect();
  const k = r.width / stage.offsetWidth || 1;
  return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
}
let drag = null;
meEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  measure();
  cancelAnimationFrame(tween);
  drag = { id: e.pointerId };
  meEl.setPointerCapture(e.pointerId);
  meEl.classList.add('is-lifted');
  pop.hidden = true;
  hint.classList.add('is-gone');
  if (here && rooms[here].voice) note.hidden = true;
  here = null;
  updateLit();
  const [X, Y] = local(e);
  const [x, y] = unproj(X, Y + 20 * scale, FLOOR + 28);
  moveMe(x, y, { hop: 0, duration: 140, tz: FLOOR + 28 });
});
meEl.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  cancelAnimationFrame(tween);
  const [X, Y] = local(e);
  const [x, y] = unproj(X, Y + 20 * scale, FLOOR + 28);
  setMe(x, y, FLOOR + 28);
  const room = roomAt(x, y);
  Object.values(roomButtons).forEach(b => b.classList.toggle('is-target', b.dataset.room === room));
  showCard(room);
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  meEl.classList.remove('is-lifted');
  Object.values(roomButtons).forEach(b => b.classList.remove('is-target'));
  const room = roomAt(me.x, me.y);
  showCard(null);
  if (room) {
    const [tx, ty] = seatForMe(room);
    moveMe(tx, ty, { hop: 10, duration: 420, then: () => arrive(room) });
  } else if (onPlinth(me.x, me.y)) {
    moveMe(me.x, me.y, { hop: 6, duration: 300, then: () => arrive(null) });
  } else {
    moveMe(PORCH[0], PORCH[1], { hop: 20, duration: 520, then: () => arrive(null) });
  }
}
meEl.addEventListener('pointerup', endDrag);
meEl.addEventListener('pointercancel', endDrag);

let rotation = null;
stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || coarse || reducedMotion || meEl.contains(e.target)) return;
  measure();
  rotation = { id: e.pointerId, x: e.clientX, yaw, on: false };
});
stage.addEventListener('pointermove', e => {
  if (rotation && e.pointerId === rotation.id && e.buttons) {
    const dx = e.clientX - rotation.x;
    if (!rotation.on && Math.abs(dx) > 6) {
      rotation.on = true;
      rotating = true;
      moved = true;
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('is-rotating');
      showCard(null);
    }
    if (rotation.on) {
      yaw = clamp(rotation.yaw + dx * 0.16, -25, 25);
      yawVel = 0;
      kick();
    }
    return;
  }
  if (drag || e.pointerType !== 'mouse') return;
  showCard(e.target.closest('.w-house-room')?.dataset.room || null);
});
function endRotation(e) {
  if (!rotation || e.pointerId !== rotation.id) return;
  if (rotation.on) {
    rotating = false;
    stage.classList.remove('is-rotating');
    kick();
    // The click that ends a rotation must not also move «You».
    setTimeout(() => (moved = false), 0);
  }
  rotation = null;
}
stage.addEventListener('pointerup', endRotation);
stage.addEventListener('pointercancel', endRotation);
stage.addEventListener('pointerleave', e => {
  if (!drag && !rotation && e.pointerType === 'mouse') showCard(null);
});

section.addEventListener('pointermove', e => {
  if (reducedMotion || coarse || rotating || drag || e.pointerType !== 'mouse') return;
  const r = section.getBoundingClientRect();
  yawTarget = ((e.clientX - r.left) / r.width - 0.5) * 9;
  kick();
});
section.addEventListener('pointerleave', () => {
  yawTarget = 0;
  kick();
});

for (const button of Object.values(roomButtons)) {
  button.disabled = false;
  button.addEventListener('click', () => {
    if (moved) return;
    measure();
    showCard(null);
    goTo(button.dataset.room);
  });
  button.addEventListener('focus', () => {
    measure();
    showCard(button.dataset.room);
  });
  button.addEventListener('blur', () => showCard(null));
}

if (coarse) hint.querySelector('.w-house-hint-text').textContent = copy.hintTouch;
function relayout() {
  fit();
  measure();
  placeOverlays();
  bridge?.onMove();
}
new ResizeObserver(relayout).observe(stage);
document.fonts?.ready.then(relayout);

// The hero flies its people into these seats. seat() reuses the stage box that progress() read
// at the start of the same frame, so the flight never forces a layout.
const landed = new Set();
let stageBox = null;
export const bridge = reducedMotion ? null : {
  onMove() {},
  progress() {
    stageBox = stage.getBoundingClientRect();
    const start = innerHeight * 0.96;
    const end = innerHeight * 0.5 - stageBox.height / 2;
    return clamp((start - stageBox.top) / Math.max(1, start - end), 0, 1);
  },
  seat(id) {
    const p = seatOf[id];
    if (!p || !stageBox) return null;
    const [X, Y] = proj(p[0], p[1], STAND);
    return { x: stageBox.left + X, y: stageBox.top + Y - 15 * scale, d: 30 * scale };
  },
  start(gathered) {
    fit();
    measure();
    assign(gathered);
    Object.values(tokens).forEach(el => el.classList.remove('is-in', 'is-speaking'));
    landed.clear();
    updateLit();
    return occupancy.lounge.concat(occupancy.game);
  },
  end() {
    Object.values(tokens).forEach(el => el.classList.remove('is-in'));
    landed.clear();
    updateLit();
  },
  land(id) {
    if (!tokens[id] || landed.has(id)) return;
    landed.add(id);
    tokens[id].classList.add('is-in');
    if (seatOf[id]) ripple(...seatOf[id]);
    updateLit();
    if (shown && !speakTimer) speakNow();
  },
  unland(id) {
    if (!tokens[id]) return;
    landed.delete(id);
    tokens[id].classList.remove('is-in', 'is-speaking');
    updateLit();
  },
};

fit();
measure();
place();
if (bridge) Object.values(tokens).forEach(el => el.classList.remove('is-in', 'is-speaking'));
setMe(me.x, me.y, me.z);
updateLit();
if (reducedMotion) {
  setSpeaking('alisa');
} else {
  visible(stage, () => {
    shown = true;
    speakNow();
  }, () => {
    shown = false;
    clearTimeout(speakTimer);
    speakTimer = 0;
  });
}
