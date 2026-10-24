import { page } from '../shell.mjs';
import { copy } from '../copy.mjs';
import { ava, icon, person } from '../html.mjs';
import { world } from '../../content/home/world.mjs';
import hero from './home/hero.mjs';
import house from './home/house.mjs';
import chat from './home/chat.mjs';
import voice, { room as lounge } from './home/voice.mjs';
import screen, { friends } from './home/screen.mjs';
import sound from './home/sound.mjs';
import server from './home/server.mjs';
import finale from './home/finale.mjs';

const roomOf = { chat: 'hash', voice: 'speaker', screen: 'speaker', sound: 'settings', server: 'home', download: 'download' };
const seated = { voice: lounge, screen: friends };

function rail(lang) {
  const c = world[lang];
  const people = room => `<ul class="w-rail-people" data-rail-room="${room}">${seated[room].map(id => `<li>${ava(id, lang, 20)}${person(id, lang).name}</li>`).join('')}</ul>`;
  const row = (id, extra = '') => `<a class="w-rail-row${roomOf[id] === 'speaker' ? ' w-rail-row--voice' : ''}" href="#w-${id}" data-goto="w-${id}">${icon(roomOf[id], 16)}<span>${c.rows[id].name}</span>${extra}<small>${c.rows[id].note}</small></a>`;
  return `<aside class="w-rail" aria-label="${c.rail}">
    <a class="w-rail-group" href="#w-house" data-goto="w-house"><span class="w-badge">${c.group[0]}</span><span>${c.group}</span></a>
    <button class="w-rail-search" type="button" data-switch-open>${icon('search', 14)}<span>${c.search}</span></button>
    <p class="w-rail-cap">${c.textChannels}</p>
    ${row('chat')}
    <p class="w-rail-cap">${c.voiceRooms}</p>
    ${row('voice', `<span class="w-rail-count">${seated.voice.length}</span>`)}
    ${people('voice')}
    ${row('screen', `<span class="w-live" data-rail-live>${copy[lang].live}</span>`)}
    ${people('screen')}
    <div class="w-rail-sep"></div>
    ${row('server')}
    ${row('download')}
    <div class="w-rail-me">
      ${ava('me', lang, 32)}
      <div><b>${person('me', lang).name}</b><span>${c.online}</span></div>
      <a class="w-rail-gear" href="#w-sound" data-goto="w-sound" aria-label="${c.rows.sound.name}" title="${c.rows.sound.name}">${icon('settings', 18)}</a>
    </div>
  </aside>`;
}

export function home(ctx) {
  const { lang } = ctx;
  const c = world[lang];
  const entries = [
    ...['chat', 'voice', 'screen', 'sound', 'server', 'download'].map(id => ({ icon: roomOf[id], label: c.rows[id].name, note: c.rows[id].note, href: `#w-${id}` })),
    { icon: 'users', label: c.group, note: c.groupNote, href: '#w-house' },
  ];
  return page({
    lang, page: 'home', title: `${c.title} — TolkTak`, description: c.description,
    downloads: ctx.downloads, switch: entries,
    body: `<main id="main">
${hero(ctx)}
${house(ctx)}
<div class="w-wrap">
  <div class="w-world">
    ${rail(lang)}
    <div class="w-rooms">
${chat(ctx)}
${voice(ctx)}
${screen(ctx)}
${sound(ctx)}
${server(ctx)}
    </div>
  </div>
</div>
${finale(ctx)}
</main>`,
  });
}
