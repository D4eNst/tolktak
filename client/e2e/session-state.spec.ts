import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type State = typeof import('../src/renderer/state');
type ApiClass = typeof import('../src/renderer/api').Api;
type AuditState = State & { PeopleStore: typeof import('../src/renderer/people').PeopleStore; HistoryStore: typeof import('../src/renderer/history').HistoryStore; Api: ApiClass; ApiError: typeof import('../src/renderer/api').ApiError; refreshReadSoon(cid: number): void; verifyHistoryVersion(api: InstanceType<ApiClass>, cid: number, version: number): Promise<boolean>; resync(): Promise<void>; resetSession(): void };
const dir = path.join(__dirname, '../src/renderer');
const bundle = buildSync({ stdin: { contents: readFileSync(path.join(dir, 'state.ts'), 'utf8') + '\nexport { Api, ApiError, resync, resetSession, refreshReadSoon, verifyHistoryVersion, PeopleStore, HistoryStore };', resolveDir: dir, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const user = (id: number, revision = 8) => ({ id, username: `user${id}`, display_name: `Profile ${revision}`, profile_revision: revision, color: '#555', is_admin: false, avatar: '', about: '', status: '' });
const server = { name: 'Test', version: '1.0.0', registration: 'open', livekit_url: '', client_download_url: '', min_client: '', capabilities: { users: 1, changes: 1 } };
const message = (id: number) => ({ id, revision: id, channel_id: 1, author_id: 2, nonce: `message${id}`, text: `Message ${id}`, created_at: 1, edited_at: null, deleted: false, reply_to: null, attachments: [], reactions: [], pinned_at: null });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let state: AuditState;
let globals: Map<string, PropertyDescriptor | undefined>;
let head: number;
let staleChannels: boolean;
let changesResponse: ReturnType<typeof deferred<unknown>> | undefined;
let requests: { path: string; api: InstanceType<ApiClass> }[];

test.beforeEach(() => {
  globals = new Map(['window', 'document', 'location', 'localStorage', 'WebSocket', 'navigator'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
    document: Object.assign(new EventTarget(), { hidden: false, hasFocus: () => false, documentElement: {} }),
    location: { protocol: 'https:', origin: 'https://session-state.test' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    WebSocket: class { static OPEN = 1; readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; close() {} send() {} },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU', userAgent: 'Node session audit' }, configurable: true });
  const module = { exports: {} };
  new Function('module', 'exports', bundle)(module, module.exports);
  state = module.exports as AuditState;
  head = 10; staleChannels = false; changesResponse = undefined; requests = [];
  state.Api.prototype.req = async function <T>(_method: string, pathname: string): Promise<T> {
    requests.push({ path: pathname, api: this });
    const url = new URL(pathname, 'https://session-state.test');
    const channel = { id: 1, kind: 'dm' as const, peer_id: 2, last_message: message(head), history_version: head, last_read_id: head === 10 ? 10 : 1, unread: 0 };
    let result: unknown;
    if (url.pathname === '/me') result = { user: user(1, 1) };
    else if (url.pathname === '/server') result = server;
    else if (url.pathname === '/channels') result = { channels: [{ ...channel, ...(staleChannels ? { history_version: 2, last_read_id: 1 } : {}) }] };
    else if (url.pathname === '/groups') result = { groups: [] };
    else if (url.pathname === '/users/profiles') result = { users: [user(2, 1)], contact_ids: [], contacts_version: 1 };
    else if (url.pathname === '/channels/1/read') result = { channel_id: 1, message_id: channel.last_read_id, history_version: head, unread: 0 };
    else if (url.pathname === '/channels/1/changes') {
      if (changesResponse) return changesResponse.promise as Promise<T>;
      if (Number(url.searchParams.get('since')) > head) throw new state.ApiError(409, 'conflict', 'Restored database');
      result = { messages: [], users: [], history_version: head, complete: true, read: { message_id: channel.last_read_id, unread: 0 } };
    } else if (url.pathname === '/channels/1/history') result = { messages: [message(head)], users: [], first_id: head, last_id: head, has_before: false, has_after: false, history_version: head, read: { message_id: channel.last_read_id, unread: 0 } };
    else throw new Error('Unexpected audit request ' + pathname);
    return result as T;
  };
  const api = new state.Api('https://session-state.test', 'original-token');
  state.session.value = { api, me: user(1), server };
  state.channels.value = new Map([[1, { id: 1, kind: 'dm', peer_id: 2, last_message: message(10), history_version: 10, last_read_id: 10, unread: 0 }]]);
  state.users.value = new Map([[1, user(1)], [2, user(2)]]);
  // Reuse the actual per-session stores that startSession creates, without opening a socket.
  state.people.value = new state.PeopleStore(api, 1, { profiles: state.users, online: state.online, send() {} });
  state.people.value!.contact({ user_id: 2, contact: true, contacts_version: 8 });
  state.history.value = new state.HistoryStore(api, { users: state.mergeUsers, read: state.applyReadState });
});
test.afterEach(() => {
  state?.resetSession();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function closeHistory() {
  const view = state.history.value!.createView(1);
  await view.open({ last_read_id: 10, unread: 0 });
  view.dispose();
  expect(state.history.value!.views.size).toBe(0);
}

test('closed history views still detect database rollback and reset channel/profile/contact revisions', async () => {
  await closeHistory();
  const old = state.session.value!.api;
  head = 2;
  await state.resync();
  expect(state.session.value!.api).not.toBe(old);
  expect(state.session.value!.api.token).toBe('original-token');
  expect(state.channels.value.get(1)).toMatchObject({ history_version: 2, last_read_id: 1 });
  expect(state.session.value!.me.profile_revision).toBe(1);
  expect(state.users.value.get(2)?.profile_revision).toBe(1);
  expect(state.people.value!.contactsVersion.value).toBe(1);
  expect(state.people.value!.contacts.value.get(2)).toBe(false);
  expect(requests.filter((request) => request.path.includes('/changes?')).map((request) => new URL(request.path, 'https://test').searchParams.get('since'))).toEqual(['10']);
});

test('one stale HTTP snapshot with a valid changes cursor preserves the active session', async () => {
  await closeHistory();
  const old = state.session.value!.api;
  staleChannels = true;
  await state.resync();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(state.session.value!.api).toBe(old);
  expect(state.channels.value.get(1)).toMatchObject({ history_version: 10, last_read_id: 10 });
  expect(requests.some((request) => request.path === '/me')).toBe(false);
  expect(requests.filter((request) => request.path.includes('/changes?'))).toHaveLength(1);
});

test('a lower read snapshot verifies rollback once instead of polling every 200 ms', async () => {
  const old = state.session.value!.api;
  head = 2;
  state.refreshReadSoon(1);
  await expect.poll(() => state.session.value!.api !== old).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(state.channels.value.get(1)).toMatchObject({ history_version: 2, last_read_id: 1 });
  expect(requests.filter((request) => request.path === '/channels/1/read')).toHaveLength(1);
});

test('late rollback verification from an old session cannot reset or clear the next account', async () => {
  const old = state.session.value!.api;
  changesResponse = deferred();
  const verification = state.verifyHistoryVersion(old, 1, 2);
  const next = new state.Api('https://session-state.test', 'next-account');
  state.session.value = { ...state.session.value!, api: next, me: user(3) };
  state.channels.value = new Map([[1, { ...state.channels.value.get(1)!, history_version: 20, last_read_id: 20 }]]);
  state.setDraft(1, 'Next account draft');
  changesResponse.reject(new state.ApiError(409, 'conflict', 'Old response'));
  expect(await verification).toBe(false);
  expect(state.session.value!.api).toBe(next);
  expect(state.session.value!.me.id).toBe(3);
  expect(state.channels.value.get(1)).toMatchObject({ history_version: 20, last_read_id: 20 });
  expect(state.drafts.value.get(1)).toBe('Next account draft');
});
