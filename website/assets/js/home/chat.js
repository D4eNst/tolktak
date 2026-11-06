import { icon, openSwitcher, reducedMotion, replay } from '../site.js';
import { chatAvatar } from './chat-markup.js';
import { draggable } from './drag.js';

const section = document.querySelector('[data-workstory]');
const copy = JSON.parse(document.getElementById('w-chat-copy').textContent);
const win = section.querySelector('[data-chat]');
const scroll = win.querySelector('[data-chat-scroll]');
const lists = [...win.querySelectorAll('[data-chat-list]')];
let list = lists[0];
const empty = win.querySelector('[data-chat-empty]');
const drafts = new Map();
const pins = win.querySelector('[data-chat-pins]');
const pinText = win.querySelector('[data-chat-pin-text]');
const pinCount = win.querySelector('[data-chat-pin-count]');
const composer = win.querySelector('[data-chat-composer]');
const input = win.querySelector('[data-chat-input]');
const replying = win.querySelector('[data-chat-replying]');
const replyWho = win.querySelector('[data-chat-reply-who]');
const replyText = win.querySelector('[data-chat-reply-text]');
const tray = section.querySelector('[data-chat-tray]');

const ava = (id, size) => chatAvatar(id, copy.people, size);
const nameOf = id => copy.people[id].name;
const colorOf = id => copy.people[id].color;
const messages = () => [...list.querySelectorAll('.w-chat-msg:not(.is-hidden)')];
const snippet = li => li.querySelector('.w-chat-text')?.textContent.trim() || copy.attachment;
const toBottom = (smooth = true) => scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth && !reducedMotion ? 'smooth' : 'auto' });
const any = items => items[Math.floor(Math.random() * items.length)];

function addActions(li) {
  const actions = document.createElement('div');
  actions.className = 'w-chat-acts';
  actions.setAttribute('role', 'toolbar');
  actions.innerHTML = [['reply', 'reply', copy.reply], ['react', 'smilePlus', copy.addReaction], ['pin', 'pin', copy.pin]]
    .map(([act, name, label]) => `<button type="button" data-act="${act}" aria-label="${label}" title="${label}">${icon(name, 16)}</button>`).join('');
  li.appendChild(actions);
}

function react(li, e, { mine = true, toggle = false } = {}) {
  const box = li.querySelector('.w-chat-reacts');
  let chip = box.querySelector(`[data-e="${e}"]`);
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'w-chat-react';
    chip.dataset.e = e;
    chip.setAttribute('aria-label', `${copy.reactWith} ${e}`);
    chip.innerHTML = `<span>${e}</span><b>0</b>`;
    box.appendChild(chip);
  }
  const count = chip.querySelector('b');
  let n = +count.textContent;
  if (mine && chip.classList.contains('is-mine')) {
    if (!toggle) return;
    n -= 1;
    chip.classList.remove('is-mine');
    if (n <= 0) {
      chip.remove();
      return;
    }
  } else {
    n += 1;
    if (mine) chip.classList.add('is-mine');
  }
  count.textContent = n;
  replay(chip, 'is-pop');
}

let picker = null;
let pickerOpener = null;
function closePicker({ focus = false } = {}) {
  if (!picker) return;
  picker.closest('.w-chat-msg')?.classList.remove('is-menu');
  picker.remove();
  picker = null;
  if (focus) pickerOpener.focus();
}
function openPicker(li, opener) {
  closePicker();
  pickerOpener = opener;
  picker = document.createElement('div');
  picker.className = 'w-chat-pick';
  picker.innerHTML = copy.emoji.map(e => `<button type="button" data-e="${e}" aria-label="${copy.reactWith} ${e}">${e}</button>`).join('');
  li.classList.add('is-menu');
  li.appendChild(picker);
  picker.querySelector('button').focus();
  picker.addEventListener('click', event => {
    const button = event.target.closest('[data-e]');
    if (!button) return;
    event.stopPropagation();
    react(li, button.dataset.e);
    closePicker({ focus: true });
  });
}

function updatePins() {
  const pinned = [...list.querySelectorAll('.is-pinned')];
  pins.hidden = !pinned.length;
  pinCount.textContent = pinned.length;
  const last = pinned.at(-1);
  if (!last) {
    pinText.replaceChildren();
    return;
  }
  const name = document.createElement('em');
  name.textContent = nameOf(last.dataset.who) + ':';
  pinText.replaceChildren(name, ' ' + snippet(last));
}

function pin(li) {
  if (!li.classList.contains('is-pinned')) {
    li.classList.add('is-pinned');
    const mark = document.createElement('p');
    mark.className = 'w-chat-pinmark' + (reducedMotion ? '' : ' is-new');
    mark.innerHTML = `${icon('pin', 12)}${copy.pinned}`;
    li.querySelector('.w-chat-body').prepend(mark);
  }
  updatePins();
  replay(pins, 'is-stamp');
}

let replyTo = null;
function setReply(li) {
  const who = li.dataset.who;
  replyTo = { who, text: snippet(li) };
  replyWho.textContent = nameOf(who);
  replyWho.style.color = colorOf(who);
  replyText.textContent = replyTo.text;
  replying.hidden = false;
  input.focus({ preventScroll: true });
}
function clearReply() {
  replyTo = null;
  replying.hidden = true;
}

function post(who, text, quote, target = list) {
  const li = document.createElement('li');
  li.className = 'w-chat-msg' + (quote ? ' has-quote' : '') + (reducedMotion ? '' : ' is-new');
  li.dataset.who = who;
  li.tabIndex = 0;
  li.setAttribute('aria-keyshortcuts', 'r p');
  li.innerHTML = `${ava(who, 36)}<div class="w-chat-body">
    ${quote ? `<p class="w-chat-quote">${ava(quote.who, 16)}<b></b><span></span></p>` : ''}
    <p class="w-chat-meta"><b></b></p>
    <p class="w-chat-text"></p>
    <div class="w-chat-reacts"></div>
  </div>`;
  if (quote) {
    li.querySelector('.w-chat-quote b').textContent = nameOf(quote.who);
    li.querySelector('.w-chat-quote span:last-child').textContent = quote.text;
  }
  const name = li.querySelector('.w-chat-meta b');
  name.textContent = nameOf(who);
  name.style.color = colorOf(who);
  li.querySelector('.w-chat-text').textContent = text;
  addActions(li);
  draggableMessage(li);
  target.appendChild(li);
  while (target.children.length > 16) target.firstElementChild.remove();
  if (target === list) {
    empty.hidden = true;
    updatePins();
    requestAnimationFrame(() => toBottom());
  }
  return li;
}

const answering = new Set();
function send() {
  const text = input.value.trim();
  if (!text) return;
  const quote = replyTo;
  const target = list;
  const mine = post('me', text, quote, target);
  input.value = '';
  composer.classList.remove('has-text');
  clearReply();
  if (answering.has(target)) return;
  answering.add(target);
  const who = quote && copy.replies[quote.who] ? quote.who : any(Object.keys(copy.replies));
  setTimeout(() => react(mine, any(['👍', '🔥', '😂', '❤️']), { mine: false }), reducedMotion ? 0 : 700);
  setTimeout(() => {
    post(who, any(copy.replies[who]), { who: 'me', text }, target);
    answering.delete(target);
  }, reducedMotion ? 0 : 1500 + Math.random() * 700);
}
composer.querySelectorAll('button:disabled').forEach(button => (button.disabled = false));
win.querySelector('[data-chat-send]').addEventListener('click', send);
input.addEventListener('input', () => composer.classList.toggle('has-text', !!input.value.trim()));
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) send();
  if (event.key === 'Escape') clearReply();
});
win.querySelector('[data-chat-reply-cancel]').addEventListener('click', clearReply);

scroll.addEventListener('click', event => {
  const chip = event.target.closest('.w-chat-react');
  if (chip) {
    react(chip.closest('.w-chat-msg'), chip.dataset.e, { toggle: true });
    return;
  }
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const li = button.closest('.w-chat-msg');
  if (button.dataset.act === 'reply') setReply(li);
  if (button.dataset.act === 'pin') pin(li);
  if (button.dataset.act === 'react') openPicker(li, button);
});
// Клавиши R и P в русской раскладке.
scroll.addEventListener('keydown', event => {
  const li = event.target;
  if (!li.matches('.w-chat-msg') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'r' || event.key === 'к') {
    event.preventDefault();
    setReply(li);
  }
  if (event.key === 'p' || event.key === 'з') {
    event.preventDefault();
    pin(li);
  }
});
document.addEventListener('pointerdown', event => picker && !picker.contains(event.target) && closePicker());
win.addEventListener('keydown', event => event.key === 'Escape' && closePicker({ focus: true }));
section.querySelector('[data-chat-find]').addEventListener('click', openSwitcher);
section.querySelector('[data-chat-write]').addEventListener('click', () => input.focus({ preventScroll: true }));
win.querySelector('[data-chat-emoji]').addEventListener('click', () => {
  replay(tray, 'is-pulse');
  tray.querySelector('.w-chat-emo').focus({ preventScroll: true });
});
if (matchMedia('(pointer: coarse)').matches) section.querySelector('[data-chat-hint]').textContent = copy.hintPinTouch;

tray.querySelectorAll('.w-chat-emo').forEach(button => {
  draggable(button, {
    tilt: -8,
    ghost: () => Object.assign(document.createElement('span'), { className: 'w-chat-ghost-emo', textContent: button.dataset.e }),
    targets: messages,
    drop: li => react(li, button.dataset.e),
    start: () => {
      win.classList.add('is-dragging-emo');
      closePicker();
    },
    end: () => win.classList.remove('is-dragging-emo'),
  });
  button.addEventListener('click', () => {
    const last = messages().filter(li => li.dataset.who !== 'me').pop();
    if (!last) return;
    react(last, button.dataset.e);
    last.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  });
});

function draggableMessage(li) {
  draggable(li, {
    touch: false,
    tilt: -2,
    ignore: event => !!event.target.closest('button, a, input, .w-chat-pick'),
    ghost: () => {
      const ghost = document.createElement('div');
      ghost.className = 'w-chat-ghost-msg';
      ghost.innerHTML = `${ava(li.dataset.who, 24)}<span></span>`;
      ghost.lastElementChild.textContent = snippet(li);
      return ghost;
    },
    targets: () => [pins, composer],
    drop: target => (target === pins ? pin(li) : setReply(li)),
    start: () => {
      win.classList.add('is-dragging-msg');
      pins.hidden = false;
      closePicker();
    },
    end: () => {
      win.classList.remove('is-dragging-msg');
      updatePins();
    },
  });
}

list.querySelectorAll('.w-chat-msg').forEach(li => {
  addActions(li);
  draggableMessage(li);
});

toBottom(false);

section.querySelectorAll('[data-chat-channel]').forEach(button => {
  button.addEventListener('click', () => {
    const id = button.dataset.chatChannel;
    if (id === list.dataset.chatList) return;
    drafts.set(list.dataset.chatList, input.value);
    closePicker();
    clearReply();
    list = lists.find(item => item.dataset.chatList === id);
    lists.forEach(item => { item.hidden = item !== list; });
    section.querySelectorAll('[data-chat-channel]').forEach(item => {
      item.classList.toggle('is-current', item === button);
      item.setAttribute('aria-pressed', item === button);
    });
    win.querySelector('[data-chat-name]').textContent = copy.channels[id];
    input.placeholder = button.dataset.placeholder;
    input.value = drafts.get(id) || '';
    composer.classList.toggle('has-text', !!input.value.trim());
    empty.hidden = !!list.children.length;
    updatePins();
    toBottom(false);
  });
});
