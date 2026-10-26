import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { expectFlowing, joinRoom, openClient, stats } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
const ids: Record<string, number> = {};

test.beforeAll(async () => {
  stack = await startStack();
  for (const u of ['alice', 'bob', 'carol']) ids[u] = (await register(stack.api, u)).user.id;
});
test.afterAll(async () => stack?.stop());

test('DM: realtime delivery, unread badge, reply', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');
  await alice.locator('.side-item', { hasText: 'Bob' }).click();
  await alice.locator('.composer textarea').fill('Привет, Боб!');
  await alice.keyboard.press('Enter');
  await expect(alice.locator('.msg-text', { hasText: 'Привет, Боб!' })).toBeVisible();
  await expect(alice.locator('.msg.pending')).toHaveCount(0);

  const bobItem = bob.locator('.side-item', { hasText: 'Alice' });
  await expect(bobItem.locator('.badge')).toHaveText('1');
  await bobItem.click();
  await expect(bob.locator('.msg-text', { hasText: 'Привет, Боб!' })).toBeVisible();
  await expect(bobItem.locator('.badge')).toHaveCount(0);
  await bob.locator('.composer textarea').fill('Привет!');
  await bob.keyboard.press('Enter');
  await expect(alice.locator('.msg-text', { hasText: /^Привет!$/ })).toBeVisible();
  await alice.context().close();
  await bob.context().close();
});

test('messages sent or received while the first page loads stay in the chat', async ({ browser }) => {
  const bob = await loginToken(stack.api, 'bob');
  const call = (path: string, body: unknown) =>
    fetch(stack.api + '/api/v1' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bob },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const { channel } = await call('/dms', { user_id: ids.carol });
  await call(`/channels/${channel.id}/messages`, { text: 'до загрузки', nonce: crypto.randomUUID() });

  const carol = await openClient(browser, stack, 'carol');
  let pageFetched!: () => void;
  let releasePage!: () => void;
  const fetched = new Promise<void>((r) => (pageFetched = r));
  const released = new Promise<void>((r) => (releasePage = r));
  await carol.route(`**/channels/${channel.id}/messages?limit=50`, async (route) => {
    const page = await route.fetch();
    pageFetched();
    await released;
    await route.fulfill({ response: page });
  });
  const bobItem = carol.locator('.side-item', { hasText: 'Bob' });
  await bobItem.click();
  await fetched;
  await call(`/channels/${channel.id}/messages`, { text: 'во время загрузки', nonce: crypto.randomUUID() });
  await expect(bobItem.locator('.side-item-sub')).toHaveText('во время загрузки');
  await carol.locator('.composer textarea').fill('отправлено при загрузке');
  await carol.keyboard.press('Enter');
  await expect(bobItem.locator('.side-item-sub')).toHaveText('отправлено при загрузке');
  releasePage();

  await expect(carol.locator('.msg-text', { hasText: 'до загрузки' })).toBeVisible();
  await expect(carol.locator('.msg-text', { hasText: 'во время загрузки' })).toBeVisible();
  await expect(carol.locator('.msg-text', { hasText: 'отправлено при загрузке' })).toBeVisible();
  await expect(carol.locator('.msg.pending')).toHaveCount(0);
  await carol.context().close();
});

test('an expired session shows one notice after signing in again', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  const page = await ctx.newPage();
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/api\/v1\/ws$/, (ws) => {
    ws.connectToServer();
    socket = ws;
  });
  const expired = page.locator('.toast', { hasText: 'Сессия завершена' });
  await page.goto(stack.web);
  for (let round = 0; round < 2; round++) {
    await page.fill('input[name=server]', stack.api);
    await page.fill('input[name=username]', 'alice');
    await page.fill('input[name=password]', 'password123');
    await page.click('button[type=submit]');
    await expect(page.locator('.shell')).toBeVisible();
    await expect.poll(() => socket).toBeTruthy();
    await socket!.close({ code: 4001, reason: 'invalid token' });
    socket = undefined;
    await expect(page.locator('input[name=username]')).toBeVisible();
    await expect(expired).toHaveCount(1);
    await expect(expired).toHaveCount(0);
  }
  await ctx.close();
});

test('group voice room: two-way audio, stream with sound, late join, host leaves', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');

  await alice.click('.rail-btn.add');
  await alice.fill('.modal input[maxlength="60"]', 'Кино');
  for (const n of ['Bob', 'Carol']) await alice.locator('.user-row', { hasText: n }).click();
  await alice.click('.modal button.primary');
  await expect(bob.locator('.rail-btn.group', { hasText: 'КИ' })).toBeVisible();

  await joinRoom(alice, 'Кино');
  await joinRoom(bob, 'Кино');
  await expect(alice.locator('.tile')).toHaveCount(2);
  await expect(bob.locator('.tile')).toHaveCount(2);
  const carol = await openClient(browser, stack, 'carol');
  await carol.locator('.rail-btn.group', { hasText: 'КИ' }).click();
  await expect(carol.locator('.room-member')).toHaveCount(2);

  const a2b = await expectFlowing(bob, ids.alice, 'microphone', 20);
  const b2a = await expectFlowing(alice, ids.bob, 'microphone', 20);
  test.info().annotations.push({ type: 'audio', description: JSON.stringify({ a2b, b2a }) });

  // No process loopback in a browser: opt in.
  await alice.click('button[aria-label="Демонстрация"]');
  await alice.locator('.warn-box input[type=checkbox]').check();
  await alice.click('.modal button.primary');
  await expect(alice.locator('.stream-card')).toHaveCount(1);
  await expect(carol.locator('.room-member .live')).toHaveCount(1);

  await bob.locator('.stream-card').click();
  await expect(bob.locator('.theater')).toBeVisible();
  const video = await expectFlowing(bob, ids.alice, 'screen_share', 40);
  const sound = await expectFlowing(bob, ids.alice, 'screen_share_audio', 50);
  test.info().annotations.push({ type: 'stream', description: JSON.stringify({ video, sound }) });
  const out = (await stats(alice)).outbound.filter((o) => o.source === 'screen_share');
  test.info().annotations.push({ type: 'encoder', description: JSON.stringify(out) });

  await carol.locator('.room-join', { hasText: 'Общая' }).click();
  await expect(carol.locator('.stream-card')).toHaveCount(1);
  const carolBefore = (await stats(carol)).inbound.find((x) => x.source === 'screen_share_audio');
  expect(carolBefore, 'stream audio must not be received before watching').toBeUndefined();
  await carol.locator('.stream-card').click();
  await expectFlowing(carol, ids.alice, 'screen_share', 40);
  await expectFlowing(carol, ids.alice, 'screen_share_audio', 50);

  await alice.click('button[aria-label="Выйти из комнаты"]');
  await expect(bob.locator('.theater')).toHaveCount(0);
  await expect(bob.locator('.stream-card')).toHaveCount(0);
  await expect(bob.locator('.tile')).toHaveCount(2);
  await expectFlowing(bob, ids.carol, 'microphone', 20);
  await expect(carol.locator('.room-member')).toHaveCount(2);

  for (const p of [alice, bob, carol]) await p.context().close();
});

test('signing out leaves voice, also while the join request is in flight', async ({ browser }) => {
  const token = await loginToken(stack.api, 'carol');
  await fetch(stack.api + '/api/v1/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: 'Выход', members: [], room_name: 'Общая' }),
  });
  const logOut = async (p: Page) => {
    await p.click('.self-id');
    await p.locator('.self-menu button.danger-text').click();
    await p.click('.modal .danger-btn');
    await expect(p.locator('input[name=username]')).toBeVisible();
  };

  const inCall = await openClient(browser, stack, 'carol');
  await joinRoom(inCall, 'Выход');
  const left = inCall.waitForResponse('**/api/v1/voice/leave');
  await logOut(inCall);
  expect((await left).status(), 'the room must be left while the token is still valid').toBe(204);
  await inCall.context().close();

  const joining = await openClient(browser, stack, 'carol');
  let joinSent!: () => void;
  let releaseJoin!: () => void;
  const sent = new Promise<void>((r) => (joinSent = r));
  const released = new Promise<void>((r) => (releaseJoin = r));
  await joining.route('**/api/v1/voice/join', async (route) => {
    const res = await route.fetch();
    joinSent();
    await released;
    await route.fulfill({ response: res });
  });
  await joining.locator('.rail-btn.group', { hasText: 'ВЫ' }).click();
  await joining.locator('.room-join', { hasText: 'Общая' }).click();
  await sent;
  await logOut(joining);
  releaseJoin();
  await joining.waitForTimeout(3000);
  expect(await joining.evaluate(() => (globalThis as any).__tolktak.room === null), 'no LiveKit room after signing out').toBe(true);
  await joining.context().close();
});
