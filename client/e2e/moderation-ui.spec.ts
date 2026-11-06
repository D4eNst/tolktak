import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const client = path.join(__dirname, '..');
const bundle = buildSync({ stdin: { resolveDir: client, loader: 'tsx', contents: `
  import { render } from 'preact';
  import { Api } from './src/renderer/api';
  import { setLocale } from './src/renderer/i18n';
  import { session, groups, users, callEvents } from './src/renderer/state';
  import { AskHost, MenuHost, openMenu } from './src/renderer/ui/common';
  import { ModerationHost, participantModerationItems, openRestrictions, canModerateRoom } from './src/renderer/ui/Moderation';
  const user = id => ({id,username:'user'+id,display_name:'Участник '+id,avatar:'',color:'#555',about:'',status:'',is_admin:false});
  const a = new Api('https://moderation.test');
  users.value = new Map([1,2,3,4].map(id=>[id,user(id)]));
  groups.value = new Map([[1,{id:1,name:'Группа',owner_id:1,members:[1,2,3,4],roles:{2:'mod',3:'mod'},rooms:[{id:7,name:'Общая',group_id:1,position:0}],text_channels:[],channel_id:1,avatar:'',description:''}]]);
  session.value = {api:a,me:user(1),server:{capabilities:{moderation:1}}};
  setLocale('ru');
  window.moderationTest = {role(id){session.value={...session.value,me:user(id)}}, permissions(id){return canModerateRoom(7,id)}, notify(){callEvents.dispatchEvent(new CustomEvent('voice.moderation',{detail:{room_id:7}}))}, reset(){window.dispatchEvent(new Event('tolktak:session-reset'));session.value={...session.value,api:new Api('https://other.test')}}};
  render(<><button onClick={e=>openMenu(e,participantModerationItems(e,7,4))}>Участник</button><button onClick={()=>openRestrictions(7)}>Ограничения комнаты</button><MenuHost/><AskHost/><ModerationHost/></>,document.getElementById('root'));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', jsxImportSource: 'preact' }).outputFiles[0].text;
const css = readFileSync(path.join(client, 'src/renderer/styles.css'), 'utf8');
const permissions = { room_id: 7, user_id: 4, rules: [], allowed: { entry: true, microphone: true, camera: true, screen: true }, moderation_version: 1, call_id: 1 };
type Request = { method: string; path: string; body: unknown };
let requests: Request[];
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  requests = [];
  await page.route('https://moderation.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: route.request().method(), path: url.pathname + url.search, body: route.request().postDataJSON() });
      await route.fulfill({ json: url.pathname.endsWith('/moderation') ? { rules: [], users: [], has_more: false, next_after: null, moderation_version: 1, call_id: 1 } : permissions });
    } else await route.fulfill({ contentType: url.pathname === '/app.js' ? 'text/javascript' : 'text/html', body: url.pathname === '/app.js' ? bundle : '<!doctype html><style>'+css+'</style><div id="root"></div><script src="/app.js"></script>' });
  });
  await page.goto('https://moderation.test/');
});
async function sourceMenu(page: Page, source = 'Микрофон') {
  await page.getByRole('button', { name: 'Участник', exact: true }).click();
  await page.getByRole('menuitem', { name: source, exact: false }).click();
}

test('participant actions keep off separate from restrictions and submit chosen durations', async ({ page }) => {
  await sourceMenu(page);
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await page.getByRole('menuitem', { name: 'Выключить', exact: true }).click();
  await expect.poll(() => requests.at(-1)).toEqual({ method: 'POST', path: '/api/v1/rooms/7/participants/4/off', body: { source: 'microphone' } });
  for (const [label, body] of [['На 5 минут', { duration: 'time', seconds: 300 }], ['До конца звонка', { duration: 'call' }], ['Бессрочно', { duration: 'permanent' }]] as const) {
    await sourceMenu(page, 'Камера');
    await page.getByRole('menuitem', { name: 'Запретить включение' }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect.poll(() => requests.at(-1)).toEqual({ method: 'PUT', path: '/api/v1/rooms/7/moderation/4/camera', body });
  }
  await sourceMenu(page, 'Трансляция');
  await page.getByRole('menuitem', { name: 'Запретить включение' }).click();
  await page.getByRole('menuitem', { name: 'Другое время…' }).click();
  await page.getByRole('spinbutton', { name: 'Минуты' }).fill('17');
  await page.getByRole('button', { name: 'Запретить включение' }).click();
  await expect.poll(() => requests.at(-1)).toEqual({ method: 'PUT', path: '/api/v1/rooms/7/moderation/4/screen', body: { duration: 'time', seconds: 1020 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('moderator hierarchy protects owner, self and fellow moderators; kick requires confirmation', async ({ page }) => {
  expect(await page.evaluate(() => [1,2,3,4].map(id=>(window as any).moderationTest.permissions(id)))).toEqual([false,true,true,true]);
  await page.evaluate(() => (window as any).moderationTest.role(2));
  expect(await page.evaluate(() => [1,2,3,4].map(id=>(window as any).moderationTest.permissions(id)))).toEqual([false,false,false,true]);
  await page.getByRole('button', { name: 'Участник', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Исключить из звонка' }).click();
  expect(requests).toHaveLength(0);
  await expect(page.getByRole('dialog')).toContainText('Вернуться можно будет после завершения текущего звонка.');
  await page.getByRole('button', { name: 'Исключить из звонка', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.path).toBe('/api/v1/rooms/7/participants/4/kick');
  await page.evaluate(() => (window as any).moderationTest.role(4));
  expect(await page.evaluate(() => (window as any).moderationTest.permissions(3))).toBe(false);
});

test('offline restrictions are paged, removable and late responses cannot reopen them after logout', async ({ page }) => {
  let removed = false;
  let deferred: (() => Promise<void>) | undefined;
  const rule = { id: 51, user_id: 4, room_id: 7, source: 'microphone', duration: 'permanent', expires_at: null, created_by: 1, call_id: null };
  await page.route('**/rooms/7/moderation?*', async route => {
    const after = new URL(route.request().url()).searchParams.get('after');
    await route.fulfill({ json: { rules: removed ? [] : [{...rule,id:after==='51'?52:51}], users: [], has_more: after === '0' && !removed, next_after: after === '0' && !removed ? 51 : null, moderation_version: 1, call_id: 1 } });
  });
  await page.route('**/rooms/7/moderation/4/microphone', async route => { removed = true; await route.fulfill({ json: permissions }); });
  await page.getByRole('button', { name: 'Ограничения комнаты' }).click();
  await expect(page.locator('.moderation-row')).toHaveCount(1);
  await expect(page.locator('.moderation-row')).toContainText('Бессрочно');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Назад', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Снять ограничение:', exact: false }).click();
  await expect(page.getByRole('dialog')).toContainText('Ограничений нет');
  await page.route('**/rooms/7/moderation?*', route => new Promise<void>(resolve => { deferred = async () => { await route.fulfill({ json: { rules:[rule], users:[], has_more:false,next_after:null,moderation_version:2,call_id:1 } });resolve(); }; }));
  await page.evaluate(() => (window as any).moderationTest.notify());
  await expect.poll(() => !!deferred).toBe(true);
  await page.evaluate(() => (window as any).moderationTest.reset());
  await deferred!();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
