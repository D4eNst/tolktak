import { page } from '../shell.mjs';
import { world } from '../../content/home/world.mjs';
import hero from './home/hero.mjs';
import house from './home/house.mjs';
import workspace from './home/workspace.mjs';
import server from './home/server.mjs';
import finale from './home/finale.mjs';

const roomOf = { chat: 'hash', voice: 'speaker', screen: 'speaker', sound: 'settings', server: 'home', download: 'download' };

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
${workspace(ctx)}
${server(ctx)}
</div>
${finale(ctx)}
</main>`,
  });
}
