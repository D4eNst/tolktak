import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const client = path.join(__dirname, '..');
const read = (file: string) => readFileSync(path.join(client, 'src/renderer/ui', file), 'utf8');
const extract = (file: string, start: string, end: string) => { const source = read(file); return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); };
const searchPanel = extract('Chat.tsx', 'function SearchPanel(', 'function TypingLine(');
const panelError = extract('Chat.tsx', 'function PanelError(', 'function PinsPanel(');
const membersPanel = extract('desk.tsx', 'function MembersPanel(', '// ---------- settings');
const callPeople = extract('Stage.tsx', 'export function CallPeople(', 'function CameraCheck(').replace('export function', 'function');
const groupSettings = read('GroupSettings.tsx').slice(read('GroupSettings.tsx').indexOf('export function GroupSettingsDialog(')).replace('export function', 'function');
const bundle = buildSync({ stdin: { resolveDir: client, loader: 'tsx', contents: `
import {render} from 'preact';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'preact/hooks';
import {signal} from '@preact/signals';
import {useSearch,SearchField} from './src/renderer/ui/search';
import {Icon,Modal} from './src/renderer/ui/common';
import {t} from './src/renderer/i18n';
import {Api} from './src/renderer/api';
import {HistoryStore} from './src/renderer/history';
const mode=signal('field'),shown=signal(true),busy=signal(false),queries=[],keys=[],requests=[],known=[],actions=[];
const realSet=window.setTimeout.bind(window),realClear=window.clearTimeout.bind(window),timers=new Set();
window.setTimeout=(fn,delay,...args)=>{let id;id=realSet(()=>{timers.delete(id);fn(...args)},delay);if(delay===350)timers.add(id);return id};
window.clearTimeout=id=>{timers.delete(id);realClear(id)};
const user=(id,name,username)=>({id,display_name:name,username,avatar:'',color:'#555'});
const users=signal(new Map([[1,user(1,'Alice','alice')],[2,user(2,'Борис','bob')],[3,user(3,'Елена','elena')],[4,user(4,'Елена Другая','elena_2')]]));
const online=signal(new Set([1,3])),me=signal({id:1});
const group={id:1,name:'Группа',members:[1,2,3,4],owner_id:1,roles:{2:'mod'},text_channels:[],rooms:[],channel_id:7,avatar:'',description:''};
const userName=id=>users.value.get(id)?.display_name??'?';
const groupRole=(g,id=1)=>id===g.owner_id?'owner':g.roles[id]??'member';
const useKnownUsers=ids=>{known.push([...ids])};
const MAX_IMAGE_MB=8;
const Avatar=({id})=><span>{userName(id)}</span>,GroupAvatar=()=>null,OrderList=()=>null;
const memberMenu=(_g,id)=>actions.push('menu'+id),openProfile=id=>actions.push('profile'+id);
const apiObject=new Api('https://search-behavior.test');
apiObject.history=async()=>({messages:[],users:[],first_id:null,last_id:null,has_before:false,has_after:false,history_version:5,read:{message_id:0,unread:0}});
apiObject.search=(cid,q,before,abort)=>new Promise((resolve,reject)=>requests.push({cid,q,before,abort,resolve,reject}));
const api=()=>apiObject,session=signal({api:apiObject}),history=signal(new HistoryStore(apiObject,{users(){},read(){}}));
const view=history.value.createView(7);view.open({last_read_id:0,unread:0});
const mergeUsers=()=>{},toast=()=>{},errorText=String,jumpTo=id=>actions.push('jump'+id);
const MiniMessage=({m,onJump})=><button class="mini-msg" onClick={onJump}>{m.text}</button>;
const call=signal({}),prefs=signal({userVolume:{}}),peers=signal([{identity:'1',userId:1,name:'Alice',isLocal:true},{identity:'2',userId:2,name:'Борис',isLocal:false},{identity:'3',userId:3,name:'Елена',isLocal:false}]);
const moderationRoom=()=>null,openParticipantMenu=()=>{},setUserVolume=()=>{};
${panelError}
${searchPanel}
${membersPanel}
${callPeople}
${groupSettings}
function Field(){const search=useSearch();window.searchTest.field=search;useLayoutEffect(()=>{if(search.query)queries.push(search.query)},[search.query]);return <SearchField search={search} placeholder="Найти" busy={busy.value} class="legacy-search" inputClass="legacy-input" onKeyDown={e=>keys.push(e.key)}/>}
window.searchTest={field:null,show(name){mode.value=name;shown.value=true},hide(){shown.value=false},busy(value){busy.value=value},resolve(index,text='result',options={}){requests[index].resolve({messages:[{id:10+index,revision:6+index,channel_id:7,author_id:2,nonce:'m'+index,text,created_at:1,edited_at:null,deleted:false,reply_to:null,attachments:[],reactions:[],pinned_at:null}],users:[],history_version:6+index,has_more:false,next_before:null,...options})},fail(index){requests[index].reject(new Error('Failed search'))},state(){return{queries:[...queries],keys:[...keys],timers:timers.size,requests:requests.map(r=>({q:r.q,before:r.before,aborted:r.abort.aborted})),known,actions,query:this.field?.query,pending:this.field?.pending}}};
function App(){if(!shown.value)return null;switch(mode.value){case'chat':return <SearchPanel channelId={7} onClose={()=>{shown.value=false}}/>;case'members':return <MembersPanel g={group}/>;case'group':return <GroupSettingsDialog group={group} onClose={()=>{shown.value=false}}/>;case'call':return <CallPeople/>;default:return <Field/>}}
render(<App/>,document.getElementById('root'));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', jsxImportSource: 'preact' }).outputFiles[0].text;

type SearchTrace = { queries: string[]; keys: string[]; timers: number; requests: { q: string; before?: number; aborted: boolean }[]; known: number[][]; actions: string[]; query?: string; pending?: boolean };
declare global { interface Window { searchTest: {
  show(mode: string): void; hide(): void; busy(value: boolean): void; resolve(index: number, text?: string, options?: Record<string, unknown>): void; fail(index: number): void; state(): SearchTrace;
} } }
const state = (page: Page) => page.evaluate(() => window.searchTest.state());
const settle = (page: Page) => page.clock.runFor(350);
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
  await page.clock.install({ time: new Date('2026-11-03T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-03T12:00:00Z'));
  await page.route('https://search-behavior.test/**', (route) => route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html', body: route.request().url().endsWith('.js') ? bundle : '<!doctype html><div id="root"></div><script src="/app.js"></script>' }));
  await page.goto('https://search-behavior.test/');
});

test('one trailing 350ms timer commits only the final input; clear and Enter cancel old timers', async ({ page }) => {
  const input = page.getByRole('searchbox');
  await input.fill('one'); await page.clock.runFor(200);
  await input.fill('two'); await page.clock.runFor(349);
  expect((await state(page)).queries).toEqual([]);
  await expect(page.locator('.search-control')).toHaveClass(/search-active/);
  await page.clock.runFor(1);
  expect((await state(page)).queries).toEqual(['two']);
  await input.fill('old'); await page.clock.runFor(100);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await state(page)).query).toBe('');
  expect((await state(page)).timers).toBe(0);
  await page.clock.runFor(500);
  expect((await state(page)).queries).toEqual(['two']);
  await input.fill('enter'); await input.press('Enter');
  expect((await state(page)).query).toBe('enter');
  expect((await state(page)).keys).toContain('Enter');
  expect((await state(page)).timers).toBe(0);
  await page.clock.runFor(500);
  expect((await state(page)).queries).toEqual(['two', 'enter']);
});

test('IME never commits interim text or forwards composition Enter, then debounces its final value', async ({ page }) => {
  const input = page.getByRole('searchbox');
  await input.dispatchEvent('compositionstart');
  await input.fill('に'); await page.clock.runFor(500);
  await input.press('ArrowDown');
  await input.press('Enter');
  expect((await state(page)).queries).toEqual([]);
  expect((await state(page)).keys).not.toContain('Enter');
  expect((await state(page)).keys).not.toContain('ArrowDown');
  await input.fill('日本'); await input.dispatchEvent('compositionend', { data: '日本' });
  await page.clock.runFor(349); expect((await state(page)).queries).toEqual([]);
  await page.clock.runFor(1); expect((await state(page)).queries).toEqual(['日本']);
});

test('unmount cancels the field timer; activity and legacy classes stay present while busy', async ({ page }) => {
  await page.getByRole('searchbox').fill('late');
  expect((await state(page)).timers).toBe(1);
  await page.evaluate(() => window.searchTest.hide());
  expect((await state(page)).timers).toBe(0);
  await page.clock.runFor(1000); expect((await state(page)).queries).toEqual([]);
  await page.evaluate(() => { window.searchTest.show('field'); window.searchTest.busy(true); });
  await expect(page.locator('.search-control.legacy-search')).toHaveClass(/search-active/);
  await expect(page.locator('input.legacy-input')).toHaveAttribute('aria-label', 'Найти');
  await expect(page.locator('.search-activity')).toHaveAttribute('aria-hidden', 'true');
  await page.evaluate(() => window.searchTest.busy(false));
  await expect(page.locator('.search-control')).not.toHaveClass(/search-active/);
});

test('chat uses settled queries only, aborts and hides stale results, and keeps the two-character minimum', async ({ page }) => {
  await page.evaluate(() => window.searchTest.show('chat'));
  const input = page.getByRole('searchbox');
  await input.fill('a'); await settle(page); expect((await state(page)).requests).toHaveLength(0);
  await input.fill('😀'); await settle(page); expect((await state(page)).requests).toHaveLength(0);
  await input.fill('alpha'); await page.clock.runFor(349); expect((await state(page)).requests).toHaveLength(0);
  await page.clock.runFor(1); expect((await state(page)).requests.map((r) => r.q)).toEqual(['alpha']);
  await page.evaluate(() => window.searchTest.resolve(0, 'alpha result'));
  await expect(page.locator('.mini-msg')).toHaveText('alpha result');
  await input.fill('beta');
  await expect(page.locator('.mini-msg')).toHaveCount(0);
  expect((await state(page)).requests[0].aborted).toBe(true);
  await settle(page); expect((await state(page)).requests.map((r) => r.q)).toEqual(['alpha', 'beta']);
  await input.fill('gamma'); expect((await state(page)).requests[1].aborted).toBe(true);
  await page.evaluate(() => window.searchTest.resolve(1, 'late beta'));
  await expect(page.locator('.mini-msg')).toHaveCount(0);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.clock.runFor(1000); expect((await state(page)).requests).toHaveLength(2);
});

test('chat preserves pagination, retry, snapshot rejection and cleanup without another debounce', async ({ page }) => {
  await page.evaluate(() => window.searchTest.show('chat'));
  await page.getByRole('searchbox').fill('alpha'); await settle(page);
  await page.evaluate(() => window.searchTest.resolve(0, 'page1', { has_more: true, next_before: 10 }));
  await expect(page.locator('.mini-msg')).toHaveText('page1');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  expect((await state(page)).requests[1]).toMatchObject({ q: 'alpha', before: 10 });
  await page.evaluate(() => window.searchTest.fail(1));
  await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  expect((await state(page)).requests[2]).toMatchObject({ q: 'alpha', before: 10 });
  await page.evaluate(() => window.searchTest.resolve(2, 'stale', { history_version: 1 }));
  await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.evaluate(() => window.searchTest.resolve(3, 'page2'));
  await expect(page.locator('.mini-msg')).toHaveText('page2');
  await page.getByRole('searchbox').fill('beta'); await page.getByRole('searchbox').press('Enter');
  expect((await state(page)).requests[4]).toEqual({ q: 'beta', aborted: false });
  await page.evaluate(() => window.searchTest.hide());
  expect((await state(page)).requests[4].aborted).toBe(true);
});

test('MembersPanel filters local names and usernames after settling, with matching online/offline counts and menus', async ({ page }) => {
  await page.evaluate(() => window.searchTest.show('members'));
  const panel = page.locator('.members-panel'), input = panel.getByRole('searchbox');
  await expect(panel.locator('.member')).toHaveCount(4);
  await input.fill('ЕЛЕНА'); await page.clock.runFor(349); await expect(panel.locator('.member')).toHaveCount(4);
  await page.clock.runFor(1); await expect(panel.locator('.member')).toHaveCount(2);
  expect(await panel.locator('.side-label-count').allTextContents()).toEqual(['1', '1']);
  await input.fill('bob'); await input.press('Enter');
  await expect(panel.locator('.member')).toHaveCount(1);
  await expect(panel.locator('.member')).toHaveClass(/offline/);
  await expect(panel.locator('.role-ico.mod')).toHaveCount(1);
  expect(await panel.locator('.side-label-count').allTextContents()).toEqual(['0', '1']);
  await panel.locator('.member').click(); await panel.locator('.member').click({ button: 'right' });
  expect((await state(page)).actions).toEqual(['profile2', 'menu2']);
  await input.fill('missing'); await settle(page);
  await expect(panel).toContainText('Ничего не найдено');
  await panel.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(panel.locator('.member')).toHaveCount(4);
  expect((await state(page)).requests).toHaveLength(0);
  expect((await state(page)).known.some((ids) => ids.join(',') === '1,2,3,4')).toBe(true);
});

test('GroupSettings member filter and call-people filter use the same delay and immediate clear', async ({ page }) => {
  await page.evaluate(() => window.searchTest.show('group'));
  await page.getByRole('button', { name: 'Участники', exact: true }).click();
  const groupInput = page.getByRole('searchbox');
  await groupInput.fill('bob'); await page.clock.runFor(349); await expect(page.locator('.member-row')).toHaveCount(4);
  await page.clock.runFor(1); await expect(page.locator('.member-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(page.locator('.member-row')).toHaveCount(4);
  await page.evaluate(() => window.searchTest.show('call'));
  const input = page.locator('.cp-search input');
  await input.fill('Елена'); await page.clock.runFor(349); await expect(page.locator('.cp-row:not(.self)')).toHaveCount(2);
  await page.clock.runFor(1); await expect(page.locator('.cp-row:not(.self)')).toHaveCount(1);
  await expect(page.locator('.cp-row.self')).toHaveCount(1);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(page.locator('.cp-row:not(.self)')).toHaveCount(2);
});
