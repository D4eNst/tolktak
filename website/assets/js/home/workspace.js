import { icon, reducedMotion } from '../site.js';
import { themes, customTheme } from './themes.js';
import { beat, progress, mix, sceneAt, script } from './workspace-timeline.js';

const story = document.querySelector('[data-workstory]');
const pin = story.querySelector('.w-story-pin');
const frame = story.querySelector('[data-workspace]');
const desk = frame.querySelector('[data-desk]');
const host = desk.querySelector('[data-columns]');
const settings = frame.querySelector('[data-settings]');
const backdrop = settings.querySelector('.w-story-backdrop');
const panel = settings.querySelector('.w-story-settings');
const appLayers = [frame.querySelector('.w-chat-titlebar'), frame.querySelector('.w-chat-workspace')];
const menu = desk.querySelector('[data-desk-menu]');
const picker = desk.querySelector('[data-story-picker]');
const drop = desk.querySelector('[data-desk-drop]');
const cursor = story.querySelector('[data-script-cursor]');
const ghost = story.querySelector('[data-script-ghost]');
const steps = [...story.querySelectorAll('[data-chapter]')];
const copy = JSON.parse(document.getElementById('w-workspace-copy').textContent);
const panes = Object.fromEntries([...desk.querySelectorAll('[data-pane]')].map(pane => [pane.dataset.pane, pane]));
const row = id => frame.querySelector(`[data-story-row="${id}"]`);
const voice = frame.querySelector('[data-voice-pane]');
const screen = frame.querySelector('[data-screen-pane]');
const sound = frame.querySelector('[data-sound-pane]');
const room = voice.querySelector('.w-voice-room');
const tiles = voice.querySelector('[data-voice-tiles]');
const appearance = settings.querySelector('[data-setting-page="appearance"]');
const swatches = settings.querySelector('.w-theme-swatches');
const custom = settings.querySelector('[data-custom-theme]');
const hue = settings.querySelector('[data-custom="hue"]');
const customInputs = [...settings.querySelectorAll('[data-custom]')];
const connection = frame.querySelector('[data-story-connection]');
let time = 0;
let lastJoined;
let lastLive;
let chapter;
let manualSettings = null;
let manualTheme = null;
let manualVoice = null;
let manualCall = false;
let activeTab = 'chat';

function group(ids) {
  const el = document.createElement('div');
  el.className = 'w-pane-group';
  el.innerHTML = `<div class="w-pane-tabs${ids.length === 1 ? ' is-single' : ''}"><span class="w-capsule-avatar" aria-hidden="true">🎲</span>${ids.map(id => `<button type="button" data-story-tab="${id}" aria-pressed="${id === ids[0]}"><span>${panes[id].getAttribute('aria-label')}</span>${icon('x', 12)}</button>`).join('')}<span class="w-capsule-menu" aria-hidden="true">···</span></div><div class="w-pane-body"></div>`;
  const body = el.lastElementChild;
  ids.forEach((id, i) => { panes[id].hidden = i !== 0; body.append(panes[id]); });
  host.append(el);
  return el;
}
const chatGroup = group(['chat', 'links']);
const roomGroup = group(['voice']);
const linksTab = chatGroup.querySelector('[data-story-tab="links"]');
const chatMenu = chatGroup.querySelector('.w-capsule-menu');
room.insertBefore(screen, room.querySelector('.w-voice-bar'));
panes.screen.remove();
desk.querySelector('[data-pane-parking]').remove();
frame.classList.add('is-scroll-scene');

function rect(el) {
  const box = el.getBoundingClientRect();
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}
const center = el => { const r = rect(el); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const interpolatePoint = (a, b, p) => ({ x: mix(a.x, b.x, p), y: mix(a.y, b.y, p) });
function place(el, box) {
  Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
}
function reveal(el, opacity) {
  el.hidden = opacity <= 0;
  el.style.opacity = opacity;
  el.inert = opacity < .95;
}
function selectTab(id) {
  activeTab = id;
  for (const name of ['chat', 'links']) {
    panes[name].hidden = name !== id;
    chatGroup.querySelector(`[data-story-tab="${name}"]`).setAttribute('aria-pressed', name === id);
  }
}
function showSettings(tab) {
  settings.querySelectorAll('[data-setting-page]').forEach(page => { page.hidden = page.dataset.settingPage !== tab; });
  settings.querySelectorAll('[data-setting-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.settingTab === tab ? 'page' : 'false'));
}
function themeValues(id) {
  if (id !== 'custom') return { ...themes.petrol, ...themes[id] };
  return { ...themes.petrol, ...customTheme(Object.fromEntries(customInputs.map(input => [input.dataset.custom, input.type === 'checkbox' ? input.checked : input.type === 'color' ? input.value : +input.value]))) };
}
let painted = '';
function paintTheme(from, to = from, amount = 1) {
  const key = `${from}|${to}|${amount.toFixed(3)}|${customInputs.map(i => i.type === 'checkbox' ? i.checked : i.value)}`;
  if (key === painted) return;
  painted = key;
  const a = themeValues(from), b = themeValues(to);
  for (const key of Object.keys(a)) {
    const value = amount === 0 ? a[key] : amount === 1 || a[key] === b[key] ? b[key]
      : key === '--grad' ? (amount < .5 ? a[key] : b[key]) : `color-mix(in srgb, ${a[key]}, ${b[key]} ${amount * 100}%)`;
    frame.style.setProperty(key, value);
  }
  const id = amount > 0 ? to : from;
  frame.dataset.theme = id;
  frame.style.colorScheme = ['paper', 'frost'].includes(id) || (id === 'custom' && settings.querySelector('[data-custom="light"]').checked) ? 'light' : 'dark';
  settings.querySelectorAll('[data-theme-pick]').forEach(button => button.setAttribute('aria-pressed', button.dataset.themePick === id));
}

function render(value) {
  const bounds = rect(desk);
  if (!bounds.w || !bounds.h) return;
  const s = sceneAt(manualCall ? script.rests[1] : value, bounds.w, bounds.h, innerWidth <= 760);
  if (manualVoice !== null) s.joined = manualVoice;
  const t = s.t;
  frame.dataset.progress = t.toFixed(4);
  frame.dataset.chapter = s.chapter;
  frame.dataset.layout = s.floating ? 'floating' : s.split ? 'split' : 'chat';
  if (chapter !== s.chapter) {
    chapter = s.chapter;
    story.querySelectorAll('[data-chapter-copy]').forEach(el => { el.hidden = el.dataset.chapterCopy !== chapter; });
    story.querySelectorAll('[data-story-go]').forEach(el => el.setAttribute('aria-current', el.dataset.storyGo === chapter ? 'step' : 'false'));
  }
  place(chatGroup, s.chat);
  place(roomGroup, s.room);
  reveal(roomGroup, s.roomOpacity);
  roomGroup.style.transform = `translateY(${(1 - s.roomOpacity) * 18}px)`;
  roomGroup.style.clipPath = s.split < 1 ? `inset(0 0 0 ${(1 - s.split) * 100}%)` : 'none';
  chatGroup.classList.toggle('is-compact', s.split > 0);
  chatGroup.style.setProperty('--split', s.split);
  chatGroup.classList.toggle('is-floating', s.floating > 0);
  chatGroup.style.opacity = s.opacity;
  linksTab.hidden = s.tab === 0;
  linksTab.style.opacity = s.tab;
  linksTab.style.maxWidth = `${s.tab * 135}px`;
  chatGroup.querySelector('.w-pane-tabs').classList.toggle('is-single', s.tab === 0);
  if (!s.tab && activeTab === 'links') selectTab('chat');

  if (!manualCall && lastJoined !== s.joined) {
    voice.dispatchEvent(new CustomEvent('w-voice-demo', { detail: s.joined }));
    lastJoined = s.joined;
  }
  connection.hidden = manualCall || !s.joined;
  connection.querySelector('span').textContent = copy.chapters[1].label;
  frame.querySelector('[data-story-you]').hidden = manualCall || !s.joined;
  frame.querySelector('[data-story-live]').hidden = s.stream === 0;
  row('voice').classList.toggle('is-current', s.split > 0);
  row('chat').classList.toggle('is-current', activeTab === 'chat');
  row('links').classList.toggle('is-current', activeTab === 'links');
  const live = s.stream > 0;
  if (lastLive !== live) {
    screen.dispatchEvent(new CustomEvent('w-screen-demo', { detail: live ? 'live' : 'idle' }));
    lastLive = live;
  }
  reveal(screen, s.stream);
  screen.style.flex = `${s.stream} 1 0px`;
  const compact = innerWidth <= 760;
  const roomHeight = s.room.h - (compact ? 42 : 54);
  const barHeight = room.querySelector('.w-voice-bar').offsetHeight;
  const fullHeight = Math.max(0, roomHeight - barHeight);
  const stripHeight = compact ? 44 : 68;
  tiles.style.flex = 'none';
  tiles.style.height = `${mix(fullHeight, stripHeight, s.stream)}px`;
  tiles.style.setProperty('--stream', s.stream);
  const columns = compact ? 4 : 2;
  const tileWidth = (s.room.w - 24 - (columns - 1) * 8) / columns;
  const tileHeight = Math.min(tileWidth / 1.1, (fullHeight - 32) / Math.ceil(tiles.children.length / columns));
  const rows = Math.ceil(tiles.children.length / columns);
  const gridHeight = rows * tileHeight + (rows - 1) * 8;
  [...tiles.children].forEach((tile, i) => {
    place(tile, {
      x: mix(12 + i % columns * (tileWidth + 8), 12 + i * (compact ? 50 : 72), s.stream),
      y: mix((fullHeight - gridHeight) / 2 + Math.floor(i / columns) * (tileHeight + 8), 8, s.stream),
      w: mix(tileWidth, compact ? 42 : 64, s.stream),
      h: mix(tileHeight, compact ? 28 : 48, s.stream),
    });
    tile.style.opacity = tile.classList.contains('is-you') && manualVoice === null ? beat(t, ...script.fx.joined) : 1;
  });
  const chatScroll = panes.chat.querySelector('[data-chat-scroll]');
  chatScroll.scrollTop = (chatScroll.scrollHeight - chatScroll.clientHeight) * s.floating;
  room.classList.toggle('is-streaming', s.stream > 0);

  reveal(picker, s.picker);
  picker.style.transform = `translateY(${(1 - s.picker) * 12}px)`;
  picker.querySelector('[data-story-source]').classList.toggle('is-picked', s.picked);
  reveal(menu, Math.max(s.menu, s.opacityMenu));
  const dimming = s.opacityMenu > 0;
  menu.querySelector('[data-script-opacity]').hidden = !dimming;
  menu.querySelectorAll(':scope > span').forEach(el => { el.hidden = dimming; });
  const menuOrigin = rect(chatMenu);
  menu.style.left = `${Math.min(bounds.w - menu.offsetWidth, Math.max(0, menuOrigin.x - bounds.x - menu.offsetWidth + 20))}px`;
  menu.style.top = `${Math.min(bounds.h - menu.offsetHeight, menuOrigin.y - bounds.y + 28)}px`;
  menu.querySelector('output').textContent = `${Math.round(s.opacity * 100)}%`;
  menu.querySelector('i b').style.width = `${s.opacity * 100}%`;

  frame.toggleAttribute('data-manual-settings', !!manualSettings && manualSettings !== 'closed');
  const open = manualSettings === 'closed' ? 0 : manualSettings ? 1 : s.settings;
  settings.hidden = open <= 0;
  settings.inert = open < .95;
  appLayers.forEach(el => { el.inert = open > 0; });
  backdrop.style.opacity = open;
  panel.style.opacity = open;
  panel.style.transform = `translateY(${(1 - open) * 14}px) scale(${.97 + open * .03})`;
  const page = manualSettings && manualSettings !== 'closed' ? manualSettings : s.page;
  showSettings(page);
  const pageEl = settings.querySelector(`[data-setting-page="${page}"]`);
  const pageIn = manualSettings ? 1 : s.pageIn;
  pageEl.style.opacity = pageIn;
  pageEl.style.transform = `translateY(${(1 - pageIn) * 6}px)`;
  if (!settings.hidden && page === 'sound' && !manualSettings)
    sound.dispatchEvent(new CustomEvent('w-sound-demo', { detail: { picked: s.noisePicked, amount: s.suppression } }));
  if (!manualTheme) {
    hue.value = Math.round(s.hue);
    hue.nextElementSibling.textContent = hue.value;
    paintTheme(...s.theme);
  }
  const customAmount = manualTheme ? +(manualTheme === 'custom') : s.custom;
  custom.hidden = customAmount === 0;
  custom.style.opacity = customAmount;
  swatches.classList.toggle('is-custom', customAmount === 1);
  if (!manualSettings && !appearance.hidden) {
    const target = Math.max(0, custom.offsetTop - appearance.offsetTop - 12);
    appearance.scrollTop = target * customAmount;
  }

  cursor.hidden = ghost.hidden = drop.hidden = true;
  frame.querySelectorAll('.is-script-target, .is-drag-source').forEach(el => el.classList.remove('is-script-target', 'is-drag-source'));
  if (reducedMotion || document.hidden || bounds.y > innerHeight || bounds.y + bounds.h < 0 || manualSettings || manualTheme) return;
  const c = cursorAt(t, s, bounds);
  if (!c || c.opacity <= 0) return;
  const { a, point } = c, source = sources[a.name];
  const pressing = t >= a.press && t <= a.lift;
  const pulse = pressing ? Math.sin(progress(t, a.press, a.lift) * Math.PI) : 0;
  cursor.hidden = false;
  cursor.style.opacity = c.opacity;
  cursor.style.transform = `translate(${point.x}px,${point.y}px) scale(${c.held && a.kind !== 'click' ? .88 : 1 - pulse * .16})`;
  cursor.style.setProperty('--click', a.kind === 'click' ? pulse : 0);
  if (a.kind === 'click' && pressing) source.classList.add('is-script-target');
  if (a.kind === 'drag' && c.held) {
    const out = 1 - beat(t, a.end - 6, a.end);
    source.classList.add('is-drag-source');
    ghost.hidden = drop.hidden = false;
    ghost.textContent = source.querySelector('span').textContent;
    ghost.style.transform = `translate(${point.x}px,${point.y}px)`;
    ghost.style.opacity = beat(t, a.press, a.press + 6) * out;
    drop.classList.toggle('is-tab-target', a.name === 'links');
    place(drop, dropBox(a.name, s));
    drop.style.opacity = beat(t, a.press, a.lift + 8) * out;
  }
}

const LINK = 80;
const sources = {
  links: row('links'), voice: row('voice'), join: voice.querySelector('[data-voice-join]'),
  share: voice.querySelector('[data-vc="share"]'), source: picker.querySelector('[data-story-source]'),
  start: picker.querySelector('[data-story-share]'), chatMenu, chatMenuAgain: chatMenu,
  float: menu.querySelector('[data-story-menu-float]'), opacity: menu.querySelector('.w-script-opacity i'),
  gear: frame.querySelector('.w-chat-me a'), soundTab: settings.querySelector('[data-setting-tab="sound"]'),
  suppress: settings.querySelector('[data-seg] input[value="2"]').parentElement,
  appearanceTab: settings.querySelector('[data-setting-tab="appearance"]'),
  embers: settings.querySelector('[data-theme-pick="embers"]'), paper: settings.querySelector('[data-theme-pick="paper"]'),
  custom: settings.querySelector('[data-theme-pick="custom"]'), hue, close: settings.querySelector('[data-close-settings]'),
};
const slides = { opacity: [1, .7], hue: [190 / 360, 245 / 360] };
let seen = {};
function spot(name) {
  const box = rect(sources[name]);
  if (box.w) seen[name] = { x: box.x + box.w / 2, y: box.y + box.h / 2, box };
  return seen[name];
}
function dropBox(name, s) {
  if (name === 'voice') return s.room;
  const d = rect(desk), label = rect(chatGroup.querySelector('[data-story-tab="chat"] > span'));
  const h = innerWidth <= 760 ? 30 : 38;
  return { x: label.x + label.w + 8 - d.x, y: label.y + label.h / 2 - h / 2 - d.y, w: innerWidth <= 760 ? 92 : 132, h };
}
function path(a, s, bounds) {
  const hit = spot(a.name);
  if (!hit) return null;
  if (a.kind === 'slide') {
    const [v0, v1] = slides[a.name], b = hit.box;
    const thumb = v => ({ x: b.x + 7 + (b.w - 14) * v, y: b.y + b.h / 2 });
    return { from: thumb(v0), to: thumb(v1) };
  }
  if (a.kind === 'drag') {
    const box = dropBox(a.name, s);
    return { from: hit, to: { x: bounds.x + box.x + box.w / 2, y: bounds.y + box.y + box.h * (a.name === 'voice' ? .45 : .5) } };
  }
  return { from: hit, to: hit };
}
function cursorAt(t, s, bounds) {
  const list = script.actions, i = list.findLastIndex(a => t >= a.start), a = list[i];
  const route = a && path(a, s, bounds);
  if (!route) return null;
  const prev = list[i - 1], next = list[i + 1];
  if (t < a.press) {
    const origin = prev && a.start - prev.end <= LINK ? path(prev, s, bounds)?.to : null;
    const off = innerWidth <= 760 ? [54, 42] : [90, 70];
    const from = origin ?? { x: route.from.x + off[0], y: route.from.y + off[1] };
    return { a, point: interpolatePoint(from, route.from, beat(t, a.start, a.press)), opacity: origin ? 1 : progress(t, a.start, a.start + 10) };
  }
  if (t <= a.end) {
    const k = beat(t, a.lift, a.end), point = interpolatePoint(route.from, route.to, k);
    if (a.kind === 'drag') point.y -= Math.sin(k * Math.PI) * 26;
    return { a, point, opacity: 1, held: true };
  }
  const linked = next && next.start - a.end <= LINK;
  return { a, point: route.to, opacity: linked ? 1 : 1 - progress(t, a.end + 8, a.end + 20) };
}

const SMOOTH = 100, SNAP = 260;
let pinTop = 0, shown = null, last = 0, frameId = 0, jumpUntil = 0;
const measurePin = () => { pinTop = parseFloat(getComputedStyle(pin).top); };
function position() {
  const index = Math.max(0, steps.findLastIndex(step => step.getBoundingClientRect().top <= pinTop + 1));
  const box = steps[index].getBoundingClientRect(), { start, length } = script.chapters[index];
  return start + length * Math.max(0, Math.min(1, (pinTop - box.top) / box.height));
}
function update(now) {
  frameId = 0;
  const target = position();
  if (shown === null || now < jumpUntil || Math.abs(target - shown) > SNAP) shown = target;
  else shown += (target - shown) * (1 - Math.exp(-Math.min(50, now - last) / SMOOTH));
  if (Math.abs(target - shown) < .05) shown = target;
  last = now;
  time = shown;
  render(reducedMotion ? script.rests[script.chapters.findLastIndex(c => target >= c.start)] : shown);
  if (shown !== target) frameId = requestAnimationFrame(update);
}
function schedule() {
  if (!frameId) { last = performance.now(); frameId = requestAnimationFrame(update); }
}
const jump = () => { jumpUntil = performance.now() + 900; schedule(); };
const remeasure = () => { seen = {}; measurePin(); schedule(); };
measurePin();
addEventListener('scroll', () => { manualSettings = manualTheme = manualVoice = null; manualCall = false; schedule(); }, { passive: true });
addEventListener('resize', remeasure);
new ResizeObserver(remeasure).observe(desk);
addEventListener('hashchange', jump);
story.addEventListener('click', e => { if (e.target.closest('[data-story-go], [data-replay], [data-goto]')) jump(); });
document.fonts.ready.then(schedule);
document.addEventListener('visibilitychange', schedule);

host.addEventListener('click', event => {
  const tab = event.target.closest('[data-story-tab]');
  if (tab && ['chat', 'links'].includes(tab.dataset.storyTab)) selectTab(tab.dataset.storyTab);
});
story.querySelectorAll('[data-replay]').forEach(button => button.addEventListener('click', () => document.getElementById(`w-${button.dataset.replay}`).scrollIntoView({ behavior: 'auto' })));
settings.addEventListener('pointerdown', () => {
  manualSettings = settings.querySelector('[data-setting-page]:not([hidden])').dataset.settingPage;
  frame.setAttribute('data-manual-settings', '');
  cursor.hidden = true;
});
settings.querySelectorAll('button[data-setting-tab]').forEach(button => button.addEventListener('click', () => { manualSettings = button.dataset.settingTab; render(time); }));
settings.querySelector('[data-close-settings]').addEventListener('click', () => { manualSettings = 'closed'; render(time); });
backdrop.addEventListener('click', () => { manualSettings = 'closed'; render(time); });
frame.addEventListener('keydown', event => { if (event.key === 'Escape' && !settings.hidden) { manualSettings = 'closed'; render(time); } });
frame.querySelector('.w-chat-me a').addEventListener('click', event => {
  if (chapter !== 'sound' && chapter !== 'appearance') return;
  event.preventDefault();
  manualSettings = chapter;
  render(time);
});
settings.querySelectorAll('[data-theme-pick]').forEach(button => button.addEventListener('click', () => {
  manualTheme = button.dataset.themePick;
  paintTheme(manualTheme);
  custom.hidden = manualTheme !== 'custom';
  custom.style.opacity = 1;
  swatches.classList.toggle('is-custom', manualTheme === 'custom');
  if (manualTheme === 'custom') appearance.scrollTo({ top: custom.offsetTop - appearance.offsetTop - 12, behavior: reducedMotion ? 'auto' : 'smooth' });
  cursor.hidden = true;
}));
customInputs.forEach(input => input.addEventListener('input', () => {
  manualTheme = 'custom';
  if (input.nextElementSibling?.tagName === 'OUTPUT') input.nextElementSibling.textContent = input.value;
  paintTheme('custom');
  cursor.hidden = true;
}));
const online = frame.querySelector('.w-voice-online');
frame.querySelector('[data-nav-people]').append(online);
frame.querySelectorAll('[data-nav-tab]').forEach(button => button.addEventListener('click', () => {
  const people = button.dataset.navTab === 'people';
  frame.querySelector('[data-nav-people]').hidden = !people;
  frame.querySelector('[data-nav-groups]').hidden = people;
  frame.querySelectorAll('[data-nav-tab]').forEach(el => el.setAttribute('aria-pressed', el === button));
}));
online.addEventListener('click', event => {
  if (!event.target.closest('[data-call]')) return;
  manualCall = true;
  lastJoined = undefined;
  render(time);
});
voice.addEventListener('click', event => {
  if (event.target.closest('[data-voice-join], [data-vc="leave"]')) {
    manualVoice = !voice.querySelector('[data-voice-ctrls]').hidden;
    render(time);
  }
});
frame.querySelector('[data-top-mic]').addEventListener('click', () => voice.querySelector('[data-vc="mic"]').click());
frame.querySelector('[data-top-leave]').addEventListener('click', () => voice.querySelector('[data-vc="leave"]').click());
new MutationObserver(() => {
  connection.hidden = voice.querySelector('[data-voice-ctrls]').hidden;
  frame.querySelector('[data-story-you]').hidden = connection.hidden;
  frame.querySelector('[data-top-mic]').setAttribute('aria-pressed', voice.querySelector('[data-vc="mic"]').getAttribute('aria-pressed'));
}).observe(voice.querySelector('[data-voice-ctrls]'), { attributes: true, subtree: true });
schedule();
