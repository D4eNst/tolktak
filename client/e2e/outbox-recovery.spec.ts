import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FileMeta, Message } from '../src/renderer/api';
import type { Pending } from '../src/renderer/localMessages';
import { groupIn } from './helpers';
import { loginToken, register, startStack, type Stack } from './stack';

let stack: Stack;
let aliceToken: string;
let aliceID: number;
let group: { id: number; name: string; channel_id: number };
type SendBody = { nonce: string; text: string; attachments: string[] };
const unavailable = { status: 503, contentType: 'application/json', body: '{"error":{"code":"internal","message":"Temporarily unavailable"}}' };
const messagesURL = /\/channels\/\d+\/messages(?:\?.*)?$/;

async function api(method: string, endpoint: string, body?: unknown) {
  const response = await fetch(stack.api + '/api/v1' + endpoint, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aliceToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function openGroup(page: Page, channel = 'общий') {
  await page.locator('.nav-tabs button', { hasText: 'Группы' }).click();
  await groupIn(page, group.name).click();
  await page.locator('.nav-row', { hasText: channel }).click();
  await expect(page.locator('.composer textarea')).toBeVisible();
}

async function pending(page: Page): Promise<Pending[]> {
  return page.evaluate(({ server, uid }) => JSON.parse(localStorage.getItem(`tolktak.messages.v1:${encodeURIComponent(server)}:${uid}`) || '{}').pending ?? [], { server: stack.api, uid: aliceID });
}

async function storedFile(page: Page, localID: string) {
  return page.evaluate(async ({ server, uid, localID }) => {
    const entry = await new Promise<{ blob: Blob; name: string } | undefined>((resolve, reject) => {
      const open = indexedDB.open('tolktak.outbox-files.v1', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('files', 'readonly');
        const request = tx.objectStore('files').get([server, uid, localID]);
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    return entry ? { name: entry.name, mime: entry.blob.type, bytes: Array.from(new Uint8Array(await entry.blob.arrayBuffer())) } : null;
  }, { server: stack.api, uid: aliceID, localID });
}

/** Expire only this test's unused upload metadata; never touch a demo/user database. */
function expireFile(fileID: string) {
  const python = path.join(__dirname, '../../server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  execFileSync(python, ['-c', `
import pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1]).resolve()
assert root.name.startswith('tolktak-e2e-') and root.is_dir(), root
db = root / 'tolktak.db'
assert db.is_file(), db
with sqlite3.connect(db.as_uri() + '?mode=rw', uri=True) as conn:
    assert conn.execute('SELECT COUNT(*) FROM message_files WHERE file_id = ?', (sys.argv[2],)).fetchone()[0] == 0
    deleted = conn.execute('DELETE FROM files WHERE id = ?', (sys.argv[2],))
    assert deleted.rowcount == 1, deleted.rowcount
`, stack.dataDir, fileID]);
}

async function attach(page: Page, name: string, bytes: Buffer): Promise<FileMeta> {
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/api/v1/files?'));
  await page.locator('.composer input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
  const response = await uploaded;
  expect(response.status()).toBe(201);
  await expect(page.locator('.upload-progress')).toHaveCount(0);
  return (await response.json()).file;
}

test.beforeEach(async ({ page }) => {
  stack = await startStack();
  aliceID = (await register(stack.api, 'alice')).user.id;
  const bobID = (await register(stack.api, 'bob')).user.id;
  aliceToken = await loginToken(stack.api, 'alice');
  group = (await api('POST', '/groups', { name: 'Восстановление очереди', members: [bobID], room_name: 'Общая', channel_name: 'общий' })).group;
  await page.context().addInitScript({ path: path.join(__dirname, 'fake-display.js') });
  await page.context().addInitScript(() => localStorage.setItem('tolktak.tour', '1'));
  await page.goto(stack.web);
  const form = page.locator('.login-card');
  await expect(form).toBeVisible();
  await form.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))));
  await page.fill('input[name=server]', stack.api);
  await page.fill('input[name=username]', 'alice');
  await page.fill('input[name=password]', 'password123');
  await page.locator('button[type=submit]').click();
  await expect(page.locator('.shell')).toBeVisible();
  await openGroup(page);
});
test.afterEach(async () => stack?.stop());

test('expired queued attachment recovers its bytes after reload with the original nonce and cleans only after confirmation', async ({ page }) => {
  let offline = true;
  let oldFileID = '';
  let missingCode = '';
  let release: (() => void) | undefined;
  const sends: SendBody[] = [];
  await page.route(messagesURL, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON() as SendBody;
    sends.push(body);
    if (offline) return route.fulfill(unavailable);
    if (body.attachments[0] === oldFileID) {
      const response = await route.fetch();
      expect(response.status()).toBe(404);
      missingCode = (await response.json()).error.code;
      return route.fulfill({ response });
    }
    // The recovered upload exists, but the server has not accepted its message yet.
    await new Promise<void>((resolve) => (release = resolve));
    return route.continue();
  });
  const bytes = Buffer.from('Durable queued file\nСохранённые байты\n');
  const original = await attach(page, 'durable.txt', bytes);
  oldFileID = original.id;
  await page.locator('.composer textarea').fill('Очередь с вложением');
  await page.locator('.composer textarea').press('Enter');
  const row = page.locator('.msg.pending.failed');
  await expect(row).toContainText('Очередь с вложением');
  const queued = (await pending(page))[0];
  const localID = queued.attachments[0].local_id!;
  expect(localID).toMatch(/^[0-9a-f]{32}$/);
  expect(await storedFile(page, localID)).toEqual({ name: 'durable.txt', mime: 'text/plain', bytes: Array.from(bytes) });
  const attempts = sends.length;
  expect(attempts).toBe(3);
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await openGroup(page);
  await expect(row).toContainText('Очередь с вложением');
  expect((await pending(page))[0]).toMatchObject({ nonce: queued.nonce, attachments: [{ id: oldFileID, local_id: localID }] });
  expect(await storedFile(page, localID)).toEqual({ name: 'durable.txt', mime: 'text/plain', bytes: Array.from(bytes) });
  await page.waitForTimeout(1000); // Reload must not silently resubmit the failed queue.
  expect(sends).toHaveLength(attempts);
  expireFile(oldFileID);
  expect((await fetch(stack.api + '/api/v1/files/' + oldFileID)).status).toBe(404);
  offline = false;
  try {
    await row.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    expect(missingCode).toBe('file_missing');
    expect(sends.slice(attempts).map((body) => body.nonce)).toEqual([queued.nonce, queued.nonce]);
    const recovered = (await pending(page))[0];
    expect(recovered.attachments[0].id).not.toBe(oldFileID);
    expect(recovered.attachments[0].local_id).toBe(localID);
    expect(await storedFile(page, localID)).not.toBeNull();
    expect((await api('GET', `/channels/${group.channel_id}/messages`)).messages).toHaveLength(0);
    release!();
    await expect(page.locator('.msg:not(.pending) .file-att')).toContainText('durable.txt');
    await expect(page.locator('.msg.pending')).toHaveCount(0);
    const sent: Message[] = (await api('GET', `/channels/${group.channel_id}/messages`)).messages;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ nonce: queued.nonce, attachments: [{ id: recovered.attachments[0].id }] });
    expect(Buffer.from(await (await fetch(stack.api + '/api/v1/files/' + sent[0].attachments[0].id)).arrayBuffer())).toEqual(bytes);
    await expect.poll(() => storedFile(page, localID)).toBeNull();
    expect(await pending(page)).toHaveLength(0);
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    await openGroup(page);
    await expect(page.locator('.msg:not(.pending) .file-att')).toHaveCount(1);
    await expect(page.locator('.msg.pending')).toHaveCount(0);
    expect(sends).toHaveLength(attempts + 2);
  } finally { release?.(); }
});

test('a failed first send blocks a second queued message and retries preserve their sequence', async ({ page }) => {
  let fail = true;
  let release: (() => void) | undefined;
  const sends: SendBody[] = [];
  await page.route(messagesURL, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sends.push(route.request().postDataJSON());
    if (sends.length === 1) await new Promise<void>((resolve) => (release = resolve));
    return fail ? route.fulfill(unavailable) : route.continue();
  });
  try {
    await page.locator('.composer textarea').fill('Первое в очереди');
    await page.locator('.composer textarea').press('Enter');
    await expect.poll(() => !!release).toBe(true);
    await page.locator('.composer textarea').fill('Второе в очереди');
    await page.locator('.composer textarea').press('Enter');
    await expect(page.locator('.msg.pending')).toHaveCount(2);
    expect(sends.map((send) => send.text)).toEqual(['Первое в очереди']);
    release!();
    await expect(page.locator('.msg.pending.failed')).toHaveCount(2);
    expect(sends.map((send) => send.text)).toEqual(['Первое в очереди', 'Первое в очереди', 'Первое в очереди']);
    expect((await api('GET', `/channels/${group.channel_id}/messages`)).messages).toHaveLength(0);
    const queued = await pending(page);
    fail = false;
    await page.locator('.msg.pending.failed', { hasText: 'Первое в очереди' }).getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.locator('.msg:not(.pending)', { hasText: 'Первое в очереди' })).toBeVisible();
    await expect(page.locator('.msg.pending.failed', { hasText: 'Второе в очереди' })).toBeVisible();
    expect(sends.at(-1)?.nonce).toBe(queued.find((p) => p.text === 'Первое в очереди')!.nonce);
    await page.locator('.msg.pending.failed', { hasText: 'Второе в очереди' }).getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.locator('.msg.pending')).toHaveCount(0);
    const sent: Message[] = (await api('GET', `/channels/${group.channel_id}/messages`)).messages;
    expect(sent.map((m) => m.text)).toEqual(['Первое в очереди', 'Второе в очереди']);
    expect(sent.map((m) => m.nonce)).toEqual(queued.map((p) => p.nonce));
  } finally { release?.(); }
});

test('a deleted channel keeps its queued text and attachment accessible in Settings until explicit discard', async ({ page }) => {
  const secondary = (await api('POST', `/groups/${group.id}/channels`, { name: 'временный' })).channel;
  await page.locator('.nav-row', { hasText: 'временный' }).click();
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Написать в «временный»');
  await page.route(messagesURL, (route) => route.request().method() === 'POST' ? route.fulfill(unavailable) : route.continue());
  const bytes = Buffer.from('Orphan attachment\nМожно сохранить после удаления чата\n');
  const file = await attach(page, 'orphan.txt', bytes);
  const text = 'Не потерять текст удалённого чата';
  await page.locator('.composer textarea').fill(text);
  await page.locator('.composer textarea').press('Enter');
  await expect(page.locator('.msg.pending.failed')).toContainText(text);
  const queued = (await pending(page))[0];
  const localID = queued.attachments[0].local_id!;
  expireFile(file.id);
  await api('DELETE', `/text-channels/${secondary.id}`);
  await expect(page.locator('.nav-row', { hasText: 'временный' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await page.locator('.topbar-avatar').click();
  await page.locator('.self-menu').getByRole('button', { name: /Неотправленные сообщения/ }).click();
  const card = page.locator('.settings-modal .unsent-message');
  await expect(card).toHaveCount(1);
  await expect(card.locator('textarea')).toHaveValue(text);
  await expect(card.locator('textarea')).not.toBeEditable();
  await expect(card.getByRole('button', { name: 'orphan.txt', exact: true })).toBeVisible();
  // Check the clipboard API boundary without replacing the user's macOS clipboard.
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (value: string) => { (window as unknown as { copied: string }).copied = value; } }));
  await card.getByRole('button', { name: 'Копировать текст', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(text);
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: 'orphan.txt', exact: true }).click();
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toBe('orphan.txt');
  expect(readFileSync((await downloaded.path())!)).toEqual(bytes);
  expect(await storedFile(page, localID)).not.toBeNull();
  expect(await pending(page)).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath('orphaned-message-recovery.png'), animations: 'disabled' });
  await card.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.locator('.modal.ask').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => storedFile(page, localID)).toBeNull();
  expect(await pending(page)).toHaveLength(0);
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await page.locator('.topbar-avatar').click();
  await expect(page.locator('.self-menu').getByRole('button', { name: /Неотправленные сообщения/ })).toHaveCount(0);
});
