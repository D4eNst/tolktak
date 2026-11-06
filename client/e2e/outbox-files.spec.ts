import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'node:path';

declare global {
  interface Window { OutboxFiles: typeof import('../src/renderer/outboxFiles') }
}

// Run the production module against real Chromium IndexedDB, without the app/server stack.
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/outboxFiles.ts')],
  bundle: true, write: false, format: 'iife', globalName: 'OutboxFiles', platform: 'browser',
}).outputFiles[0].text;

test.beforeEach(async ({ context, page }) => {
  await context.route('https://outbox.test/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('/store.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('/store.js') ? bundle : '<!doctype html><script src="/store.js"></script>',
  }));
  await page.goto('https://outbox.test/');
});

test('attachment bytes survive reload, are shared by popouts and stay account/server scoped', async ({ page, context }) => {
  const localID = await page.evaluate(() => window.OutboxFiles.saveOutgoingFile(
    ' https://api.test/// ', 17, new File([new Uint8Array([0, 1, 255, 42])], 'voice.ogg', { type: 'audio/ogg' }), 'voice.ogg',
  ));
  expect(localID).toMatch(/^[0-9a-f]{32}$/);
  await page.reload();
  const popout = await context.newPage();
  await popout.goto('https://outbox.test/popout');
  expect(await popout.evaluate(async (localID) => {
    const file = await window.OutboxFiles.loadOutgoingFile('https://api.test', 17, localID);
    return file && { name: file.name, mime: file.blob.type, bytes: Array.from(new Uint8Array(await file.blob.arrayBuffer())) };
  }, localID)).toEqual({ name: 'voice.ogg', mime: 'audio/ogg', bytes: [0, 1, 255, 42] });
  expect(await page.evaluate(async (localID) => {
    const files = window.OutboxFiles;
    await files.deleteOutgoingFile('https://api.test', 18, localID);
    await files.deleteOutgoingFile('https://other.test', 17, localID);
    return [
      await files.loadOutgoingFile('https://api.test', 18, localID),
      await files.loadOutgoingFile('https://other.test', 17, localID),
      Boolean(await files.loadOutgoingFile('https://api.test', 17, localID)),
    ];
  }, localID)).toEqual([null, null, true]);
  await popout.evaluate((localID) => window.OutboxFiles.deleteOutgoingFile('https://api.test', 17, localID), localID);
  expect(await page.evaluate((localID) => window.OutboxFiles.loadOutgoingFile('https://api.test', 17, localID), localID)).toBeNull();
  await page.evaluate((localID) => window.OutboxFiles.deleteOutgoingFile('https://api.test', 17, localID), localID);
});

test('save waits for transaction commit, rejects aborted writes and closes its database', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const add = IDBObjectStore.prototype.add;
    let localID = '';
    IDBObjectStore.prototype.add = function (entry, key) {
      localID = entry.localID;
      const request = add.call(this, entry, key);
      // Even a successful write request is not durable until its transaction commits.
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
    let rejected = false;
    try {
      await window.OutboxFiles.saveOutgoingFile('https://api.test', 17, new Blob(['lost']), 'lost.txt');
    } catch {
      rejected = true;
    } finally {
      IDBObjectStore.prototype.add = add;
    }
    const missing = await window.OutboxFiles.loadOutgoingFile('https://api.test', 17, localID);
    const saved = await window.OutboxFiles.saveOutgoingFile('https://api.test', 17, new Blob(['kept']), 'kept.txt');
    const recovered = await window.OutboxFiles.loadOutgoingFile('https://api.test', 17, saved);
    await window.OutboxFiles.deleteOutgoingFile('https://api.test', 17, saved);
    // Every operation, including a failed save, releases its IDB connection.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('tolktak.outbox-files.v1');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Attachment storage leaked an open connection'));
    });
    return { rejected, missing, recovered: await recovered?.blob.text() };
  });
  expect(outcome).toEqual({ rejected: true, missing: null, recovered: 'kept' });
});

test('quota and unavailable storage errors reach the caller and a later save can recover', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const add = IDBObjectStore.prototype.add;
    const open = IDBFactory.prototype.open;
    const errors: string[] = [];
    try {
      IDBObjectStore.prototype.add = function () { throw new DOMException('Disk quota exhausted', 'QuotaExceededError'); };
      try {
        await window.OutboxFiles.saveOutgoingFile('https://api.test', 17, new Blob(['quota']), 'quota.txt');
      } catch (error) { errors.push((error as Error).name); }
      IDBObjectStore.prototype.add = add;
      IDBFactory.prototype.open = function () { throw new DOMException('Storage disabled', 'SecurityError'); };
      try {
        await window.OutboxFiles.loadOutgoingFile('https://api.test', 17, 'missing');
      } catch (error) { errors.push((error as Error).name); }
    } finally {
      IDBObjectStore.prototype.add = add;
      IDBFactory.prototype.open = open;
    }
    const localID = await window.OutboxFiles.saveOutgoingFile('https://api.test', 17, new Blob(['recovered']), 'ok.txt');
    const file = await window.OutboxFiles.loadOutgoingFile('https://api.test', 17, localID);
    await window.OutboxFiles.deleteOutgoingFile('https://api.test', 17, localID);
    return { errors, recovered: await file?.blob.text() };
  });
  expect(errors).toEqual({ errors: ['QuotaExceededError', 'SecurityError'], recovered: 'recovered' });
});
