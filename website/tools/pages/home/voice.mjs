import { ava, fill, icon, json, person } from '../../html.mjs';
import { voice as copy } from '../../../content/home/voice.mjs';

export const room = ['alisa', 'borya', 'vera', 'dima'];
const online = ['ira', 'pasha', 'lena'];

const veraCamera = `<svg class="w-voice-cam" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs>
    <radialGradient id="w-voice-lamp" cx="0.16" cy="0.28" r="0.7">
      <stop offset="0" stop-color="#ffbe4b" stop-opacity="0.34"/>
      <stop offset="0.55" stop-color="#ff8a4c" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#ff8a4c" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="320" height="180" fill="#2a221f"/>
  <rect width="320" height="180" fill="url(#w-voice-lamp)"/>
  <rect x="214" y="22" width="76" height="66" rx="4" fill="#15211f"/>
  <path d="M 252 22 V 88 M 214 55 H 290" stroke="#3b302a" stroke-width="3"/>
  <rect x="214" y="22" width="76" height="66" rx="4" fill="none" stroke="#3b302a" stroke-width="4"/>
  <circle cx="272" cy="38" r="6" fill="#f3e3c2"/>
  <path d="M 34 52 L 66 52 L 74 78 L 26 78 Z" fill="#f2a85b"/>
  <rect x="48" y="78" width="4" height="56" fill="#3b302a"/>
  <rect x="36" y="132" width="28" height="6" rx="2" fill="#3b302a"/>
  <path d="M 108 180 C 110 138 132 122 160 122 C 188 122 210 138 212 180 Z" fill="#6e56cf"/>
  <path d="M 146 122 C 150 132 170 132 174 122" fill="#5a44b8"/>
  <circle cx="160" cy="92" r="27" fill="#e8b48c"/>
  <path d="M 133 90 C 131 62 189 58 188 90 C 184 76 172 70 160 70 C 147 70 137 77 133 90 Z" fill="#3a2621"/>
  <path d="M 128 92 A 32 32 0 0 1 192 92" fill="none" stroke="#1d1b22" stroke-width="6" stroke-linecap="round"/>
  <rect x="122" y="86" width="12" height="20" rx="5" fill="#1d1b22"/>
  <rect x="186" y="86" width="12" height="20" rx="5" fill="#1d1b22"/>
  <circle cx="151" cy="95" r="2.4" fill="#2a1a16"/>
  <circle cx="169" cy="95" r="2.4" fill="#2a1a16"/>
  <path d="M 153 106 Q 160 111 167 106" fill="none" stroke="#2a1a16" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="0" y="164" width="320" height="16" fill="#1c1716"/>
</svg>`;

const yourCamera = `<svg class="w-voice-cam" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <rect width="320" height="180" fill="#24201f"/>
  <rect x="22" y="18" width="98" height="88" rx="3" fill="#2f2926"/>
  <path d="M 22 48 H 120 M 22 78 H 120" stroke="#3d3531" stroke-width="3"/>
  <rect x="30" y="26" width="9" height="20" rx="1.5" fill="#6e5a4c"/><rect x="41" y="29" width="7" height="17" rx="1.5" fill="#8a4d3a"/><rect x="50" y="24" width="10" height="22" rx="1.5" fill="#4f6f62"/><rect x="62" y="30" width="8" height="16" rx="1.5" fill="#b0864a"/>
  <rect x="34" y="58" width="12" height="18" rx="1.5" fill="#5b6a7a"/><rect x="48" y="62" width="8" height="14" rx="1.5" fill="#9b5b46"/><circle cx="96" cy="68" r="8" fill="#46a758"/><rect x="90" y="70" width="12" height="8" rx="2" fill="#7a5a45"/>
  <path d="M 252 128 C 238 112 236 86 252 70 C 262 90 266 110 252 128 Z" fill="#3f6b4c"/>
  <path d="M 268 128 C 282 108 280 84 266 72 C 258 92 256 112 268 128 Z" fill="#4f8a5c"/>
  <rect x="248" y="124" width="26" height="24" rx="4" fill="#a8603f"/>
  <path d="M 104 180 C 106 136 130 120 160 120 C 190 120 214 136 216 180 Z" fill="#ff8a4c"/>
  <path d="M 144 120 L 160 138 L 176 120" fill="#f1773a"/>
  <circle cx="160" cy="90" r="27" fill="#d9a07a"/>
  <path d="M 132 84 C 132 62 188 60 188 84 L 194 86 C 194 92 126 92 126 86 Z" fill="#2a2731"/>
  <circle cx="151" cy="94" r="2.4" fill="#2a1a16"/><circle cx="169" cy="94" r="2.4" fill="#2a1a16"/>
  <path d="M 152 104 Q 160 110 168 104" fill="none" stroke="#2a1a16" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="0" y="166" width="320" height="14" fill="#1a1716"/>
</svg>`;

function tile(id, lang, speaking) {
  const p = person(id, lang);
  if (id === 'vera') {
    return `<li class="w-voice-tile is-cam" data-who="${id}" style="--c:${p.color}">${veraCamera}<span class="w-voice-name">${icon('video', 13)}${p.name}</span></li>`;
  }
  return `<li class="w-voice-tile${speaking ? ' is-speaking' : ''}" data-who="${id}" style="--c:${p.color}">
    <span class="w-voice-glow"></span>${ava(id, lang, 72)}<span class="w-voice-name">${p.name}</span>
  </li>`;
}

export default function voice({ lang }) {
  const c = copy[lang];
  const control = (vc, name, label, extra = '') => `<button type="button" class="w-voice-cb${vc === 'leave' ? ' w-voice-cb--leave' : ''}" data-vc="${vc}" aria-label="${label}" title="${label}"${extra}>${icon(name, 20)}</button>`;
  return `<section class="w-scene w-voice" id="w-voice" aria-labelledby="w-voice-title">
  <div class="w-scene-text w-voice-intro">
    <div class="w-voice-intro-a">
      <p class="w-room w-room--voice">${icon('speaker', 15)}${c.room}</p>
      <h2 class="w-h2" id="w-voice-title">${c.title}</h2>
    </div>
    <div class="w-voice-intro-b">
      <p class="w-lead">${c.lead}</p>
      <ul class="w-facts">
        <li>${icon('speaker', 18)}${c.facts.speaker}</li>
        <li>${icon('phone', 18)}${c.facts.phone}</li>
        <li>${icon('video', 18)}${c.facts.video}</li>
      </ul>
    </div>
  </div>
  <div class="w-stage">
    <div class="w-voice-layout" data-voice>
      <div class="w-voice-room w-win" data-voice-room>
        <header class="w-voice-head">
          <span class="w-voice-head-icon">${icon('speaker', 16)}</span>
          <b>${c.head}</b>
          <span class="w-voice-count" data-voice-count>${fill(c.inRoom, { n: room.length })}</span>
        </header>
        <ul class="w-voice-tiles" data-voice-tiles>
          ${room.map((id, i) => tile(id, lang, i === 0)).join('\n')}
        </ul>
        <div class="w-voice-bar">
          <button class="w-voice-join" type="button" data-voice-join data-needs-js>${icon('speaker', 18)}<span>${c.join}</span></button>
          <div class="w-voice-ctrls" data-voice-ctrls hidden>
            ${control('mic', 'mic', c.controls.mic, ' aria-pressed="true"')}
            ${control('sound', 'headphones', c.controls.sound, ' aria-pressed="true"')}
            ${control('cam', 'videoOff', c.controls.cam, ' aria-pressed="false"')}
            ${control('share', 'screen', c.controls.share)}
            ${control('leave', 'phoneOff', c.controls.leave)}
          </div>
        </div>
        <p class="w-voice-drop" aria-hidden="true"><span>${c.drop}</span></p>
      </div>

      <aside class="w-voice-side">
        <div class="w-voice-me" data-voice-me>
          <button class="w-voice-chip" type="button" data-voice-chip aria-label="${c.joinRoom}" data-needs-js>${ava('me', lang, 52)}</button>
          <div class="w-voice-me-text"><b>${person('me', lang).name}</b><span data-voice-status>${c.status.online}</span></div>
          <p class="w-hint">${c.hint}</p>
        </div>
        <div class="w-voice-connected" data-voice-connected hidden>
          <span class="w-voice-dot"></span>
          <div><b>${c.connected}</b><span>${c.head}</span></div>
          <button type="button" data-voice-disconnect aria-label="${c.disconnect}" title="${c.disconnect}">${icon('phoneOff', 16)}</button>
        </div>
        <div class="w-voice-online w-win">
          <p class="w-voice-cap">${c.online}</p>
          <ul>
            ${online.map(id => `<li class="w-voice-person" data-who="${id}">
              ${ava(id, lang, 34)}
              <span class="w-voice-pname"><b>${person(id, lang).name}</b><small>${c.status.online}</small></span>
              <button type="button" class="w-voice-call-btn" data-call="${id}" aria-label="${c.call}: ${person(id, lang).name}" title="${c.call}" data-needs-js>${icon('phone', 16)}</button>
            </li>`).join('\n')}
          </ul>
        </div>
      </aside>

      <div class="w-voice-call w-win" data-voice-call hidden></div>
      <p class="w-sr" role="status" data-voice-announce></p>
      <template data-voice-camera>${yourCamera}</template>
    </div>
  </div>
  ${json('w-voice-copy', {
    inRoom: c.inRoom, status: c.status, controls: c.controls, micOff: c.micOff, disconnect: c.disconnect,
    ringing: c.ringing, directCall: c.directCall, inCall: c.inCall, announce: c.announce,
  })}
</section>`;
}
