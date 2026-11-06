import { ava, nameOf } from '../site.js';

const rooms = [...document.querySelectorAll('[data-rail-room]')];
const live = [...document.querySelectorAll('[data-rail-live]')];

let seat = null;
let sharing = false;
const showLive = () => live.forEach(badge => (badge.hidden = !(sharing && seat === 'screen')));

export const seated = () => seat;

export function sit(room) {
  if (room === seat) return;
  seat = room;
  document.querySelectorAll('[data-rail-you]').forEach(person => person.remove());
  for (const list of rooms) {
    const name = list.dataset.railRoom;
    if (name === room) list.insertAdjacentHTML('beforeend', `<li data-rail-you>${ava('me', 20)}${nameOf('me')}</li>`);
    const count = list.closest('.w-rail').querySelector(`[data-goto="w-${name}"] .w-rail-count`);
    if (count) count.textContent = list.children.length;
  }
  showLive();
  dispatchEvent(new CustomEvent('w-seat', { detail: room }));
}

export function share(on) {
  sharing = on;
  showLive();
}
