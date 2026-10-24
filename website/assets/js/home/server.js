import { copyText, icon, reducedMotion } from '../site.js';

const section = document.getElementById('w-server');
const stage = section.querySelector('.w-server-stage');
const svg = stage.querySelector('.w-srv-svg');
const labels = stage.querySelector('.w-srv-labels');
const soft = svg.querySelector('.w-srv-soft');
const input = stage.querySelector('.w-srv-addr input');
const status = stage.querySelector('[data-srv-status]');
const engrave = svg.querySelector('[data-srv-addr]');
const text = JSON.parse(document.getElementById('w-server-copy').textContent);
const order = ['hw', 'data', 'code', 'tolktak', 'house'];

// SVG units per CSS pixel, so the HTML labels move together with the layers.
let scale = 1;
let hot = null;
let pinned = null;

function measure() {
  scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width || 1;
  if (hot) setHot(hot, true);
}

function setHot(name, force = false) {
  if (name === hot && !force) return;
  hot = name;
  const at = name ? order.indexOf(name) : -1;
  const offset = i => (at < 0 ? 0 : i > at ? -30 : i === at ? -16 : 0);
  svg.querySelectorAll('.w-srv-hw.is-on .w-srv-layer, .w-srv-soft .w-srv-layer').forEach(g => {
    const i = order.indexOf(g.dataset.layer);
    g.style.setProperty('--dy', `${offset(i)}px`);
    g.classList.toggle('is-hot', i === at);
  });
  labels.querySelectorAll('button').forEach(button => {
    const i = order.indexOf(button.dataset.layer);
    button.parentElement.style.setProperty('--dy', `${offset(i) * scale}px`);
    button.classList.toggle('is-hot', i === at);
  });
}

const layerOf = target => target.closest?.('.w-srv-layer')?.dataset.layer || null;
svg.addEventListener('pointerover', e => {
  if (e.pointerType !== 'touch' && layerOf(e.target)) setHot(layerOf(e.target));
});
svg.addEventListener('pointerleave', () => setHot(pinned));
svg.addEventListener('click', e => {
  const name = layerOf(e.target);
  pinned = name && pinned !== name ? name : null;
  setHot(pinned);
});
labels.querySelectorAll('button').forEach(button => (button.disabled = false));
labels.addEventListener('pointerover', e => {
  const button = e.target.closest('button');
  if (button && e.pointerType !== 'touch') setHot(button.dataset.layer);
});
labels.addEventListener('pointerleave', () => setHot(pinned));
labels.addEventListener('focusin', e => setHot(e.target.closest('button').dataset.layer));
labels.addEventListener('focusout', () => setHot(pinned));
labels.addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  pinned = pinned === button.dataset.layer ? null : button.dataset.layer;
  setHot(pinned || button.dataset.layer, true);
});

const radios = [...stage.querySelectorAll('.w-srv-where [role="radio"]')];
const hardware = { home: svg.querySelector('[data-hw="home"]'), vps: svg.querySelector('[data-hw="vps"]') };
const hwName = stage.querySelector('[data-hw-name]');
let where = 'home';
let busy = false;

function lift(px) {
  soft.style.setProperty('--lift', `${px}px`);
  labels.style.setProperty('--lift-px', `${px * scale}px`);
}

function restart(el) {
  el.classList.add('is-reset');
  void el.getBoundingClientRect();
  el.classList.remove('is-reset');
}

function swap(to) {
  if (to === where || busy) return;
  const [from, next] = [hardware[where], hardware[to]];
  where = to;
  radios.forEach(radio => {
    const on = radio.dataset.where === to;
    radio.setAttribute('aria-checked', on);
    radio.tabIndex = on ? 0 : -1;
  });
  hwName.textContent = text.hardware[to];
  const row = hwName.closest('li');
  row.style.top = to === 'vps' ? row.dataset.topVps : row.dataset.topHome;
  const keepHot = hot === 'hw';
  setHot(null);
  if (reducedMotion) {
    from.classList.remove('is-on');
    next.classList.add('is-on');
    if (keepHot) setHot('hw');
    return;
  }
  busy = true;
  stage.classList.add('is-swapping');
  lift(-48);
  setTimeout(() => {
    from.classList.replace('is-on', 'is-leaving');
    next.classList.remove('is-leaving');
    restart(next);
    next.classList.add('is-on');
  }, 170);
  setTimeout(() => {
    stage.classList.replace('is-swapping', 'is-drop');
    lift(0);
  }, 640);
  setTimeout(() => next.classList.add('is-thump'), 760);
  setTimeout(() => {
    stage.classList.remove('is-drop');
    next.classList.remove('is-thump');
    from.classList.remove('is-leaving');
    restart(from);
    busy = false;
    if (keepHot) setHot('hw');
  }, 1250);
}

radios.forEach((radio, i) => {
  radio.addEventListener('click', () => swap(radio.dataset.where));
  radio.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    if (busy) return;
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const target = radios[(i + step + radios.length) % radios.length];
    target.focus();
    swap(target.dataset.where);
  });
});

const isIp = value => /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
const isDomain = value => /^([\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}$/u.test(value);
const clean = value => value.toLowerCase().replace(/^\s*https?:\/\//, '').replace(/\/.*$/, '').replace(/[^\p{L}\p{N}.-]/gu, '').slice(0, 40);
let shown = text.sample;

function showAddress() {
  const value = clean(input.value) || text.sample;
  stage.classList.toggle('is-valid', isIp(value) || isDomain(value));
  if (value === shown) return;
  const grew = value.length > shown.length;
  shown = value;
  engrave.textContent = value;
  engrave.style.fontSize = `${Math.max(8, Math.min(14, 268 / (value.length * 0.6))).toFixed(2)}px`;
  section.querySelector('[data-srv-room]').textContent = value;
  if (grew && !reducedMotion) engrave.animate([{ fill: '#fff4dc' }, {}], { duration: 520, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
}

input.addEventListener('input', showAddress);
input.addEventListener('focus', () => input.value === text.sample && input.select());
input.addEventListener('blur', () => {
  if (!clean(input.value)) input.value = text.sample;
});
stage.classList.add('is-valid');

stage.querySelectorAll('.w-srv-copy').forEach(button => {
  button.addEventListener('click', async () => {
    const command = button.previousElementSibling.textContent.replace(/^\s*\$\s*/, '');
    status.textContent = '';
    status.textContent = (await copyText(command)) ? text.copied : text.copyFailed;
    button.classList.add('is-done');
    button.innerHTML = icon('check', 15);
    setTimeout(() => {
      status.textContent = '';
      button.classList.remove('is-done');
      button.innerHTML = icon('copy', 15);
    }, 1400);
  });
});

// On phones the labels sit under the drawing, so the drawing drops the space they used.
const narrow = matchMedia('(max-width: 760px)');
const fitViewBox = () => svg.setAttribute('viewBox', narrow.matches ? '-186 -224 466 518' : '-196 -224 742 518');
fitViewBox();
narrow.addEventListener('change', fitViewBox);
measure();
new ResizeObserver(measure).observe(svg);
