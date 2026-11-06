import { copy } from '../../copy.mjs';
import { ava, icon, person } from '../../html.mjs';
import { world } from '../../../content/home/world.mjs';
import { room as lounge } from './voice.mjs';
import { friends } from './screen.mjs';

const roomOf = { chat: 'hash', voice: 'speaker', screen: 'speaker', sound: 'settings', server: 'home', download: 'download' };
const seated = { voice: lounge, screen: friends };

export default function rail(lang, embedded = false) {
  const c = world[lang];
  const people = room => `<ul class="w-rail-people" data-rail-room="${room}">${seated[room].map(id => `<li>${ava(id, lang, 20)}${person(id, lang).name}</li>`).join('')}</ul>`;
  const row = (id, extra = '') => `<a class="w-rail-row${roomOf[id] === 'speaker' ? ' w-rail-row--voice' : ''}" aria-label="${c.rows[id].name}: ${c.rows[id].note}" title="${c.rows[id].name}" href="#w-${id}" data-goto="w-${id}">${icon(roomOf[id], 16)}<span>${c.rows[id].name}</span>${extra}<small>${c.rows[id].note}</small></a>`;
  return `<aside class="w-rail${embedded ? ' w-rail--embedded' : ''}" aria-label="${c.rail}">
    <a class="w-rail-group" href="#w-house" data-goto="w-house"><span class="w-badge">${embedded ? '🎲' : c.group[0]}</span><span>${c.group}</span></a>
    ${embedded ? '' : `<button class="w-rail-search" type="button" data-switch-open>${icon('search', 14)}<span>${c.search}</span></button>`}
    <div class="w-rail-content">
      <p class="w-rail-cap">${embedded ? c.channels : c.textChannels}</p>
      ${row('chat')}
      <p class="w-rail-cap">${embedded ? c.rooms : c.voiceRooms}</p>
      ${row('voice', `<span class="w-rail-count">${seated.voice.length}</span>`)}
      ${people('voice')}
      ${row('screen', `<span class="w-live" data-rail-live>${copy[lang].live}</span>`)}
      ${people('screen')}
      <div class="w-rail-sep"></div>
      ${row('server')}
      ${row('download')}
    </div>
    <div class="w-rail-me">
      ${ava('me', lang, 32)}
      <div><b>${person('me', lang).name}</b><span>${c.online}</span></div>
      <a class="w-rail-gear" href="#w-sound" data-goto="w-sound" aria-label="${c.rows.sound.name}" title="${c.rows.sound.name}">${icon('settings', 18)}</a>
    </div>
  </aside>`;
}
