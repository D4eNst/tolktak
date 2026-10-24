import { ava, icon, json } from '../../html.mjs';
import { sound as copy } from '../../../content/home/sound.mjs';

// Each noise word: the suppression step that removes it, its loudness and its home in the field (%).
const noise = [
  { step: 1, loud: 0.5, x: 14, y: 22 },
  { step: 1, loud: 0.45, x: 76, y: 70 },
  { step: 2, loud: 0.8, x: 68, y: 16, big: true },
  { step: 2, loud: 0.6, x: 10, y: 66 },
  { step: 2, loud: 0.7, x: 26, y: 44 },
  { step: 3, loud: 0.9, x: 80, y: 42, big: true },
  { step: 3, loud: 1, x: 36, y: 80, big: true },
  { step: 3, loud: 0.65, x: 58, y: 84 },
];

const toggle = (name, label) => `<label class="w-sound-switch">
              <input type="checkbox" checked data-opt="${name}">
              <span class="w-sound-toggle" aria-hidden="true"></span>
              <span>${label}</span>
            </label>`;

export default function sound(ctx) {
  const { lang } = ctx;
  const c = copy[lang];
  return `<section class="w-scene w-sound" id="w-sound" aria-labelledby="w-sound-title">
  <div class="w-scene-text">
    <p class="w-room">${icon('settings', 15)}${c.room}</p>
    <h2 class="w-h2" id="w-sound-title">${c.title}</h2>
    <p class="w-lead">${c.lead}</p>
    <ul class="w-facts">
      <li>${icon('keyboard', 18)}${c.facts[0]}</li>
      <li>${icon('headphones', 18)}${c.facts[1]}</li>
      <li>${icon('wave', 18)}${c.facts[2]}</li>
      <li>${icon('mic', 18)}${c.facts[3]}</li>
    </ul>
  </div>
  <div class="w-stage w-sound-stage">
    <div class="w-sound-panel w-win">
      <div class="w-sound-field" data-field>
        ${noise.map((n, i) => `<span class="w-sound-word${n.big ? ' is-big' : ''}" data-step="${n.step}" data-loud="${n.loud}" style="left:${n.x}%;top:${n.y}%">${c.noise[i]}</span>`).join('\n        ')}
        <div class="w-sound-me">
          ${ava('me', lang, 88, 'w-sound-voice')}
          <span class="w-sound-level" aria-hidden="true"><i data-level></i></span>
        </div>
        <p class="w-hint w-sound-fieldhint" data-field-hint>${c.fieldHint}</p>
      </div>
      <div class="w-sound-ns">
        <p class="w-sound-label" id="w-sound-ns-label">${c.denoise}</p>
        <div class="w-sound-seg" role="radiogroup" aria-labelledby="w-sound-ns-label" data-seg>
          ${c.steps.map((step, i) => `<label><input type="radio" name="w-sound-ns" value="${i}"${i ? '' : ' checked'}><span>${step}</span></label>`).join('\n          ')}
          <span class="w-sound-thumb" aria-hidden="true"></span>
        </div>
        <p class="w-sound-note w-sound-maxhint">${c.maxHint}</p>
      </div>
      <div class="w-sound-grid">
        <section class="w-sound-card w-sound-ptt" aria-labelledby="w-sound-ptt-title">
          <p class="w-sound-label" id="w-sound-ptt-title">${c.ptt}</p>
          <div class="w-sound-game" aria-hidden="true">
            <svg class="w-sound-hud" viewBox="0 0 200 100" preserveAspectRatio="none">
              <path class="w-sound-hills" d="M0 70 L24 58 L46 64 L76 44 L104 58 L130 48 L158 62 L182 52 L200 57 L200 100 L0 100 Z"/>
              <path class="w-sound-hills2" d="M0 82 L36 74 L70 80 L110 70 L148 78 L180 72 L200 75 L200 100 L0 100 Z"/>
            </svg>
            <span class="w-sound-cross"></span>
            <span class="w-sound-hp"><i></i><i></i><i></i></span>
            <span class="w-sound-map"><i></i></span>
          </div>
          <p class="w-sound-cap">${c.pttKey}</p>
          <div class="w-sound-keyrow">
            <button type="button" class="w-sound-key" data-ptt aria-pressed="false" disabled aria-label="${c.pttKeyLabel}">V</button>
            <span class="w-sound-arrow" aria-hidden="true"></span>
            <span class="w-sound-roomtile" aria-hidden="true">${ava('me', lang, 32, 'w-sound-ptt-you')}<span>${c.lounge}</span></span>
          </div>
        </section>
        <section class="w-sound-card w-sound-proc" aria-label="${c.processing}">
          <p class="w-sound-label">${c.processing}</p>
          <div class="w-sound-opt">
            ${toggle('echo', c.echo)}
            <span class="w-sound-echo" aria-hidden="true" data-echo>
              <span class="w-sound-spk">${icon('speaker', 16)}</span>
              <i></i><i></i><i></i>
              <span class="w-sound-wall"></span>
              <span class="w-sound-mic">${icon('mic', 16)}</span>
            </span>
          </div>
          <div class="w-sound-opt">
            ${toggle('agc', c.agc)}
            <span class="w-sound-bars" aria-hidden="true" data-bars>${'<i></i>'.repeat(10)}</span>
          </div>
          <div class="w-sound-opt">
            <button type="button" class="w-sound-hear" data-hear aria-pressed="false" data-needs-js>${icon('headphones', 16)}<span data-hear-label>${c.hear}</span></button>
            <span class="w-sound-delay" aria-hidden="true">
              ${ava('me', lang, 24, 'w-sound-now')}
              <span class="w-sound-arrow"></span>
              ${ava('me', lang, 24, 'w-sound-later')}
              <small>${c.delay}</small>
            </span>
          </div>
          <p class="w-sound-note">${c.hearNote}</p>
        </section>
      </div>
    </div>
  </div>
  ${json('w-sound-copy', { hear: c.hear, stop: c.stop })}
</section>`;
}
