import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'node:path';

const bundle = buildSync({ stdin: { resolveDir: path.join(__dirname, '..'), loader: 'tsx', contents: `
import {render} from 'preact';
import {signal} from '@preact/signals';
import {Modal,Popover,AskHost,confirmDialog,promptDialog} from './src/renderer/ui/common';
const shown=signal(false), version=signal(1), popover=signal(false), popVersion=signal(1), calls=[], results=[];
const deferred=new Map(), nativeSet=window.setTimeout.bind(window), nativeClear=window.clearTimeout.bind(window);
let timer=-1;
window.setTimeout=(fn,delay,...args)=>{if(delay===undefined&&String(fn).includes('addEventListener')&&String(fn).includes('mousedown')){const id=timer--;deferred.set(id,()=>fn(...args));return id}return nativeSet(fn,delay,...args)};
window.clearTimeout=id=>{deferred.delete(id);nativeClear(id)};
const mouseListeners=new Set(), add=window.addEventListener.bind(window), remove=window.removeEventListener.bind(window);
window.addEventListener=(type,fn,...args)=>{if(type==='mousedown')mouseListeners.add(fn);return add(type,fn,...args)};
window.removeEventListener=(type,fn,...args)=>{if(type==='mousedown')mouseListeners.delete(fn);return remove(type,fn,...args)};
window.commonLifecycle={
  show(){shown.value=true},hide(){shown.value=false},callback(v){version.value=v},
  pop(){popover.value=true},hidePop(){popover.value=false},popCallback(v){popVersion.value=v},
  flush(){const callbacks=[...deferred.values()];deferred.clear();callbacks.forEach(fn=>fn())},
  confirm(id,title='Один заголовок'){confirmDialog(title).then(value=>results.push({id,value}))},
  prompt(id){promptDialog('Новый ввод',{initial:'Начальное значение'}).then(value=>results.push({id,value}))},
  reset(){window.dispatchEvent(new Event('tolktak:session-reset'))},
  state(){return{calls:[...calls],results:[...results],deferred:deferred.size,scheduled:-timer-1,mouseListeners:mouseListeners.size}}
};
function App(){const v=version.value,pv=popVersion.value;return <>
  {shown.value&&<Modal title="Тест Modal" onClose={()=>{calls.push('modal'+v);shown.value=false}}>Тело</Modal>}
  {popover.value&&<Popover x={10} y={10} onClose={()=>calls.push('popover'+pv)}>Popover body</Popover>}
  <AskHost/>
</>}
render(<App/>,document.getElementById('root'));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', jsxImportSource: 'preact' }).outputFiles[0].text;

declare global { interface Window { commonLifecycle: {
  show(): void; hide(): void; callback(version: number): void; pop(): void; hidePop(): void; popCallback(version: number): void; flush(): void;
  confirm(id: string, title?: string): void; prompt(id: string): void; reset(): void;
  state(): { calls: string[]; results: { id: string; value: boolean | string | null }[]; deferred: number; scheduled: number; mouseListeners: number };
} } }
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
  await page.route('https://common-lifecycle.test/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('.js') ? bundle : '<!doctype html><button id="outside">Outside</button><div id="root"></div><script src="/app.js"></script>',
  }));
  await page.goto('https://common-lifecycle.test/');
});

test('unmount cancels a pending Modal close and a remounted dialog stays open', async ({ page }) => {
  await page.evaluate(() => window.commonLifecycle.show());
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();
  await page.evaluate(() => window.commonLifecycle.hide());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.commonLifecycle.show());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.commonLifecycle.state().calls)).toEqual([]);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('Modal closes once and uses its current callback during the closing animation', async ({ page }) => {
  await page.evaluate(() => window.commonLifecycle.show());
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await page.evaluate(() => window.commonLifecycle.callback(2));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.commonLifecycle.state().calls)).toEqual(['modal2']);
});

test('replacing an AskHost request cancels the old promise and cannot close the new prompt', async ({ page }) => {
  await page.evaluate(() => window.commonLifecycle.confirm('old'));
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();
  await page.evaluate(() => window.commonLifecycle.prompt('new'));
  await expect(page.getByRole('dialog', { name: 'Новый ввод' })).toBeVisible();
  await page.waitForTimeout(200);
  await expect(page.getByRole('dialog', { name: 'Новый ввод' })).toBeVisible();
  expect(await page.evaluate(() => window.commonLifecycle.state().results)).toEqual([{ id: 'old', value: false }]);
  await page.getByRole('textbox').fill('Новый результат');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.commonLifecycle.state().results)).toEqual([{ id: 'old', value: false }, { id: 'new', value: 'Новый результат' }]);
});

test('session reset cancels old close callbacks even when the next ask has the same title', async ({ page }) => {
  await page.evaluate(() => window.commonLifecycle.confirm('old'));
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();
  await page.evaluate(() => { window.commonLifecycle.reset(); window.commonLifecycle.confirm('new'); });
  await page.waitForTimeout(200);
  await expect(page.getByRole('dialog', { name: 'Один заголовок' })).toBeVisible();
  expect(await page.evaluate(() => window.commonLifecycle.state().results)).toEqual([{ id: 'old', value: false }]);
  await page.getByRole('button', { name: 'Да', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.commonLifecycle.state().results)).toEqual([{ id: 'old', value: false }, { id: 'new', value: true }]);
});

test('Popover cannot install an outside listener after unmount', async ({ page }) => {
  await page.evaluate(() => window.commonLifecycle.pop());
  await expect.poll(() => page.evaluate(() => window.commonLifecycle.state().deferred)).toBe(1);
  await page.evaluate(() => window.commonLifecycle.hidePop());
  await expect(page.locator('.popover')).toHaveCount(0);
  await page.evaluate(() => window.commonLifecycle.flush());
  await page.locator('#outside').click();
  expect(await page.evaluate(() => window.commonLifecycle.state())).toMatchObject({ calls: [], deferred: 0, mouseListeners: 0 });
});

test('Popover replaces pending callbacks without leaking old outside listeners', async ({ page }) => {
  await page.evaluate(() => window.commonLifecycle.pop());
  await expect.poll(() => page.evaluate(() => window.commonLifecycle.state().deferred)).toBe(1);
  await page.evaluate(() => window.commonLifecycle.popCallback(2));
  await expect.poll(() => page.evaluate(() => window.commonLifecycle.state().scheduled)).toBe(2);
  await page.evaluate(() => window.commonLifecycle.flush());
  await page.locator('#outside').click();
  expect(await page.evaluate(() => window.commonLifecycle.state().calls)).toEqual(['popover2']);
  await page.evaluate(() => window.commonLifecycle.hidePop());
  await expect(page.locator('.popover')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.commonLifecycle.state().mouseListeners), { timeout: 2000 }).toBe(0);
});
