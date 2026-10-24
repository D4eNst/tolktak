import { finale as copy } from '../../../content/home/finale.mjs';
import { copy as site } from '../../copy.mjs';
import { github } from '../../github.mjs';
import { escape, face, icon, person } from '../../html.mjs';
import { builds, megabytes, systems } from '../../release.mjs';
import { downloadCopy } from '../../../content/download.mjs';
import { url } from '../../urls.mjs';
import { house } from './house-art.mjs';


// A fixed pseudo-random sky, so every build draws the same stars.
function sky() {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const stars = Array.from({ length: 160 }, (_, i) => {
    const [x, y, r, opacity] = [random() * 1440, random() * 840, 0.5 + random() * 1.3, 0.2 + random() * 0.6];
    const twinkle = i % 7 === 0 ? ` class="tw" style="animation-delay:-${(random() * 6).toFixed(1)}s;animation-duration:${(3 + random() * 4).toFixed(1)}s"` : '';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" opacity="${opacity.toFixed(1)}"${twinkle}/>`;
  });
  return `<svg class="w-fin-sky" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><g class="w-fin-stars">${stars.join('')}</g></svg>`;
}

const company = [['alisa', -112.9, 78.8], ['borya', -94.9, 89.2], ['katya', -41.6, 120], ['dima', 46.2, 170.7], ['ira', 66.3, 182.3], ['pasha', 220.8, 126.5], ['vera', 203.5, 136.5], ['lena', 158.5, 162.5], ['gosha', 141.2, 172.5]];
const spills = ['-129.9,121 -77.9,151 -109.1,195 -176.7,156', '-67.5,157 -15.6,187 -46.8,231 -114.3,192', '27.7,212 84.9,245 53.7,289 -19.1,247', '237.3,169 187.1,198 226.9,247 292.7,209', '174.9,205 124.7,234 164.5,283 230.4,245'];

// The avatar look from the app: the colour mixed with 22% white at the top left.
const lighten = hex => '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.78 + 255 * 0.22).toString(16).padStart(2, '0')).join('');

function art(lang, c) {
  const people = company.map(([id]) => person(id, lang));
  const gradients = people.map(p => `<radialGradient id="w-fin-av-${p.id}" cx="0.28" cy="0.22" r="0.95"><stop offset="0" stop-color="${lighten(p.color)}"/><stop offset="1" stop-color="${p.color}"/></radialGradient>`).join('');
  const inside = company.map(([id, x, y], i) => `<g class="w-fin-p" transform="translate(${x} ${y})"><circle class="ring" r="18.5"/><circle class="sep" r="17"/><circle r="15" fill="url(#w-fin-av-${id})"/><g clip-path="url(#w-fin-face)"><g transform="translate(-15 -15) scale(0.75)">${face(id)}</g></g><ellipse class="sh" cx="0" cy="30" rx="23" ry="14" fill="${people[i].color}"/></g>`).join('');
  return `<svg class="w-fin-art" viewBox="-300 -330 700 720" role="img" aria-labelledby="w-fin-art-title">
        <title id="w-fin-art-title">${c.art}</title>
        <defs>
          <linearGradient id="w-fin-spill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb35c" stop-opacity="0.2"/><stop offset="1" stop-color="#ffb35c" stop-opacity="0"/></linearGradient>
          ${gradients}
          <clipPath id="w-fin-face"><circle r="15"/></clipPath>
        </defs>
        <polygon class="w-fin-shadow" points="-8.7,-35 433,220 95.3,415 -346.4,160"/>
        <g class="w-fin-plinth">
          <polygon class="t" points="0,-44 363.7,166 103.9,316 -259.8,106"/>
          <polygon class="l" points="-259.8,106 103.9,316 103.9,360 -259.8,150"/>
          <polygon class="r" points="363.7,166 103.9,316 103.9,360 363.7,210"/>
          <text class="w-fin-engrave" transform="matrix(0.8660 0.5 0 1 -237.3 146)">talk.example.com</text>
          <g transform="matrix(0.8660 0.5 0 1 -259.8 150)"><circle class="led" cx="372" cy="-22" r="3.2"/><circle class="led led-b" cx="386" cy="-22" r="3.2"/></g>
        </g>
        ${spills.map(points => `<polygon class="w-fin-glow" points="${points}"/>`).join('')}
        <polygon class="w-fin-doorglow" points="-5.2,193 20.8,208 17.3,268 -48.5,230"/>
        ${house({
          name: 'w-fin-house', corner: [95.3, 131], left: 280, right: 180, height: 120, rise: 70, overhang: 9.6,
          windows: [['left', 24, 52, 32, 62], ['left', 96, 52, 32, 62], ['left', 206, 58, 32, 62], ['right', 110, 50, 32, 62], ['right', 38, 50, 32, 62]],
          door: [166, 26, 42],
        }, inside)}
        <g transform="translate(173.2 58) matrix(1 -0.6 0 1 0 0)"><ellipse class="w-fin-gable-win" rx="11" ry="11"/><path class="w-fin-gable-bars" d="M-11 0H11M0 -11V11"/></g>
        <g class="w-fin-you" transform="translate(-21.7 201.5)"><g class="w-fin-you-in"><ellipse class="sh" cx="0" cy="16" rx="13" ry="5"/><circle class="bd" r="14"/><text y="4">${person('me', lang).name}</text></g></g>
      </svg>`;
}

export default function finale(ctx) {
  const { lang, release } = ctx;
  const c = copy[lang];
  const d = downloadCopy[lang];
  const s = site[lang];
  const files = builds(release);
  const row = os => `<div class="w-fin-row" data-os="${os}">
          <p class="w-fin-row-name"><b>${systems[os]}</b><span class="w-fin-yours">${c.yours}</span></p>
          <div class="w-fin-row-files">${files[os].map(file => `<a href="${escape(file.url)}" data-build="${file.key}">${d.files[file.key]}<span>${file.ext} · ${megabytes(file.size, lang)} ${d.sizeUnit}</span></a>`).join('')}</div>
        </div>`;
  return `<section class="w-finale" id="w-download" aria-labelledby="w-download-title">
  ${sky()}
  <div class="w-wrap w-fin-grid">
    <div class="w-fin-copy">
      <h2 class="w-h2" id="w-download-title">${c.title}</h2>
      <p class="w-lead">${s.platforms} · ${s.earlyRelease} ${escape(release.version)}</p>
      <div class="w-fin-cta">
        <a class="w-btn w-btn--primary w-fin-btn" href="${url(lang, 'download/')}" data-download data-door>${icon('download', 20)}<span data-download-label>${s.downloadApp}</span></a>
        <span class="w-btn-meta" data-download-meta>${s.platforms}</span>
      </div>
      <div class="w-fin-os" data-door>
        ${Object.keys(systems).map(row).join('\n        ')}
      </div>
      <p class="w-fin-links"><a class="w-link" href="${url(lang, 'releases/')}">${c.allVersions}</a></p>
      <p class="w-fin-links"><a class="w-link" href="${github}">${c.source}</a></p>
    </div>
    <div class="w-fin-scene">
      ${art(lang, c)}
    </div>
  </div>
</section>`;
}
