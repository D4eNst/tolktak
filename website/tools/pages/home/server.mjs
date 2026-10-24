import { server as copy } from '../../../content/home/server.mjs';
import { copy as site } from '../../copy.mjs';
import { fill, icon, json } from '../../html.mjs';
import { docUrl } from '../../urls.mjs';
import { house } from './house-art.mjs';

const sample = 'talk.example.com';

// Isometric drawing of the stack in SVG units (x is scaled by cos 30°); the HTML labels beside
// it are positioned in percentages of the same 742 × 518 box.
const iso = n => (0.866 * n).toFixed(1);

const unit = (y, own = false) => {
  const bays = [0, 1, 2, 3, 4, 5].map(i => {
    const [x, x2] = [iso(-160 + 30 * i), iso(-136 + 30 * i)];
    return `<polygon class="bay" points="${x},${y + 128} ${x2},${y + 140} ${x2},${y + 154} ${x},${y + 142}"/>`;
  }).join('');
  const leds = `<g transform="matrix(0.8660 0.5 0 1 -173.2 ${y + 130})"><circle class="led${own ? ' blink' : ''}" cx="236" cy="-15" r="2.6"/><circle class="led${own ? ' blink b2' : ''}" cx="248" cy="-15" r="2.6"/><circle class="led led-dim" cx="260" cy="-15" r="2.6"/></g>`;
  return `<polygon class="t" points="0,${y} 259.8,${y + 150} 86.6,${y + 250} -173.2,${y + 100}"/>
      <polygon class="l" points="-173.2,${y + 100} 86.6,${y + 250} 86.6,${y + 280} -173.2,${y + 130}"/>
      <polygon class="r" points="259.8,${y + 150} 86.6,${y + 250} 86.6,${y + 280} 259.8,${y + 180}"/>
      ${bays}${leds}`;
};

const layer = (name, y, depth, extra = '') => `<g class="w-srv-layer" data-layer="${name}">
    <polygon class="t" points="0,${y} 259.8,${y + 150} 86.6,${y + 250} -173.2,${y + 100}"/>
    <polygon class="l" points="-173.2,${y + 100} 86.6,${y + 250} 86.6,${y + 250 + depth} -173.2,${y + 100 + depth}"/>
    <polygon class="r" points="259.8,${y + 150} 86.6,${y + 250} 86.6,${y + 250 + depth} 259.8,${y + 150 + depth}"/>
    ${extra}<polyline class="w-srv-lead" points="265.8,${y + 150 + depth / 2} 303.8,${y + 150 + depth / 2}"/>
  </g>`;

const slits = Array.from({ length: 9 }, (_, i) => {
  const [x, x2, y] = [iso(-20 + 11 * i), iso(-16 + 11 * i), 142 + 5.5 * i];
  return `<polygon class="slit" points="${x},${y} ${x2},${y + 2} ${x2},${y + 34} ${x},${y + 32}"/>`;
}).join('');

const art = c => `<svg class="w-srv-svg" viewBox="-196 -224 742 518" role="img" aria-labelledby="w-srv-art-title">
  <title id="w-srv-art-title">${c.art}</title>
  <defs>
    <linearGradient id="w-srv-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <mask id="w-srv-rack-mask" maskUnits="userSpaceOnUse" x="-196" y="-262" width="742" height="596"><rect x="-196" y="-262" width="742" height="438" fill="#fff"/><rect x="-196" y="176" width="742" height="118" fill="url(#w-srv-fade)"/></mask>
  </defs>
  <g class="w-srv-hw is-on" data-hw="home">
    <polygon class="w-srv-floor" points="0,-26 304.8,150 86.6,276 -218.2,100"/>
    <g class="w-srv-layer w-srv-layer--hw" data-layer="hw">
      <polygon class="t" points="0,-64 259.8,86 86.6,186 -173.2,36"/>
      <polygon class="l" points="-173.2,36 86.6,186 86.6,250 -173.2,100"/>
      <polygon class="r" points="259.8,86 86.6,186 86.6,250 259.8,150"/>
      <polygon class="bay" points="-90.1,102 -29.4,137 -29.4,165 -90.1,130"/>
      ${slits}
      <g transform="matrix(0.8660 0.5 0 1 -173.2 100)"><circle class="pwr" cx="38" cy="-32" r="11"/><path class="pwr-i" d="M38 -38 v6 M33.5 -35 a6.5 6.5 0 1 0 9 0"/><circle class="led" cx="62" cy="-32" r="3"/></g>
      <polyline class="w-srv-lead" points="265.8,118 303.8,118"/>
    </g>
  </g>
  <g class="w-srv-hw" data-hw="vps">
    <g mask="url(#w-srv-rack-mask)">
      <g class="unit u3">${unit(34)}</g>
      <g class="unit u2">${unit(2)}</g>
      <g class="unit u1">${unit(-30)}</g>
      <g class="w-srv-layer w-srv-layer--hw" data-layer="hw"><g class="unit own">${unit(-64, true)}
        <text class="vps-tag" transform="matrix(0.8660 0.5 0 1 -162.8 62)">VPS</text>
        <polyline class="w-srv-lead" points="265.8,101 303.8,101"/>
      </g></g>
      <g class="post"><polygon class="t" points="-187.1,28 -178.4,33 -185.3,37 -194,32"/><polygon class="l" points="-194,32 -185.3,37 -185.3,197 -194,192"/><polygon class="r" points="-178.4,33 -185.3,37 -185.3,197 -178.4,193"/></g>
      <g class="post"><polygon class="t" points="91.8,189 100.5,194 93.5,198 84.9,193"/><polygon class="l" points="84.9,193 93.5,198 93.5,358 84.9,353"/><polygon class="r" points="100.5,194 93.5,198 93.5,358 100.5,354"/></g>
    </g>
  </g>
  <g class="w-srv-soft">
    ${layer('data', -100, 24)}
    ${layer('code', -138, 24)}
    ${layer('tolktak', -184, 32, `<text class="w-srv-engrave" transform="matrix(0.8660 0.5 0 1 -154.2 -52)" data-srv-addr>${sample}</text>`)}
    <g class="w-srv-layer w-srv-layer--house" data-layer="house">${house({
      name: 'w-srv-house', corner: [69.3, -54], left: 160, right: 100, height: 60, rise: 46, overhang: 6,
      windows: [['left', 12, 32, 20, 26], ['left', 104, 40, 20, 26], ['right', 56, 28, 20, 24], ['right', 16, 28, 20, 24]],
      door: [58, 26, 24],
    })}</g>
  </g>
</svg>`;

const labels = c => {
  const label = (name, top) => `<li style="top:${top}"><button type="button" data-layer="${name}" disabled><b>${c.layers[name]}</b></button></li>`;
  return `<ul class="w-srv-labels">
      ${label('tolktak', '39.77%')}
      ${label('code', '47.88%')}
      ${label('data', '55.21%')}
      <li class="w-srv-label-hw" style="top:66.02%" data-top-home="66.02%" data-top-vps="62.74%"><button type="button" data-layer="hw" disabled><b data-hw-name>${c.hardware.home}</b></button></li>
    </ul>`;
};

const command = (c, text) => `<li><code><span class="w-srv-prompt">$</span> ${text}</code><button type="button" class="w-srv-copy" aria-label="${c.copy}" data-needs-js>${icon('copy', 15)}</button></li>`;

export default function server(ctx) {
  const { lang } = ctx;
  const c = copy[lang];
  return `<section class="w-scene w-server" id="w-server" aria-labelledby="w-server-title">
  <div class="w-scene-text">
    <p class="w-room">${icon('home', 15)}<span data-srv-room>${sample}</span></p>
    <h2 class="w-h2" id="w-server-title">${c.title}</h2>
    <p class="w-lead">${c.lead}</p>
    <p class="w-server-links"><a class="w-btn w-btn--sm" href="${docUrl(lang, 'install/docker')}">${c.install}</a><a class="w-link" href="${docUrl(lang, 'install/requirements')}">${c.requirements}</a></p>
    <ul class="w-facts">
      ${c.facts.map(([name, text]) => `<li>${icon(name, 18)}${text}</li>`).join('\n      ')}
    </ul>
  </div>
  <div class="w-stage w-server-stage">
    <label class="w-srv-addr" data-needs-js>
      <span class="w-srv-addr-cap">${c.address}</span>
      <span class="w-srv-addr-field">
        <input type="text" value="${sample}" spellcheck="false" autocomplete="off" autocapitalize="off" inputmode="url" maxlength="40" aria-describedby="w-srv-hint">
        <span class="w-srv-ok">${icon('check', 16)}</span>
      </span>
    </label>
    <div class="w-srv-controls" data-needs-js>
      <div class="w-srv-where" role="radiogroup" aria-label="${c.where}">
        <button type="button" role="radio" aria-checked="true" data-where="home">${icon('home', 17)}${c.hardware.home}</button>
        <button type="button" role="radio" aria-checked="false" tabindex="-1" data-where="vps">${icon('rack', 17)}${c.hardware.vps}</button>
      </div>
      <p class="w-hint" id="w-srv-hint">${c.hint}</p>
    </div>
    <div class="w-srv-art">
      ${art(c)}
      ${labels(c)}
    </div>
    <div class="w-win w-srv-term">
      <p class="w-srv-term-head"><span>${c.terminal}</span></p>
      <ol class="w-srv-cmds">
        ${command(c, 'docker run --network host d4enst/tolktak')}
      </ol>
      <p class="w-srv-term-foot">${fill(c.more, { link: `<a class="w-link" href="${docUrl(lang, 'install/docker')}">${c.guide}</a>` })}</p>
    </div>
    <p class="w-sr" role="status" aria-live="polite" data-srv-status></p>
  </div>
  ${json('w-server-copy', { sample, hardware: c.hardware, copied: site[lang].copied, copyFailed: site[lang].copyFailed })}
</section>`;
}
