import { expect, test } from '@playwright/test';
import { signal } from '@preact/signals';
import { Api, ApiError, type ContactState, type ProfilesPage, type User, type UserPage } from '../src/renderer/api';
import { PeopleStore } from '../src/renderer/people';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeApi extends Api {
  directoryCalls: { q: string; after: number; exclude: number[]; signal?: AbortSignal; result: ReturnType<typeof deferred<UserPage>> }[] = [];
  contactsCalls: { after: number; signal?: AbortSignal; result: ReturnType<typeof deferred<UserPage>> }[] = [];
  profilesCalls: { ids: number[]; signal?: AbortSignal; result: ReturnType<typeof deferred<ProfilesPage>> }[] = [];
  profileCalls: { id: number; signal?: AbortSignal; result: ReturnType<typeof deferred<Awaited<ReturnType<Api['profile']>>>> }[] = [];
  setContactCalls: { id: number; contact: boolean; result: ReturnType<typeof deferred<ContactState>> }[] = [];
  constructor() { super('https://people.test'); }
  override directory = (q = '', after = 0, signal?: AbortSignal, exclude: number[] = []) => {
    const result = deferred<UserPage>(); this.directoryCalls.push({ q, after, signal, exclude, result }); return result.promise;
  };
  override contacts = (after = 0, signal?: AbortSignal) => {
    const result = deferred<UserPage>(); this.contactsCalls.push({ after, signal, result }); return result.promise;
  };
  override profiles = (ids: number[], signal?: AbortSignal) => {
    const result = deferred<ProfilesPage>(); this.profilesCalls.push({ ids: [...ids], signal, result }); return result.promise;
  };
  override profile = (id: number, signal?: AbortSignal) => {
    const result = deferred<Awaited<ReturnType<Api['profile']>>>(); this.profileCalls.push({ id, signal, result }); return result.promise;
  };
  override setContact = (id: number, contact: boolean) => {
    const result = deferred<ContactState>(); this.setContactCalls.push({ id, contact, result }); return result.promise;
  };
}
const user = (id: number, patch: Partial<User> = {}): User => ({ id, username: `user${id}`, display_name: `User ${id}`, profile_revision: 1, color: '#555', is_admin: false, avatar: '', about: '', status: '', ...patch });
const ids = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
const page = (users: User[], patch: Partial<UserPage> = {}): UserPage => ({ users, contact_ids: [], contacts_version: 1, has_more: false, next_after: null, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
type Watch = { type: string; user_ids: number[]; request_id: string };
const stores: PeopleStore[] = [];
function setup() {
  const api = new FakeApi();
  const profiles = signal(new Map<number, User>());
  const online = signal(new Set<number>());
  const frames: Watch[] = [];
  const store = new PeopleStore(api, 1, { profiles, online, send: (frame) => frames.push(frame as Watch) });
  stores.push(store);
  return { api, store, profiles, online, frames };
}
test.afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });

test('directory forwards pagination/exclusions and returns canonical profiles after a newer event', async () => {
  const { api, store, profiles } = setup();
  const loading = store.directory('anna', 50, undefined, [8, 9]);
  expect(api.directoryCalls[0]).toMatchObject({ q: 'anna', after: 50, exclude: [8, 9] });
  store.merge([user(2, { profile_revision: 8, display_name: 'Updated over WebSocket' })]);
  api.directoryCalls[0].result.resolve(page([user(2, { profile_revision: 3 })], { contact_ids: [2], contacts_version: 4, has_more: true, next_after: 2 }));
  const result = await loading;
  expect(result.users[0]).toBe(profiles.value.get(2));
  expect(result.users[0].display_name).toBe('Updated over WebSocket');
  expect(result).toMatchObject({ has_more: true, next_after: 2 });
  expect(store.contacts.value.get(2)).toBe(true);
});

test('a later presence event wins over an older HTTP response, but a fresh lookup can update it', async () => {
  const { api, store, profiles, online } = setup();
  const loading = store.profile(2);
  store.presence({ user_id: 2, online: true });
  api.profileCalls[0].result.resolve({ user: user(2, { online: false }), contact: false, contacts_version: 0 });
  expect((await loading).online).toBe(true);
  expect(online.value.has(2)).toBe(true);
  const fresh = store.profile(2);
  api.profileCalls[1].result.resolve({ user: user(2, { online: false }), contact: false, contacts_version: 0 });
  await fresh;
  expect(online.value.has(2)).toBe(false);
  expect(profiles.value.get(2)?.online).toBe(false);
});

test('HTTP response ordering cannot roll profile revision or presence backwards', async () => {
  const { api, store, profiles, online } = setup();
  const first = store.profile(2);
  const second = store.profile(2);
  api.profileCalls[1].result.resolve({ user: user(2, { profile_revision: 9, display_name: 'New', online: false }), contact: true, contacts_version: 2 });
  await second;
  api.profileCalls[0].result.resolve({ user: user(2, { profile_revision: 2, display_name: 'Old', online: true }), contact: false, contacts_version: 1 });
  await first;
  expect(profiles.value.get(2)).toMatchObject({ profile_revision: 9, display_name: 'New', online: false });
  expect(online.value.has(2)).toBe(false);
  expect(store.contacts.value.get(2)).toBe(true);
});

test('presence received before a directory reveals its IDs is preserved over the pending page', async () => {
  const { api, store, online } = setup();
  const loading = store.directory();
  store.presence({ user_id: 2, online: true });
  api.directoryCalls[0].result.resolve(page([user(2, { online: false })]));
  const result = await loading;
  expect(result.users[0].online).toBe(true);
  expect(online.value.has(2)).toBe(true);
});

test('only the current watch snapshot applies and it cannot overwrite subsequent presence events', async () => {
  const { store, profiles, online, frames } = setup();
  store.retain('visible', [2, 3]);
  store.watchNow();
  const first = frames.at(-1)!;
  store.watchNow();
  const second = frames.at(-1)!;
  expect(second.request_id).not.toBe(first.request_id);
  store.snapshot({ users: [user(2)], user_ids: first.user_ids, request_id: first.request_id });
  expect(profiles.value.has(2)).toBe(false);
  store.presence({ user_id: 2, online: true });
  store.snapshot({ users: [user(1), user(2, { online: false }), user(3, { online: true })], user_ids: second.user_ids, request_id: second.request_id });
  expect(profiles.value.get(2)?.online).toBe(true);
  expect(online.value.has(2)).toBe(true);
  expect(online.value.has(3)).toBe(true);
  store.presence({ user_id: 3, online: false });
  store.snapshot({ users: [user(3, { online: true })], user_ids: second.user_ids, request_id: second.request_id });
  expect(online.value.has(3)).toBe(false);
});

test('late partial membership cannot undo contact events; gaps invalidate older partial knowledge', async () => {
  const { api, store } = setup();
  const loading = store.directory();
  store.contact({ user_id: 2, contact: true, contacts_version: 5 });
  api.directoryCalls[0].result.resolve(page([user(2), user(3)], { contacts_version: 4, contact_ids: [] }));
  await loading;
  expect(store.contactsVersion.value).toBe(5);
  expect(store.contacts.value.get(2)).toBe(true);
  expect(store.contacts.value.has(3)).toBe(false);
  store.contact({ user_id: 3, contact: true, contacts_version: 6 });
  expect(store.contacts.value.get(2)).toBe(true);
  store.contact({ user_id: 4, contact: false, contacts_version: 8 });
  expect([...store.contacts.value]).toEqual([[4, false]]);
  expect(store.contactsVersion.value).toBe(8);
  const sameVersion = store.contactsPage(20);
  api.contactsCalls[0].result.resolve(page([user(2)], { contacts_version: 8, contact_ids: [2] }));
  await sameVersion;
  expect([...store.contacts.value]).toEqual([[4, false], [2, true]]);
  expect(api.contactsCalls[0].after).toBe(20);
});

test('a late setContact receipt cannot revert a newer change from another tab', async () => {
  const { api, store } = setup();
  const setting = store.setContact(2, true);
  store.contact({ user_id: 2, contact: false, contacts_version: 4 });
  api.setContactCalls[0].result.resolve({ user_id: 2, contact: true, contacts_version: 3 });
  expect(await setting).toMatchObject({ contact: false, contacts_version: 4 });
  expect(store.contacts.value.get(2)).toBe(false);
});

test('ensure coalesces overlapping requests, uses batches of at most 100 and deduplicates cached IDs', async () => {
  const { api, store, profiles } = setup();
  const first = store.ensure(ids(2, 152));
  const second = store.ensure(ids(100, 251));
  await tick();
  expect(api.profilesCalls).toHaveLength(2);
  expect(api.profilesCalls.every((call) => call.ids.length <= 100)).toBe(true);
  api.profilesCalls[0].result.resolve(page(api.profilesCalls[0].ids.map((id) => user(id))));
  await expect.poll(() => api.profilesCalls.length, { timeout: 1000 }).toBe(3);
  api.profilesCalls[1].result.resolve(page(api.profilesCalls[1].ids.map((id) => user(id))));
  api.profilesCalls[2].result.resolve(page(api.profilesCalls[2].ids.map((id) => user(id))));
  await Promise.all([first, second]);
  const requested = api.profilesCalls.flatMap((call) => call.ids);
  expect(requested).toHaveLength(250);
  expect(new Set(requested).size).toBe(250);
  expect(profiles.value.size).toBe(250);
  await store.ensure(ids(2, 251));
  await tick();
  expect(api.profilesCalls).toHaveLength(3);
  const forced = store.ensure([2, 3], true);
  await tick();
  expect(api.profilesCalls[3].ids).toEqual([2, 3]);
  api.profilesCalls[3].result.resolve(page([user(2, { profile_revision: 2 }), user(3)]));
  await forced;
  expect(profiles.value.get(2)?.profile_revision).toBe(2);
});

test('failed ensure rejects without automatic retry; missing IDs also need an explicit retry', async () => {
  const { api, store } = setup();
  const first = store.ensure([2]);
  const failed = expect(first).rejects.toThrow('Offline');
  await tick(); api.profilesCalls[0].result.reject(new Error('Offline')); await failed;
  await tick(); expect(api.profilesCalls).toHaveLength(1);
  const missing = store.ensure([2]);
  const unavailable = expect(missing).rejects.toThrow('unavailable');
  await tick(); api.profilesCalls[1].result.resolve(page([])); await unavailable;
  await tick(); expect(api.profilesCalls).toHaveLength(2);
  const retry = store.ensure([2]);
  await tick(); api.profilesCalls[2].result.resolve(page([user(2)])); await retry;
});

test('dispose aborts all reads and rejects queued work while late responses cannot mutate shared signals', async () => {
  const { api, store, profiles, online, frames } = setup();
  const operations = [store.directory(), store.contactsPage(), store.profile(2), store.ensure([3]), store.setContact(4, true)];
  const settled = operations.map((operation) => operation.then(() => 'resolved', (error: Error) => error.name));
  await tick();
  store.dispose();
  expect([api.directoryCalls[0].signal, api.contactsCalls[0].signal, api.profileCalls[0].signal, api.profilesCalls[0].signal].every((signal) => signal?.aborted)).toBe(true);
  expect(await Promise.all(settled)).toEqual(Array(5).fill('AbortError'));
  api.directoryCalls[0].result.resolve(page([user(5)]));
  api.contactsCalls[0].result.resolve(page([user(6)]));
  api.profileCalls[0].result.resolve({ user: user(2), contact: true, contacts_version: 9 });
  api.profilesCalls[0].result.resolve(page([user(3)]));
  api.setContactCalls[0].result.resolve({ user_id: 4, contact: true, contacts_version: 10 });
  await tick();
  expect(profiles.value.size).toBe(0);
  expect(online.value.size).toBe(0);
  expect(store.contacts.value.size).toBe(0);
  expect(frames).toHaveLength(0);
});

test('caller abort cancels a lookup without poisoning later requests in the same store', async () => {
  const { api, store, profiles } = setup();
  const controller = new AbortController();
  const loading = store.directory('old', 0, controller.signal);
  const cancelled = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await cancelled;
  expect(api.directoryCalls[0].signal?.aborted).toBe(true);
  api.directoryCalls[0].result.resolve(page([user(2)]));
  await tick(); expect(profiles.value.has(2)).toBe(false);
  const retry = store.directory('new');
  api.directoryCalls[1].result.resolve(page([user(3)])); await retry;
  expect(profiles.value.has(3)).toBe(true);
});

test('dispose before the coalescing delay cancels queued ensure and watch work without issuing requests', async () => {
  const { api, store, frames } = setup();
  const loading = store.ensure([2, 3]);
  const cancelled = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  store.retain('temporary', [2, 3]);
  store.dispose();
  await cancelled; await tick();
  expect(api.profilesCalls).toHaveLength(0);
  expect(frames).toHaveLength(0);
});

test('watch lists include self plus only the 499 most recently retained peers, and reconnect resends', async () => {
  const { api, store, frames } = setup();
  store.merge(ids(2, 901).map((id) => user(id)));
  store.retain('older window', ids(2, 401));
  store.retain('recent window', ids(402, 901));
  store.watchNow();
  expect(frames[0].user_ids).toEqual([1, ...ids(402, 900)]);
  expect(api.profilesCalls).toHaveLength(0);
  store.release('recent window'); await tick();
  expect(frames.at(-1)!.user_ids).toEqual([1, ...ids(2, 401)]);
  store.release('older window'); await tick();
  expect(frames.at(-1)!.user_ids).toEqual([1]);
  const oldNonce = frames.at(-1)!.request_id;
  store.watchNow(); expect(frames.at(-1)!.request_id).not.toBe(oldNonce);
});

test('cold profile and membership caches are bounded while all actively pinned profiles survive', async () => {
  const { store, profiles, online } = setup();
  store.retain('visible', [2]);
  store.merge(ids(2, 2301).map((id) => user(id)));
  expect(profiles.value.size).toBeLessThanOrEqual(2000);
  expect(profiles.value.has(2)).toBe(true);
  expect(profiles.value.has(3)).toBe(false);
  expect(profiles.value.has(2301)).toBe(true);
  for (const id of ids(5000, 7200)) store.contact({ user_id: id, contact: true, contacts_version: id });
  expect(store.contacts.value.size).toBeLessThanOrEqual(2000);
  for (const id of ids(8000, 10_050)) store.presence({ user_id: id, online: true });
  expect(online.value.has(10_050)).toBe(true);
  expect(online.value.size).toBeLessThanOrEqual(2000);
  const active = ids(10_000, 12_099);
  store.retain('large active group', active);
  store.merge(active.map((id) => user(id)));
  expect(active.every((id) => profiles.value.has(id))).toBe(true);
  await store.ensure(active); // Keeping pins above budget must not trigger an endless refill loop.
  store.release('large active group');
  expect(profiles.value.size).toBeLessThanOrEqual(2000);
  expect(profiles.value.has(2)).toBe(true);
});


test('mutual relation snapshots and summary counters reject late responses after a newer request event', async () => {
  const api = new FakeApi();
  const summary = deferred<{ contacts_version: number; incoming_count: number }>();
  api.contactsSummary = () => summary.promise;
  const store = new PeopleStore(api, 1, { profiles: signal(new Map()), online: signal(new Set()), send() {} }, true);
  stores.push(store);
  const oldSummary = store.summary();
  const loading = store.directory('peer');
  store.contact({ user_id: 2, contact: false, relation: { state: 'incoming', request_id: 'new', since: 10 }, contacts_version: 8, incoming_count: 1 });
  api.directoryCalls[0].result.resolve(page([user(2)], { contacts_version: 7, incoming_count: 0, relations: {} }));
  summary.resolve({ contacts_version: 6, incoming_count: 0 });
  await Promise.all([oldSummary, loading]);
  expect(store.incomingCount.value).toBe(1);
  expect(store.relations.value.get(2)).toEqual({ state: 'incoming', request_id: 'new', since: 10 });
  const revision = store.contactEvents.value;
  store.contact({ user_id: 2, contact: false, relation: { state: 'incoming', request_id: 'new', since: 10 }, contacts_version: 8, incoming_count: 1 });
  expect(store.contactEvents.value).toBe(revision);
});

test('a stale button uses the identity it displayed, never a replacement request, and refreshes on conflict', async () => {
  const api = new FakeApi();
  const called: (string | null | undefined)[] = [];
  api.contactAction = async (_id, _action, identity) => { called.push(identity); throw new ApiError(409, 'contact_state', 'changed'); };
  const store = new PeopleStore(api, 1, { profiles: signal(new Map([[2, user(2)]])), online: signal(new Set()), send() {} }, true);
  stores.push(store);
  store.contact({ user_id: 2, contact: false, relation: { state: 'incoming', request_id: 'replacement', since: 20 }, contacts_version: 2, incoming_count: 1 });
  const acting = store.act(2, 'decline', 'displayed-old');
  const rejected = expect(acting).rejects.toMatchObject({ status: 409 });
  await tick();
  api.profileCalls[0].result.resolve({ user: user(2), contact: false, contacts_version: 2, relation: { state: 'incoming', request_id: 'replacement', since: 20 }, incoming_count: 1 });
  await rejected;
  expect(called).toEqual(['displayed-old']);
  expect(store.relations.value.get(2)?.request_id).toBe('replacement');
});
