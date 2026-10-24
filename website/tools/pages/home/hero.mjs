import { copy } from '../../copy.mjs';
import { escape, fill, icon, json, person, picture } from '../../html.mjs';
import { url, docUrl } from '../../urls.mjs';
import { world } from '../../../content/home/world.mjs';
import { hero as text } from '../../../content/home/hero.mjs';

// Size and positions of each person: hx/hy are the home spot inside the playground (0–1),
// lx/ly and mx/my place them before the script runs on wide and narrow screens.
const company = [
  ['alisa', 92, 0.3, 0.16, '66%', '24%', '22%', '30%'],
  ['borya', 78, 0.8, 0.08, '85%', '17%', '76%', '22%'],
  ['katya', 86, 0.1, 0.5, '58%', '52%', '12%', '70%'],
  ['dima', 70, 0.58, 0.36, '77%', '40%', '52%', '44%'],
  ['ira', 88, 0.92, 0.52, '91%', '56%', '86%', '62%'],
  ['pasha', 64, 0.4, 0.8, '69%', '76%', '36%', '80%'],
  ['vera', 72, 0.7, 0.88, '83%', '83%', '64%', '82%'],
  ['lena', 60, 0.99, 0.26, '95%', '32%', '95%', '30%', true],
  ['gosha', 56, 0.04, 0.92, '56%', '86%', '5%', '30%', true],
];

export default function hero({ lang, release }) {
  const c = text[lang];
  const shared = copy[lang];
  const people = company.map(([id, size, hx, hy, lx, ly, mx, my, extra]) => {
    const p = person(id, lang);
    return `<span class="w-ava w-hero-av${extra ? ' w-hero-av--extra' : ''}" data-who="${id}" data-name="${p.name}" data-hx="${hx}" data-hy="${hy}" style="--c:${p.color};--s:${size}px;--lx:${lx};--ly:${ly};--mx:${mx};--my:${my}">${picture(id)}</span>`;
  }).join('\n        ');
  return `<section class="w-hero" id="w-hero" aria-labelledby="w-hero-title">
  <div class="w-wrap w-hero-grid">
    <div class="w-hero-copy">
      <p class="w-hero-badge"><span></span>${shared.earlyRelease} · ${escape(release.version)}</p>
      <h1 class="w-h1" id="w-hero-title">${world[lang].title.replace(/ (\S) /g, ' $1&nbsp;')}</h1>
      <p class="w-lead">${world[lang].description}</p>
      <div class="w-hero-paths">
        <div class="w-hero-path">
          <a class="w-btn w-btn--primary" href="${url(lang, 'download/')}" data-download>${icon('download', 20)}<span data-download-label>${shared.downloadApp}</span></a>
          <span class="w-btn-meta" data-download-meta>${shared.platforms}</span>
        </div>
        <div class="w-hero-path">
          <a class="w-btn" href="${docUrl(lang, 'install/docker')}"><span>${c.serverPath}</span>${icon('chevronRight', 18)}</a>
          <span class="w-btn-meta"><a class="w-link" href="${docUrl(lang, 'install/docker')}">${c.serverGuide}</a> · <a class="w-link" href="${docUrl(lang, 'install/requirements')}">${c.requirements}</a></span>
        </div>
      </div>
    </div>
    <div class="w-stage w-hero-stage">
      <div class="w-hero-play" aria-hidden="true">
        <div class="w-hero-room"><div class="w-hero-room-floor"></div></div>
        <p class="w-hero-room-head"><span class="w-hero-room-ico">${icon('speaker', 15)}</span><b>${c.room}</b><span class="w-hero-room-count">${fill(c.inRoom, { n: 3 })}</span></p>
        ${people}
        <div class="w-hero-you"><span class="w-hero-you-ring"></span><span class="w-hero-you-label">${person('me', lang).name}</span></div>
      </div>
      <div class="w-hero-ui">
        <p class="w-hint w-hero-hint"><span class="w-hero-hint-pointer">${c.hintPointer}</span><span class="w-hero-hint-touch">${c.hintTouch}</span></p>
        <button class="w-hero-gather" type="button" aria-pressed="false" data-needs-js>${icon('users', 16)}<span class="w-hero-gather-label">${c.gather}</span></button>
      </div>
    </div>
  </div>
  ${json('w-hero-copy', { inRoom: c.inRoom, gather: c.gather, release: c.release })}
</section>`;
}
