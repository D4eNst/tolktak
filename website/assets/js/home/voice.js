import { ava, conversation, fill, icon, nameOf, reducedMotion, visible } from '../site.js';
import { draggable } from './drag.js';
import { seated, sit } from './world.js';

const section = document.getElementById('w-voice');
const copy = JSON.parse(document.getElementById('w-voice-copy').textContent);
const layout = section.querySelector('[data-voice]');
const room = layout.querySelector('[data-voice-room]');
const tiles = room.querySelector('[data-voice-tiles]');
const count = room.querySelector('[data-voice-count]');
const join = room.querySelector('[data-voice-join]');
const controls = room.querySelector('[data-voice-ctrls]');
const me = layout.querySelector('[data-voice-me]');
const chip = layout.querySelector('[data-voice-chip]');
const status = layout.querySelector('[data-voice-status]');
const connected = layout.querySelector('[data-voice-connected]');
const callBox = layout.querySelector('[data-voice-call]');
const announcer = layout.querySelector('[data-voice-announce]');
const camera = layout.querySelector('[data-voice-camera]');
const people = [...layout.querySelectorAll('.w-voice-person')];

const announce = text => (announcer.textContent = text);

let where = 'out';
let mic = true;
let sound = true;
let cam = false;
let you = null;

const talk = conversation(() => [...tiles.children].filter(t => t !== you || (mic && sound)), { min: 900, max: 2400 });
if (!reducedMotion) {
  tiles.querySelector('.is-speaking')?.classList.remove('is-speaking');
  visible(room, () => talk.start(), () => talk.stop());
}

// FLIP, so the tiles glide to their new places when you join or leave.
function reflow(change) {
  if (reducedMotion) return change();
  const before = new Map([...tiles.children].map(t => [t, t.getBoundingClientRect()]));
  change();
  for (const t of tiles.children) {
    const a = before.get(t);
    if (!a) continue;
    const b = t.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const scale = a.width / b.width;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.01) continue;
    t.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${scale})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: 520, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' });
  }
}

function setStatus(text, live) {
  status.textContent = text;
  status.classList.toggle('is-live', live);
}

function syncCount() {
  count.textContent = fill(copy.inRoom, { n: tiles.children.length });
  if (where === 'room') sit('voice');
  else if (seated() === 'voice') sit(null);
}

function setControl(name, iconName, pressed, state) {
  const button = controls.querySelector(`[data-vc="${name}"]`);
  button.innerHTML = icon(iconName, 20);
  button.setAttribute('aria-pressed', pressed);
  button.classList.toggle('is-off', state === 'off');
  button.classList.toggle('is-on', state === 'on');
}

function paintYou() {
  you.classList.toggle('is-cam', cam);
  you.querySelector('.w-voice-cam')?.remove();
  if (cam) you.prepend(camera.content.cloneNode(true));
  you.querySelector('.w-voice-badge')?.remove();
  const live = mic && sound;
  if (!live) {
    you.insertAdjacentHTML('beforeend', `<span class="w-voice-badge" title="${copy.micOff}">${icon(sound ? 'micOff' : 'headphonesOff', 15)}</span>`);
    you.classList.remove('is-speaking');
  }
  setControl('mic', live ? 'mic' : 'micOff', live, live ? '' : 'off');
  setControl('sound', sound ? 'headphones' : 'headphonesOff', sound, sound ? '' : 'off');
  setControl('cam', cam ? 'video' : 'videoOff', cam, cam ? 'on' : '');
}

function enter() {
  if (where === 'call') hangUp();
  if (where === 'room') return;
  where = 'room';
  mic = true;
  sound = true;
  cam = false;
  reflow(() => {
    you = document.createElement('li');
    you.className = 'w-voice-tile is-you';
    you.style.setProperty('--c', 'var(--w-you)');
    you.dataset.who = 'me';
    you.innerHTML = `<span class="w-voice-glow"></span>${ava('me', 72)}<span class="w-voice-name">${nameOf('me')}</span>`;
    tiles.appendChild(you);
    tiles.classList.add('has-5');
  });
  join.hidden = true;
  controls.hidden = false;
  connected.hidden = false;
  me.classList.add('is-away');
  setStatus(copy.status.room, true);
  announce(copy.announce.joined);
  paintYou();
  syncCount();
  if (reducedMotion) return;
  setTimeout(() => you && mic && sound && you.classList.add('is-speaking'), 650);
  setTimeout(() => you?.classList.remove('is-speaking'), 2200);
}

function leave() {
  if (where !== 'room') return;
  where = 'out';
  reflow(() => {
    you.remove();
    you = null;
    tiles.classList.remove('has-5');
  });
  join.hidden = false;
  controls.hidden = true;
  connected.hidden = true;
  me.classList.remove('is-away');
  setStatus(copy.status.online, false);
  announce(copy.announce.left);
  syncCount();
}

join.addEventListener('click', enter);
layout.querySelector('[data-voice-disconnect]').addEventListener('click', leave);
controls.addEventListener('click', event => {
  const action = event.target.closest('[data-vc]')?.dataset.vc;
  if (action === 'leave') return leave();
  if (action === 'share') return document.getElementById('w-screen')?.scrollIntoView();
  if (action === 'mic') {
    mic = !(mic && sound);
    sound = true;
  }
  if (action === 'sound') {
    sound = !sound;
    if (sound) mic = true;
  }
  if (action === 'cam') cam = !cam;
  if (action) paintYou();
});

let ringTimer = 0;
let clockTimer = 0;
let pairTalk = null;

function hangUp() {
  const caller = people.find(row => row.classList.contains('is-calling'));
  const hadFocus = callBox.contains(document.activeElement);
  clearTimeout(ringTimer);
  clearInterval(clockTimer);
  pairTalk?.stop();
  pairTalk = null;
  callBox.hidden = true;
  callBox.innerHTML = '';
  layout.classList.remove('is-calling');
  for (const row of people) {
    row.classList.remove('is-calling');
    row.querySelector('small').textContent = copy.status.online;
  }
  if (hadFocus) caller?.querySelector('[data-call]').focus();
  if (where !== 'call') return;
  where = 'out';
  me.classList.remove('is-away');
  setStatus(copy.status.online, false);
  announce(copy.announce.ended);
}

const hangUpButton = `<button type="button" class="w-voice-cb w-voice-cb--leave" data-hang aria-label="${copy.disconnect}" title="${copy.disconnect}">${icon('phoneOff', 20)}</button>`;

function call(id) {
  if (where === 'room') leave();
  if (where === 'call') hangUp();
  const name = nameOf(id);
  const row = people.find(li => li.dataset.who === id);
  row.classList.add('is-calling');
  row.querySelector('small').textContent = copy.ringing;
  where = 'call';
  me.classList.add('is-away');
  setStatus(copy.status.ringing, false);
  announce(fill(copy.announce.ringing, { name }));
  layout.classList.add('is-calling');
  callBox.hidden = false;
  callBox.innerHTML = `
    <div class="w-voice-ring">${reducedMotion ? '' : '<i></i><i></i><i></i>'}${ava(id, 76)}</div>
    <b class="w-voice-call-name">${name}</b>
    <span class="w-voice-call-state">${copy.ringing}</span>
    <div class="w-voice-call-ctrls">${hangUpButton}</div>`;
  ringTimer = setTimeout(() => {
    const refocus = callBox.contains(document.activeElement);
    callBox.innerHTML = `
      <div class="w-voice-call-pair">
        <figure>${ava('me', 64)}<figcaption>${nameOf('me')}</figcaption></figure>
        <figure>${ava(id, 64)}<figcaption>${name}</figcaption></figure>
      </div>
      <b class="w-voice-call-name">${copy.directCall}</b>
      <span class="w-voice-call-state is-live">${copy.inCall} · <span role="timer" data-clock>0:00</span></span>
      <div class="w-voice-call-ctrls">
        <button type="button" class="w-voice-cb" data-call-mic aria-label="${copy.controls.mic}" title="${copy.controls.mic}" aria-pressed="true">${icon('mic', 20)}</button>
        <button type="button" class="w-voice-cb" data-call-cam aria-label="${copy.controls.cam}" title="${copy.controls.cam}" aria-pressed="false">${icon('videoOff', 20)}</button>
        ${hangUpButton}
      </div>`;
    if (refocus) callBox.querySelector('[data-hang]').focus();
    setStatus(copy.status.call, true);
    announce(fill(copy.announce.call, { name }));
    row.querySelector('small').textContent = copy.inCall;
    const time = callBox.querySelector('[data-clock]');
    let seconds = 0;
    clockTimer = setInterval(() => {
      seconds += 1;
      time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
    pairTalk = conversation(() => [...callBox.querySelectorAll('.w-voice-call-pair .w-ava')], { min: 900, max: 2200 });
    pairTalk.start();
  }, reducedMotion ? 300 : 2300);
}

callBox.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.matches('[data-hang]')) return hangUp();
  if (button.matches('[data-call-mic]')) {
    const off = button.classList.toggle('is-off');
    button.innerHTML = icon(off ? 'micOff' : 'mic', 20);
    button.setAttribute('aria-pressed', !off);
  }
  if (button.matches('[data-call-cam]')) {
    const on = button.classList.toggle('is-on');
    button.innerHTML = icon(on ? 'video' : 'videoOff', 20);
    button.setAttribute('aria-pressed', on);
  }
});
people.forEach(row => row.querySelector('[data-call]').addEventListener('click', () => call(row.dataset.who)));
section.addEventListener('keydown', event => event.key === 'Escape' && where === 'call' && hangUp());
addEventListener('w-seat', event => {
  if (event.detail === 'voice') return;
  if (where === 'room') leave();
  if (where === 'call') hangUp();
});

draggable(chip, {
  tilt: -6,
  ghost: () => Object.assign(document.createElement('span'), { className: 'w-voice-ghost', innerHTML: ava('me', 56) }),
  targets: () => [room, ...people],
  drop: target => (target === room ? enter() : call(target.dataset.who)),
  start: () => layout.classList.add('is-dragging'),
  end: () => layout.classList.remove('is-dragging'),
});
chip.addEventListener('click', enter);
