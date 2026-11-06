import { expect, test } from '@playwright/test';
import { Api, ApiError, type HistoryPage, type HistoryQuery, type Message, type MessageChanges, type ReadState } from '../src/renderer/api';
import { HistoryStore } from '../src/renderer/history';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeApi extends Api {
  historyCalls: { cid: number; query: HistoryQuery; signal?: AbortSignal; result: ReturnType<typeof deferred<HistoryPage>> }[] = [];
  changeCalls: { cid: number; since: number; signal?: AbortSignal; result: ReturnType<typeof deferred<MessageChanges>> }[] = [];
  constructor() { super('https://history.test'); }
  override history = (cid: number, query: HistoryQuery = {}, signal?: AbortSignal) => {
    const result = deferred<HistoryPage>();
    this.historyCalls.push({ cid, query: { ...query }, signal, result });
    // Deliberately ignore abort: a real transport can already have delivered its response.
    return result.promise;
  };
  override changes = (cid: number, since: number, signal?: AbortSignal) => {
    const result = deferred<MessageChanges>();
    this.changeCalls.push({ cid, since, signal, result });
    return result.promise;
  };
}

const message = (id: number, patch: Partial<Message> = {}): Message => ({
  id, revision: 1, channel_id: 1, author_id: 7, nonce: `message-${id}`, text: `Message ${id}`, created_at: id,
  edited_at: null, deleted: false, reply_to: null, attachments: [], reactions: [], pinned_at: null, ...patch,
});
const range = (first: number, last: number, cid = 1) => Array.from({ length: last - first + 1 }, (_, i) => message(first + i, { channel_id: cid }));
const page = (messages: Message[], patch: Partial<HistoryPage> = {}): HistoryPage => ({
  messages, users: [], first_id: messages[0]?.id ?? null, last_id: messages.at(-1)?.id ?? null,
  has_before: false, has_after: false, history_version: 10, read: { message_id: 0, unread: 0 }, ...patch,
});
const changes = (patch: Partial<MessageChanges> = {}): MessageChanges => ({
  messages: [], users: [], history_version: 10, complete: true, read: { message_id: 0, unread: 0 }, ...patch,
});
const stores: HistoryStore[] = [];
function setup() {
  const api = new FakeApi();
  const reads: ReadState[] = [];
  const store = new HistoryStore(api, { users() {}, read: (state) => reads.push(state) });
  stores.push(store);
  return { api, store, reads };
}
test.afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });

test('unread opens after read zero; independent views can browse the same channel', async () => {
  const { api, store } = setup();
  const unread = store.createView(1);
  const tail = store.createView(1);
  const first = unread.open({ last_read_id: 0, unread: 4 });
  expect(api.historyCalls[0].query).toEqual({ after: 0, limit: 100 });
  api.historyCalls[0].result.resolve(page(range(1, 4), { has_after: true }));
  expect(await first).toBe(true);
  const second = tail.open({ last_read_id: 4, unread: 0 });
  expect(api.historyCalls[1].query).toEqual({ limit: 100 });
  api.historyCalls[1].result.resolve(page(range(90, 100), { has_before: true }));
  await second;
  const jump = unread.jump(40);
  expect(api.historyCalls[2].query).toEqual({ around: 40, limit: 100 });
  api.historyCalls[2].result.resolve(page(range(35, 45), { has_before: true, has_after: true }));
  await jump;
  expect(unread.items.map((m) => m.id)).toEqual(range(35, 45).map((m) => m.id));
  expect(tail.items.map((m) => m.id)).toEqual(range(90, 100).map((m) => m.id));
  expect(tail.state.value.position.kind).toBe('latest');
});

test('jump cancels older work and late initial/edge responses cannot replace the destination', async () => {
  const { api, store, reads } = setup();
  const view = store.createView(1);
  const initial = view.latest();
  const jump = view.jump(50);
  expect(api.historyCalls[0].signal?.aborted).toBe(true);
  api.historyCalls[1].result.resolve(page(range(45, 55), { has_before: true, has_after: true }));
  await jump;
  api.historyCalls[0].result.resolve(page(range(90, 100)));
  expect(await initial).toBe(false);
  const older = view.older();
  const latest = view.latest();
  expect(api.historyCalls[2].signal?.aborted).toBe(true);
  api.historyCalls[3].result.resolve(page(range(90, 100)));
  await latest;
  api.historyCalls[2].result.resolve(page(range(1, 44)));
  await older;
  expect(view.items.map((m) => m.id)).toEqual(range(90, 100).map((m) => m.id));
  expect(reads).toHaveLength(2);
  const pending = view.jump(200);
  const beforeDispose = reads.length;
  view.dispose();
  expect(api.historyCalls[4].signal?.aborted).toBe(true);
  api.historyCalls[4].result.resolve(page(range(195, 205)));
  expect(await pending).toBe(false);
  expect(store.message(1, 200)).toBeUndefined();
  expect(reads).toHaveLength(beforeDispose);
});

test('a stale snapshot cannot undo an edit or restore a deleted reply preview', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const loading = view.latest();
  store.receive(message(10, { revision: 11, text: 'Edited while loading', reply_to: 5 }));
  store.receive(message(5, { revision: 12, deleted: true, text: '' }));
  const staleReply = { id: 5, author_id: 7, text: 'Old secret', deleted: false, attachments: 1, revision: 2 };
  api.historyCalls[0].result.resolve(page([
    message(5, { revision: 2, text: 'Old secret' }),
    message(10, { revision: 3, text: 'Before edit', reply_to: 5, reply: staleReply }),
  ]));
  await loading;
  expect(view.items.map((m) => m.id)).toEqual([10]);
  expect(view.items[0]).toMatchObject({ text: 'Edited while loading', revision: 11, reply: { id: 5, text: '', deleted: true, attachments: 0, revision: 12 } });
  store.retain('search', 1, [message(10, { revision: 13, text: 'Even newer', reply_to: 5, reply: staleReply })]);
  expect(store.collection('search')[0]).toMatchObject({ text: 'Even newer', reply: { deleted: true, text: '', revision: 12 } });
});

test('overlapping older/newer pages stay sorted, unique and preserve the opposite edge', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.open({ last_read_id: 99, unread: 5 });
  api.historyCalls[0].result.resolve(page(range(100, 102), { has_before: true, has_after: true }));
  await opening;
  const older = view.older();
  expect(api.historyCalls[1].query).toEqual({ before: 100, limit: 100 });
  api.historyCalls[1].result.resolve(page(range(98, 100), { has_after: true }));
  await older;
  expect(view.state.value.hasAfter).toBe(true);
  const newer = view.newer();
  expect(api.historyCalls[2].query).toEqual({ after: 102, limit: 100 });
  api.historyCalls[2].result.resolve(page(range(102, 104), { has_before: true }));
  await newer;
  expect(view.items.map((m) => m.id)).toEqual([98, 99, 100, 101, 102, 103, 104]);
  expect(view.state.value.hasBefore).toBe(false);
  expect(view.state.value.hasAfter).toBe(false);
});

test('reaching the tail includes events received after the page snapshot', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.open({ last_read_id: 0, unread: 3 });
  api.historyCalls[0].result.resolve(page(range(1, 2), { has_after: true }));
  await opening;
  const newer = view.newer();
  store.receive(message(4, { revision: 11 }));
  api.historyCalls[1].result.resolve(page([message(3)]));
  await newer;
  store.receive(message(5, { revision: 12 }));
  expect(view.items.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  expect(view.edgeID).toBe(5);
  expect(view.state.value.hasAfter).toBe(false);
});

test('an empty newer page keeps live tail events but not deleted or older edited messages', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.open({ last_read_id: 1, unread: 2 });
  api.historyCalls[0].result.resolve(page(range(2, 3), { has_before: true, has_after: true }));
  await opening;
  const newer = view.newer();
  store.receive(message(1, { revision: 11, edited_at: 1 }));
  store.receive(message(4, { revision: 12 }));
  store.receive(message(4, { revision: 13, deleted: true }));
  store.receive(message(5, { revision: 14 }));
  api.historyCalls[1].result.resolve(page([]));
  await newer;
  expect(view.items.map((m) => m.id)).toEqual([2, 3, 5]);
  expect(view.edgeID).toBe(5);
  expect(view.state.value.hasBefore).toBe(true);
});

test('an older concurrent snapshot reloads once without showing a manual error', async () => {
  const { api, store } = setup();
  const earlier = store.createView(1), later = store.createView(1);
  const oldLoad = earlier.latest(), newLoad = later.latest();
  api.historyCalls[1].result.resolve(page(range(1, 2), { history_version: 11 }));
  await newLoad;
  api.historyCalls[0].result.resolve(page([message(1)]));
  await expect.poll(() => api.historyCalls.length).toBe(3);
  expect(earlier.state.value.error).toBeNull();
  api.historyCalls[2].result.resolve(page(range(1, 2), { history_version: 11 }));
  expect(await oldLoad).toBe(true);
  expect(earlier.items.map((m) => m.id)).toEqual([1, 2]);
});

test('stale snapshot retries stay bounded and cancel when a new navigation starts', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest();
  api.historyCalls[0].result.resolve(page([message(10)], { history_version: 20, has_before: true }));
  await opening;
  const older = view.older();
  api.historyCalls[1].result.resolve(page([message(5)], { history_version: 19 }));
  await expect.poll(() => api.historyCalls.length).toBe(3);
  api.historyCalls[2].result.resolve(page([message(5)], { history_version: 19 }));
  await older;
  expect(view.state.value.olderError).toBeTruthy();
  expect(api.historyCalls).toHaveLength(3);
  const retry = view.older();
  api.historyCalls[3].result.resolve(page([message(5)], { history_version: 19 }));
  await expect.poll(() => api.historyCalls.length).toBe(5);
  const latest = view.latest();
  expect(api.historyCalls[4].signal?.aborted).toBe(true);
  api.historyCalls[5].result.resolve(page([message(10)], { history_version: 20 }));
  await latest;
  api.historyCalls[4].result.resolve(page([message(5)], { history_version: 20 }));
  await retry;
  expect(view.items.map((m) => m.id)).toEqual([10]);
  expect(view.state.value.olderError).toBeNull();
});

test('a restored server requests one session reset and ignores old in-flight windows', async () => {
  const api = new FakeApi();
  const recovery = deferred<void>();
  let resets = 0;
  const store = new HistoryStore(api, { users() {}, read() {}, reset: async () => { resets++; await recovery.promise; store.dispose(); } });
  stores.push(store);
  const first = store.createView(1), second = store.createView(2);
  for (const view of [first, second]) {
    const opening = view.latest();
    api.historyCalls.at(-1)!.result.resolve(page([message(10, { channel_id: view.channelId })], { history_version: 20 }));
    await opening;
  }
  const pending = first.jump(5);
  const one = store.sync(1), two = store.sync(2);
  for (const call of api.changeCalls) call.result.reject(new ApiError(409, 'conflict', 'Restored database'));
  await expect.poll(() => resets).toBe(1);
  recovery.resolve();
  await Promise.all([one, two]);
  api.historyCalls.at(-1)!.result.resolve(page([message(5)], { history_version: 20 }));
  expect(await pending).toBe(false);
  expect(store.views.size).toBe(0);
});

test('failed session recovery remains visible and can be retried', async () => {
  const api = new FakeApi();
  let resets = 0;
  const store = new HistoryStore(api, { users() {}, read() {}, reset: async () => {
    if (++resets === 1) throw new Error('Connection unavailable');
    store.dispose();
  } });
  stores.push(store);
  const view = store.createView(1);
  const opening = view.latest();
  api.historyCalls[0].result.resolve(page([message(10)], { history_version: 20 }));
  await opening;
  const sync = store.sync(1);
  api.changeCalls[0].result.reject(new ApiError(409, 'conflict', 'Restored database'));
  await expect(sync).rejects.toThrow('Connection unavailable');
  expect(view.state.value.error).toBeTruthy();
  const retry = view.retry();
  api.changeCalls[1].result.reject(new ApiError(409, 'conflict', 'Restored database'));
  expect(await retry).toBe(true);
  expect(resets).toBe(2);
});

test('editing a message older than a tail window does not insert it into that window', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest();
  api.historyCalls[0].result.resolve(page(range(100, 102), { has_before: true }));
  await opening;
  store.receive(message(1, { revision: 11, text: 'An old message was edited' }));
  expect(view.items.map((m) => m.id)).toEqual([100, 101, 102]);
  store.receive(message(101, { revision: 12, text: 'Visible edit' }));
  store.receive(message(103, { revision: 13, text: 'New tail message' }));
  expect(view.items.map((m) => m.id)).toEqual([100, 101, 102, 103]);
  expect(view.items.find((m) => m.id === 101)?.text).toBe('Visible edit');
});

test('live tail is capped at 300 while retaining the newest message', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest();
  api.historyCalls[0].result.resolve(page(range(1, 100), { history_version: 100 }));
  await opening;
  for (let id = 101; id <= 450; id++) store.receive(message(id, { revision: id }));
  expect(view.items).toHaveLength(300);
  expect(view.items[0].id).toBe(151);
  expect(view.items.at(-1)?.id).toBe(450);
  expect(view.state.value.hasBefore).toBe(true);
});

test('independent channel windows share a bounded global message budget', async () => {
  const { api, store } = setup();
  const views = [];
  for (let cid = 1; cid <= 10; cid++) {
    const view = store.createView(cid);
    views.push(view);
    const opening = view.latest();
    api.historyCalls.at(-1)!.result.resolve(page(range(301, 400, cid), { has_before: true }));
    await opening;
    for (let end = 300; end >= 100; end -= 100) {
      const loading = view.older();
      api.historyCalls.at(-1)!.result.resolve(page(range(end - 99, end, cid), { has_before: end > 100 }));
      await loading;
    }
  }
  expect(views.every((view) => view.items.length > 0 && view.items.length <= 300)).toBe(true);
  let retained = 0;
  for (let cid = 1; cid <= 10; cid++) for (let id = 1; id <= 400; id++) if (store.message(cid, id)) retained++;
  expect(retained).toBeLessThanOrEqual(2400);
  for (const view of views) expect(view.items.map((m) => m.id)).toEqual(view.state.value.ids);
});

test('thirty-two windows can page both ways below the page-size budget and release their data', async () => {
  const { api, store } = setup();
  const views = [];
  for (let cid = 1; cid <= 32; cid++) {
    const view = store.createView(cid);
    views.push(view);
    const opening = view.latest();
    api.historyCalls.at(-1)!.result.resolve(page(range(301, 400, cid), { has_before: true }));
    await opening;
  }
  const view = views[0];
  view.following = false;
  const previousFirst = view.state.value.ids[0];
  view.anchor = { id: previousFirst, offset: 0 };
  const older = view.older();
  const boundary = api.historyCalls.at(-1)!.query.before!;
  api.historyCalls.at(-1)!.result.resolve(page(range(boundary - 100, boundary - 1), { has_before: true, has_after: true }));
  await older;
  expect(view.state.value.ids[0]).toBeLessThan(previousFirst);
  const previousLast = view.state.value.ids.at(-1)!;
  view.anchor = { id: previousLast, offset: 0 };
  const newer = view.newer();
  const after = api.historyCalls.at(-1)!.query.after!;
  api.historyCalls.at(-1)!.result.resolve(page(range(after + 1, after + 100), { has_before: true, has_after: true }));
  await newer;
  expect(view.state.value.ids.at(-1)!).toBeGreaterThan(previousLast);
  expect(views.reduce((total, item) => total + item.items.length, 0)).toBeLessThanOrEqual(2400);
  for (const item of views) item.dispose();
  expect(store.views.size).toBe(0);
  for (let cid = 1; cid <= 32; cid++) expect(store.message(cid, 400)).toBeUndefined();
});

test('incomplete changes reload every active window before accepting the new interval', async () => {
  const { api, store } = setup();
  const tail = store.createView(1);
  const old = store.createView(1);
  const latest = tail.latest(); api.historyCalls[0].result.resolve(page(range(90, 100))); await latest;
  const jump = old.jump(40); api.historyCalls[1].result.resolve(page(range(35, 45), { has_before: true, has_after: true })); await jump;
  old.anchor = { id: 40, offset: 19 };
  const syncing = store.sync(1);
  api.changeCalls[0].result.resolve(changes({ complete: false, history_version: 20 }));
  await expect.poll(() => api.historyCalls.length, { timeout: 1000 }).toBe(4);
  expect(api.historyCalls.slice(2).map((call) => call.query)).toEqual([{ limit: 100 }, { around: 40, limit: 100 }]);
  api.historyCalls[2].result.resolve(page(range(95, 105), { history_version: 20 }));
  api.historyCalls[3].result.resolve(page(range(38, 48), { history_version: 20, has_before: true, has_after: true }));
  await syncing;
  expect(tail.items.at(-1)?.id).toBe(105);
  expect(old.items[0].id).toBe(38);
  expect(old.state.value.position).toMatchObject({ kind: 'anchor', id: 40, offset: 19 });
  const next = store.sync(1);
  expect(api.changeCalls[1].since).toBe(20);
  api.changeCalls[1].result.resolve(changes({ history_version: 20 })); await next;
});

test('failed reload after incomplete changes cannot claim the lost interval as synced', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest(); api.historyCalls[0].result.resolve(page(range(90, 100))); await opening;
  const syncing = store.sync(1);
  api.changeCalls[0].result.resolve(changes({ complete: false, history_version: 20 }));
  await expect.poll(() => api.historyCalls.length, { timeout: 1000 }).toBe(2);
  api.historyCalls[1].result.reject(new Error('Offline during required reload'));
  await syncing.catch(() => {});
  expect(view.state.value.error).toBeTruthy();
  const retry = store.sync(1);
  expect(api.changeCalls[1].since).toBeLessThanOrEqual(10);
  api.changeCalls[1].result.resolve(changes({ complete: false, history_version: 20 }));
  await expect.poll(() => api.historyCalls.length, { timeout: 1000 }).toBe(3);
  api.historyCalls[2].result.resolve(page(range(90, 105), { history_version: 20 })); await retry;
});

test('websocket revision gaps stay unsynced until every missing revision is accounted for', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest(); api.historyCalls[0].result.resolve(page([message(100)])); await opening;
  store.receive(message(102, { revision: 12 }));
  store.receive(message(101, { revision: 11 }));
  store.receive(message(104, { revision: 14 }));
  const syncing = store.sync(1);
  expect(api.changeCalls[0].since).toBe(12);
  api.changeCalls[0].result.resolve(changes({ history_version: 14, messages: [message(103, { revision: 13 }), message(104, { revision: 14 })] }));
  await syncing;
  const again = store.sync(1);
  expect(api.changeCalls[1].since).toBe(14);
  api.changeCalls[1].result.resolve(changes({ history_version: 14 })); await again;
  expect(view.items.map((m) => m.id)).toEqual([100, 101, 102, 103, 104]);
});

test('an initial load failure can retry the original unread query', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.open({ last_read_id: 0, unread: 1 });
  api.historyCalls[0].result.reject(new Error('Temporary outage'));
  expect(await opening).toBe(false);
  expect(view.state.value.loading).toBe(false);
  expect(view.state.value.loaded).toBe(false);
  expect(view.state.value.error).toBeTruthy();
  const retry = view.retry();
  expect(api.historyCalls[1].query).toEqual({ after: 0, limit: 100 });
  api.historyCalls[1].result.resolve(page([message(1)]));
  expect(await retry).toBe(true);
  expect(view.state.value.error).toBeNull();
  expect(view.items.map((m) => m.id)).toEqual([1]);
  expect(view.state.value.position.kind).toBe('start');
  expect(view.following).toBe(false);
});

test('retrying a failed jump preserves its target instead of positioning at the latest edge', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest(); api.historyCalls[0].result.resolve(page(range(90, 100))); await opening;
  const jumping = view.jump(40);
  api.historyCalls[1].result.reject(new Error('Offline during jump'));
  expect(await jumping).toBe(false);
  const retry = view.retry();
  expect(api.historyCalls[2].query).toEqual({ around: 40, limit: 100 });
  api.historyCalls[2].result.resolve(page(range(35, 45), { has_before: true, has_after: true }));
  expect(await retry).toBe(true);
  expect(view.state.value.position).toMatchObject({ kind: 'target', id: 40 });
  expect(view.following).toBe(false);
});


test('a late event below the retained snapshot cannot resurrect a deleted message', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const loading = view.latest();
  api.historyCalls[0].result.resolve(page([message(20, { revision: 9 })]));
  await loading;
  store.receive(message(15, { revision: 4 }));
  expect(view.items.map((m) => m.id)).toEqual([20]);
  store.receive(message(20, { revision: 11, text: '', deleted: true }));
  for (let n = 0; n < 250; n++) store.receive(message(100 + n, { revision: 12 + n }));
  store.receive(message(20, { revision: 9, text: 'Delayed original' }));
  expect(view.items.some((m) => m.id === 20)).toBe(false);
});

test('initial reconnect preserves the unread query after an initial history failure', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const loading = view.open({ last_read_id: 0, unread: 30 });
  api.historyCalls[0].result.reject(new Error('unavailable'));
  await loading;
  const reconnect = store.sync(1);
  expect(api.historyCalls[1].query).toEqual({ after: 0, limit: 100 });
  api.historyCalls[1].result.resolve(page(range(1, 10), { has_after: true }));
  await reconnect;
  expect(view.state.value.position.kind).toBe('start');
  expect(view.following).toBe(false);
});

test('events arriving before the first snapshot still repair a missing revision', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest();
  store.receive(message(12, { revision: 12 }));
  api.historyCalls[0].result.resolve(page(range(1, 10), { history_version: 10 }));
  await opening;
  await expect.poll(() => api.changeCalls.length).toBe(1);
  expect(api.changeCalls[0].since).toBe(10);
  api.changeCalls[0].result.resolve(changes({ messages: [message(11, { revision: 11 }), message(12, { revision: 12 })], history_version: 12 }));
  await expect.poll(() => view.items.map((m) => m.id)).toEqual(range(1, 12).map((m) => m.id));
});

test('closing the last view releases channel invalidation state', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.latest();
  api.historyCalls[0].result.resolve(page([message(1)]));
  await opening;
  store.receive(message(1, { revision: 11, text: 'Edited' }));
  expect(store.collectionsVersion.value.has(1)).toBe(true);
  view.dispose();
  expect(store.collectionsVersion.value.has(1)).toBe(false);
});

test('an empty tail keeps its boundary after deletions and ignores updates to older messages', async () => {
  const { api, store } = setup();
  const view = store.createView(1);
  const opening = view.open({ last_read_id: 100, unread: 1 });
  api.historyCalls[0].result.resolve(page([], { has_before: true }));
  await opening;
  store.receive(message(80, { revision: 11, edited_at: 1 }));
  expect(view.items).toHaveLength(0);
  store.receive(message(101, { revision: 12 }));
  expect(view.items.map(m => m.id)).toEqual([101]);
  store.receive(message(101, { revision: 13, deleted: true }));
  store.receive(message(90, { revision: 14, edited_at: 1 }));
  expect(view.items).toHaveLength(0);
  const older = view.older();
  expect(api.historyCalls[1].query).toEqual({ around: 101, limit: 100 });
  api.historyCalls[1].result.resolve(page(range(40, 89), { history_version: 14, has_before: true }));
  await older;
  expect(view.items.at(-1)?.id).toBe(89);
});
