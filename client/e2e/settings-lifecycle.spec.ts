import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(path.join(__dirname, '../src/renderer/ui/Settings.tsx'), 'utf8');
// Mount the unchanged production component, with controllable device/processor boundaries.
const component = source.slice(source.indexOf('function MicMeter('), source.indexOf('const DENOISE:'));
const bundle = buildSync({ stdin: { resolveDir: path.join(__dirname, '..'), loader: 'tsx', contents: `
import {render} from 'preact';
import {useEffect,useRef,useState} from 'preact/hooks';
import {signal} from '@preact/signals';
const call=signal(null), micLevel=signal(0), micGain=signal(0);
const prefs=signal({inputDevice:'A',outputDevice:'default',denoise:'off',echoCancellation:true,agc:false,inputGain:0});
const mounted=signal(true), listening=signal(false), media=[], requests=[], chains=[];
const t=()=>({settings:{meter:{gainTitle:'Gain',db:x=>x}}});
const chainSettings=p=>({inputGain:p.inputGain});
const micConstraints=()=>({deviceId:prefs.value.inputDevice});
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise(resolve=>media.push({resolve,stopped:false}))}});
const createVoiceChain=track=>new Promise((resolve,reject)=>requests.push({resolve,reject,track}));
${component}
window.settingsLifecycle={
  patch(p){prefs.value={...prefs.value,...p}},hide(){mounted.value=false},
  listen(){listening.value=true},
  media(i){const m=media[i];const track={stop(){m.stopped=true}};m.resolve({getAudioTracks:()=>[track],getTracks:()=>[track]})},
  chain(i){const c={id:i,closed:false,sets:[],output:{},set(p){this.sets.push(p.inputGain)},close(){this.closed=true}};chains.push(c);requests[i].resolve(c)},
  fail(i){requests[i].reject(new Error('Processor failed'))},
  state(){return{media:media.map(m=>({stopped:m.stopped})),requests:requests.length,chains:chains.map(c=>({id:c.id,closed:c.closed,sets:c.sets}))}}
};
function App(){return mounted.value?<MicMeter listen={listening.value}/>:null}
render(<App/>,document.getElementById('root'));
` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact' }).outputFiles[0].text;

declare global { interface Window { settingsLifecycle: {
  patch(patch: Record<string, unknown>): void; hide(): void; listen(): void; media(index: number): void; chain(index: number): void; fail(index: number): void;
  state(): { media: { stopped: boolean }[]; requests: number; chains: { id: number; closed: boolean; sets: number[] }[] };
} } }
const state = (page: Page) => page.evaluate(() => window.settingsLifecycle.state());
async function acquired(page: Page, index: number) {
  await expect.poll(async () => (await state(page)).media.length).toBe(index + 1);
  await page.evaluate((i) => window.settingsLifecycle.media(i), index);
  await expect.poll(async () => (await state(page)).requests).toBe(index + 1);
}
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
  await page.route('https://settings-lifecycle.test/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('.js') ? bundle : '<!doctype html><div id="root"></div><script src="/app.js"></script>',
  }));
  await page.goto('https://settings-lifecycle.test/');
});

test('late processor creation cannot replace the current settings chain or leak it on close', async ({ page }) => {
  await acquired(page, 0);
  await page.evaluate(() => window.settingsLifecycle.patch({ inputDevice: 'B' }));
  await acquired(page, 1);
  await page.evaluate(() => window.settingsLifecycle.chain(1));
  await expect.poll(async () => (await state(page)).chains.length).toBe(1);
  await page.evaluate(() => window.settingsLifecycle.chain(0));
  await expect.poll(async () => (await state(page)).chains.find((c) => c.id === 0)?.closed).toBe(true);
  expect((await state(page)).chains.find((c) => c.id === 1)?.closed).toBe(false);
  await page.evaluate(() => window.settingsLifecycle.patch({ inputGain: 7 }));
  await expect.poll(async () => (await state(page)).chains.find((c) => c.id === 1)?.sets).toContain(7);
  await page.evaluate(() => window.settingsLifecycle.hide());
  await expect.poll(async () => (await state(page)).chains.every((c) => c.closed)).toBe(true);
  expect((await state(page)).media.every((m) => m.stopped)).toBe(true);
});

test('a late device stream from an old effect cannot stop the new microphone preview', async ({ page }) => {
  await expect.poll(async () => (await state(page)).media.length).toBe(1);
  await page.evaluate(() => window.settingsLifecycle.patch({ inputDevice: 'B' }));
  await expect.poll(async () => (await state(page)).media.length).toBe(2);
  await page.evaluate(() => window.settingsLifecycle.media(1));
  await expect.poll(async () => (await state(page)).requests).toBe(1);
  await page.evaluate(() => window.settingsLifecycle.chain(0));
  await expect.poll(async () => (await state(page)).chains.length).toBe(1);
  await page.evaluate(() => window.settingsLifecycle.media(0));
  await expect.poll(async () => (await state(page)).media[0].stopped).toBe(true);
  expect((await state(page)).chains[0].closed).toBe(false);
  await page.evaluate(() => window.settingsLifecycle.hide());
  await expect.poll(async () => (await state(page)).chains[0].closed).toBe(true);
});

test('closing during processor creation releases the late chain; a failed processor stops its raw microphone immediately', async ({ page }) => {
  await acquired(page, 0);
  await page.evaluate(() => window.settingsLifecycle.hide());
  await expect.poll(async () => (await state(page)).media[0].stopped).toBe(true);
  await page.evaluate(() => window.settingsLifecycle.chain(0));
  await expect.poll(async () => (await state(page)).chains[0].closed).toBe(true);
  await page.reload();
  await acquired(page, 0);
  await page.evaluate(() => window.settingsLifecycle.fail(0));
  await expect.poll(async () => (await state(page)).media[0].stopped).toBe(true);
});
