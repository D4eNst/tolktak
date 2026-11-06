import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'node:path';
import type { Signal } from '@preact/signals';
import type { HistoryPage, HistoryQuery, Message } from '../src/renderer/api';
import type { HistoryStore, HistoryView } from '../src/renderer/history';
import type { useHistoryScroll } from '../src/renderer/ui/useHistoryScroll';

type Controls = ReturnType<typeof useHistoryScroll>;
type Harness = {
  calls: { query: HistoryQuery; signal: AbortSignal; resolve(page: HistoryPage): void }[];
  reads: number[]; hidden: Signal<boolean>; store: HistoryStore; view: HistoryView; controls: Controls;
  message(id: number, revision?: number): Message;
  page(first: number, last: number, patch?: Partial<HistoryPage>): HistoryPage;
  pending?: Promise<boolean | void>; recording?: Promise<number[]>;
  track(id: number, offset?: number, center?: boolean): Promise<number[]>;
  pressed: number; focused?: boolean; realNow?: typeof Date.now; unmount(): void;
};
declare global { interface Window { historyScrollTest: Harness } }

// Real production hook + store + Preact commits; only HTTP is deferred. No app/server stack.
const bundle = buildSync({
  stdin: { resolveDir: path.join(__dirname, '..'), loader: 'tsx', contents: `
    import { h, render } from 'preact';
    import { useLayoutEffect, useRef, useState } from 'preact/hooks';
    import { signal } from '@preact/signals';
    import { Api } from './src/renderer/api';
    import { HistoryStore } from './src/renderer/history';
    import { useHistoryScroll } from './src/renderer/ui/useHistoryScroll';
    const calls = [], reads = [], hidden = signal(false);
    const api = new Api('https://api.test');
    api.history = (_cid, query, signal) => new Promise(resolve => calls.push({query, signal, resolve}));
    api.changes = async () => ({messages:[],users:[],history_version:1000,complete:true,read:{message_id:0,unread:0}});
    const store = new HistoryStore(api, {users(){},read(){}}), view = store.createView(1);
    const message = (id, revision=id) => ({id,revision,channel_id:1,author_id:7,nonce:String(id),text:String(id),created_at:id,edited_at:null,deleted:false,reply_to:null,attachments:[],reactions:[],pinned_at:null});
    const page = (first,last,patch={}) => ({messages:Array.from({length:last-first+1},(_,i)=>message(first+i)),users:[],first_id:first,last_id:last,has_before:true,has_after:true,history_version:1000,read:{message_id:0,unread:0},...patch});
    const harness = window.historyScrollTest = {calls,reads,hidden,store,view,message,page,pressed:0};
    function App() {
      const list = useRef(null), items = view.items;
      const [painted, setPainted] = useState([]);
      // Intentionally delay children: a signal snapshot is not proof that its rows have committed.
      useLayoutEffect(() => { const id = requestAnimationFrame(() => setPainted(items)); return () => cancelAnimationFrame(id); }, [view.state.value.ids]);
      const controls = useHistoryScroll(view,list,id=>reads.push(id),hidden.value);
      harness.controls = controls;
      return h('div',{id:'parent'},h('button',{id:'activity'},'Activity'),
        h('div',{class:'msg-list',ref:list,onScroll:controls.onScroll},h('div',{class:'pad'}),
          ...painted.map(m=>h('div',{class:'msg','data-id':m.id,key:m.id},String(m.id),h('button',{class:'actions',onClick:()=>harness.pressed++},'Action')))),
        h('button',{id:'back',disabled:!view.backStack.length,onClick:controls.back},'Back'));
    }
    harness.track = (id, offset=0, center=false) => new Promise(resolve => {
      const samples=[], started=performance.now();
      const frame=()=>{const list=document.querySelector('.msg-list'),row=list?.querySelector('.msg[data-id="'+id+'"]');
        if(row){const r=row.getBoundingClientRect(),l=list.getBoundingClientRect();samples.push(center?(r.top+r.bottom-l.top-l.bottom)/2:r.top-l.top-offset);}
        if(performance.now()-started<400)requestAnimationFrame(frame);else resolve(samples);
      };requestAnimationFrame(frame);
    });
    render(h(App,{}),document.getElementById('root'));
    harness.unmount = () => render(null,document.getElementById('root'));
    view.open(new URL(location.href).searchParams.has('tail')?{last_read_id:0,unread:0}:{last_read_id:100,unread:40});
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser',
}).outputFiles[0].text;
const html = '<!doctype html><style>body{margin:0}.msg-list{height:300px;width:400px;overflow:auto;position:relative}.msg{height:40px;box-sizing:border-box;position:relative}.pad{height:50px}.actions{display:none;position:absolute;right:4px;top:10px}.msg:hover .actions{display:block}</style><div id="root"></div><script src="/harness.js"></script>';
test.use({ viewport: { width: 800, height: 700 } });
test.beforeEach(async ({ page }) => {
  await page.route('https://history-scroll.test/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('/harness.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('/harness.js') ? bundle : html,
  }));
});

async function boot(page: Page, tail = false) {
  await page.goto('https://history-scroll.test/' + (tail ? '?tail' : ''));
  await page.bringToFront();
  await page.evaluate((tail) => { const h = window.historyScrollTest; h.calls[0].resolve(h.page(101, 140, { has_after: !tail })); }, tail);
  await expect(page.locator('.msg[data-id]')).toHaveCount(40);
  if (tail) await expect.poll(() => page.locator('.msg-list').evaluate((list) => list.scrollHeight - list.clientHeight - list.scrollTop)).toBeLessThan(1);
  else await expect.poll(() => offset(page, 101)).toBeLessThan(1);
  await page.waitForTimeout(100); // Programmatic positioning must settle before a user scroll.
}
async function offset(page: Page, id: number) {
  return page.locator(`.msg[data-id="${id}"]`).evaluate((row) => row.getBoundingClientRect().top - row.closest('.msg-list')!.getBoundingClientRect().top);
}
async function scrollTo(page: Page, top: number) {
  await page.locator('.msg-list').evaluate((list, top) => { list.scrollTop = top; list.dispatchEvent(new Event('scroll')); }, top);
}

test('delayed DOM commits still position first unread, and prepend/resize preserve the visible anchor without cascading pages', async ({ page }) => {
  await boot(page);
  expect(await offset(page, 101)).toBe(0);
  await scrollTo(page, 290);
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.calls.length)).toBe(2);
  const anchor = await page.evaluate(() => window.historyScrollTest.view.anchor!);
  await page.evaluate(() => { const h = window.historyScrollTest; h.calls[1].resolve(h.page(91, 100)); });
  await expect(page.locator('.msg[data-id]')).toHaveCount(50);
  await expect.poll(async () => Math.abs(await offset(page, anchor.id) - anchor.offset)).toBeLessThan(1);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.historyScrollTest.calls.length)).toBe(2);
  await page.locator('.msg[data-id="91"]').evaluate((row) => (row.style.height = '140px'));
  await expect.poll(async () => Math.abs(await offset(page, anchor.id) - anchor.offset)).toBeLessThan(1);
});

test('older jumps move upward and Back moves toward its newer anchor after the bounded replacement', async ({ page }) => {
  await boot(page);
  await scrollTo(page, 650);
  const anchor = await page.evaluate(() => window.historyScrollTest.view.anchor!);
  const start = await page.locator('.msg-list').evaluate((list) => list.scrollTop);
  await page.evaluate(() => { const h = window.historyScrollTest; h.pending = h.controls.jump(20); });
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.calls.length)).toBe(2);
  expect(await page.locator('.msg-list').evaluate((list) => list.scrollTop)).toBeLessThan(start);
  await page.evaluate(() => { const h = window.historyScrollTest; h.recording = h.track(20, 0, true); h.calls[1].resolve(h.page(1, 100, { has_before: false })); });
  expect(await page.evaluate(() => window.historyScrollTest.pending)).toBe(true);
  const older = await page.evaluate(() => window.historyScrollTest.recording!);
  expect(Math.min(...older)).toBeLessThan(-20);
  expect(Math.abs(older.at(-1)!)).toBeLessThan(1);
  const beforeBack = await page.locator('.msg-list').evaluate((list) => list.scrollTop);
  await page.evaluate(() => { const h = window.historyScrollTest; h.pending = h.controls.back(); });
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.calls.length)).toBe(3);
  expect(await page.locator('.msg-list').evaluate((list) => list.scrollTop)).toBeGreaterThan(beforeBack);
  await page.evaluate((anchor) => { const h = window.historyScrollTest; h.recording = h.track(anchor.id, anchor.offset); h.calls[2].resolve(h.page(90, 189)); }, anchor);
  await page.evaluate(() => window.historyScrollTest.pending);
  const newer = await page.evaluate(() => window.historyScrollTest.recording!);
  expect(Math.max(...newer)).toBeGreaterThan(20);
  expect(Math.abs(newer.at(-1)!)).toBeLessThan(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => window.historyScrollTest.controls.jump(125))).toBe(true);
  const center = await page.locator('.msg[data-id="125"]').evaluate((row) => { const r = row.getBoundingClientRect(), l = row.closest('.msg-list')!.getBoundingClientRect(); return (r.top + r.bottom - l.top - l.bottom) / 2; });
  expect(Math.abs(center)).toBeLessThan(1);
});

test('local jumps expose Back, and wheel cancellation or disposal rejects late navigation results', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(() => window.historyScrollTest.controls.jump(120))).toBe(true);
  await expect(page.locator('#back')).toBeEnabled();
  await page.evaluate(() => { const h = window.historyScrollTest; h.pending = h.controls.jump(900); });
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.calls.length)).toBe(2);
  await page.locator('.msg-list').dispatchEvent('wheel', { deltaY: 200 });
  expect(await page.evaluate(() => window.historyScrollTest.calls[1].signal.aborted)).toBe(true);
  await page.evaluate(() => { const h = window.historyScrollTest; h.calls[1].resolve(h.page(850, 949)); });
  expect(await page.evaluate(() => window.historyScrollTest.pending)).toBe(false);
  await expect(page.locator('.msg[data-id="900"]')).toHaveCount(0);
  await page.evaluate(() => { const h = window.historyScrollTest; h.pending = h.controls.jump(1000); });
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.calls.length)).toBe(3);
  await page.evaluate(() => { const h = window.historyScrollTest; h.unmount(); h.calls[2].resolve(h.page(950, 1049)); });
  expect(await page.evaluate(() => window.historyScrollTest.pending)).toBe(false);
  await expect(page.locator('.msg-list')).toHaveCount(0);
});

test('reading requires focus, fresh activity and dwell, and hidden/inactive windows do not auto-read', async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(550);
  expect(await page.evaluate(() => window.historyScrollTest.reads)).toEqual([]);
  await page.click('#activity');
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.historyScrollTest.reads)).toEqual([]);
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.reads.at(-1))).toBe(108);
  const count = await page.evaluate(() => window.historyScrollTest.reads.length);
  await page.click('#activity');
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.reads.length)).toBeGreaterThan(count);
  await page.evaluate(() => (window.historyScrollTest.hidden.value = true));
  await page.waitForTimeout(50);
  const hiddenCount = await page.evaluate(() => window.historyScrollTest.reads.length);
  await page.click('#activity'); await page.waitForTimeout(550);
  expect(await page.evaluate(() => window.historyScrollTest.reads.length)).toBe(hiddenCount);
  await page.evaluate(() => { const h = window.historyScrollTest; h.hidden.value = false; h.realNow = Date.now; Date.now = () => h.realNow!() + 61_000; });
  await page.waitForTimeout(100);
  await scrollTo(page, 850); await page.waitForTimeout(550);
  expect(await page.evaluate(() => window.historyScrollTest.reads.at(-1))).toBe(108);
  await page.click('#activity'); await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.historyScrollTest.reads.at(-1))).toBe(108);
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.reads.at(-1))).toBe(128);
  // Playwright headless emulates focused background pages; control the DOM focus boundary.
  await page.evaluate(() => {
    const h = window.historyScrollTest; h.focused = false;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => h.focused });
    window.dispatchEvent(new Event('blur'));
  });
  await scrollTo(page, 950); await page.waitForTimeout(550);
  expect(await page.evaluate(() => window.historyScrollTest.reads.at(-1))).toBe(128);
  await page.evaluate(() => { window.historyScrollTest.focused = true; window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.reads.at(-1))).toBe(130);
});

test('search/floating overlays and hidden ancestors block reading; a tall message needs 200 visible pixels', async ({ page }) => {
  await boot(page);
  for (const className of ['chat-panel', 'dv-floating-overlay-host']) {
    await page.evaluate((className) => {
      const rect = document.querySelector('.msg-list')!.getBoundingClientRect(), cover = document.createElement('aside');
      cover.id = 'cover'; cover.className = className;
      Object.assign(cover.style, { position: 'fixed', zIndex: '9999', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', background: 'black' });
      document.body.append(cover);
    }, className);
    await page.click('#activity'); await page.waitForTimeout(550);
    expect(await page.evaluate(() => window.historyScrollTest.reads)).toEqual([]);
    await page.locator('#cover').evaluate((cover) => cover.remove());
  }
  await page.evaluate(() => { document.querySelector<HTMLElement>('#parent')!.style.visibility = 'hidden'; window.historyScrollTest.store.receive(window.historyScrollTest.message(107, 1001)); });
  await page.waitForTimeout(550);
  expect(await page.evaluate(() => window.historyScrollTest.reads)).toEqual([]);
  await page.locator('#parent').evaluate((parent) => (parent.style.visibility = ''));
  await page.locator('.msg[data-id="108"]').evaluate((row) => (row.style.height = '800px'));
  await page.waitForTimeout(100);
  await scrollTo(page, 630);
  await page.click('#activity');
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.reads.at(-1))).toBe(108);
});

test('pointer hover stops an append glide so row actions remain reachable', async ({ page }) => {
  await boot(page, true);
  const before = await page.locator('.msg-list').evaluate((list) => list.scrollTop);
  await page.evaluate(() => { const h = window.historyScrollTest; h.store.receive(h.message(141, 1001)); });
  await expect(page.locator('.msg[data-id="141"]')).toHaveCount(1);
  await page.waitForTimeout(80);
  const bounds = (await page.locator('.msg[data-id="140"]').boundingBox())!;
  await page.mouse.move(bounds.x + 200, bounds.y + bounds.height / 2);
  const stopped = await page.locator('.msg-list').evaluate((list) => list.scrollTop);
  expect(stopped).toBeGreaterThan(before);
  await page.waitForTimeout(420);
  expect(await page.locator('.msg-list').evaluate((list) => list.scrollTop)).toBeCloseTo(stopped, 0);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.msg')?.getAttribute('data-id'), { x: bounds.x + 200, y: bounds.y + bounds.height / 2 })).toBe('140');
  await page.locator('.msg[data-id="140"] .actions').click({ timeout: 1500 });
  expect(await page.evaluate(() => window.historyScrollTest.pressed)).toBe(1);
});

test('a browser scroll immediately after positioning is not mistaken for the controller own scroll', async ({ page }) => {
  await boot(page, true);
  const position = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.msg-list')!;
    window.dispatchEvent(new Event('focus'));
    return new Promise<number>((resolve) => requestAnimationFrame(() => {
      list.scrollTop -= 120;
      list.dispatchEvent(new Event('scroll'));
      const top = list.scrollTop;
      document.querySelector('.msg[data-id="138"]')!.firstChild!.textContent = 'Changed';
      resolve(top);
    }));
  });
  await page.waitForTimeout(150);
  expect(await page.locator('.msg-list').evaluate((list) => list.scrollTop)).toBeCloseTo(position, 0);
  expect(await page.evaluate(() => window.historyScrollTest.view.following)).toBe(false);
  await page.locator('.msg[data-id="138"]').hover();
  await page.locator('.msg[data-id="138"] .actions').click();
  expect(await page.evaluate(() => window.historyScrollTest.pressed)).toBe(1);
});

test('a rendered history still pages without a request loop when 32 views share the cache budget', async ({ page }) => {
  await boot(page, true);
  await page.evaluate(async () => {
    const h = window.historyScrollTest;
    const load = h.view.latest();
    h.calls.at(-1)!.resolve(h.page(301, 400, { has_after: false }));
    await load;
    for (let cid = 2; cid <= 32; cid++) {
      const view = h.store.createView(cid);
      const load = view.latest();
      const result = h.page(301, 400, { has_after: false });
      result.messages = result.messages.map((message) => ({ ...message, channel_id: cid }));
      h.calls.at(-1)!.resolve(result);
      await load;
    }
  });
  await expect(page.locator('.msg[data-id]')).toHaveCount(75);
  const calls = await page.evaluate(() => window.historyScrollTest.calls.length);
  const first = Number(await page.locator('.msg[data-id]').first().getAttribute('data-id'));
  await scrollTo(page, 0);
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.calls.length)).toBe(calls + 1);
  await page.evaluate(() => {
    const h = window.historyScrollTest;
    const request = h.calls.at(-1)!;
    const before = request.query.before!;
    request.resolve(h.page(before - 100, before - 1));
  });
  await expect.poll(async () => Number(await page.locator('.msg[data-id]').first().getAttribute('data-id'))).toBeLessThan(first);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.historyScrollTest.calls.length)).toBe(calls + 1);
  const last = Number(await page.locator('.msg[data-id]').last().getAttribute('data-id'));
  await scrollTo(page, 100_000);
  await expect.poll(() => page.evaluate(() => window.historyScrollTest.calls.length)).toBe(calls + 2);
  await page.evaluate(() => {
    const h = window.historyScrollTest;
    const request = h.calls.at(-1)!;
    const after = request.query.after!;
    request.resolve(h.page(after + 1, after + 100));
  });
  await expect.poll(async () => Number(await page.locator('.msg[data-id]').last().getAttribute('data-id'))).toBeGreaterThan(last);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.historyScrollTest.calls.length)).toBe(calls + 2);
  expect(await page.evaluate(() => [...window.historyScrollTest.store.views].reduce((total, view) => total + view.items.length, 0))).toBeLessThanOrEqual(2400);
  await page.evaluate(() => {
    const h = window.historyScrollTest;
    h.unmount();
    h.store.dispose();
  });
  expect(await page.evaluate(() => window.historyScrollTest.store.views.size)).toBe(0);
});
