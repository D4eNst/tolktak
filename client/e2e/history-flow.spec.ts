import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { groupIn, openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
let alice: string;
let bob: string;
let bobID: number;
let channel: number;
let groupName: string;
let ids: number[];
let sequence = 0;
const root = path.resolve(__dirname, '../..');

async function call(method: string, endpoint: string, body?: unknown, token = alice) {
  const response = await fetch(stack.api + '/api/v1' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function openGroup(page: Page) {
  await page.locator('.nav-tabs button', { hasText: 'Группы' }).click();
  await groupIn(page, groupName).click();
  await page.locator('.nav-row', { hasText: 'общий' }).click();
  await expect(page.locator('.composer textarea')).toBeVisible();
}

async function search(page: Page, q: string) {
  if (!await page.locator('.chat-panel input').count()) await page.getByRole('button', { name: 'Поиск по чату', exact: true }).click();
  await page.locator('.chat-panel input').fill(q);
}

async function firstVisible(page: Page) {
  return page.locator('.msg-list').evaluate((list) => {
    const top = list.getBoundingClientRect().top;
    const row = [...list.querySelectorAll<HTMLElement>('.msg[data-id]:not([data-deleted])')].find((el) => el.getBoundingClientRect().bottom > top);
    return row ? { id: Number(row.dataset.id), offset: row.getBoundingClientRect().top - top } : null;
  });
}

test.beforeAll(async () => {
  stack = await startStack();
  await register(stack.api, 'alice');
  bobID = (await register(stack.api, 'bob')).user.id;
  alice = await loginToken(stack.api, 'alice');
  bob = await loginToken(stack.api, 'bob');
});
test.afterAll(async () => stack?.stop());
test.beforeEach(async () => {
  groupName = `История ${++sequence}`;
  channel = (await call('POST', '/groups', { name: groupName, members: [bobID], room_name: 'Общая', channel_name: 'общий' })).group.channel_id;
  const python = process.env.TT_SERVER_BIN ? path.join(path.dirname(process.env.TT_SERVER_BIN), 'python') : path.join(root, 'server/.venv/bin/python');
  ids = JSON.parse(execFileSync(python, ['-c', `
import asyncio, json, sys
from pathlib import Path
from tolktak import db
from tolktak.store import chat
async def run():
    await db.init('', Path(sys.argv[1]))
    ids = []
    for n in range(1, 1201):
        text = f'архив {n:04d} — ' + ('альфа' if n == 20 else 'бета' if n == 40 else 'сообщение')
        m, _ = await chat.create_message(int(sys.argv[2]), int(sys.argv[3]), f'seed-{sys.argv[2]}-{n}', text, ids[9] if n == 40 else 0, [])
        ids.append(m['id'])
    print(json.dumps(ids))
    await db.close()
asyncio.run(run())
`, stack.dataDir, String(channel), String(bobID)], { cwd: path.join(root, 'server'), encoding: 'utf8' }));
});

test('first unread, bounded context jumps, return and paginated search', async ({ browser }) => {
  await call('POST', `/channels/${channel}/read`, { message_id: ids[199] });
  const requests: URL[] = [];
  const page = await openClient(browser, stack, 'alice', 'password123', (page) => {
    page.on('request', (r) => { if (r.url().includes(`/channels/${channel}/history`)) requests.push(new URL(r.url())); });
  });
  await openGroup(page);
  await expect(page.locator('.msg[data-id]').first()).toHaveAttribute('data-id', String(ids[200]));
  await expect.poll(async () => (await firstVisible(page))?.id).toBe(ids[200]);
  expect(requests.some((u) => u.searchParams.get('after') === String(ids[199]))).toBeTruthy();
  expect(await page.locator('.msg[data-id]').count()).toBeLessThanOrEqual(100);
  await page.locator('.msg-list').click({ position: { x: 15, y: 60 } });
  await expect.poll(async () => (await call('GET', `/channels/${channel}/read`)).message_id).toBeGreaterThan(ids[200]);
  expect((await call('GET', `/channels/${channel}/read`)).unread).toBeGreaterThan(900);
  const anchor = await firstVisible(page);
  await search(page, 'архив 0020');
  await expect(page.locator('.mini-msg')).toHaveCount(1);
  await page.locator('.mini-msg').click();
  await expect(page.locator(`.msg[data-id="${ids[19]}"]`)).toBeVisible();
  await expect(page.locator('.msg.flash')).toHaveAttribute('data-id', String(ids[19]));
  expect(await page.locator('.msg[data-id]').count()).toBeLessThanOrEqual(100);
  expect(requests.some((u) => u.searchParams.get('around') === String(ids[19]))).toBeTruthy();
  await page.getByRole('button', { name: 'Вернуться', exact: true }).click();
  await expect.poll(async () => Math.abs(await page.locator(`.msg[data-id="${anchor!.id}"]`).evaluate((row) => row.getBoundingClientRect().top - row.closest('.msg-list')!.getBoundingClientRect().top) - anchor!.offset)).toBeLessThan(3);
  await page.getByRole('button', { name: 'К последним сообщениям', exact: true }).click();
  await expect(page.locator('.msg[data-id]').last()).toHaveAttribute('data-id', String(ids[1199]));
  await expect.poll(async () => (await call('GET', `/channels/${channel}/read`)).unread).toBe(0);
  await search(page, 'архив');
  await expect(page.locator('.mini-msg')).toHaveCount(50);
  await expect(page.locator('.mini-msg').first()).toContainText('1200');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(page.locator('.mini-msg').first()).toContainText('1150');
  await expect(page.locator('.mini-msg')).toHaveCount(50);
  await page.locator('.chat-panel').getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.locator('.mini-msg').first()).toContainText('1200');
  expect(requests.every((u) => Number(u.searchParams.get('limit')) <= 100)).toBeTruthy();
  expect(requests.length).toBeLessThan(12);
  await page.context().close();
});

test('load errors retry and late search responses cannot replace a newer query', async ({ browser }) => {
  let fail = true;
  const page = await openClient(browser, stack, 'alice', 'password123', async (page) => { await page.route(`**/channels/${channel}/history?*`, (route) => {
    if (fail) return route.fulfill({ status: 503, json: {} });
    return route.continue();
  }); });
  await openGroup(page);
  await expect(page.getByText('Не удалось загрузить сообщения')).toBeVisible();
  fail = false;
  await page.locator('.history-status').getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('.msg[data-id]').first()).toHaveAttribute('data-id', String(ids[0]));
  let release: (() => void) | undefined;
  await page.route(`**/channels/${channel}/search?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'альфа') return route.continue();
    const response = await route.fetch();
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  await search(page, 'альфа');
  await expect.poll(() => !!release).toBeTruthy();
  await search(page, 'бета');
  await expect(page.locator('.mini-msg')).toHaveCount(1);
  await expect(page.locator('.mini-msg')).toContainText('бета');
  release!();
  await page.waitForTimeout(400);
  await expect(page.locator('.mini-msg')).toContainText('бета');
  await page.context().close();
});

test('reconnect repairs old edits, deletes and reply previews while preserving the history position', async ({ browser }) => {
  const page = await openClient(browser, stack, 'alice');
  await openGroup(page);
  await expect(page.locator('.msg[data-id]')).toHaveCount(100);
  await search(page, 'архив 0040');
  await expect(page.locator('.mini-msg')).toHaveCount(1);
  await page.locator('.mini-msg').click();
  await expect(page.locator(`.msg[data-id="${ids[39]}"] .msg-reply`)).toContainText('0010');
  await page.locator('.chat-panel button[aria-label="Закрыть"]').click();
  await page.waitForTimeout(400);
  const anchor = await firstVisible(page);
  await page.context().setOffline(true);
  await call('PATCH', `/messages/${ids[19]}`, { text: 'Изменено во время отключения' }, bob);
  await call('DELETE', `/messages/${ids[9]}`, undefined, bob);
  await page.context().setOffline(false);
  await expect(page.locator(`.msg[data-id="${ids[19]}"]`)).toContainText('Изменено во время отключения');
  await expect(page.locator(`.msg[data-id="${ids[9]}"]`)).toHaveCount(0);
  await expect(page.locator(`.msg[data-id="${ids[39]}"] .msg-reply`)).toContainText('сообщение удалено');
  await expect.poll(async () => (await firstVisible(page))?.id).toBe(anchor!.id);
  await page.context().close();
});
