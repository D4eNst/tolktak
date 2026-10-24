import { ava, icon, nameOf, openSwitcher, reducedMotion, replay, site, visible } from '../site.js';
import { clock, person } from '../markup.js';
import { draggable } from './drag.js';

const section = document.getElementById('w-chat');
const copy = JSON.parse(document.getElementById('w-chat-copy').textContent);
const win = section.querySelector('[data-chat]');
const scroll = win.querySelector('[data-chat-scroll]');
const list = win.querySelector('[data-chat-list]');
const pins = win.querySelector('[data-chat-pins]');
const pinText = win.querySelector('[data-chat-pin-text]');
const pinCount = win.querySelector('[data-chat-pin-count]');
const composer = win.querySelector('[data-chat-composer]');
const input = win.querySelector('[data-chat-input]');
const replying = win.querySelector('[data-chat-replying]');
const replyWho = win.querySelector('[data-chat-reply-who]');
const replyText = win.querySelector('[data-chat-reply-text]');
const tray = section.querySelector('[data-chat-tray]');

const colorOf = id => (id === 'me' ? '' : person(id, site.lang).color);
const messages = () => [...list.querySelectorAll('.w-chat-msg:not(.is-hidden)')];
const snippet = li => li.querySelector('.w-chat-text')?.textContent.trim() || (li.querySelector('.w-chat-sticker') ? copy.sticker : copy.attachment);
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

let pinned = 1;
function pin(li) {
  if (!li.classList.contains('is-pinned')) {
    li.classList.add('is-pinned');
    const mark = document.createElement('p');
    mark.className = 'w-chat-pinmark' + (reducedMotion ? '' : ' is-new');
    mark.innerHTML = `${icon('pin', 12)}${copy.pinned}`;
    li.querySelector('.w-chat-body').prepend(mark);
    pinned += 1;
    pinCount.textContent = pinned;
  }
  const name = document.createElement('em');
  name.textContent = nameOf(li.dataset.who) + ':';
  pinText.replaceChildren(name, ' ' + snippet(li));
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

let minute = copy.clock;
function post(who, text, quote) {
  minute += 1;
  const li = document.createElement('li');
  li.className = 'w-chat-msg' + (quote ? ' has-quote' : '') + (reducedMotion ? '' : ' is-new');
  li.dataset.who = who;
  li.tabIndex = 0;
  li.setAttribute('aria-keyshortcuts', 'r p');
  li.innerHTML = `${ava(who, 36)}<div class="w-chat-body">
    ${quote ? `<p class="w-chat-quote">${ava(quote.who, 16)}<b></b><span></span></p>` : ''}
    <p class="w-chat-meta"><b></b><time>${clock(minute, site.lang)}</time></p>
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
  list.appendChild(li);
  while (list.children.length > 16) list.firstElementChild.remove();
  requestAnimationFrame(() => toBottom());
  return li;
}

let answering = false;
function send() {
  const text = input.value.trim();
  if (!text) return;
  const quote = replyTo;
  const mine = post('me', text, quote);
  input.value = '';
  composer.classList.remove('has-text');
  clearReply();
  if (answering) return;
  answering = true;
  const who = quote && copy.replies[quote.who] ? quote.who : any(Object.keys(copy.replies));
  setTimeout(() => react(mine, any(['👍', '🔥', '😂', '❤️']), { mine: false }), reducedMotion ? 0 : 700);
  setTimeout(() => {
    post(who, any(copy.replies[who]), { who: 'me', text });
    answering = false;
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

list.addEventListener('click', event => {
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
// "к" and "з" are where "r" and "p" sit on the Russian layout.
list.addEventListener('keydown', event => {
  const li = event.target;
  if (!li.matches('.w-chat-msg') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'r' || event.key === 'к') setReply(li);
  if (event.key === 'p' || event.key === 'з') pin(li);
});
document.addEventListener('pointerdown', event => picker && !picker.contains(event.target) && closePicker());
win.addEventListener('keydown', event => event.key === 'Escape' && closePicker({ focus: true }));
win.querySelector('[data-chat-find]').addEventListener('click', openSwitcher);
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
      closePicker();
    },
    end: () => win.classList.remove('is-dragging-msg'),
  });
}

list.querySelectorAll('.w-chat-msg').forEach(li => {
  addActions(li);
  draggableMessage(li);
});

const later = [...list.children].slice(2);
if (!reducedMotion) later.forEach(li => li.classList.add('is-hidden'));
toBottom(false);
if (!reducedMotion) {
  const observer = visible(win, () => {
    observer.disconnect();
    later.forEach((li, i) => setTimeout(() => {
      li.classList.remove('is-hidden');
      li.classList.add('is-new');
      toBottom();
    }, 350 + i * 650));
  });
}
