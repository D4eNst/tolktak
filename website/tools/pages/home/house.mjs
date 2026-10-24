import { copy } from '../../copy.mjs';
import { ava, escape, fill, icon, json, person, plan } from '../../html.mjs';
import { house as text } from '../../../content/home/house.mjs';

// Where everyone sits before the script moves the company in: the static picture of the house.
const seats = Object.fromEntries(['lounge', 'game'].flatMap(room => plan.people[room].map((id, n) => [id, plan.seats[room][plan.order[room][n]]])));

export default function house({ lang, release }) {
  const c = text[lang];
  const facts = ['hash', 'speaker', 'crown'].map((name, i) => `<li>${icon(name, 18)}${c.facts[i]}</li>`).join('\n        ');
  const tokens = Object.entries(seats).map(([id, [x, y]]) =>
    `<span aria-hidden="true" class="w-house-bb w-house-tok is-in${id === 'alisa' ? ' is-speaking' : ''}" data-who="${id}" style="--x:${x};--y:${y};--z:46">${ava(id, lang, 30, 'w-house-face')}</span>`,
  ).join('\n          ');
  const voiceLabel = (room, n) => fill(c.voiceRoom, { name: c.rooms[room], n });
  return `<section class="w-scene w-house" id="w-house" aria-labelledby="w-house-title">
  <div class="w-wrap w-house-grid">
    <div class="w-scene-text">
      <p class="w-room">${icon('home', 15)}${c.label}</p>
      <h2 class="w-h2" id="w-house-title">${c.title}</h2>
      <p class="w-lead">${c.lead}</p>
      <ul class="w-facts">
        ${facts}
      </ul>
    </div>
    <div class="w-stage w-house-stage" role="group" aria-label="${c.stage}">
      <div class="w-house-world" data-lit="lounge game" data-here="">
        <i class="w-house-p w-house-ground" style="--x:-90;--y:-70;--w:520;--d:460;--z:-1"></i>
        <i class="w-house-p w-house-pl-top" style="--x:-40;--y:-20;--w:420;--d:360;--z:40"></i>
        <i aria-hidden="true" class="w-house-fx w-house-pl-l" style="--x:-40;--y:-20;--d:360;--h:40;--z:0"><b>TOLKTAK ${escape(release.version)}</b></i>
        <i aria-hidden="true" class="w-house-fy w-house-pl-r" style="--x:-40;--y:340;--w:420;--h:40;--z:0"><b>talk.example.com · Docker</b><s class="w-house-leds"><u></u><u></u><u></u></s><s class="w-house-vents"></s></i>

        <button class="w-house-room w-house-p" type="button" disabled data-room="game" style="--x:0;--y:0;--w:160;--d:170;--z:40.4" aria-label="${voiceLabel('game', 4)}, ${fill(c.sharing, { who: person('dima', lang).name })}">
          <span aria-hidden="true" class="w-house-room-name" style="left:12px;top:142px">${c.rooms.game}</span>
        </button>
        <button class="w-house-room w-house-p" type="button" disabled data-room="lounge" style="--x:160;--y:0;--w:200;--d:170;--z:40.4" aria-label="${voiceLabel('lounge', 5)}">
          ${[[12, 18], [76, 18], [140, 18], [12, 96], [76, 96], [140, 96]].map(([left, top], i) => `<span aria-hidden="true" class="w-house-tile" data-seat="${i}" style="left:${left}px;top:${top}px"></span>`).join('\n          ')}
          <span aria-hidden="true" class="w-house-room-name" style="left:12px;top:162px">${c.rooms.lounge}</span>
        </button>
        <button class="w-house-room w-house-p" type="button" disabled data-room="general" style="--x:0;--y:170;--w:150;--d:130;--z:40.4" aria-label="${fill(c.textChannel, { name: c.rooms.general })}">
          <span aria-hidden="true" class="w-house-room-name" style="left:12px;top:12px">#${c.rooms.general}</span>
        </button>
        <button class="w-house-room w-house-p" type="button" disabled data-room="shots" style="--x:150;--y:170;--w:110;--d:130;--z:40.4" aria-label="${fill(c.textChannel, { name: c.rooms.shots })}">
          <span aria-hidden="true" class="w-house-room-name" style="left:10px;top:104px">#${c.rooms.shots}</span>
        </button>
        <button class="w-house-room w-house-p" type="button" disabled data-room="links" style="--x:260;--y:170;--w:100;--d:130;--z:40.4" aria-label="${fill(c.textChannel, { name: c.rooms.links })}">
          <span aria-hidden="true" class="w-house-room-name" style="left:10px;top:104px">#${c.rooms.links}</span>
        </button>

        <div aria-hidden="true" class="w-house-fy w-house-wall" style="--x:0;--y:0;--w:360;--h:84;--z:40">
          <i class="w-house-seg" data-room="game" style="left:0;width:160px"></i>
          <i class="w-house-seg" data-room="lounge" style="left:160px;width:200px"></i>
          <i class="w-house-tv" data-room="game" style="left:18px;top:13px"><i class="w-house-tv-board"></i><i class="w-house-tv-live">${copy[lang].live}</i></i>
          <i class="w-house-win" data-room="lounge" style="left:184px"></i>
          <i class="w-house-win" data-room="lounge" style="left:244px"></i>
          <i class="w-house-win" data-room="lounge" style="left:304px"></i>
        </div>
        <div aria-hidden="true" class="w-house-fx w-house-wall w-house-wall-r" style="--x:360;--y:0;--d:300;--h:84;--z:40">
          <i class="w-house-seg" data-room="lounge" style="left:0;width:170px"></i>
          <i class="w-house-seg" data-room="links" style="left:170px;width:130px"></i>
          <i class="w-house-win" data-room="lounge" style="left:30px"></i>
          <i class="w-house-win" data-room="lounge" style="left:104px"></i>
          <i class="w-house-win" data-room="links" style="left:214px"></i>
        </div>
        <i class="w-house-p w-house-cap" style="--x:-4;--y:-6;--w:370;--d:6;--z:124"></i>
        <i class="w-house-p w-house-cap" style="--x:360;--y:-6;--w:6;--d:306;--z:124"></i>

        <i class="w-house-fx w-house-par" style="--x:0;--y:0;--d:300;--h:10;--z:40"></i>
        <i class="w-house-fy w-house-par" style="--x:0;--y:300;--w:360;--h:10;--z:40"></i>
        <i class="w-house-p w-house-cap" style="--x:0;--y:0;--w:4;--d:300;--z:50"></i>
        <i class="w-house-p w-house-cap" style="--x:0;--y:296;--w:360;--d:4;--z:50"></i>
        <i class="w-house-fy w-house-part" style="--x:4;--y:170;--w:356;--h:10;--z:40"></i>
        <i class="w-house-fx w-house-part" style="--x:160;--y:0;--d:170;--h:10;--z:40"></i>
        <i class="w-house-fx w-house-part" style="--x:150;--y:170;--d:126;--h:10;--z:40"></i>
        <i class="w-house-fx w-house-part" style="--x:260;--y:170;--d:126;--h:10;--z:40"></i>

        <i aria-hidden="true" class="w-house-bb w-house-stack" style="--x:76;--y:244;--z:46">
          <i class="w-house-msg" style="--c:${person('ira', lang).color}"><b></b><s style="width:64%"></s></i>
          <i class="w-house-msg" style="--c:${person('borya', lang).color}"><b></b><s style="width:86%"></s></i>
          <i class="w-house-msg" style="--c:${person('katya', lang).color}"><b></b><s style="width:48%"></s><em></em></i>
        </i>
        <i aria-hidden="true" class="w-house-bb w-house-pics" style="--x:205;--y:246;--z:46"><i></i><i></i></i>
        <i aria-hidden="true" class="w-house-bb w-house-pin" style="--x:310;--y:246;--z:46">${icon('pin', 12)}<s></s><s></s></i>

        ${plan.seats.game.map(([x, y]) => `<i class="w-house-pad w-house-seat" style="--x:${x};--y:${y}"></i>`).join('\n        ')}
        ${tokens}

        <i class="w-house-pad w-house-me-shadow" style="--x:-14;--y:314"></i>
        <span class="w-house-bb w-house-me" style="--x:-14;--y:314;--z:44" aria-hidden="true"><b>${person('me', lang).name}</b></span>

        <i class="w-house-roof w-house-roof-n"></i>
        <i class="w-house-roof w-house-roof-f"></i>
        <i class="w-house-fx w-house-gable" style="--x:0;--y:0;--d:300;--h:64;--z:168"><svg viewBox="0 0 300 64" preserveAspectRatio="none"><polygon points="1,63.5 150,1 299,63.5"/></svg></i>
        <i class="w-house-fx w-house-gable" style="--x:360;--y:0;--d:300;--h:64;--z:168"><svg viewBox="0 0 300 64" preserveAspectRatio="none"><polygon points="1,63.5 150,1 299,63.5"/></svg></i>
        <i class="w-house-fy w-house-guide" style="--x:0;--y:0;--w:1;--h:44;--z:124"></i>
        <i class="w-house-fy w-house-guide" style="--x:359;--y:0;--w:1;--h:44;--z:124"></i>
        <i class="w-house-fy w-house-guide" style="--x:359;--y:300;--w:1;--h:44;--z:124"></i>
      </div>

      <div class="w-house-ui">
        <p class="w-house-hint" data-needs-js>${icon('arrowDown', 14)}<span class="w-house-hint-text">${c.hintPointer}</span></p>
        <div class="w-house-card" hidden></div>
        <div class="w-house-pop" hidden></div>
        <div class="w-house-note" hidden>
          <span class="w-house-note-dot"></span>
          <span class="w-house-note-text"><b>${c.connected}</b><span class="w-house-note-where"></span></span>
          <span class="w-house-note-ctl">${icon('mic', 16)}${icon('headphones', 16)}<span class="w-house-note-leave">${icon('phoneOff', 16)}</span></span>
        </div>
      </div>
    </div>
  </div>
  ${json('w-house-copy', {
    group: c.group, rooms: c.rooms, voiceRoom: c.voiceRoom, inRoom: c.inRoom, sharing: c.sharing,
    last: c.last, pinned: c.pinned, messages: c.messages, hintTouch: c.hintTouch,
  })}
</section>`;
}
