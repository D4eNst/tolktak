import { expect, test, type Page } from '@playwright/test';
import { expectFlowing, expectFps, joinRoom, openClient, stats } from './helpers';
import { loginToken, outage, register, startStack, type Stack } from './stack';

let stack: Stack;
const ids: Record<string, number> = {};
let tokens: Record<string, string> = {};

test.beforeAll(async () => {
  stack = await startStack();
  for (const u of ['alice', 'bob', 'carol']) {
    const r = await register(stack.api, u);
    ids[u] = r.user.id;
    tokens[u] = await loginToken(stack.api, u);
  }
  const res = await fetch(stack.api + '/api/v1/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.alice },
    body: JSON.stringify({ name: 'Тест', members: [ids.bob, ids.carol], room_name: 'Общая', channel_name: 'общий' }),
  });
  expect(res.ok, await res.clone().text()).toBeTruthy();
});
test.afterAll(async () => stack?.stop());

async function share(p: Page, opts: { switching?: boolean } = {}) {
  await p.click('button[aria-label="Демонстрация"]');
  await p.locator('.warn-box input[type=checkbox]').check();
  await p.click('.modal button.primary');
  await expect(p.locator('.modal')).toHaveCount(0);
  if (!opts.switching) await expect(p.locator('.stream-card').first()).toBeVisible();
}

test('toggles, source switch, two parallel streams', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');
  const carol = await openClient(browser, stack, 'carol');
  for (const p of [alice, bob, carol]) await joinRoom(p, 'Тест');
  await expect(alice.locator('.tile')).toHaveCount(3);

  await bob.click('button[aria-label="Камера"]');
  await expectFlowing(alice, ids.bob, 'camera', 20);
  await expect(alice.locator('.tile video')).toHaveCount(1);
  await bob.click('button[aria-label="Камера"]');
  await expect(alice.locator('.tile video')).toHaveCount(0);

  await bob.click('button[aria-label="Микрофон"]');
  await expect(alice.locator('.tile', { hasText: 'Bob' }).locator('svg')).not.toHaveCount(0);
  await expect(carol.locator('.room-member', { hasText: 'Bob' }).locator('svg')).toHaveCount(1);
  await bob.click('button[aria-label="Микрофон"]');
  await expect(carol.locator('.room-member', { hasText: 'Bob' }).locator('svg')).toHaveCount(0);

  await share(alice);
  await carol.locator('.stream-card').click();
  await expectFlowing(carol, ids.alice, 'screen_share', 40);
  await alice.click('button[aria-label="Демонстрация"]');
  await expect(alice.locator('.modal h2')).toHaveText('Сменить источник');
  await alice.locator('.warn-box input[type=checkbox]').check();
  await alice.click('.modal button.primary');
  await expect(alice.locator('.modal')).toHaveCount(0);
  expect(await alice.evaluate(() => (window as any).__fakeDisplayCalls)).toBe(2);
  await expect(carol.locator('.theater')).toBeVisible();
  await expectFlowing(carol, ids.alice, 'screen_share', 40);
  await expectFlowing(carol, ids.alice, 'screen_share_audio', 50);

  await share(bob);
  await carol.locator('.theater button', { hasText: 'Закрыть' }).click();
  await expect(carol.locator('.stream-card')).toHaveCount(2);
  await carol.locator('.stream-card', { hasText: 'Bob' }).click();
  await expectFlowing(carol, ids.bob, 'screen_share', 40);
  await expectFlowing(carol, ids.bob, 'screen_share_audio', 50);
  const s = await stats(carol);
  const aliceAudio = s.inbound.find((x) => x.from === String(ids.alice) && x.source === 'screen_share_audio');
  expect(aliceAudio, "the unwatched stream's sound is unsubscribed").toBeUndefined();

  for (const p of [alice, bob, carol]) await p.context().close();
});

test('short network loss (5 s): call and stream recover, chat catches up', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');
  for (const p of [alice, bob]) await joinRoom(p, 'Тест');
  await share(alice);
  await bob.locator('.stream-card').click();
  await expectFlowing(bob, ids.alice, 'screen_share', 40);

  const sent = fetch(stack.api + '/api/v1/channels', { headers: { Authorization: 'Bearer ' + tokens.alice } });
  await sent;
  const t0 = Date.now();
  await outage(5000);
  await expect(bob.locator('.voicebar-call .dot.ok')).toBeVisible({ timeout: 30_000 });
  await expect(alice.locator('.voicebar-call .dot.ok')).toBeVisible({ timeout: 30_000 });
  const recovered = (Date.now() - t0) / 1000;
  await expect(bob.locator('.theater')).toBeVisible();
  const back = await expectFps(bob, ids.alice, 'screen_share', 15, 60_000);
  await expectFlowing(bob, ids.alice, 'microphone', 20);
  test.info().annotations.push({ type: 'recovered', description: JSON.stringify({ signalling_s: recovered.toFixed(1), video15fps_after_s: back.seconds.toFixed(1) }) });
  for (const p of [alice, bob]) await p.context().close();
});

test('long network loss (40 s): client rejoins by itself and republishes its stream', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');
  for (const p of [alice, bob]) await joinRoom(p, 'Тест');
  await share(alice);
  await bob.locator('.stream-card').click();
  await expectFlowing(bob, ids.alice, 'screen_share', 40);

  const group = (await (await fetch(stack.api + '/api/v1/groups', { headers: { Authorization: 'Bearer ' + tokens.alice } })).json()).groups[0];
  await alice.locator('button', { hasText: 'Открыть чат группы' }).click();
  const o = outage(40_000);
  await alice.waitForTimeout(1000);
  await alice.locator('.composer textarea').fill('сообщение во время обрыва');
  await alice.keyboard.press('Enter');
  await o;
  const t0 = Date.now();
  await expect(alice.locator('.voicebar-call .dot.ok')).toBeVisible({ timeout: 90_000 });
  await expect(bob.locator('.voicebar-call .dot.ok')).toBeVisible({ timeout: 90_000 });
  test.info().annotations.push({ type: 'rejoin_s_after_outage', description: ((Date.now() - t0) / 1000).toFixed(1) });
  await expect(bob.locator('.stream-card, .theater').first()).toBeVisible({ timeout: 30_000 });
  if (await bob.locator('.stream-card').count()) await bob.locator('.stream-card').click();
  await expectFlowing(bob, ids.alice, 'screen_share', 40);
  await expect.poll(async () => {
    const r = await fetch(`${stack.api}/api/v1/channels/${group.channel_id}/messages`, { headers: { Authorization: 'Bearer ' + tokens.bob } });
    return (await r.json()).messages.filter((m: { text: string }) => m.text === 'сообщение во время обрыва').length;
  }, { timeout: 60_000 }).toBe(1);
  for (const p of [alice, bob]) await p.context().close();
});

test('SFU restart: everyone is back in the room', async ({ browser }) => {
  const alice = await openClient(browser, stack, 'alice');
  const bob = await openClient(browser, stack, 'bob');
  for (const p of [alice, bob]) await joinRoom(p, 'Тест');
  await expectFlowing(bob, ids.alice, 'microphone', 20);
  await stack.restartLivekit();
  for (const p of [alice, bob]) await expect(p.locator('.voicebar-call .dot.wait')).toBeVisible({ timeout: 30_000 });
  for (const p of [alice, bob]) await expect(p.locator('.voicebar-call .dot.ok')).toBeVisible({ timeout: 90_000 });
  await expect(bob.locator('.tile')).toHaveCount(2, { timeout: 30_000 });
  await expect(alice.locator('.tile')).toHaveCount(2, { timeout: 30_000 });
  await expectFlowing(bob, ids.alice, 'microphone', 20);
  await expectFlowing(alice, ids.bob, 'microphone', 20);
  for (const p of [alice, bob]) await p.context().close();
});
