import { loop, reducedMotion, visible } from '../site.js';
import { share, sit } from './world.js';

const section = document.getElementById('w-screen');
const copy = JSON.parse(document.getElementById('w-screen-copy').textContent);
const $ = selector => section.querySelector(selector);
const $$ = selector => [...section.querySelectorAll(selector)];
const app = $('.w-screen-app');
const viewer = $('.w-screen-viewer');
const board = $('[data-board]');
const picker = $('.w-screen-picker');
const hint = $('[data-hint]');
const turnLabel = $('[data-turn]');
const live = () => app.dataset.state === 'live';

let touched = false;
let demo = 0;
function noteTouch() {
  touched = true;
  clearTimeout(demo);
}

const minis = $$('[data-mini] i');
const pieces = $$('.w-screen-pc').map((el, i) => {
  const r = +el.dataset.r;
  const col = +el.dataset.c;
  return { el, mini: minis[i], side: el.classList.contains('is-w') ? 'w' : 'b', r, col, king: false, alive: true, home: [r, col] };
});
const put = piece => {
  for (const el of [piece.el, piece.mini]) {
    el.style.left = `${piece.col * 12.5}%`;
    el.style.top = `${piece.r * 12.5}%`;
  }
  piece.el.classList.toggle('is-king', piece.king);
};

const at = (r, col) => pieces.find(p => p.alive && p.r === r && p.col === col);
const inside = (r, col) => r >= 0 && r < 8 && col >= 0 && col < 8;
const diagonals = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const takesFor = piece => diagonals.flatMap(([dr, dc]) => {
  const middle = at(piece.r + dr, piece.col + dc);
  const r = piece.r + dr * 2;
  const col = piece.col + dc * 2;
  return middle && middle.side !== piece.side && inside(r, col) && !at(r, col) ? [{ piece, r, col, take: middle }] : [];
});
const stepsFor = piece => (piece.king ? [-1, 1] : [piece.side === 'w' ? -1 : 1]).flatMap(dr =>
  [-1, 1].filter(dc => inside(piece.r + dr, piece.col + dc) && !at(piece.r + dr, piece.col + dc)).map(dc => ({ piece, r: piece.r + dr, col: piece.col + dc })));
// Taking is compulsory, as in draughts.
function movesOf(side) {
  const mine = pieces.filter(p => p.alive && p.side === side);
  const takes = mine.flatMap(takesFor);
  return takes.length ? takes : mine.flatMap(stepsFor);
}

let turn = 'w';
let picked = null;
let chain = null;
let busy = false;
let hinted = false;
let score = { w: 0, b: 0 };

function refreshMovable() {
  const moves = turn === 'w' && !busy && live() ? movesOf('w') : [];
  for (const piece of pieces) {
    const can = piece.side === 'w' && piece.alive && moves.some(m => m.piece === piece) && (!chain || chain === piece);
    piece.el.classList.toggle('can-move', can);
    piece.el.disabled = !can;
    piece.el.setAttribute('aria-label', piece.side === 'b' ? copy.piece.black : can ? copy.piece.movable : copy.piece.white);
  }
  app.classList.toggle('is-yours', turn === 'w' && !busy);
  turnLabel.textContent = turn === 'w' ? copy.turn.yours : copy.turn.theirs;
}

function pick(piece, focus) {
  pieces.forEach(p => p.el.classList.toggle('is-picked', p === piece));
  picked = piece;
  $$('.w-screen-target').forEach(target => target.remove());
  if (!piece) return;
  for (const move of movesOf('w').filter(m => m.piece === piece)) {
    const target = document.createElement('button');
    target.type = 'button';
    target.className = 'w-screen-target' + (move.take ? ' is-take' : '');
    target.style.left = `${move.col * 12.5}%`;
    target.style.top = `${move.r * 12.5}%`;
    target.setAttribute('aria-label', move.take ? copy.target.take : copy.target.move);
    target.addEventListener('click', e => {
      e.stopPropagation();
      playerMove(move, e.detail === 0);
    });
    board.appendChild(target);
  }
  if (focus) board.querySelector('.w-screen-target')?.focus();
}

function applyMove(move) {
  const piece = move.piece;
  piece.r = move.r;
  piece.col = move.col;
  if ((piece.side === 'w' && piece.r === 0) || (piece.side === 'b' && piece.r === 7)) piece.king = true;
  put(piece);
  if (move.take) {
    move.take.alive = false;
    move.take.el.classList.add('is-gone');
    move.take.mini.classList.add('is-gone');
    score[piece.side] += 1;
    $('[data-score-w]').textContent = score.w;
    $('[data-score-b]').textContent = score.b;
  }
  knock(move.take ? 1 : 0.6);
}

function finishTurn(side) {
  chain = null;
  turn = side === 'w' ? 'b' : 'w';
  if (!movesOf(turn).length) {
    busy = true;
    refreshMovable();
    turnLabel.textContent = copy.turn.over;
    setTimeout(resetGame, 2400);
    return;
  }
  if (turn === 'b') {
    busy = true;
    setTimeout(botMove, reducedMotion ? 200 : 820);
  }
  refreshMovable();
}

function playerMove(move, focus) {
  if (busy || turn !== 'w') return;
  applyMove(move);
  hint.classList.add('is-off');
  hinted = true;
  react();
  if (move.take && takesFor(move.piece).length) {
    chain = move.piece;
    pick(move.piece, focus);
    refreshMovable();
    return;
  }
  if (focus) board.focus();
  pick(null);
  finishTurn('w');
}

// A square is risky when a white piece could jump over the black piece landing there.
const threatened = move => diagonals.some(([dr, dc]) => {
  const foe = at(move.r + dr, move.col + dc);
  const land = [move.r - dr, move.col - dc];
  return foe && foe.side === 'w' && inside(...land) && (!at(...land) || at(...land) === move.piece);
});

function botMove() {
  const moves = movesOf('b');
  const safe = moves.filter(m => m.take || !threatened(m));
  const pool = moves.some(m => m.take) || !safe.length ? moves : safe;
  let move = pool[Math.floor(Math.random() * pool.length)];
  applyMove(move);
  const next = () => {
    const more = move.take ? takesFor(move.piece) : [];
    if (more.length) {
      move = more[0];
      setTimeout(() => {
        applyMove(move);
        next();
      }, reducedMotion ? 120 : 520);
      return;
    }
    busy = false;
    finishTurn('b');
  };
  next();
}

function resetGame() {
  for (const piece of pieces) {
    [piece.r, piece.col] = piece.home;
    piece.king = false;
    piece.alive = true;
    piece.el.classList.remove('is-gone', 'is-picked');
    piece.mini.classList.remove('is-gone');
    put(piece);
  }
  score = { w: 0, b: 0 };
  $('[data-score-w]').textContent = '0';
  $('[data-score-b]').textContent = '0';
  turn = 'w';
  busy = false;
  chain = null;
  pick(null);
  refreshMovable();
}

board.addEventListener('click', e => {
  const el = e.target.closest('.w-screen-pc');
  const piece = el && pieces.find(p => p.el === el);
  if (!piece || !live() || !el.classList.contains('can-move') || (chain && chain !== piece)) return;
  noteTouch();
  pick(picked === piece && !chain ? null : piece, e.detail === 0);
});

const lists = { windows: $('[data-list="windows"]'), screens: $('[data-list="screens"]') };
const tabs = $$('[data-tab]');
const shareAudio = $('[data-pick-audio]');
let chosen = $('.w-screen-src.is-picked');

function showHint(text) {
  hint.textContent = text;
  hint.classList.remove('is-off');
}

function choose(source) {
  $$('.w-screen-src').forEach(s => s.classList.toggle('is-picked', s === source));
  chosen = source;
  $('[data-audio-hint]').textContent = source.dataset.kind === 'screen' ? copy.audioHint.system : copy.audioHint.app;
}

function showTab(name) {
  tabs.forEach(tab => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    tab.tabIndex = tab.dataset.tab === name ? 0 : -1;
  });
  for (const [key, list] of Object.entries(lists)) list.hidden = key !== name;
  choose(lists[name].querySelector('.is-picked') || lists[name].querySelector('.w-screen-src'));
}

function setState(state) {
  app.dataset.state = state;
  viewer.dataset.live = state === 'live' ? 'on' : 'off';
  picker.hidden = state !== 'picking';
  share(state === 'live');
  if (state === 'idle') showHint(copy.hint.idle);
  if (state === 'picking') showHint(copy.hint.picking);
  if (state === 'live') {
    if (app.dataset.view === 'board' && !hinted) showHint(copy.hint.live);
    else hint.classList.add('is-off');
  }
  refreshMovable();
}

function openPicker(focus) {
  if (app.dataset.state !== 'idle') return;
  setState('picking');
  if (!focus) return;
  const list = lists.windows.hidden ? lists.screens : lists.windows;
  (list.querySelector('.is-picked') || list.querySelector('.w-screen-src')).focus({ preventScroll: true });
}

function startShare() {
  if (app.dataset.state !== 'picking') return;
  const from = chosen.querySelector('.w-screen-thumb').getBoundingClientRect();
  const screen = chosen.dataset.kind === 'screen';
  app.dataset.source = chosen.dataset.kind;
  app.dataset.view = viewer.dataset.view = chosen.dataset.view;
  app.dataset.audio = shareAudio.checked ? 'on' : 'off';
  $('[data-src-name]').textContent = chosen.dataset.name;
  $('[data-src-audio]').textContent = !shareAudio.checked ? copy.audio.none : screen ? copy.audio.system : copy.audio.app;
  $('[data-wtitle]').textContent = screen ? copy.board : chosen.dataset.name;
  setState('live');
  if (!reducedMotion) {
    const stream = $('.w-screen-stream');
    const to = stream.getBoundingClientRect();
    stream.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, borderRadius: '40px' },
      { transform: 'none', borderRadius: '14px' },
    ], { duration: 560, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    $('.w-screen-tag .w-live').animate([
      { transform: 'scale(0.4)', opacity: 0 },
      { transform: 'scale(1.15)', opacity: 1, offset: 0.7 },
      { transform: 'none' },
    ], { duration: 520, delay: 380, easing: 'ease-out', fill: 'backwards' });
  }
  setTimeout(react, reducedMotion ? 0 : 700);
  knock(1);
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => {
    noteTouch();
    showTab(tab.dataset.tab);
  });
  tab.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    noteTouch();
    showTab(next.dataset.tab);
    next.focus();
  });
});
$$('.w-screen-src').forEach(source => {
  source.addEventListener('click', () => {
    noteTouch();
    choose(source);
  });
  source.addEventListener('dblclick', startShare);
});
$('[data-share]').addEventListener('click', () => {
  noteTouch();
  openPicker(true);
});
$('[data-stop]').addEventListener('click', () => {
  noteTouch();
  pick(null);
  setState('idle');
});
$$('[data-pick-cancel]').forEach(button => button.addEventListener('click', () => {
  noteTouch();
  setState('idle');
}));
$('[data-pick-go]').addEventListener('click', () => {
  noteTouch();
  startShare();
});
shareAudio.addEventListener('change', noteTouch);
picker.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  setState('idle');
  $('[data-share]').focus();
});

const friends = [...app.querySelectorAll('.w-screen-people .w-ava:not(.w-ava--you)')].map(el => el.dataset.who);
const speaking = new Set();
function say(who, duration) {
  const avatars = app.querySelectorAll(`.w-ava[data-who="${who}"]`);
  speaking.add(who);
  avatars.forEach(el => el.classList.add('is-speaking'));
  setTimeout(() => {
    speaking.delete(who);
    avatars.forEach(el => el.classList.remove('is-speaking'));
  }, duration);
}
function react() {
  if (reducedMotion) return;
  const who = friends[Math.floor(Math.random() * friends.length)];
  setTimeout(() => say(who, 1100 + Math.random() * 900), 250);
}
let chatter = 0;
function chat() {
  clearTimeout(chatter);
  if (Math.random() < 0.55) say(friends[Math.floor(Math.random() * friends.length)], 900 + Math.random() * 1600);
  chatter = setTimeout(chat, 2600 + Math.random() * 2600);
}

const volumes = { stream: $('[data-vol="stream"]'), voice: $('[data-vol="voice"]') };
const meters = { stream: $('[data-meter="stream"]'), voice: $('[data-meter="voice"]') };
const duck = $('[data-duck]');
const duckNote = $('[data-ducknote]');
for (const [name, input] of Object.entries(volumes)) {
  const paint = () => {
    input.style.setProperty('--p', input.value + '%');
    $(`[data-out="${name}"]`).textContent = input.value + '%';
  };
  paint();
  input.addEventListener('input', () => {
    paint();
    noteTouch();
  });
}
duck.addEventListener('change', noteTouch);

let hit = 0;
function knock(strength) {
  hit = Math.max(hit, strength);
}
let factor = 1;
let streamLevel = 0.5;
let voiceLevel = 0;
let time = 0;
loop(viewer, dt => {
  time += dt;
  const talking = speaking.size > 0;
  const streaming = live() && app.dataset.audio === 'on';
  const want = duck.checked && talking ? 0.35 : 1;
  factor += (want - factor) * Math.min(1, dt * (want < factor ? 7 : 1.6));
  hit = Math.max(0, hit - dt * 2.2);
  const music = 0.56 + 0.18 * Math.sin(time * 2.3) + 0.12 * Math.sin(time * 5.1 + 1) + 0.25 * hit;
  const streamTarget = streaming ? Math.min(1, music) * (volumes.stream.value / 100) * factor : 0;
  streamLevel += (streamTarget - streamLevel) * Math.min(1, dt * 12);
  const voiceTarget = talking ? (0.55 + 0.35 * Math.abs(Math.sin(time * 9.3))) * (volumes.voice.value / 100) : 0;
  voiceLevel += (voiceTarget - voiceLevel) * Math.min(1, dt * 14);
  meters.stream.style.transform = `scaleX(${streamLevel.toFixed(3)})`;
  meters.voice.style.transform = `scaleX(${voiceLevel.toFixed(3)})`;
  duckNote.classList.toggle('is-on', streaming && duck.checked && talking);
});

section.addEventListener('pointerdown', noteTouch);
function runDemo() {
  if (touched || app.dataset.state !== 'idle') return;
  openPicker();
  demo = setTimeout(() => {
    if (touched) return;
    showTab('windows');
    choose(lists.windows.querySelector('[data-view="board"]'));
    demo = setTimeout(() => !touched && startShare(), 900);
  }, 1000);
}

visible(app, () => sit('screen'), null, 0.45);
if (reducedMotion) {
  setState('live');
} else {
  setState('idle');
  let seen = false;
  visible(app, () => {
    chat();
    if (seen) return;
    seen = true;
    demo = setTimeout(runDemo, 2200);
  }, () => clearTimeout(chatter), 0.45);
}
