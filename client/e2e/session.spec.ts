import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { groupIn, openClient } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

type ClientAudit = Pick<typeof import('../src/renderer/state'), 'session' | 'history' | 'channels' | 'markRead' | 'sendMessage' | 'setReply' | 'people' | 'users'> & {
  collectionKeys: string[]; retentionFailures: number;
};
declare global { interface Window { clientAudit: ClientAudit } }

// Observe public state actions and collections inside the real application bundle.
// The served module alone gains this footer; production sources stay untouched.
async function observeClient(page: Page) {
  await page.route('**/renderer.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
      window.clientAudit = { session, history, channels, markRead, sendMessage, setReply, people, users, collectionKeys: [], retentionFailures: 0 };
      const auditRetain = HistoryStore.prototype.retain;
      HistoryStore.prototype.retain = function(...args) {
        const retained = auditRetain.apply(this, args);
        if (retained && !window.clientAudit.collectionKeys.includes(args[0])) window.clientAudit.collectionKeys.push(args[0]);
        if (!retained) window.clientAudit.retentionFailures++;
        return retained;
      };
    ` });
  });
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.clientAudit)).toBe(true);
}

let stack: Stack;
let aliceToken: string;
let aliceId: number;
let bobId: number;
let group: { id: number; name: string; channel_id: number };
let groupNumber = 0;

async function api(method: string, endpoint: string, body?: unknown) {
  const response = await fetch(stack.api + '/api/v1' + endpoint, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aliceToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function signIn(page: Page, username: string, server = stack.api) {
  const form = page.locator('.login-card');
  await expect(form).toBeVisible();
  await form.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))));
  await page.fill('input[name=server]', server);
  await expect(page.locator('input[name=server]')).toHaveValue(server);
  await page.fill('input[name=username]', username);
  await expect(page.locator('input[name=username]')).toHaveValue(username);
  await page.fill('input[name=password]', 'password123');
  await expect(page.locator('input[name=password]')).toHaveValue('password123');
  await page.locator('button[type=submit]').click();
  await expect(page.locator('.shell')).toBeVisible();
}

async function signOut(page: Page) {
  await page.locator('.topbar-avatar').click();
  await page.locator('.self-menu').getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
  await page.locator('.modal.ask').getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.locator('.login-card')).toBeVisible();
}

async function openGroup(page: Page) {
  await page.locator('.nav-tabs button', { hasText: 'Группы' }).click();
  await groupIn(page, group.name).click();
  await page.locator('.nav-row', { hasText: 'общий' }).click();
  await expect(page.locator('.composer textarea')).toBeVisible();
}

async function blockMessageStorage(page: Page) {
  return page.evaluateHandle(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('tolktak.messages.v1:')) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
    return () => { Storage.prototype.setItem = setItem; };
  });
}

test.beforeEach(async ({ page }) => {
  stack = await startStack();
  aliceId = (await register(stack.api, 'alice')).user.id;
  bobId = (await register(stack.api, 'bob')).user.id;
  aliceToken = await loginToken(stack.api, 'alice');
  group = (await api('POST', '/groups', { name: `Сессия ${++groupNumber}`, members: [bobId], room_name: 'Общая', channel_name: 'общий' })).group;
  await page.context().addInitScript({ path: path.join(__dirname, 'fake-display.js') });
  await page.context().addInitScript(() => localStorage.setItem('tolktak.tour', '1'));
  await page.goto(stack.web);
  await signIn(page, 'alice');
  await openGroup(page);
});

test.afterEach(async () => stack?.stop());

test('an old send cannot retry or update the next account', async ({ page }) => {
  let release: (() => void) | undefined;
  const requests: { text: string; authorization: string | undefined }[] = [];
  await page.route(/\/channels\/\d+\/messages(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push({ text: route.request().postDataJSON().text, authorization: route.request().headers().authorization });
    if (requests.length > 1) return route.continue();
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"internal","message":"unavailable"}}' });
  });
  await page.locator('.composer textarea').fill('Сообщение Алисы');
  await page.locator('.composer textarea').press('Enter');
  await expect.poll(() => !!release).toBe(true);
  await signOut(page);
  await signIn(page, 'bob');
  await openGroup(page);
  release!();
  // Wait past the retry delay.
  await page.waitForTimeout(2000);
  expect(requests).toHaveLength(1);
  await expect(page.locator('.msg.pending')).toHaveCount(0);
  expect((await api('GET', `/channels/${group.channel_id}/messages`)).messages).toHaveLength(0);

  await page.locator('.composer textarea').fill('Сообщение Боба');
  await page.locator('.composer textarea').press('Enter');
  await expect(page.locator('.msg:not(.pending)')).toContainText('Сообщение Боба');
  const stored = (await api('GET', `/channels/${group.channel_id}/messages`)).messages;
  expect(stored).toHaveLength(1);
  expect(stored[0].author_id).toBe(bobId);
  expect(requests[1].authorization).not.toBe(requests[0].authorization);
});

test('draft text and reply survive reload and stay private to their account', async ({ page }) => {
  const original = (await api('POST', `/channels/${group.channel_id}/messages`, { text: 'Сообщение для ответа', nonce: crypto.randomUUID() })).message;
  const row = page.locator(`.msg[data-id="${original.id}"]`);
  await row.hover();
  await row.locator('button[aria-label="Ответить"]').click();
  await page.locator('.composer textarea').fill('Личный черновик Алисы');
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await openGroup(page);
  await expect(page.locator('.composer textarea')).toHaveValue('Личный черновик Алисы');
  await expect(page.locator('.reply-bar')).toContainText('Сообщение для ответа');

  await signOut(page);
  await signIn(page, 'bob');
  await openGroup(page);
  await expect(page.locator('.composer textarea')).toHaveValue('');
  await expect(page.locator('.reply-bar')).toHaveCount(0);
  await page.locator('.composer textarea').fill('Личный черновик Боба');
  await signOut(page);
  await signIn(page, 'alice');
  await openGroup(page);
  await expect(page.locator('.composer textarea')).toHaveValue('Личный черновик Алисы');
  await expect(page.locator('.reply-bar')).toContainText('Сообщение для ответа');
});

test('drafts are scoped to the server address as well as the user', async ({ page }) => {
  await page.locator('.composer textarea').fill('Черновик на первом сервере');
  await signOut(page);
  await signIn(page, 'alice', stack.api.replace('127.0.0.1', 'localhost'));
  await openGroup(page);
  await expect(page.locator('.composer textarea')).toHaveValue('');
  await page.locator('.composer textarea').fill('Черновик на втором сервере');
  await signOut(page);
  await signIn(page, 'alice');
  await openGroup(page);
  await expect(page.locator('.composer textarea')).toHaveValue('Черновик на первом сервере');
});

test('failed outgoing text and attachments survive reload and retry only on request', async ({ page }) => {
  let fail = true;
  const requests: { nonce: string; text: string; attachments: string[] }[] = [];
  await page.route(/\/channels\/\d+\/messages(?:\?.*)?$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(route.request().postDataJSON());
    return fail ? route.abort('internetdisconnected') : route.continue();
  });
  const uploaded = page.waitForResponse((response) => response.url().includes('/api/v1/files?') && response.request().method() === 'POST');
  await page.locator('.composer input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Сохраненный файл') });
  const file = (await (await uploaded).json()).file;
  await expect(page.locator('.upload')).toHaveCount(1);
  await expect(page.locator('.upload-progress')).toHaveCount(0);
  await page.locator('.composer textarea').fill('Неотправленное сообщение с файлом');
  await page.locator('.composer textarea').press('Enter');
  await expect(page.locator('.msg.pending.failed')).toContainText('Неотправленное сообщение с файлом');
  const attemptsBeforeReload = requests.length;
  expect(attemptsBeforeReload).toBe(3);
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await openGroup(page);
  const pending = page.locator('.msg.pending.failed');
  await expect(pending).toContainText('Неотправленное сообщение с файлом');
  await expect(pending).toContainText('1 вложение');
  await page.waitForTimeout(1500);
  expect(requests).toHaveLength(attemptsBeforeReload);
  await signOut(page);
  await signIn(page, 'bob');
  await openGroup(page);
  await expect(page.locator('.msg.pending')).toHaveCount(0);
  await signOut(page);
  await signIn(page, 'alice');
  await openGroup(page);
  await expect(pending).toContainText('Неотправленное сообщение с файлом');

  fail = false;
  await pending.getByRole('button', { name: 'Повторить', exact: true }).click();
  const sent = page.locator('.msg:not(.pending)', { hasText: 'Неотправленное сообщение с файлом' });
  await expect(sent.locator('.file-att')).toContainText('draft.txt');
  await expect(page.locator('.msg.pending')).toHaveCount(0);
  expect(requests.at(-1)).toEqual({ ...requests[0], attachments: [file.id] });
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await openGroup(page);
  await expect(page.locator('.msg.pending')).toHaveCount(0);
  await expect(page.locator('.msg:not(.pending)', { hasText: 'Неотправленное сообщение с файлом' })).toHaveCount(1);
});

test('a send keeps its composer text when local storage cannot save the outbox', async ({ page }) => {
  let sends = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/channels\/\d+\/messages$/.test(request.url())) sends++;
  });
  await blockMessageStorage(page);
  await page.locator('.composer textarea').fill('Текст, который нельзя потерять');
  await page.locator('.composer textarea').press('Enter');
  await expect(page.locator('.toast.error')).toBeVisible();
  await expect(page.locator('.composer textarea')).toHaveValue('Текст, который нельзя потерять');
  await expect(page.locator('.msg.pending')).toHaveCount(0);
  expect(sends).toBe(0);
});

test('a recorded voice message stays attached when local storage cannot save the outbox', async ({ page }) => {
  await page.context().grantPermissions(['microphone']);
  const restore = await blockMessageStorage(page);
  let sends = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/channels\/\d+\/messages$/.test(request.url())) sends++;
  });
  await page.getByRole('button', { name: 'Записать голосовое сообщение', exact: true }).click();
  await expect(page.locator('.composer.recording')).toBeVisible();
  await page.waitForTimeout(750);
  await page.getByRole('button', { name: 'Отправить голосовое сообщение', exact: true }).click();
  await expect(page.locator('.upload-tray .upload-name')).toContainText('.webm');
  await expect(page.locator('.upload-progress')).toHaveCount(0);
  await expect(page.locator('.toast.error')).toBeVisible();
  expect(sends).toBe(0);
  await page.screenshot({ path: test.info().outputPath('voice-retained-after-storage-error.png'), animations: 'disabled' });
  await restore.evaluate((restoreStorage) => restoreStorage());
  await restore.dispose();
  await page.locator('.composer').getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.msg:not(.pending) .audio-att.voice')).toBeVisible();
  await expect(page.locator('.upload')).toHaveCount(0);
  expect(sends).toBe(1);
});

test('reloading during a send restores a failed row without submitting it again', async ({ page }) => {
  let release: (() => void) | undefined;
  let sends = 0;
  await page.route(/\/channels\/\d+\/messages(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sends++;
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }).catch(() => {});
  });
  await page.locator('.composer textarea').fill('Сообщение в момент перезапуска');
  await page.locator('.composer textarea').press('Enter');
  await expect.poll(() => !!release).toBe(true);
  await expect(page.locator('.msg.pending.sending')).toBeVisible();
  await page.reload();
  release!();
  await expect(page.locator('.shell')).toBeVisible();
  await openGroup(page);
  await expect(page.locator('.msg.pending.failed')).toContainText('Сообщение в момент перезапуска');
  await page.waitForTimeout(1500);
  expect(sends).toBe(1);
});

test('a late voice join cannot connect as the signed-out account', async ({ page }) => {
  let release: (() => void) | undefined;
  let joins = 0;
  await page.route('**/api/v1/voice/join', async (route) => {
    if (++joins > 1) return route.continue();
    const response = await route.fetch();
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ response });
  });
  await page.locator('.nav-row', { hasText: 'Общая' }).click();
  await expect.poll(() => !!release).toBe(true);
  await signOut(page);
  await signIn(page, 'bob');
  await openGroup(page);
  release!();
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (globalThis as any).__tolktak.room)).toBeNull();
  await expect(page.locator('.capsule .dot.ok')).toHaveCount(0);

  await page.locator('.nav-row', { hasText: 'Общая' }).click();
  await expect(page.locator('.capsule .dot.ok')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).__tolktak.room.localParticipant.identity)).toBe(String(bobId));
});

test('leaving and rejoining a room works without the advisory leave endpoint', async ({ page, browser }) => {
  let joins = 0;
  let advisoryLeaves = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/voice/join')) joins++;
  });
  await page.route('**/api/v1/voice/leave', (route) => {
    advisoryLeaves++;
    return route.abort('internetdisconnected');
  });
  const observer = await openClient(browser, stack, 'bob');
  try {
    await openGroup(observer);
    const member = observer.locator('.nav-sub', { hasText: 'Alice' });
    await page.locator('.nav-row', { hasText: 'Общая' }).click();
    await expect(page.locator('.capsule .dot.ok')).toBeVisible();
    await expect(member).toHaveCount(1);
    await page.locator('.capsule').getByRole('button', { name: 'Выйти из звонка', exact: true }).click();
    await page.locator('.nav-row', { hasText: 'Общая' }).click();
    await expect(page.locator('.capsule .dot.ok')).toBeVisible();
    expect(joins).toBe(2);
    expect(await page.evaluate(() => (globalThis as any).__tolktak.room.localParticipant.identity)).toBe(String(aliceId));
    await page.waitForTimeout(1500);
    await expect(member).toHaveCount(1);
    await page.locator('.capsule').getByRole('button', { name: 'Выйти из звонка', exact: true }).click();
    await expect(member).toHaveCount(0);
    expect(advisoryLeaves).toBe(0);
  } finally {
    await observer.context().close();
  }
});

test('session expiry cancels account confirmations before another user signs in', async ({ page }) => {
  let socket: WebSocketRoute | undefined;
  let ready = false;
  let deletions = 0;
  await page.routeWebSocket(/\/api\/v1\/ws$/, (client) => {
    socket = client;
    const server = client.connectToServer();
    server.onMessage((data) => {
      if (JSON.parse(String(data)).type === 'hello') ready = true;
      client.send(data);
    });
  });
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().endsWith(`/api/v1/groups/${group.id}`)) deletions++;
  });
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await expect.poll(() => ready).toBe(true);
  await openGroup(page);
  await page.locator('.nav-page-head button[aria-label="Меню группы"]').click();
  await page.getByRole('menuitem', { name: 'Удалить группу', exact: true }).click();
  await expect(page.locator('.modal.ask')).toBeVisible();
  await socket!.close({ code: 4001, reason: 'Session expired' });
  await expect(page.locator('.login-card')).toBeVisible();
  await expect(page.locator('.modal.ask, .menu, .lightbox')).toHaveCount(0);
  await signIn(page, 'bob');
  await openGroup(page);
  await expect(page.locator('.modal.ask, .menu, .lightbox')).toHaveCount(0);
  expect(deletions).toBe(0);
});

test('a delayed voice upload cannot attach itself to another channel', async ({ page }) => {
  await api('POST', `/groups/${group.id}/channels`, { name: 'другой' });
  await page.context().grantPermissions(['microphone']);
  await blockMessageStorage(page);
  let release: (() => void) | undefined;
  let sends = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/channels\/\d+\/messages$/.test(request.url())) sends++;
  });
  await page.route('**/api/v1/files?*', async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole('button', { name: 'Записать голосовое сообщение', exact: true }).click();
    await expect(page.locator('.composer.recording')).toBeVisible();
    await page.waitForTimeout(750);
    await page.getByRole('button', { name: 'Отправить голосовое сообщение', exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    await page.locator('.nav-row', { hasText: 'другой' }).click();
    await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Написать в «другой»');
    release!();
    await page.waitForTimeout(1500);
    await expect(page.locator('.upload')).toHaveCount(0);
    await expect(page.locator('.composer textarea')).toHaveValue('');
    await expect(page.locator('.msg.pending')).toHaveCount(0);
    expect(sends).toBe(0);
  } finally {
    release?.();
  }
});

test('a delayed channel summary cannot discard a newly opened direct chat', async ({ page }) => {
  const first = (await api('POST', `/channels/${group.channel_id}/messages`, { text: 'Временное сообщение', nonce: 'summary-race' })).message;
  await expect(page.locator(`.msg[data-id="${first.id}"]`)).toBeVisible();
  let release: (() => void) | undefined;
  let held = false;
  await page.route(/\/api\/v1\/channels$/, async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ response });
  });
  await api('DELETE', `/messages/${first.id}`);
  await expect.poll(() => !!release).toBe(true);
  await page.locator('.nav-tabs button', { hasText: 'Люди' }).click();
  await page.locator('.people-tabs').getByRole('tab', { name: 'Все', exact: true }).click();
  await page.locator('.nav-search input').fill('bob');
  await page.locator('.nav-person', { hasText: 'bob' }).click();
  await expect(page.locator('.composer textarea')).toBeVisible();
  release!();
  await page.waitForTimeout(300);
  await expect(page.locator('.nav-person.active')).toContainText('bob');
  await page.locator('.composer textarea').fill('Диалог сохранён');
  await page.locator('.composer textarea').press('Enter');
  await expect(page.locator('.msg-text', { hasText: 'Диалог сохранён' })).toBeVisible();
});

test('a delayed channel summary cannot restore revoked group channels, but a later membership grant can', async ({ page }) => {
  await signOut(page);
  let hideRestore = false;
  let hiddenRestores = 0;
  let revocations = 0;
  let release: (() => void) | undefined;
  await page.routeWebSocket(/\/api\/v1\/ws$/, (client) => {
    const server = client.connectToServer();
    server.onMessage((data) => {
      const event = JSON.parse(String(data));
      if (event.type === 'group.updated' && event.data.id === group.id && hideRestore) { hiddenRestores++; return; }
      if (event.type === 'group.deleted' && event.data.id === group.id) revocations++;
      client.send(data);
    });
  });
  await signIn(page, 'bob');
  await openGroup(page);
  await page.route(/\/channels\/\d+\/messages$/, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { error: { code: 'internal', message: 'Temporarily unavailable' } } })
    : route.continue());
  const text = 'Черновик из недоступной группы';
  await page.locator('.composer textarea').fill(text);
  await page.locator('.composer textarea').press('Enter');
  await expect(page.locator('.msg.pending.failed')).toContainText(text);
  await api('DELETE', `/groups/${group.id}/members/${bobId}`);
  await expect.poll(() => revocations).toBe(1);
  await expect(groupIn(page, group.name)).toHaveCount(0);

  // Reproduce a missed grant notification: HTTP can now contain a group absent from local state.
  hideRestore = true;
  await api('POST', `/groups/${group.id}/members`, { user_ids: [bobId] });
  await expect.poll(() => hiddenRestores).toBe(1);
  let held = false;
  await page.route(/\/api\/v1\/channels$/, async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    expect((await response.json()).channels.some((channel: { group_id?: number }) => channel.group_id === group.id)).toBe(true);
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    // A separate real group event starts the collection refresh without revealing the target group.
    await api('POST', '/groups', { name: 'Причина обновления', members: [bobId], room_name: 'Общая', channel_name: 'общий' });
    await expect.poll(() => !!release).toBe(true);
    await api('DELETE', `/groups/${group.id}/members/${bobId}`);
    await expect.poll(() => revocations).toBe(2);
    release!();
    await page.waitForTimeout(300);
    await page.locator('.topbar-avatar').click();
    await page.locator('.self-menu').getByRole('button', { name: /Неотправленные сообщения/ }).click();
    await expect(page.locator('.unsent-message textarea')).toHaveValue(text);
    await expect(groupIn(page, group.name)).toHaveCount(0);
    await page.keyboard.press('Escape');

    hideRestore = false;
    await api('POST', `/groups/${group.id}/members`, { user_ids: [bobId] });
    await expect(groupIn(page, group.name)).toBeVisible();
    await openGroup(page);
    await expect(page.locator('.msg.pending.failed')).toContainText(text);
    await page.locator('.topbar-avatar').click();
    await expect(page.locator('.self-menu').getByRole('button', { name: /Неотправленные сообщения/ })).toHaveCount(0);
  } finally { release?.(); }
});


test('account teardown clears overlapping read and send tasks even when the next account uses the same channel ID', async ({ page }) => {
  await observeClient(page);
  await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }));
  await openGroup(page);
  const originals = [];
  for (const text of ['Первое для чтения', 'Второе для чтения', 'Третье только для Алисы']) originals.push((await api('POST', `/channels/${group.channel_id}/messages`, { text, nonce: crypto.randomUUID() })).message);
  let releaseAliceRead: (() => void) | undefined, releaseAliceSend: (() => void) | undefined, releaseBobRead: (() => void) | undefined;
  const reads: { token: string; message_id: number }[] = [], sends: { token: string; text: string }[] = [];
  const tokenAlice = await page.evaluate(() => window.clientAudit.session.value!.api.token);
  await page.route(`**/channels/${group.channel_id}/read`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const token = route.request().headers().authorization!;
    reads.push({ token, message_id: route.request().postDataJSON().message_id });
    const response = await route.fetch();
    if (token === 'Bearer ' + tokenAlice && !releaseAliceRead) await new Promise<void>((resolve) => { releaseAliceRead = resolve; });
    else if (token !== 'Bearer ' + tokenAlice && !releaseBobRead) await new Promise<void>((resolve) => { releaseBobRead = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route(/\/channels\/\d+\/messages(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const token = route.request().headers().authorization!;
    sends.push({ token, text: route.request().postDataJSON().text });
    if (token !== 'Bearer ' + tokenAlice) return route.continue();
    await new Promise<void>((resolve) => { releaseAliceSend = resolve; });
    await route.fulfill({ status: 503, json: { error: { code: 'internal', message: 'Delayed old account failure' } } }).catch(() => {});
  });
  try {
    await page.evaluate(({ cid, mid }) => {
      window.clientAudit.markRead(cid, mid);
      if (!window.clientAudit.sendMessage(cid, 'Удерживаемая отправка Алисы')) throw new Error('Alice enqueue failed');
    }, { cid: group.channel_id, mid: originals[2].id });
    await expect.poll(() => !!releaseAliceRead && !!releaseAliceSend).toBe(true);
    await signOut(page);
    await signIn(page, 'bob');
    // Supply explicit viewed IDs through the public callback while automatic dwell is inactive.
    // Focus/visibility gates themselves have separate browser coverage.
    const tokenBob = await page.evaluate(() => window.clientAudit.session.value!.api.token);
    expect(tokenBob).not.toBe(tokenAlice);
    expect(await page.evaluate(({ cid, mid }) => {
      window.clientAudit.markRead(cid, mid);
      return window.clientAudit.sendMessage(cid, 'Новая отправка Боба');
    }, { cid: group.channel_id, mid: originals[0].id })).toBe(true);
    await expect.poll(() => !!releaseBobRead).toBe(true);
    await expect.poll(async () => (await api('GET', `/channels/${group.channel_id}/messages`)).messages.some((message: { text: string; author_id: number }) => message.text === 'Новая отправка Боба' && message.author_id === bobId)).toBe(true);
    releaseAliceRead!(); releaseAliceSend!();
    await page.evaluate(({ cid, mid }) => window.clientAudit.markRead(cid, mid), { cid: group.channel_id, mid: originals[1].id });
    await page.waitForTimeout(1100); // Old send must not retry; old read must not clear Bob's task.
    expect(sends.filter((send) => send.token === 'Bearer ' + tokenAlice)).toHaveLength(1);
    expect(reads.filter((read) => read.token === 'Bearer ' + tokenBob).map((read) => read.message_id)).toEqual([originals[0].id]);
    releaseBobRead!();
    await expect.poll(() => reads.filter((read) => read.token === 'Bearer ' + tokenBob).map((read) => read.message_id)).toEqual([originals[0].id, originals[1].id]);
    const bobRead = await fetch(`${stack.api}/api/v1/channels/${group.channel_id}/read`, { headers: { Authorization: 'Bearer ' + tokenBob } });
    expect((await bobRead.json()).message_id).toBe(originals[1].id);
    await openGroup(page);
    await expect(page.locator('.msg.pending')).toHaveCount(0);
    await expect(page.locator('.msg:not(.pending)', { hasText: 'Новая отправка Боба' })).toHaveCount(1);
  } finally { releaseAliceRead?.(); releaseAliceSend?.(); releaseBobRead?.(); }
});

test('the first realtime hello repairs messages changed after bootstrap but before authentication completed', async ({ page }) => {
  const original = (await api('POST', `/channels/${group.channel_id}/messages`, { text: 'Снимок до первого hello', nonce: crypto.randomUUID() })).message;
  let releaseHello: (() => void) | undefined;
  let holding = true;
  const repairs: string[] = [];
  await page.routeWebSocket(/\/api\/v1\/ws$/, (client) => {
    const server = client.connectToServer();
    server.onMessage((data) => {
      const event = JSON.parse(String(data));
      if (event.type === 'hello' && holding) { releaseHello = () => { holding = false; client.send(data); }; return; }
      if (!holding) client.send(data);
    });
  });
  page.on('request', (request) => { if (!holding && /\/(history|changes)(?:\?|$)/.test(request.url())) repairs.push(request.url()); });
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await openGroup(page);
  await expect.poll(() => !!releaseHello).toBe(true);
  await expect(page.locator(`.msg[data-id="${original.id}"]`)).toContainText('Снимок до первого hello');
  await api('PATCH', `/messages/${original.id}`, { text: 'Исправлено в промежутке bootstrap' });
  const arrived = (await api('POST', `/channels/${group.channel_id}/messages`, { text: 'Пропущенное первое событие', nonce: crypto.randomUUID() })).message;
  await expect(page.locator(`.msg[data-id="${original.id}"]`)).toContainText('Снимок до первого hello');
  await expect(page.locator(`.msg[data-id="${arrived.id}"]`)).toHaveCount(0);
  releaseHello!();
  await expect(page.locator(`.msg[data-id="${original.id}"]`)).toContainText('Исправлено в промежутке bootstrap');
  await expect(page.locator(`.msg[data-id="${arrived.id}"]`)).toContainText('Пропущенное первое событие');
  expect(repairs.length).toBeGreaterThan(0);
});

// A held search snapshot predates the first history snapshot. It must be rejected,
// then an explicit retry may install it; closing/replacing panels releases the collection.
test('search rejects a stale collection snapshot and releases search and pin collections when panels close', async ({ page }) => {
  const cold = (await api('POST', `/groups/${group.id}/channels`, { name: 'холодный' })).channel;
  const target = (await api('POST', `/channels/${cold.id}/messages`, { text: 'Искомая иголка', nonce: crypto.randomUUID() })).message;
  await api('POST', `/messages/${target.id}/pin`);
  await observeClient(page);
  let releaseHistory: (() => void) | undefined, releaseSearch: (() => void) | undefined;
  let holdHistory = true, holdSearch = true;
  await page.route(`**/channels/${cold.id}/history?*`, async (route) => {
    if (holdHistory) { holdHistory = false; await new Promise<void>((resolve) => { releaseHistory = resolve; }); }
    await route.continue();
  });
  await page.route(`**/channels/${cold.id}/search?*`, async (route) => {
    if (!holdSearch) return route.continue();
    holdSearch = false;
    const response = await route.fetch();
    await new Promise<void>((resolve) => { releaseSearch = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await openGroup(page);
    await page.locator('.nav-row', { hasText: 'холодный' }).click();
    await expect.poll(() => !!releaseHistory).toBe(true);
    await page.getByRole('button', { name: 'Поиск по чату', exact: true }).click();
    await page.locator('.chat-panel input').fill('иголка');
    await expect.poll(() => !!releaseSearch).toBe(true);
    const newer = (await api('POST', `/channels/${cold.id}/messages`, { text: 'Снимок истории стал новее', nonce: crypto.randomUUID() })).message;
    releaseHistory!();
    await expect(page.locator(`.msg[data-id="${newer.id}"]`)).toBeVisible();
    releaseSearch!();
    await expect(page.locator('.chat-panel .history-status')).toContainText('Не удалось загрузить сообщения');
    expect(await page.evaluate(() => window.clientAudit.retentionFailures)).toBe(1);
    await page.locator('.chat-panel').getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.locator('.mini-msg')).toContainText('Искомая иголка');
    const activeCollections = () => page.evaluate(() => window.clientAudit.collectionKeys.filter((key) => window.clientAudit.history.value!.collection(key).length > 0).length);
    expect(await activeCollections()).toBe(1);
    await page.locator('.chat-panel').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect.poll(activeCollections).toBe(0);
    for (let n = 0; n < 3; n++) {
      await page.getByRole('button', { name: 'Закреплённые', exact: true }).click();
      await expect(page.locator('.mini-msg')).toContainText('Искомая иголка');
      expect(await activeCollections()).toBe(1);
      await page.getByRole('button', { name: 'Поиск по чату', exact: true }).click();
      await expect.poll(activeCollections).toBe(0);
      await page.locator('.chat-panel input').fill('иголка');
      await expect(page.locator('.mini-msg')).toContainText('Искомая иголка');
      expect(await activeCollections()).toBe(1);
      await page.locator('.chat-panel').getByRole('button', { name: 'Закрыть', exact: true }).click();
      await expect.poll(activeCollections).toBe(0);
    }
  } finally { releaseHistory?.(); releaseSearch?.(); }
});

test('deletion removes pin and last-message previews and replaces saved reply previews before and after reload', async ({ page }) => {
  const dm = (await api('POST', '/dms', { user_id: bobId })).channel;
  const create = async (text: string, reply_to?: number) => (await api('POST', `/channels/${dm.id}/messages`, { text, reply_to, nonce: crypto.randomUUID() })).message;
  const fallback = await create('Предыдущее безопасное сообщение');
  const target = await create('Удаляемый фрагмент 7f2b');
  const reply = await create('Ответ без исходного текста', target.id);
  await api('POST', `/messages/${target.id}/pin`);
  await observeClient(page);
  await page.locator('.nav-tabs').getByRole('tab', { name: 'Люди', exact: true }).click();
  await page.locator('.nav-search input').fill('bob');
  const person = page.locator('.nav-person', { hasText: 'Bob' });
  await person.click();
  await expect(page.locator(`.msg[data-id="${reply.id}"] .msg-reply`)).toContainText('Удаляемый фрагмент 7f2b');
  await page.evaluate(({ cid, target }) => window.clientAudit.setReply(cid, target), { cid: dm.id, target });
  await expect(page.locator('.reply-bar')).toContainText('Удаляемый фрагмент 7f2b');
  await page.getByRole('button', { name: 'Закреплённые', exact: true }).click();
  await expect(page.locator('.mini-msg')).toContainText('Удаляемый фрагмент 7f2b');
  await api('DELETE', `/messages/${target.id}`);
  await expect(page.locator('.mini-msg')).toHaveCount(0);
  await expect(page.locator('.chat-panel')).toContainText('Нет закреплённых сообщений');
  await expect(page.locator(`.msg[data-id="${reply.id}"] .msg-reply`)).toContainText(/сообщение удалено/i);
  await expect(page.locator('.reply-bar')).toContainText(/сообщение удалено/i);
  await expect(page.locator('.reply-bar')).not.toContainText('7f2b');
  await page.locator('.chat-panel').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await api('DELETE', `/messages/${reply.id}`);
  await expect(person.locator('.nav-person-sub')).toHaveText(fallback.text);
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await page.locator('.nav-tabs').getByRole('tab', { name: 'Люди', exact: true }).click();
  await page.locator('.nav-search input').fill('bob');
  await person.click();
  await expect(page.locator('.reply-bar')).toContainText(/сообщение удалено/i);
  await expect(page.locator('.msg:not([data-deleted])')).not.toContainText('7f2b');
  await expect(person.locator('.nav-person-sub')).toHaveText(fallback.text);
});


test('a real database restore recovers lower session versions while retaining drafts and queued attachment bytes', async ({ page }) => {
  await observeClient(page);
  await page.evaluate(() => Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }));
  await openGroup(page);
  const bobToken = await loginToken(stack.api, 'bob');
  const bobCall = async (method: string, endpoint: string, body: unknown) => {
    const response = await fetch(stack.api + '/api/v1' + endpoint, { method, headers: { Authorization: 'Bearer ' + bobToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const original = (await bobCall('POST', `/channels/${group.channel_id}/messages`, { text: 'Сообщение из восстановленной базы', nonce: crypto.randomUUID() })).message;
  await expect(page.locator(`.msg[data-id="${original.id}"]`)).toBeVisible();
  await page.evaluate(() => window.clientAudit.history.value!.syncAll());
  const snapshot = (action: 'save' | 'restore') => {
    const python = path.join(__dirname, '../../server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    execFileSync(python, ['-c', `
import pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1]).resolve()
assert root.name.startswith('tolktak-e2e-') and (root / 'tolktak.db').is_file(), root
live = root / 'tolktak.db'
saved = root / 'client-audit-restore.db'
source, target = (live, saved) if sys.argv[2] == 'save' else (saved, live)
assert source.is_file()
with sqlite3.connect(source) as old, sqlite3.connect(target) as new:
    old.backup(new)
`, stack.dataDir, action]);
  };
  snapshot('save');
  await api('PATCH', '/me', { display_name: 'Alice после снимка' });
  await api('PATCH', '/me', { status: 'Новая ревизия' });
  await bobCall('PATCH', '/me', { display_name: 'Bob после снимка' });
  await api('PUT', `/contacts/${bobId}`, { contact: true });
  const future = (await bobCall('POST', `/channels/${group.channel_id}/messages`, { text: 'Этого сообщения уже нет в восстановленной базе', nonce: crypto.randomUUID() })).message;
  await bobCall('PATCH', `/messages/${original.id}`, { text: 'Изменено после снимка' });
  await page.evaluate(() => window.clientAudit.history.value!.syncAll());
  await expect.poll(() => page.evaluate(() => window.clientAudit.session.value!.me.profile_revision)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.clientAudit.people.value!.contactsVersion.value)).toBeGreaterThan(0);
  const oldApi = await page.evaluateHandle(() => window.clientAudit.session.value!.api);
  const oldStore = await page.evaluateHandle(() => window.clientAudit.history.value);
  let releaseRead: (() => void) | undefined, releaseSend: (() => void) | undefined;
  const sends: { nonce: string; attachments: string[] }[] = [];
  const changeStatuses: number[] = [];
  page.on('response', (response) => { if (response.url().includes(`/channels/${group.channel_id}/changes?`)) changeStatuses.push(response.status()); });
  await page.route(`**/channels/${group.channel_id}/read`, async (route) => {
    if (route.request().method() !== 'POST' || releaseRead) return route.continue();
    const response = await route.fetch();
    await new Promise<void>((resolve) => { releaseRead = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route(/\/channels\/\d+\/messages(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sends.push(route.request().postDataJSON());
    if (sends.length > 1) return route.continue();
    await new Promise<void>((resolve) => { releaseSend = resolve; });
    await route.fulfill({ status: 503, json: { error: { code: 'internal', message: 'Old request after database restore' } } }).catch(() => {});
  });
  try {
    await page.locator('.composer input[type=file]').setInputFiles({ name: 'after-restore.txt', mimeType: 'text/plain', buffer: Buffer.from('Durable across a real server database restore') });
    await expect(page.locator('.upload-progress')).toHaveCount(0);
    await expect(page.locator('.upload-tray .upload-name')).toHaveText('after-restore.txt');
    await page.locator('.composer textarea').fill('Очередь переживает восстановление базы');
    await page.locator('.composer').getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.evaluate(({ cid, mid }) => window.clientAudit.markRead(cid, mid), { cid: group.channel_id, mid: future.id });
    await expect.poll(() => !!releaseRead && !!releaseSend).toBe(true);
    await page.locator('.composer textarea').fill('Черновик переживает восстановление базы');
    const queued = await page.evaluate(({ server, uid }) => JSON.parse(localStorage.getItem(`tolktak.messages.v1:${encodeURIComponent(server)}:${uid}`)!).pending[0], { server: stack.api, uid: aliceId });
    expect(queued.attachments[0].local_id).toMatch(/^[0-9a-f]{32}$/);
    await stack.restartServer(async () => snapshot('restore'));
    // Reconnect's first hello drives the repair: the test does not manually request a reset.
    await expect.poll(() => page.evaluate((old) => window.clientAudit.session.value!.api !== old, oldApi)).toBe(true);
    expect(changeStatuses).toContain(409);
    expect(await page.evaluate((old) => window.clientAudit.history.value !== old, oldStore)).toBe(true);
    await expect(page.locator('.shell')).toBeVisible();
    await openGroup(page);
    await expect(page.locator('.composer textarea')).toHaveValue('Черновик переживает восстановление базы');
    await expect(page.locator('.msg.pending.failed')).toContainText('Очередь переживает восстановление базы');
    releaseRead!(); releaseSend!();
    await page.waitForTimeout(1100);
    expect(sends).toHaveLength(1);
    expect(await page.evaluate(({ cid, peer }) => ({
      profile: window.clientAudit.session.value!.me.profile_revision,
      peerProfile: window.clientAudit.users.value.get(peer)?.profile_revision,
      contacts: window.clientAudit.people.value!.contactsVersion.value,
      history: window.clientAudit.channels.value.get(cid)!.history_version,
      read: window.clientAudit.channels.value.get(cid)!.last_read_id,
    }), { cid: group.channel_id, peer: bobId })).toEqual({ profile: 0, peerProfile: 0, contacts: 0, history: 1, read: 0 });
    await expect(page.locator(`.msg[data-id="${original.id}"]`)).toContainText('Сообщение из восстановленной базы');
    await expect(page.locator(`.msg[data-id="${future.id}"]:not(.pending)`)).toHaveCount(0);
    await page.locator('.msg.pending.failed').getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.locator('.msg.pending')).toHaveCount(0);
    await expect(page.locator('.msg:not(.pending) .file-att')).toContainText('after-restore.txt');
    expect(sends.map((send) => send.nonce)).toEqual([queued.nonce, queued.nonce, queued.nonce]);
    const recovered = (await api('GET', `/channels/${group.channel_id}/messages`)).messages.find((message: { nonce: string }) => message.nonce === queued.nonce);
    expect(recovered.attachments[0].id).not.toBe(queued.attachments[0].id);
    expect(await (await fetch(`${stack.api}/api/v1/files/${recovered.attachments[0].id}`)).text()).toBe('Durable across a real server database restore');
    await expect(page.locator('.composer textarea')).toHaveValue('Черновик переживает восстановление базы');
    await page.screenshot({ path: test.info().outputPath('database-restore-recovery.png'), animations: 'disabled' });
  } finally { releaseRead?.(); releaseSend?.(); await oldApi.dispose(); await oldStore.dispose(); }
});
