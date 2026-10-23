// Skipped unless LONG_MIN=<minutes> is set.
import { test } from '@playwright/test';
import { expectFlowing, joinRoom, openClient, stats } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

const MIN = Number(process.env.LONG_MIN ?? 0);
let stack: Stack;
const ids: Record<string, number> = {};

test.beforeAll(async () => {
  if (!MIN) return;
  stack = await startStack();
  for (const u of ['alice', 'bob', 'carol']) ids[u] = (await register(stack.api, u)).user.id;
  const t = await loginToken(stack.api, 'alice');
  await fetch(stack.api + '/api/v1/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify({ name: 'Марафон', members: [ids.bob, ids.carol], room_name: 'Общая', channel_name: 'общий' }),
  });
});
test.afterAll(async () => stack?.stop());

test('long movie session', async ({ browser }) => {
  test.skip(!MIN, 'set LONG_MIN');
  test.setTimeout((MIN + 5) * 60_000);
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((u) => openClient(browser, stack, u)));
  for (const p of [alice, bob, carol]) await joinRoom(p, 'Марафон');
  await alice.click('button[aria-label="Демонстрация"]');
  await alice.locator('.warn-box input[type=checkbox]').check();
  await alice.selectOption('.share-options select', '720p30');
  await alice.click('.modal button.primary');
  for (const p of [bob, carol]) await p.locator('.stream-card').click();
  await expectFlowing(bob, ids.alice, 'screen_share', 40);
  const rows: string[] = [];
  const heap = (p: typeof alice) => p.evaluate(() => Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6));
  for (let m = 1; m <= MIN; m++) {
    await bob.waitForTimeout(60_000);
    const sb = (await stats(bob)).inbound.find((x) => x.source === 'screen_share');
    const sc = (await stats(carol)).inbound.find((x) => x.source === 'screen_share');
    const sa = (await stats(bob)).inbound.find((x) => x.source === 'screen_share_audio') as any;
    rows.push(
      JSON.stringify({
        m,
        bob: { fps: sb?.fps, frames: sb?.framesDecoded, freezes: sb?.freezeCount, lost: (sb as any)?.packetsLost, res: `${sb?.width}x${sb?.height}` },
        carol: { fps: sc?.fps, freezes: sc?.freezeCount },
        audioPkts: sa?.packetsReceived,
        heapMB: { alice: await heap(alice), bob: await heap(bob), carol: await heap(carol) },
      }),
    );
    console.log(rows[rows.length - 1]);
  }
  test.info().annotations.push({ type: 'long', description: rows.join('\n') });
  await expectFlowing(bob, ids.alice, 'screen_share', 40);
  await expectFlowing(carol, ids.alice, 'screen_share_audio', 50);
  for (const p of [alice, bob, carol]) await p.context().close();
});
