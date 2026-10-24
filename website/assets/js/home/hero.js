import { clamp, conversation, ease, fill, reducedMotion, visible } from '../site.js';
import { bridge } from './house.js';

const hero = document.getElementById('w-hero');
const stage = hero.querySelector('.w-hero-stage');
const play = hero.querySelector('.w-hero-play');
const copyBlock = hero.querySelector('.w-hero-copy');
const youEl = hero.querySelector('.w-hero-you');
const roomEl = hero.querySelector('.w-hero-room');
const roomHead = hero.querySelector('.w-hero-room-head');
const roomCount = hero.querySelector('.w-hero-room-count');
const roomIcon = hero.querySelector('.w-hero-room-ico');
const gatherButton = hero.querySelector('.w-hero-gather');
const gatherLabel = hero.querySelector('.w-hero-gather-label');
const text = JSON.parse(document.getElementById('w-hero-copy').textContent);

const elements = [...play.querySelectorAll('.w-hero-av')];
play.classList.add('is-live');
elements.forEach((el, i) => el.style.setProperty('--i', i));

// Physics runs in playground pixels; one step is one 60 Hz frame (dt = 1).
const GAP = 24;
let width = 0;
let height = 0;
let headWidth = 0;
let compact = false;
let obstacle = null;
let area = null;
const bodies = elements.map((el, i) => ({
  el, i, id: el.dataset.who, r: 30, x: 0, y: 0, vx: 0, vy: 0,
  hx: +el.dataset.hx, hy: +el.dataset.hy, px: 0, py: 0, phase: Math.random() * Math.PI * 2,
  grab: false, on: true, pulled: false, landed: false,
}));
const byId = Object.fromEntries(bodies.map(b => [b.id, b]));
const you = { x: 0, y: 0, tx: 0, ty: 0, r: 28, on: false, all: false, source: '' };
const room = { x: 0, y: 0, w: 0, h: 0, on: false, until: 0 };
let members = [];
let lastGathered = [];
let user = false;
let heroShown = true;
let drag = null;
let demo = null;
let demoTimer = 0;
let placed = false;

const talk = conversation(() => members.map(b => b.el), { min: 650, max: 1900 });

function measure() {
  const pr = play.getBoundingClientRect();
  width = pr.width;
  height = pr.height;
  headWidth = roomHead.offsetWidth;
  const wasCompact = compact;
  compact = getComputedStyle(stage).position !== 'static';
  if (compact) {
    obstacle = null;
    area = { x: 44, y: 34, w: width - 88, h: height - 110 };
  } else {
    const cr = copyBlock.getBoundingClientRect();
    obstacle = { x: cr.left - pr.left - 36, y: cr.top - pr.top - 36, w: cr.width + 72, h: cr.height + 72 };
    const left = obstacle.x + obstacle.w + 70;
    area = { x: left, y: 70, w: Math.max(200, width - left - 90), h: Math.max(200, height - 70 - 150) };
  }
  for (const b of bodies) {
    b.on = getComputedStyle(b.el).display !== 'none';
    b.r = b.el.offsetWidth / 2;
    b.px = area.x + b.hx * area.w;
    b.py = area.y + b.hy * area.h;
    // The other layout's positions may sit under the headline.
    if (!placed || compact !== wasCompact) {
      b.x = b.px;
      b.y = b.py;
    }
  }
  placed = true;
}

function local(e) {
  const pr = play.getBoundingClientRect();
  return { x: e.clientX - pr.left, y: e.clientY - pr.top };
}
const overCopy = p => obstacle && p.x > obstacle.x + 24 && p.x < obstacle.x + obstacle.w - 24 && p.y > obstacle.y + 24 && p.y < obstacle.y + obstacle.h - 24;

function setYou(on, p, source) {
  if (on) {
    if (!you.on) {
      you.x = p.x;
      you.y = p.y;
    }
    you.tx = p.x;
    you.ty = p.y;
    you.source = source;
  }
  you.on = on;
  youEl.classList.toggle('is-on', on);
}

function takeOver() {
  if (user) return;
  user = true;
  clearTimeout(demoTimer);
  if (demo) {
    demo = null;
    setYou(false);
  }
}

function setGatherAll(on) {
  you.all = on;
  gatherButton.setAttribute('aria-pressed', String(on));
  gatherLabel.textContent = on ? text.release : text.gather;
  if (on) setYou(true, { x: area.x + area.w * 0.45, y: area.y + area.h * 0.52 }, 'all');
  else if (you.source === 'all') setYou(false);
  kick();
}

function step(dt, now) {
  if (demo) runDemo(now);
  if (you.on) {
    const k = 1 - Math.pow(0.62, dt);
    you.x += (you.tx - you.x) * k;
    you.y += (you.ty - you.y) * k;
  }
  const t = now / 1000;
  for (const b of bodies) {
    if (!b.on || b.grab) continue;
    let ax = 0;
    let ay = 0;
    let pulled = false;
    if (you.on) {
      const dx = you.x - b.x;
      const dy = you.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const reach = you.all ? 1 : clamp(1 - (d - 140) / 170, 0, 1);
      const rest = you.r + b.r + GAP;
      if (reach > 0.02) {
        pulled = reach > 0.3;
        if (d > rest) {
          const f = Math.min(0.6, (d - rest) * 0.013) * reach;
          ax += (dx / d) * f;
          ay += (dy / d) * f;
        }
      }
    }
    if (!pulled) {
      const hx = b.px + Math.sin(t * 0.55 + b.phase) * 12;
      const hy = b.py + Math.cos(t * 0.47 + b.phase * 1.7) * 9;
      ax += (hx - b.x) * 0.0055;
      ay += (hy - b.y) * 0.0055;
    }
    b.pulled = pulled;
    b.vx += ax * dt;
    b.vy += ay * dt;
    const damp = Math.pow(pulled ? 0.83 : 0.9, dt);
    b.vx *= damp;
    b.vy *= damp;
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > 36) {
      b.vx *= 36 / speed;
      b.vy *= 36 / speed;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }
  for (let iteration = 0; iteration < 4; iteration++) {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!a.on) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (b.on) collide(a, b);
      }
      if (a.grab) continue;
      if (you.on) keepAwayFromYou(a);
      if (obstacle) pushOut(a, obstacle);
      if (room.on && !members.includes(a)) pushOut(a, { x: room.x + 6, y: room.y + 6, w: room.w - 12, h: room.h - 12 });
      bounds(a);
    }
  }
  updateRoom(dt);
}

function collide(a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const min = a.r + b.r + GAP;
  if (d >= min) return;
  if (d < 0.01) {
    dx = 1;
    dy = 0;
    d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  const overlap = min - d;
  const ma = a.r * a.r;
  const mb = b.r * b.r;
  const wa = a.grab ? 0 : b.grab ? 1 : mb / (ma + mb);
  const wb = b.grab ? 0 : a.grab ? 1 : ma / (ma + mb);
  a.x -= nx * overlap * wa;
  a.y -= ny * overlap * wa;
  b.x += nx * overlap * wb;
  b.y += ny * overlap * wb;
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) {
    const impulse = -1.4 * rv;
    a.vx -= impulse * nx * wa;
    a.vy -= impulse * ny * wa;
    b.vx += impulse * nx * wb;
    b.vy += impulse * ny * wb;
  }
}

function keepAwayFromYou(b) {
  const dx = b.x - you.x;
  const dy = b.y - you.y;
  const d = Math.hypot(dx, dy) || 1;
  const min = you.r + b.r + GAP;
  if (d >= min) return;
  b.x = you.x + (dx / d) * min;
  b.y = you.y + (dy / d) * min;
  const vn = b.vx * (dx / d) + b.vy * (dy / d);
  if (vn < 0) {
    b.vx -= vn * (dx / d);
    b.vy -= vn * (dy / d);
  }
}

function pushOut(b, box) {
  const cx = clamp(b.x, box.x, box.x + box.w);
  const cy = clamp(b.y, box.y, box.y + box.h);
  const dx = b.x - cx;
  const dy = b.y - cy;
  const d = Math.hypot(dx, dy);
  if (d === 0) {
    const gaps = [b.x - box.x, box.x + box.w - b.x, b.y - box.y, box.y + box.h - b.y];
    const nearest = Math.min(...gaps);
    if (nearest === gaps[1]) b.x = box.x + box.w + b.r;
    else if (nearest === gaps[0]) b.x = box.x - b.r;
    else if (nearest === gaps[2]) b.y = box.y - b.r;
    else b.y = box.y + box.h + b.r;
    return;
  }
  if (d < b.r) {
    const nx = dx / d;
    const ny = dy / d;
    b.x = cx + nx * b.r;
    b.y = cy + ny * b.r;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      b.vx -= 1.5 * vn * nx;
      b.vy -= 1.5 * vn * ny;
    }
  }
}

function bounds(b) {
  const side = 8;
  const top = compact ? 30 : 16;
  const bottom = compact ? 58 : 96;
  if (b.x < b.r + side) {
    b.x = b.r + side;
    b.vx = Math.abs(b.vx) * 0.5;
  } else if (b.x > width - b.r - side) {
    b.x = width - b.r - side;
    b.vx = -Math.abs(b.vx) * 0.5;
  }
  if (b.y < b.r + top) {
    b.y = b.r + top;
    b.vy = Math.abs(b.vy) * 0.5;
  } else if (b.y > height - b.r - bottom) {
    b.y = height - b.r - bottom;
    b.vy = -Math.abs(b.vy) * 0.5;
  }
}

function updateRoom(dt) {
  const near = [];
  if (you.on) {
    const pool = bodies.filter(b => b.on && !b.grab && b.pulled);
    for (const b of pool) if (Math.hypot(b.x - you.x, b.y - you.y) < you.r + b.r + GAP + 34) near.push(b);
    for (let i = 0; i < near.length; i++) {
      for (const b of pool) if (!near.includes(b) && Math.hypot(b.x - near[i].x, b.y - near[i].y) < near[i].r + b.r + GAP + 30) near.push(b);
    }
    near.sort((a, b) => a.i - b.i);
  }
  const active = near.length >= 3;
  if (near.length !== members.length || near.some((b, i) => members[i] !== b)) {
    members.forEach(b => b.el.classList.remove('is-near'));
    members = near;
    members.forEach(b => b.el.classList.add('is-near'));
    if (active) {
      roomCount.textContent = fill(text.inRoom, { n: members.length + 1 });
      headWidth = 0;
      lastGathered = members.map(b => b.id);
    }
  }
  if (active) {
    let x0 = you.x - you.r;
    let y0 = you.y - you.r;
    let x1 = you.x + you.r;
    let y1 = you.y + you.r;
    for (const b of members) {
      x0 = Math.min(x0, b.x - b.r);
      y0 = Math.min(y0, b.y - b.r);
      x1 = Math.max(x1, b.x + b.r);
      y1 = Math.max(y1, b.y + b.r + 22);
    }
    const pad = 26;
    let tx = x0 - pad;
    let ty = y0 - pad - 8;
    let tw = x1 - x0 + pad * 2;
    let th = y1 - y0 + pad * 2 + 8;
    if (compact) {
      tx = Math.max(6, tx);
      ty = Math.max(20, ty);
      tw = Math.min(width - 6 - tx, tw);
      th = Math.min(height - 6 - ty, th);
    }
    const k = room.on ? 1 - Math.pow(0.8, dt) : 1;
    room.x += (tx - room.x) * k;
    room.y += (ty - room.y) * k;
    room.w += (tw - room.w) * k;
    room.h += (th - room.h) * k;
  }
  if (active !== room.on) setRoom(active);
}
function setRoom(on) {
  room.on = on;
  room.until = on ? Infinity : performance.now() + 450;
  roomEl.classList.toggle('is-on', on);
  roomHead.classList.toggle('is-on', on);
  if (on) talk.start();
  else talk.stop();
}

let progress = 0;
let frozen = false;
let order = [];
const DELAY = 0.055;
const SPAN = 0.5;
function flightOf(b) {
  const n = order.indexOf(b.id);
  return n < 0 ? 0 : ease(clamp((progress - n * DELAY) / SPAN, 0, 1));
}
function freeze() {
  frozen = true;
  hero.classList.add('is-leaving');
  clearTimeout(demoTimer);
  demo = null;
  if (you.all) setGatherAll(false);
  setYou(false);
  if (drag) {
    drag.b.grab = false;
    drag.b.el.classList.remove('is-grab');
    drag = null;
  }
  const gathered = room.on ? members.map(b => b.id) : lastGathered;
  setRoom(false);
  members.forEach(b => b.el.classList.remove('is-near'));
  members = [];
  for (const b of bodies) {
    b.vx = 0;
    b.vy = 0;
    b.el.classList.remove('is-speaking');
  }
  const flying = id => byId[id]?.on;
  order = bridge.start(gathered.filter(flying)).filter(flying);
}
function unfreeze() {
  frozen = false;
  hero.classList.remove('is-leaving');
  bridge.end();
  if (!user) scheduleDemo(2600);
}

function render() {
  const playRect = frozen && play.getBoundingClientRect();
  headWidth ||= roomHead.offsetWidth;
  for (const b of bodies) {
    if (!b.on) continue;
    let x = b.x;
    let y = b.y;
    let k = 1;
    const f = frozen ? flightOf(b) : 0;
    const seat = f > 0 && bridge.seat(b.id);
    if (seat) {
      const ex = seat.x - playRect.left;
      const ey = seat.y - playRect.top;
      const n = order.indexOf(b.id);
      const c1x = b.x + (ex - b.x) * 0.12 + (n % 2 ? 24 : -24);
      const c1y = b.y - (compact ? 50 : 90 + (n % 3) * 26);
      const c2y = ey - (compact ? 140 : 240);
      const u = 1 - f;
      x = u * u * u * b.x + 3 * u * u * f * c1x + 3 * u * f * f * ex + f * f * f * ex;
      y = u * u * u * b.y + 3 * u * u * f * c1y + 3 * u * f * f * c2y + f * f * f * ey;
      k = 1 + (seat.d / (b.r * 2) - 1) * f;
    }
    b.el.classList.toggle('is-flying', f > 0);
    const landed = f >= 0.995;
    if (landed !== b.landed) {
      b.landed = landed;
      b.el.classList.toggle('is-landed', landed);
      if (landed) bridge.land(b.id);
      else bridge.unland(b.id);
    }
    b.el.style.transform = `translate3d(${(x - b.r).toFixed(1)}px,${(y - b.r).toFixed(1)}px,0)${k !== 1 ? ` scale(${k.toFixed(3)})` : ''}`;
  }
  youEl.style.transform = `translate3d(${you.x.toFixed(1)}px,${you.y.toFixed(1)}px,0)`;
  if (room.w && (room.on || performance.now() < room.until)) {
    roomEl.style.transform = `translate3d(${room.x.toFixed(1)}px,${room.y.toFixed(1)}px,0)`;
    roomEl.style.width = `${room.w.toFixed(1)}px`;
    roomEl.style.height = `${room.h.toFixed(1)}px`;
    const headX = room.x + Math.min(22, Math.max(8 - room.x, width - 8 - room.x - headWidth));
    roomHead.style.transform = `translate3d(${headX.toFixed(1)}px,${(room.y - 15).toFixed(1)}px,0)`;
  }
  roomIcon.classList.toggle('is-talk', members.some(b => b.el.classList.contains('is-speaking')));
}

function scheduleDemo(ms) {
  if (user) return;
  clearTimeout(demoTimer);
  demoTimer = setTimeout(() => {
    if (user || frozen) return;
    if (!heroShown || document.hidden) return scheduleDemo(2500);
    const from = { x: width + 60, y: area.y + area.h * (compact ? 0.8 : 0.85) };
    const at = compact ? { x: area.x + area.w * 0.5, y: area.y + area.h * 0.5 } : { x: area.x + area.w * 0.4, y: area.y + area.h * 0.56 };
    const to = { x: width + 60, y: area.y + area.h * 0.12 };
    demo = { t0: performance.now(), from, at, to };
    kick();
  }, ms);
}
function runDemo(now) {
  const s = (now - demo.t0) / 1000;
  const [arrived, stays, left] = [1.5, 7.2, 8.6];
  const wander = w => ({ x: demo.at.x + Math.sin(w * 0.9) * 26, y: demo.at.y + Math.sin(w * 0.6) * 14 });
  let p;
  if (s < arrived) {
    const k = ease(s / arrived);
    p = { x: demo.from.x + (demo.at.x - demo.from.x) * k, y: demo.from.y + (demo.at.y - demo.from.y) * k };
  } else if (s < stays) {
    p = wander(s - arrived);
  } else if (s < left) {
    const k = ease((s - stays) / (left - stays));
    const base = wander(stays - arrived);
    p = { x: base.x + (demo.to.x - base.x) * k, y: base.y + (demo.to.y - base.y) * k };
  } else {
    demo = null;
    setYou(false);
    scheduleDemo(8000);
    return;
  }
  setYou(true, p, 'demo');
}

let raf = 0;
let last = 0;
function frame(now) {
  raf = 0;
  const dt = Math.min(2.5, Math.max(0, now - last) / 16.667 || 1);
  last = now;
  const target = bridge.progress();
  progress += (target - progress) * (1 - Math.pow(0.82, dt));
  if (Math.abs(target - progress) < 0.0008) progress = target;
  if (!frozen && progress > 0.0005) freeze();
  else if (frozen && progress <= 0.0005) {
    progress = 0;
    unfreeze();
  }
  if (!frozen && heroShown) step(dt, now);
  render();
  if (!document.hidden && (heroShown || progress !== target)) raf = requestAnimationFrame(frame);
}
function kick() {
  if (raf) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}


function pointAt(e) {
  if (e.pointerType === 'touch' || drag || frozen) return;
  const p = local(e);
  if (overCopy(p) || p.y < 0 || p.y > height || p.x < 0 || p.x > width) {
    if (you.source === 'mouse') setYou(false);
    return;
  }
  takeOver();
  if (you.all) setGatherAll(false);
  setYou(true, p, 'mouse');
  kick();
}

let leaveTimer = 0;
function press(e) {
  if (frozen) return;
  const avatar = e.target.closest('.w-hero-av');
  const p = local(e);
  takeOver();
  if (avatar) {
    const b = bodies.find(body => body.el === avatar);
    drag = { b, id: e.pointerId, ox: p.x - b.x, oy: p.y - b.y, lx: p.x, ly: p.y, lt: performance.now(), vx: 0, vy: 0 };
    b.grab = true;
    b.vx = 0;
    b.vy = 0;
    avatar.classList.add('is-grab');
    avatar.setPointerCapture(e.pointerId);
    if (you.source === 'mouse') setYou(false);
    e.preventDefault();
    kick();
    return;
  }
  if (e.pointerType === 'touch' || e.pointerType === 'pen') {
    clearTimeout(leaveTimer);
    if (you.all) setGatherAll(false);
    setYou(true, p, 'touch');
    kick();
  }
}

function move(e) {
  const p = local(e);
  if (drag && e.pointerId === drag.id) {
    const now = performance.now();
    const frames = Math.max(1, now - drag.lt) / 16.667;
    drag.vx = drag.vx * 0.4 + ((p.x - drag.lx) / frames) * 0.6;
    drag.vy = drag.vy * 0.4 + ((p.y - drag.ly) / frames) * 0.6;
    Object.assign(drag, { lx: p.x, ly: p.y, lt: now });
    drag.b.x = clamp(p.x - drag.ox, drag.b.r, width - drag.b.r);
    drag.b.y = clamp(p.y - drag.oy, drag.b.r, height - drag.b.r);
    return;
  }
  if (you.source === 'touch') setYou(true, p, 'touch');
}

// A thrown person keeps the speed of the last pointer moves; a lifted finger leaves «You»
// in place for a moment so the room does not vanish at once.
function release(e) {
  if (drag && e.pointerId === drag.id) {
    const b = drag.b;
    b.grab = false;
    b.vx = clamp(drag.vx, -30, 30);
    b.vy = clamp(drag.vy, -30, 30);
    b.el.classList.remove('is-grab');
    drag = null;
    return;
  }
  if (you.source !== 'touch') return;
  clearTimeout(leaveTimer);
  if (e.type === 'pointercancel') setYou(false);
  else leaveTimer = setTimeout(() => you.source === 'touch' && setYou(false), 2600);
}

function still() {
  const cx = area.x + area.w * (compact ? 0.5 : 0.42);
  const cy = area.y + area.h * 0.5;
  const pick = bodies.filter(b => b.on).slice(0, 5);
  pick.forEach((b, i) => {
    const a = (i / pick.length) * Math.PI * 2 - Math.PI / 2;
    const distance = you.r + b.r + 16;
    b.x = cx + Math.cos(a) * distance * 1.05;
    b.y = cy + Math.sin(a) * distance;
  });
  setYou(true, { x: cx, y: cy }, 'still');
  you.x = cx;
  you.y = cy;
  for (let i = 0; i < 30; i++) step(1, 0);
  room.on = false;
  updateRoom(1);
  talk.stop();
  pick[0].el.classList.add('is-speaking');
  pick[2].el.classList.add('is-speaking');
  render();
}

measure();
if (reducedMotion) {
  still();
  new ResizeObserver(() => {
    measure();
    still();
  }).observe(play);
} else {
  bridge.onMove = kick;
  hero.addEventListener('pointermove', pointAt);
  hero.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'touch' && you.source === 'mouse' && !drag) setYou(false);
  });
  play.addEventListener('pointerdown', press);
  play.addEventListener('pointermove', move);
  play.addEventListener('pointerup', release);
  play.addEventListener('pointercancel', release);
  play.addEventListener('lostpointercapture', release);
  gatherButton.addEventListener('click', () => {
    if (frozen) return;
    takeOver();
    setGatherAll(!you.all);
  });
  const resize = new ResizeObserver(() => {
    measure();
    kick();
  });
  resize.observe(play);
  resize.observe(copyBlock);
  document.fonts?.ready.then(measure);
  visible(hero, () => {
    heroShown = true;
    kick();
  }, () => {
    heroShown = false;
    if (room.on) setRoom(false);
  });
  addEventListener('scroll', kick, { passive: true });
  document.addEventListener('visibilitychange', () => !document.hidden && kick());
  render();
  kick();
  scheduleDemo(1700);
}
