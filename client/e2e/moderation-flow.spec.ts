import { expect, test, type Page } from '@playwright/test';
import { groupIn, joinRoom, openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';
import type { Group, VoicePermissions, VoiceSource } from '../src/renderer/api';

let stack: Stack;
let group: Group;
let tokens: Record<string, string>;
let bobID: number;
const roomID = () => group.rooms[0].id;
async function request(user: string, method: string, endpoint: string, body?: unknown) {
  return fetch(stack.api + '/api/v1' + endpoint, { method, headers: { Authorization: 'Bearer ' + tokens[user], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api(user: string, method: string, endpoint: string, body?: unknown) {
  const r = await request(user, method, endpoint, body);
  if (!r.ok) throw new Error(`${endpoint}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const own = (): Promise<VoicePermissions> => api('bob', 'GET', `/rooms/${roomID()}/permissions`);
const microphone = (page: Page) => page.locator('.capsule button[aria-label="Микрофон"]');
const publication = (page: Page, source: string) => page.evaluate(source => {
  const track = (window as any).__tolktak.room?.localParticipant.getTrackPublication(source)?.track;
  return !!track && track.mediaStreamTrack?.readyState === 'live' && !track.isMuted;
}, source);
async function menu(page: Page, source: string) {
  await page.locator('.nav-sub', { hasText: 'bob' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: source, exact: false }).click();
}
async function restriction(page: Page, source: string, duration: string) {
  await menu(page, source);
  await page.getByRole('menuitem', { name: 'Запретить включение' }).click();
  await page.getByRole('menuitem', { name: duration, exact: true }).click();
}
async function clear(page: Page, source: string) {
  await page.locator('.nav-row', { hasText: 'Общая' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ограничения', exact: true }).click();
  await page.getByRole('button', { name: `Снять ограничение: Bob, ${source}`, exact: true }).click();
  await expect(page.locator('.moderation-row')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
}

test.beforeEach(async () => {
  stack = await startStack();
  await register(stack.api, 'alice');
  bobID = (await register(stack.api, 'bob')).user.id;
  tokens = { alice: await loginToken(stack.api, 'alice'), bob: await loginToken(stack.api, 'bob') };
  group = (await api('alice', 'POST', '/groups', { name: 'Модерация', members: [bobID], channel_name: 'общий', room_name: 'Общая' })).group;
});
test.afterEach(async () => stack?.stop());

test('moderator stops real media, applies restrictions, and removing them never restarts capture', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');
  try {
    await joinRoom(alice, group.name);
    await joinRoom(bob, group.name);
    await expect(alice.locator('.tile')).toHaveCount(2);
    await expect.poll(() => publication(bob, 'microphone')).toBe(true);
    await bob.evaluate(() => { const w = window as any; w.beforeOff = w.__tolktak.room.localParticipant.getTrackPublication('microphone').track.mediaStreamTrack; });
    await menu(alice, 'Микрофон');
    await alice.screenshot({ path: test.info().outputPath('microphone-actions.png'), animations: 'disabled' });
    await alice.getByRole('menuitem', { name: 'Выключить', exact: true }).click();
    await expect(microphone(bob)).toHaveClass(/off/);
    await expect.poll(() => bob.evaluate(() => (window as any).beforeOff.readyState)).toBe('ended');
    await expect(microphone(bob)).toBeEnabled();
    await microphone(bob).click();
    await expect.poll(() => publication(bob, 'microphone')).toBe(true);

    await restriction(alice, 'Микрофон', 'На 5 минут');
    await expect(microphone(bob)).toBeDisabled();
    await expect.poll(async () => (await own()).allowed.microphone).toBe(false);
    await expect.poll(() => publication(bob, 'microphone')).toBe(false);
    await bob.keyboard.press('ControlOrMeta+Shift+m');
    await expect(microphone(bob)).toHaveClass(/off/);
    await bob.screenshot({ path: test.info().outputPath('restricted-microphone.png'), animations: 'disabled' });
    await clear(alice, 'Микрофон');
    await expect(microphone(bob)).toBeEnabled();
    await expect(microphone(bob)).toHaveClass(/off/);
    await expect.poll(() => publication(bob, 'microphone')).toBe(false);
    await microphone(bob).click();
    await expect.poll(() => publication(bob, 'microphone')).toBe(true);

    await bob.evaluate(() => (window as any).__tolktak.setPrefs({ cameraPreview: false }));
    await bob.locator('.call-controls').getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await expect.poll(() => publication(bob, 'camera')).toBe(true);
    await restriction(alice, 'Камера', 'Бессрочно');
    await expect(bob.locator('.call-controls').getByRole('button', { name: 'Включить камеру', exact: true })).toBeDisabled();
    await expect.poll(() => publication(bob, 'camera')).toBe(false);
    await bob.locator('.capsule button.leave').click();
    await joinRoom(bob, group.name);
    await expect(bob.locator('.call-controls').getByRole('button', { name: 'Включить камеру', exact: true })).toBeDisabled();
    await clear(alice, 'Камера');
    await expect(bob.locator('.call-controls').getByRole('button', { name: 'Включить камеру', exact: true })).toBeEnabled();
    await expect.poll(() => publication(bob, 'camera')).toBe(false);

    await bob.locator('.capsule button[aria-label="Показать экран"]').click();
    await bob.locator('.warn-box input[type=checkbox]').check();
    await bob.locator('.modal button.primary').click();
    await expect.poll(() => publication(bob, 'screen_share')).toBe(true);
    await restriction(alice, 'Трансляция', 'До конца звонка');
    await expect(bob.locator('.capsule button[aria-label="Показать экран"]')).toBeDisabled();
    await expect.poll(() => publication(bob, 'screen_share')).toBe(false);
    await expect.poll(() => publication(bob, 'screen_share_audio')).toBe(false);
    await clear(alice, 'Трансляция');
    await expect(bob.locator('.capsule button[aria-label="Показать экран"]')).toBeEnabled();
    await expect.poll(() => publication(bob, 'screen_share')).toBe(false);

    await api('alice', 'PUT', `/rooms/${roomID()}/moderation/${bobID}/microphone`, { duration: 'time', seconds: 2 });
    await expect(microphone(bob)).toBeDisabled();
    await expect(microphone(bob)).toBeEnabled({ timeout: 15000 });
    await expect(microphone(bob)).toHaveClass(/off/);
    await expect.poll(() => publication(bob, 'microphone')).toBe(false);
  } finally { await Promise.allSettled([alice.context().close(), bob.context().close()]); }
});

test('kick blocks reentry until the call ends and offline permanent restrictions can be removed', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');
  try {
    await joinRoom(alice, group.name);
    await joinRoom(bob, group.name);
    await expect(alice.locator('.tile')).toHaveCount(2);
    await bob.locator('.nav-row', { hasText: 'Общая' }).click({ button: 'right' });
    await expect(bob.getByRole('menuitem', { name: 'Ограничения', exact: true })).toHaveCount(0);
    await bob.keyboard.press('Escape');
    for (const source of ['microphone','camera','screen'] as VoiceSource[]) {
      expect((await request('bob', 'PUT', `/rooms/${roomID()}/moderation/1/${source}`, { duration:'permanent' })).status).toBe(403);
    }
    await restriction(alice, 'Камера', 'Бессрочно');
    await alice.locator('.nav-sub', { hasText: 'bob' }).click({ button:'right' });
    await alice.getByRole('menuitem', { name:'Исключить из звонка',exact:true }).click();
    await alice.getByRole('dialog').getByRole('button', { name:'Исключить из звонка',exact:true }).click();
    await expect(bob.locator('.capsule')).not.toHaveClass(/in-call/);
    await expect.poll(async () => (await own()).allowed.entry).toBe(false);
    expect((await request('bob','POST','/voice/join',{room_id:roomID()})).status).toBe(403);
    await alice.locator('.nav-row', { hasText: 'Общая' }).click({ button:'right' });
    await alice.getByRole('menuitem', { name:'Ограничения',exact:true }).click();
    await expect(alice.locator('.moderation-row')).toHaveCount(2);
    await alice.screenshot({path:test.info().outputPath('offline-restrictions.png'),animations:'disabled'});
    await alice.getByRole('button', { name:'Снять ограничение: Bob, Камера',exact:true }).click();
    await expect(alice.locator('.moderation-row')).toHaveCount(1);
    await alice.getByRole('dialog').getByRole('button', {name:'Закрыть',exact:true}).click();
    await alice.locator('.capsule button.leave').click();
    await expect.poll(async () => (await own()).allowed.entry, {timeout:15000}).toBe(true);
    await joinRoom(bob, group.name);
    await expect(bob.locator('.call-controls').getByRole('button', {name:'Включить камеру',exact:true})).toBeEnabled();
    await expect.poll(async () => (await own()).rules).toEqual([]);
    await bob.locator('.capsule button.leave').click();
    await bob.reload();
    await expect(bob.locator('.shell')).toBeVisible();
    await groupIn(bob,group.name).click();
  } finally { await Promise.allSettled([alice.context().close(), bob.context().close()]); }
});
