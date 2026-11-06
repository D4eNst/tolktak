import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { Group } from '../src/renderer/api';
import { groupIn, mainWindow, openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
let ownerToken: string;
let memberToken: string;
let group: Group;

async function request(method: string, endpoint: string, body?: unknown, token = ownerToken) {
  return fetch(stack.api + '/api/v1' + endpoint, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api(method: string, endpoint: string, body?: unknown) {
  const response = await request(method, endpoint, body);
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
async function currentGroup(): Promise<Group> {
  return (await api('GET', '/groups')).groups.find((item: Group) => item.id === group.id);
}
async function openGroup(page: Page) {
  await page.locator('.nav-tabs').getByRole('tab', { name: 'Группы', exact: true }).click();
  await groupIn(page, group.name).click();
  await expect(page.locator('.nav-page')).toBeVisible();
}
async function manage(page: Page) {
  await openGroup(page);
  await page.locator('.nav-page-head').getByRole('button', { name: 'Меню группы', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Настройки группы', exact: true }).click();
  const modal = page.locator('.modal').filter({ has: page.getByRole('heading', { name: 'Настройки группы', exact: true }) });
  await modal.locator('.settings-nav').getByRole('button', { name: 'Каналы и комнаты', exact: true }).click();
  await expect(modal.locator('.manage-list')).toHaveCount(2);
  return modal;
}
async function navOrder(page: Page) {
  return page.locator('.nav-page .nav-row > .ellipsis').allTextContents();
}

test.beforeEach(async () => {
  stack = await startStack();
  await register(stack.api, 'alice');
  const member = await register(stack.api, 'bob');
  ownerToken = await loginToken(stack.api, 'alice');
  memberToken = await loginToken(stack.api, 'bob');
  group = (await api('POST', '/groups', { name: 'Порядок каналов', members: [member.user.id], channel_name: 'общий', room_name: 'Общая' })).group;
  await api('POST', `/groups/${group.id}/channels`, { name: 'планы' });
  await api('POST', `/groups/${group.id}/channels`, { name: 'архив' });
  await api('POST', `/groups/${group.id}/rooms`, { name: 'Первая' });
  await api('POST', `/groups/${group.id}/rooms`, { name: 'Вторая' });
  group = await currentGroup();
});
test.afterEach(async () => stack?.stop());

test('owner reorders channels and rooms, another client sees live order and a member cannot change it', async ({ browser }) => {
  const owner = await openClient(browser, stack, 'alice');
  const member = await openClient(browser, stack, 'bob');
  try {
    await openGroup(member);
    const modal = await manage(owner);
    const channels = modal.locator('.manage-list').nth(0);
    const rooms = modal.locator('.manage-list').nth(1);
    const names = (list: typeof channels) => list.locator('.manage-row > .ellipsis').allTextContents();
    expect(await names(channels)).toEqual(['общий', 'планы', 'архив']);
    expect(await names(rooms)).toEqual(['Общая', 'Первая', 'Вторая']);
    await expect(channels.locator('.manage-row').first().getByRole('button', { name: 'Выше', exact: true })).toBeDisabled();
    await expect(channels.locator('.manage-row', { hasText: 'общий' }).getByRole('button', { name: 'Удалить', exact: true })).toBeDisabled();
    await expect(channels.locator('.manage-row').last().getByRole('button', { name: 'Ниже', exact: true })).toBeDisabled();
    const move = async (kind: 'channel' | 'room', name: string, direction: 'Выше' | 'Ниже', expected: string[]) => {
      const list = kind === 'channel' ? channels : rooms;
      const response = owner.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/groups/${group.id}/${kind}-order`));
      await list.locator('.manage-row', { hasText: name }).getByRole('button', { name: direction, exact: true }).click();
      expect((await response).status()).toBe(204);
      await expect.poll(() => names(list)).toEqual(expected);
    };
    await move('channel', 'архив', 'Выше', ['общий', 'архив', 'планы']);
    await expect.poll(() => channels.evaluate((el) => [...el.querySelectorAll('.manage-row')].some((row) => row.getAnimations().some((animation) => animation.playState === 'running'))), { intervals: [10] }).toBe(true);
    await move('channel', 'общий', 'Ниже', ['архив', 'общий', 'планы']);
    await move('room', 'Общая', 'Ниже', ['Первая', 'Общая', 'Вторая']);
    await move('room', 'Вторая', 'Выше', ['Первая', 'Вторая', 'Общая']);
    const final = ['архив', 'общий', 'планы', 'Первая', 'Вторая', 'Общая'];
    await expect.poll(() => navOrder(member)).toEqual(final);
    const server = await currentGroup();
    expect(server.text_channels.map((channel) => channel.name)).toEqual(final.slice(0, 3));
    expect(server.rooms.map((room) => room.name)).toEqual(final.slice(3));
    expect(server.channel_id).toBe(group.channel_id);
    await owner.screenshot({ path: test.info().outputPath('group-manage-order.png'), animations: 'disabled' });
    await member.reload();
    await expect(member.locator('.shell')).toBeVisible();
    await openGroup(member);
    await expect.poll(() => navOrder(member)).toEqual(final);
    await member.locator('.nav-page-head').getByRole('button', { name: 'Меню группы', exact: true }).click();
    await expect(member.getByRole('menuitem', { name: 'Настройки группы', exact: true })).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'Выше', exact: true })).toHaveCount(0);
    await member.keyboard.press('Escape');
    for (const [endpoint, ids] of [
      ['channel-order', server.text_channels.map((channel) => channel.id)],
      ['room-order', server.rooms.map((room) => room.id)],
    ] as const) {
      expect((await request('PUT', `/groups/${group.id}/${endpoint}`, { ids: [...ids].reverse() }, memberToken)).status).toBe(403);
    }
    const afterForbidden = await currentGroup();
    expect(afterForbidden.text_channels.map((channel) => channel.id)).toEqual(server.text_channels.map((channel) => channel.id));
    expect(afterForbidden.rooms.map((room) => room.id)).toEqual(server.rooms.map((room) => room.id));
  } finally { await Promise.all([owner.context().close(), member.context().close()]); }
});

test('a stale exact-set reorder returns 409 without losing a concurrently created channel, then explicit retry succeeds', async ({ browser }) => {
  const owner = await openClient(browser, stack, 'alice');
  const member = await openClient(browser, stack, 'bob');
  let release: (() => void) | undefined;
  let submitted: number[] = [];
  let status = 0;
  const pattern = `**/groups/${group.id}/channel-order`;
  try {
    await openGroup(member);
    const modal = await manage(owner);
    const list = modal.locator('.manage-list').nth(0);
    await owner.route(pattern, async (route) => {
      submitted = route.request().postDataJSON().ids;
      await new Promise<void>((resolve) => (release = resolve));
      const response = await route.fetch();
      status = response.status();
      await route.fulfill({ response });
    });
    await list.locator('.manage-row', { hasText: 'архив' }).getByRole('button', { name: 'Выше', exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    const created = (await api('POST', `/groups/${group.id}/channels`, { name: 'новый' })).channel;
    await expect(list.locator('.manage-row')).toHaveCount(4);
    release!();
    await expect.poll(() => status).toBe(409);
    await expect(owner.locator('.toast.error')).toBeVisible();
    expect(submitted).toEqual([group.text_channels[0].id, group.text_channels[2].id, group.text_channels[1].id]);
    const expected = ['общий', 'планы', 'архив', 'новый'];
    await expect.poll(() => list.locator('.manage-row > .ellipsis').allTextContents()).toEqual(expected);
    await expect.poll(() => navOrder(member)).toEqual([...expected, 'Общая', 'Первая', 'Вторая']);
    const preserved = await currentGroup();
    expect(preserved.text_channels.map((channel) => channel.id)).toEqual([...group.text_channels.map((channel) => channel.id), created.id]);
    await owner.unroute(pattern);
    const retry = owner.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/groups/${group.id}/channel-order`));
    await list.locator('.manage-row', { hasText: 'новый' }).getByRole('button', { name: 'Выше', exact: true }).click();
    expect((await retry).status()).toBe(204);
    const reordered = ['общий', 'планы', 'новый', 'архив'];
    await expect.poll(() => list.locator('.manage-row > .ellipsis').allTextContents()).toEqual(reordered);
    await expect.poll(() => navOrder(member)).toEqual([...reordered, 'Общая', 'Первая', 'Вторая']);
    expect(new Set((await currentGroup()).text_channels.map((channel) => channel.id)).size).toBe(4);
  } finally { release?.(); await Promise.all([owner.context().close(), member.context().close()]); }
});


test('member search covers the whole existing group by name and username without browsing the directory', async ({ browser }) => {
  const root = path.resolve(__dirname, '../..');
  const ids: number[] = JSON.parse(execFileSync(path.join(root, 'server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ['-c', `
import asyncio, json, sys
from pathlib import Path
from tolktak import db
from tolktak.models import User
from tolktak.store import now
async def run():
    directory = Path(sys.argv[1]).resolve()
    assert directory.name.startswith('tolktak-e2e-') and (directory / 'tolktak.db').is_file()
    await db.init('', directory)
    template = await User.get(username='alice')
    ids = []
    for n in range(1, 106):
        username = f'member{n:03d}'
        display = 'Елена 100%_literal' if n == 105 else f'Участник {n:03d}'
        user = await User.create(username=username, display_name=display, password_hash=template.password_hash,
            username_folded=username.casefold(), display_name_folded=display.casefold(),
            color='#0090ff', is_admin=0, created_at=now())
        ids.append(user.id)
    print(json.dumps(ids))
    await db.close()
asyncio.run(run())
`, stack.dataDir], { cwd: path.join(root, 'server'), encoding: 'utf8' }));
  await api('POST', `/groups/${group.id}/members`, { user_ids: ids });
  let directoryRequests = 0;
  const profileBatches: number[][] = [];
  const owner = await openClient(browser, stack, 'alice', 'password123', (page) => { page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/users/directory')) directoryRequests++;
    if (new URL(request.url()).pathname.endsWith('/users/profiles')) profileBatches.push(request.postDataJSON().ids);
  }); });
  try {
    const modal = await manage(owner);
    await modal.locator('.settings-nav').getByRole('button', { name: 'Участники', exact: true }).click();
    await expect(modal.locator('.member-row')).toHaveCount(107);
    const search = modal.getByRole('searchbox', { name: 'Найти участника', exact: true });
    await search.fill('ЕЛЕНА');
    await expect(modal.locator('.member-row')).toHaveCount(1);
    await expect(modal.locator('.member-row')).toContainText('Елена 100%_literal');
    await owner.screenshot({ path: test.info().outputPath('group-members-search.png'), animations: 'disabled' });
    await search.fill('MEMBER105');
    await expect(modal.locator('.member-row')).toHaveCount(1);
    await expect(modal.locator('.member-row')).toContainText('@member105');
    await search.fill('100%_literal');
    await expect(modal.locator('.member-row')).toHaveCount(1);
    await search.fill('нет такого участника');
    await expect(modal.locator('.member-row')).toHaveCount(0);
    await expect(modal.getByText('Никого не найдено', { exact: true })).toBeVisible();
    await search.fill('');
    await expect(modal.locator('.member-row')).toHaveCount(107);
    expect(directoryRequests).toBe(0);
    expect(profileBatches.flat()).toContain(ids[104]);
    expect(profileBatches.every((batch) => batch.length <= 100)).toBe(true);
  } finally { await owner.context().close(); }
});

test('mouse drag scrolls long channel and room lists, saves the exact order and respects reduced motion', async ({ browser }) => {
  for (let n = 1; n <= 18; n++) await api('POST', `/groups/${group.id}/channels`, { name: `Канал ${n}` });
  for (let n = 1; n <= 12; n++) await api('POST', `/groups/${group.id}/rooms`, { name: `Комната ${n}` });
  group = await currentGroup();
  const owner = await openClient(browser, stack, 'alice');
  const member = await openClient(browser, stack, 'bob');
  try {
    await openGroup(member);
    const modal = await manage(owner);
    const channels = modal.locator('.manage-list').nth(0), rooms = modal.locator('.manage-list').nth(1);
    const dragFirstToEnd = async (list: typeof channels, kind: 'channel' | 'room', initial: string[]) => {
      await list.scrollIntoViewIfNeeded();
      await list.evaluate((el) => { el.scrollTop = 0; });
      const handle = list.locator('.manage-row').first().locator('.reorder-handle');
      const box = (await handle.boundingBox())!, bounds = (await list.boundingBox())!;
      await owner.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await owner.mouse.down();
      await owner.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 10, { steps: 3 });
      await owner.mouse.move(box.x + box.width / 2, bounds.y + bounds.height - 5, { steps: 8 });
      await expect.poll(() => list.evaluate((el) => el.scrollTop >= el.scrollHeight - el.clientHeight - 1)).toBe(true);
      await expect(list).toHaveClass(/drop-end/);
      await expect(list.locator('.dragging')).toHaveCount(1);
      const generalTab = modal.locator('.settings-nav').getByRole('button', { name: 'Основное', exact: true });
      expect(await generalTab.evaluate((el) => { const r = el.getBoundingClientRect(), body = el.closest('.modal')!.getBoundingClientRect(); return r.top >= body.top && r.bottom <= body.bottom; })).toBe(true);
      await owner.screenshot({ path: test.info().outputPath(`group-${kind}-drag.png`), animations: 'disabled' });
      const response = owner.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/groups/${group.id}/${kind}-order`));
      await owner.mouse.up();
      expect((await response).status()).toBe(204);
      const expected = [...initial.slice(1), initial[0]];
      await expect.poll(() => list.locator('.manage-row > .ellipsis').allTextContents()).toEqual(expected);
      await expect(list.locator('.dragging')).toHaveCount(0);
      return expected;
    };
    const channelOrder = await dragFirstToEnd(channels, 'channel', group.text_channels.map((channel) => channel.name));
    const roomOrder = await dragFirstToEnd(rooms, 'room', group.rooms.map((room) => room.name));
    await expect.poll(() => navOrder(member)).toEqual([...channelOrder, ...roomOrder]);
    let saved = await currentGroup();
    expect(saved.text_channels.map((channel) => channel.name)).toEqual(channelOrder);
    expect(saved.rooms.map((room) => room.name)).toEqual(roomOrder);
    expect(saved.channel_id).toBe(group.channel_id);
    await expect(channels.locator('.manage-row').last().getByRole('button', { name: 'Удалить', exact: true })).toBeDisabled();
    await expect(channels.locator('.manage-row').last().getByRole('button', { name: 'Ниже', exact: true })).toBeDisabled();
    await expect(rooms.locator('.manage-row').first().getByRole('button', { name: 'Выше', exact: true })).toBeDisabled();
    // The same controls remain usable with motion disabled; no row animation should run.
    await owner.emulateMedia({ reducedMotion: 'reduce' });
    await channels.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))));
    const response = owner.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/groups/${group.id}/channel-order`));
    await channels.locator('.manage-row').last().getByRole('button', { name: 'Выше', exact: true }).click();
    expect((await response).status()).toBe(204);
    [channelOrder[channelOrder.length - 2], channelOrder[channelOrder.length - 1]] = [channelOrder[channelOrder.length - 1], channelOrder[channelOrder.length - 2]];
    await expect.poll(() => channels.locator('.manage-row > .ellipsis').allTextContents()).toEqual(channelOrder);
    expect(await channels.evaluate((el) => [...el.querySelectorAll('.manage-row')].flatMap((row) => row.getAnimations()).filter((animation) => animation.playState === 'running').length)).toBe(0);
    saved = await currentGroup();
    expect(saved.text_channels.map((channel) => channel.name)).toEqual(channelOrder);
    await owner.screenshot({ path: test.info().outputPath('group-manage-drag-after.png'), animations: 'disabled' });
    await member.reload();
    await expect(member.locator('.shell')).toBeVisible();
    await openGroup(member);
    await expect.poll(() => navOrder(member)).toEqual([...channelOrder, ...roomOrder]);
  } finally { await Promise.all([owner.context().close(), member.context().close()]); }
});


test('drag cancels on Escape, an outside drop, a lost pointerup and a concurrent list change without sending an old order', async ({ browser }) => {
  const owner = await openClient(browser, stack, 'alice');
  let orders = 0;
  owner.on('request', (request) => { if (request.method() === 'PUT' && request.url().endsWith('/channel-order')) orders++; });
  try {
    const modal = await manage(owner), list = modal.locator('.manage-list').first();
    const begin = async () => {
      const handle = list.locator('.reorder-handle').first();
      await handle.evaluate((el) => el.addEventListener('pointerdown', (event) => { (el as HTMLElement).dataset.testPointerId = String((event as PointerEvent).pointerId); }, { once: true }));
      const box = (await handle.boundingBox())!;
      await owner.mouse.move(box.x + 10, box.y + 10);
      await owner.mouse.down();
      await owner.mouse.move(box.x + 10, box.y + 60, { steps: 5 });
      await expect(list.locator('.dragging')).toHaveCount(1);
      return handle;
    };
    await begin();
    await owner.keyboard.press('Escape');
    await owner.mouse.up();
    await expect(list.locator('.dragging')).toHaveCount(0);
    await expect(modal).toBeVisible();
    await begin();
    const bounds = (await list.boundingBox())!;
    await owner.mouse.move(bounds.x - 30, bounds.y + 50);
    await owner.mouse.up();
    await expect(list.locator('.dragging')).toHaveCount(0);
    const lostUp = await begin();
    // Model an OS release whose pointerup was lost: the next move has no pressed button.
    await lostUp.evaluate((el) => el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: Number((el as HTMLElement).dataset.testPointerId), pointerType: 'mouse', buttons: 0 })));
    await expect(list.locator('.dragging')).toHaveCount(0);
    await owner.mouse.up();
    await expect(modal).toBeVisible();
    await begin();
    await api('POST', `/groups/${group.id}/channels`, { name: 'новый во время переноса' });
    await expect(list.locator('.manage-row')).toHaveCount(4);
    await expect(list.locator('.dragging')).toHaveCount(0);
    await owner.mouse.up();
    expect(orders).toBe(0);
    expect((await currentGroup()).text_channels.map((channel) => channel.name)).toEqual(['общий', 'планы', 'архив', 'новый во время переноса']);
  } finally { await owner.context().close(); }
});


test('Electron mouse drag reorders channels and rooms and retains the server order after reload', async () => {
  test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs an X display (xvfb-run)');
  const profile = mkdtempSync(path.join(tmpdir(), 'tt-group-order-electron-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), '--no-sandbox', '--lang=ru', '--no-proxy-server'],
    env: { ...process.env, TOLKTAK_USER_DATA: profile } as Record<string, string>,
  });
  try {
    const page = await mainWindow(app);
    page.on('pageerror', (error) => console.log('[electron group-order]', error.message));
    await page.evaluate(() => localStorage.setItem('tolktak.tour', '1'));
    await page.fill('input[name=server]', stack.api);
    await page.fill('input[name=username]', 'alice');
    await page.fill('input[name=password]', 'password123');
    await page.click('button[type=submit]');
    await expect(page.locator('.shell')).toBeVisible();
    const modal = await manage(page);
    const channels = modal.locator('.manage-list').nth(0), rooms = modal.locator('.manage-list').nth(1);
    const dragFirstToEnd = async (list: typeof channels, kind: 'channel' | 'room', expected: string[]) => {
      const handle = list.locator('.reorder-handle').first();
      await handle.scrollIntoViewIfNeeded();
      const from = (await handle.boundingBox())!, to = (await list.locator('.manage-row').last().boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, to.y + to.height - 4, { steps: 12 });
      await expect(list.locator('.dragging')).toHaveCount(1);
      await expect(list).toHaveClass(/drop-end/);
      const response = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/groups/${group.id}/${kind}-order`));
      await page.mouse.up();
      expect((await response).status()).toBe(204);
      await expect(list.locator('.dragging')).toHaveCount(0);
      await expect.poll(() => list.locator('.manage-row > .ellipsis').allTextContents()).toEqual(expected);
    };
    const channelOrder = ['планы', 'архив', 'общий'], roomOrder = ['Первая', 'Вторая', 'Общая'];
    await dragFirstToEnd(channels, 'channel', channelOrder);
    await dragFirstToEnd(rooms, 'room', roomOrder);
    const saved = await currentGroup();
    expect(saved.text_channels.map((channel) => channel.name)).toEqual(channelOrder);
    expect(saved.rooms.map((room) => room.name)).toEqual(roomOrder);
    expect(saved.channel_id).toBe(group.channel_id);
    await expect(channels.locator('.manage-row').last().getByRole('button', { name: 'Удалить', exact: true })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath('group-electron-drag-after.png'), animations: 'disabled' });
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    const restored = await manage(page);
    await expect.poll(() => restored.locator('.manage-list').nth(0).locator('.manage-row > .ellipsis').allTextContents()).toEqual(channelOrder);
    await expect.poll(() => restored.locator('.manage-list').nth(1).locator('.manage-row > .ellipsis').allTextContents()).toEqual(roomOrder);
    await page.screenshot({ path: test.info().outputPath('group-electron-drag-reloaded.png'), animations: 'disabled' });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
