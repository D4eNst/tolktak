export const clamp = value => Math.max(0, Math.min(1, value));
export const mix = (a, b, p) => a + (b - a) * p;
export const progress = (time, start, end) => end > start ? clamp((time - start) / (end - start)) : +(time >= end);
export const ease = value => value * value * (3 - 2 * value);
export const beat = (time, start, end) => ease(progress(time, start, end));

// One unit is 1% of the pinned frame height.
export const PACE = 1;
const fx = {}, act = {}, actions = [], chapters = [], rests = [];
let at = 0;
const wait = n => { at += n * PACE; };
const effect = (name, n) => { fx[name] = [at, at += n * PACE]; };
const settle = n => { rests.push(at + n * PACE / 2); wait(n); };
const chapter = (id, intro) => { chapters.push({ id, start: at }); wait(intro); };
function action(name, kind, travel, carry = 0) {
  const a = { name, kind, start: at };
  a.press = at += travel * PACE;
  a.lift = at += 8 * PACE;
  a.end = at += carry * PACE;
  actions.push(act[name] = a);
}
const click = (name, travel = 34) => action(name, 'click', travel);
const drag = (name, carry = 56) => action(name, 'drag', 34, carry);
const slide = (name, travel = 24) => action(name, 'slide', travel, 44);

chapter('chat', 36);
drag('links'); effect('tab', 22); settle(44);

chapter('voice', 30);
drag('voice', 60); effect('split', 48);
click('join', 30); effect('joined', 12); settle(56);

chapter('screen', 30);
click('share'); effect('picker', 14);
click('source', 26); wait(8);
click('start', 26); effect('stream', 44); settle(32);

chapter('layout', 0);
click('chatMenu', 40); effect('menu', 14);
click('float', 22); effect('floating', 50); wait(26);
click('chatMenuAgain', 36); effect('opacityMenu', 14);
slide('opacity'); effect('menuClose', 12); settle(56);

chapter('sound', 26);
click('gear', 40); effect('settings', 38); wait(10);
click('soundTab', 30); effect('soundPage', 12);
click('suppress', 32); effect('suppression', 46); settle(56);

chapter('appearance', 26);
click('appearanceTab'); effect('appearancePage', 12);
click('embers', 30); effect('embers', 20); wait(12);
click('paper', 26); effect('paper', 20); wait(12);
click('custom', 26); effect('custom', 20);
slide('hue', 26); wait(20);
click('close'); effect('close', 28); settle(60);

chapters.forEach((c, i) => { c.length = (chapters[i + 1]?.start ?? at) - c.start; });
export const script = { end: at, chapters, actions, act, fx, rests };

const f = (t, name, delay = 0) => beat(t, fx[name][0] + delay * PACE, fx[name][1]);

export function sceneAt(time, width, height, compact = false) {
  const t = Math.max(0, Math.min(at, time));
  const split = f(t, 'split');
  const floating = f(t, 'floating');
  const gap = compact ? 8 : 12;
  const chat = compact
    ? { x: 0, y: 0, w: width, h: mix(height, height * .48 - gap / 2, split) }
    : { x: 0, y: 0, w: mix(width, width * .47 - gap / 2, split), h: height };
  const room = compact
    ? { x: 0, y: height * .48 + gap / 2, w: width, h: height * .52 - gap / 2 }
    : { x: width * .47 + gap / 2, y: 0, w: width * .53 - gap / 2, h: height };
  const destination = compact
    ? { x: width * .10, y: height * .35, w: width * .87, h: height * .45 }
    : { x: width * .54, y: height * .32, w: width * .43, h: height * .52 };
  for (const key of ['x', 'y', 'w', 'h']) {
    chat[key] = mix(chat[key], destination[key], floating);
    room[key] = mix(room[key], { x: 0, y: 0, w: width, h: height }[key], floating);
  }
  const page = t < act.soundTab.lift ? 'profile' : t < act.appearanceTab.lift ? 'sound' : 'appearance';
  return {
    t, chapter: chapters.findLast(c => t >= c.start).id, chat, room,
    tab: f(t, 'tab'), split, floating,
    roomOpacity: beat(t, fx.split[0], fx.split[0] + 34 * PACE),
    joined: t >= fx.joined[0],
    picker: f(t, 'picker') * (1 - beat(t, fx.stream[0], fx.stream[0] + 10 * PACE)),
    picked: t >= act.source.lift,
    stream: f(t, 'stream', 8),
    menu: f(t, 'menu') * (1 - beat(t, fx.floating[0], fx.floating[0] + 8 * PACE)),
    opacityMenu: f(t, 'opacityMenu') * (1 - f(t, 'menuClose')),
    opacity: mix(1, .7, beat(t, act.opacity.lift, act.opacity.end)),
    settings: f(t, 'settings') * (1 - f(t, 'close')),
    page,
    pageIn: page === 'sound' ? f(t, 'soundPage') : page === 'appearance' ? f(t, 'appearancePage') : 1,
    noisePicked: t >= act.suppress.lift,
    suppression: f(t, 'suppression'),
    theme: t < fx.embers[0] ? ['petrol', 'petrol', 1]
      : t < fx.paper[0] ? ['petrol', 'embers', f(t, 'embers')]
      : t < fx.custom[0] ? ['embers', 'paper', f(t, 'paper')]
      : ['paper', 'custom', f(t, 'custom')],
    custom: f(t, 'custom'),
    hue: mix(190, 245, beat(t, act.hue.lift, act.hue.end)),
  };
}
