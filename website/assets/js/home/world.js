import { ava, conversation, nameOf, visible } from '../site.js';

// The sidebar highlights the room under the upper part of the viewport.
const scenes = ['w-house', 'w-chat', 'w-voice', 'w-screen', 'w-sound', 'w-server', 'w-download'].map(id => document.getElementById(id)).filter(Boolean);
const links = [...document.querySelectorAll('[data-goto]')];
let here = '';
function markHere() {
  const line = innerHeight * 0.42;
  const current = scenes.filter(scene => scene.getBoundingClientRect().top <= line).pop()?.id || '';
  if (current === here) return;
  here = current;
  links.forEach(link => link.classList.toggle('is-here', link.dataset.goto === current));
}
addEventListener('scroll', markHere, { passive: true });
markHere();

const rooms = Object.fromEntries([...document.querySelectorAll('[data-rail-room]')].map(list => [list.dataset.railRoom, list]));
const live = document.querySelector('[data-rail-live]');
const talk = conversation(() => Object.values(rooms).flatMap(list => [...list.querySelectorAll('.w-ava')]), { min: 1200, max: 3200 });
visible(rooms.voice, () => talk.start(), () => talk.stop());

// Like in the app, you are in one voice room at a time: joining one announces `w-seat`, so the
// scene of the other room lets you out. LIVE shows while you share your screen in Game night.
let seat = null;
let sharing = false;
const showLive = () => (live.hidden = !(sharing && seat === 'screen'));

export const seated = () => seat;

export function sit(room) {
  if (room === seat) return;
  seat = room;
  document.querySelector('[data-rail-you]')?.remove();
  rooms[room]?.insertAdjacentHTML('beforeend', `<li data-rail-you>${ava('me', 20)}${nameOf('me')}</li>`);
  for (const [name, list] of Object.entries(rooms)) {
    const count = document.querySelector(`[data-goto="w-${name}"] .w-rail-count`);
    if (count) count.textContent = list.children.length;
  }
  showLive();
  dispatchEvent(new CustomEvent('w-seat', { detail: room }));
}

export function share(on) {
  sharing = on;
  showLive();
}
