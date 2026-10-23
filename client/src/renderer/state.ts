import { batch, computed, signal } from '@preact/signals';
import { Api, ApiError, Channel, FileMeta, Group, Message, normalizeServer, ServerInfo, User, VoiceMember } from './api';
import { bridge } from './bridge';
import { t } from './i18n';
import { Realtime } from './realtime';

export type Pending = { nonce: string; channel_id: number; text: string; created_at: number; status: 'sending' | 'failed'; reply_to?: number; attachments: FileMeta[] };
export type ChannelMessages = { items: Message[]; pending: Pending[]; hasOlder: boolean; loading: boolean; loaded: boolean };
export type View = { kind: 'home'; channelId?: number } | { kind: 'group'; groupId: number; channelId?: number; stage?: boolean };
export type Toast = { id: number; text: string; kind: 'info' | 'error' };
export type IncomingCall = { channelId: number; from: number };

export const session = signal<{ api: Api; me: User; server: ServerInfo } | null>(null);
export const booting = signal(true);
export const connection = signal<'online' | 'connecting' | 'offline'>('connecting');
export const users = signal<Map<number, User>>(new Map());
export const online = signal<Set<number>>(new Set());
export const channels = signal<Map<number, Channel>>(new Map());
export const groups = signal<Map<number, Group>>(new Map());
export const messages = signal<Map<number, ChannelMessages>>(new Map());
export const voiceRooms = signal<Map<string, VoiceMember[]>>(new Map());
export const typing = signal<Map<number, Map<number, number>>>(new Map());
export const view = signal<View>({ kind: 'home' });
export const toasts = signal<Toast[]>([]);
export const incomingCall = signal<IncomingCall | null>(null);
export const switcherOpen = signal(false);
export const settingsOpen = signal<false | SettingsTab>(false);
export type SettingsTab = 'profile' | 'voice' | 'video' | 'keys' | 'watch' | 'app';
export const replyTo = signal<Map<number, Message>>(new Map());
export const drafts = signal<Map<number, string>>(new Map());

export function fileUrl(id: string, name?: string) {
  return session.value?.api.fileUrl(id, name) ?? '';
}
export function avatarUrl(fileId: string) {
  return fileId ? fileUrl(fileId) : '';
}
export function groupRole(g: Group, uid = session.value?.me.id ?? 0): 'owner' | 'mod' | 'member' {
  if (g.owner_id === uid) return 'owner';
  return g.roles?.[String(uid)] === 'mod' ? 'mod' : 'member';
}
export function canModerate(g: Group) {
  return groupRole(g) !== 'member';
}
export function setReply(cid: number, m: Message | null) {
  if (m) setIn(replyTo, cid, m);
  else delIn(replyTo, cid);
}
export function setDraft(cid: number, text: string) {
  if (text) setIn(drafts, cid, text);
  else delIn(drafts, cid);
}
export function messagePreview(m: { text: string; deleted?: boolean; attachments?: FileMeta[] | number }): string {
  const p = t().core.preview;
  if (m.deleted) return p.deleted;
  if (/^\[\[sticker:[\w-]+\]\]$/.test(m.text)) return p.sticker;
  const text = m.text.replace(/[*_~`|>#]+/g, '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  const att = m.attachments;
  const n = typeof att === 'number' ? att : (att?.length ?? 0);
  if (!n) return '';
  if (Array.isArray(att)) {
    const f = att[0];
    if (f.mime.startsWith('image/')) return n > 1 ? p.photos(n) : p.photo;
    if (f.mime.startsWith('audio/')) return f.name.startsWith('voice-') ? p.voiceMessage : p.audio;
    if (f.mime.startsWith('video/')) return p.video;
    return n > 1 ? p.files(n) : f.name;
  }
  return p.attachment;
}

/** Minimised, in the tray or (Windows) fully covered. Chromium only reports the first two. */
export const windowHidden = signal(document.hidden);
let occluded = false;
const updateHidden = () => {
  const v = document.hidden || occluded;
  if (windowHidden.value !== v) windowHidden.value = v;
};
document.addEventListener('visibilitychange', updateHidden);
bridge.onOccluded((v) => {
  occluded = v;
  updateHidden();
  updateActive();
});

export const appActive = signal(document.hasFocus() && !document.hidden);
const updateActive = () => {
  const v = document.hasFocus() && !windowHidden.value;
  if (appActive.value !== v) appActive.value = v;
};
window.addEventListener('focus', updateActive);
window.addEventListener('blur', updateActive);
document.addEventListener('visibilitychange', updateActive);
updateActive();

export const me = computed(() => session.value?.me ?? null);
export const api = () => {
  const s = session.value;
  if (!s) throw new Error('not signed in');
  return s.api;
};

export const totalUnread = computed(() => {
  let n = 0;
  for (const c of channels.value.values()) if (!channelMuted(c)) n += c.unread;
  return n;
});

// Per device. Keys are `c<channelId>` and `g<groupId>`, values the end time or 0 for "until turned on".
const MUTE_KEY = 'tolktak.muted';
export const mutes = signal<Record<string, number>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(MUTE_KEY) || '{}');
    } catch {
      return {};
    }
  })(),
);
export function isMuted(key: string): boolean {
  const until = mutes.value[key];
  return until === 0 || (until !== undefined && until > Date.now());
}
export function channelMuted(c: Channel): boolean {
  return isMuted('c' + c.id) || (c.group_id ? isMuted('g' + c.group_id) : false);
}
export function setMuted(key: string, until: number | null) {
  const next = { ...mutes.value };
  if (until === null) delete next[key];
  else next[key] = until;
  for (const k in next) if (next[k] && next[k] < Date.now()) delete next[k];
  mutes.value = next;
  try {
    localStorage.setItem(MUTE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

export function userName(id: number): string {
  return users.value.get(id)?.display_name ?? t().core.unknownUser(id);
}

export function dmChannelWith(userId: number): Channel | undefined {
  for (const c of channels.value.values()) if (c.kind === 'dm' && c.peer_id === userId) return c;
  return undefined;
}

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500) {
  const item = { id: ++toastSeq, text, kind };
  toasts.value = [...toasts.value, item];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== item.id)), ms);
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.status === 413 ? 'too_large' : e.code;
    return t().core.errors[code] ?? (e.message || `HTTP ${e.status}`);
  }
  return e instanceof Error ? e.message : String(e);
}

// Signals need a new Map to notify.

function setIn<K, V>(sig: { value: Map<K, V> }, key: K, val: V) {
  const m = new Map(sig.value);
  m.set(key, val);
  sig.value = m;
}
function delIn<K, V>(sig: { value: Map<K, V> }, key: K) {
  const m = new Map(sig.value);
  m.delete(key);
  sig.value = m;
}

let rt: Realtime | null = null;

window.addEventListener('online', () => rt?.nudge());
window.addEventListener('tolktak:unauthorized', () => {
  toast(t().core.sessionExpired, 'error');
  logout();
});

export async function boot() {
  const s = await bridge.getSettings();
  if (s.server && s.token) {
    try {
      const a = new Api(s.server, s.token);
      const [{ user }, info] = await Promise.all([a.me(), a.serverInfo()]);
      await startSession(a, user, info);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await bridge.setSettings({ token: '' });
      else if (e instanceof ApiError && e.status === 0) toast(t().core.serverUnavailable, 'error');
    }
  }
  booting.value = false;
}

export async function login(serverInput: string, username: string, password: string) {
  const server = normalizeServer(serverInput);
  if (!server) throw new Error(t().core.enterServer);
  const a = new Api(server);
  const info = await a.serverInfo();
  const app = await bridge.appInfo();
  const { token, user } = await a.login(username, password, `TolkTak ${app.version} (${app.platform})`);
  a.token = token;
  await bridge.setSettings({ server, token });
  await startSession(a, user, info);
}

export async function logout() {
  const s = session.value;
  rt?.close();
  rt = null;
  try {
    await s?.api.logout();
  } catch {
    /* already invalid */
  }
  await bridge.setSettings({ token: '' });
  batch(() => {
    session.value = null;
    channels.value = new Map();
    groups.value = new Map();
    messages.value = new Map();
    voiceRooms.value = new Map();
    view.value = { kind: 'home' };
  });
}

async function startSession(a: Api, user: User, server: ServerInfo) {
  session.value = { api: a, me: user, server };
  await refreshAll();
  rt = new Realtime(a, handleEvent, (st) => {
    const was = connection.value;
    connection.value = st;
    if (st === 'online' && was !== 'online' && was !== 'connecting') resync();
  });
  rt.connect();
  bridge.setTitle(server.name + ' — TolkTak');
}

export function sendRealtime(frame: Record<string, unknown>) {
  rt?.send(frame);
}

async function refreshAll() {
  const a = api();
  const [u, c, g] = await Promise.all([a.users(), a.channels(), a.groups()]);
  batch(() => {
    users.value = new Map(u.users.map((x) => [x.id, x]));
    online.value = new Set(u.users.filter((x) => x.online).map((x) => x.id));
    channels.value = new Map(c.channels.map((x) => [x.id, x]));
    groups.value = new Map(g.groups.map((x) => [x.id, x]));
  });
}

async function resync() {
  try {
    await refreshAll();
    forgetChannels([...messages.value.keys()].filter((id) => !channels.value.has(id)));
    for (const [cid, cm] of messages.value) {
      if (!cm.loaded) continue;
      const last = cm.items[cm.items.length - 1];
      if (!last) continue;
      const { messages: fresh } = await api().messages(cid, { after: last.id, limit: 100 });
      fresh.forEach(upsertMessage);
    }
  } catch (e) {
    console.warn('resync failed', e);
  }
}

type Ev = { type: string; data: any };

function handleEvent(ev: Ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'hello': {
      batch(() => {
        online.value = new Set(d.online as number[]);
        voiceRooms.value = new Map((d.voice as { room: string; members: VoiceMember[] }[]).map((r) => [r.room, r.members]));
      });
      break;
    }
    case 'presence': {
      const s = new Set(online.value);
      if (d.online) s.add(d.user_id);
      else s.delete(d.user_id);
      online.value = s;
      break;
    }
    case 'user.created':
    case 'user.updated':
      setIn(users, d.id, d as User);
      if (session.value && d.id === session.value.me.id) session.value = { ...session.value, me: d };
      break;
    case 'message.created':
      onMessageCreated(d as Message);
      break;
    case 'message.updated':
      upsertMessage(d as Message);
      break;
    case 'channel.created':
      setIn(channels, d.id, { last_message: null, last_read_id: 0, unread: 0, ...d } as Channel);
      break;
    case 'channel.deleted': {
      delIn(channels, d.id);
      forgetChannels([d.id]);
      const v = view.value;
      if (v.kind === 'group' && v.channelId === d.id) view.value = { kind: 'group', groupId: v.groupId };
      break;
    }
    case 'channel.read': {
      const c = channels.value.get(d.channel_id);
      if (c) setIn(channels, c.id, { ...c, unread: 0, last_read_id: Math.max(c.last_read_id, d.message_id) });
      break;
    }
    case 'group.updated': {
      const g = d as Group;
      const isNew = !groups.value.has(g.id);
      setIn(groups, g.id, g);
      if (isNew || !channels.value.has(g.channel_id) || (g.text_channels ?? []).some((tc) => !channels.value.has(tc.id))) {
        api()
          .channels()
          .then(({ channels: cs }) => (channels.value = new Map(cs.map((x) => [x.id, x]))))
          .catch(() => {});
      }
      break;
    }
    case 'group.deleted': {
      const g = groups.value.get(d.id);
      delIn(groups, d.id);
      if (g) {
        const ids = [g.channel_id, ...(g.text_channels ?? []).map((tc) => tc.id)];
        const m = new Map(channels.value);
        for (const id of ids) m.delete(id);
        channels.value = m;
        forgetChannels(ids);
      }
      if (view.value.kind === 'group' && view.value.groupId === d.id) view.value = { kind: 'home' };
      break;
    }
    case 'voice.room':
      if ((d.members as VoiceMember[]).length === 0) delIn(voiceRooms, d.room);
      else setIn(voiceRooms, d.room, d.members);
      break;
    case 'typing': {
      const m = new Map(typing.value);
      const inner = new Map(m.get(d.channel_id) ?? []);
      inner.set(d.user_id, Date.now() + 6000);
      m.set(d.channel_id, inner);
      typing.value = m;
      break;
    }
    case 'call.ring':
      incomingCall.value = { channelId: d.channel_id, from: d.from };
      bridge.requestAttention();
      notify(userName(d.from), t().core.incomingCall);
      break;
    case 'call.declined':
    case 'call.cancelled':
    case 'call.ended':
      if (incomingCall.value?.channelId === d.channel_id) incomingCall.value = null;
      callEvents.dispatchEvent(new CustomEvent(ev.type, { detail: d }));
      break;
  }
}

export const callEvents = new EventTarget();

// Cached history of a deleted channel must not show up in a new one.
function forgetChannels(ids: number[]) {
  const m = new Map(messages.value);
  const t = new Map(typing.value);
  for (const id of ids) {
    m.delete(id);
    t.delete(id);
  }
  messages.value = m;
  typing.value = t;
}

function cmFor(cid: number): ChannelMessages {
  return messages.value.get(cid) ?? { items: [], pending: [], hasOlder: true, loading: false, loaded: false };
}

export function upsertMessage(m: Message) {
  const cm = cmFor(m.channel_id);
  if (!cm.loaded) {
    bumpChannel(m);
    return;
  }
  const items = cm.items.slice();
  const i = items.findIndex((x) => x.id === m.id);
  if (i >= 0) items[i] = m;
  else {
    items.push(m);
    items.sort((a, b) => a.id - b.id);
  }
  setIn(messages, m.channel_id, { ...cm, items, pending: cm.pending.filter((p) => p.nonce !== m.nonce) });
  bumpChannel(m);
}

function bumpChannel(m: Message) {
  const c = channels.value.get(m.channel_id);
  if (c && (!c.last_message || c.last_message.id <= m.id)) setIn(channels, c.id, { ...c, last_message: m });
}

function isChannelVisible(cid: number) {
  const v = view.value;
  if (!document.hasFocus()) return false;
  if (v.kind === 'home') return v.channelId === cid;
  const g = groups.value.get(v.groupId);
  return !!g && (v.channelId ?? g.channel_id) === cid && !v.stage;
}

function onMessageCreated(m: Message) {
  upsertMessage(m);
  const mine = m.author_id === session.value?.me.id;
  const c = channels.value.get(m.channel_id);
  if (!c || mine) return;
  if (isChannelVisible(m.channel_id)) {
    markRead(m.channel_id, m.id);
  } else {
    setIn(channels, c.id, { ...c, unread: c.unread + 1 });
    if (channelMuted(c)) return;
    bridge.requestAttention();
    const where = c.kind === 'group' ? groups.value.get(c.group_id!)?.name : undefined;
    notify(where ? t().core.messageIn(userName(m.author_id), where) : userName(m.author_id), messagePreview(m).slice(0, 140));
  }
}

const NOTIFY_KEY = 'tolktak.notify';
export const notificationsOn = signal((() => {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== '0';
  } catch {
    return true;
  }
})());
export function setNotifications(on: boolean) {
  notificationsOn.value = on;
  try {
    localStorage.setItem(NOTIFY_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function notify(title: string, body: string) {
  if (document.hasFocus() || !notificationsOn.value) return;
  try {
    if (Notification.permission === 'granted') new Notification(title, { body, silent: false });
    else if (Notification.permission !== 'denied') Notification.requestPermission();
  } catch {
    /* notifications unavailable */
  }
}

const readTimer: Record<number, number> = {};
export function markRead(cid: number, mid: number) {
  const c = channels.value.get(cid);
  if (!c || (c.last_read_id >= mid && c.unread === 0)) return;
  setIn(channels, cid, { ...c, unread: 0, last_read_id: Math.max(mid, c.last_read_id) });
  clearTimeout(readTimer[cid]);
  readTimer[cid] = window.setTimeout(() => api().markRead(cid, mid).catch(() => {}), 400);
}

export async function openChannel(cid: number) {
  const cm = cmFor(cid);
  if (cm.loaded || cm.loading) return;
  setIn(messages, cid, { ...cm, loading: true });
  try {
    const { messages: items } = await api().messages(cid, { limit: 50 });
    setIn(messages, cid, { items, pending: cm.pending, hasOlder: items.length === 50, loading: false, loaded: true });
  } catch (e) {
    setIn(messages, cid, { ...cm, loading: false });
    toast(errorText(e), 'error');
  }
}

export async function loadOlder(cid: number) {
  const cm = cmFor(cid);
  if (cm.loading || !cm.hasOlder || !cm.items.length) return;
  setIn(messages, cid, { ...cm, loading: true });
  try {
    const { messages: older } = await api().messages(cid, { before: cm.items[0].id, limit: 50 });
    const now = cmFor(cid);
    setIn(messages, cid, { ...now, items: [...older, ...now.items], hasOlder: older.length === 50, loading: false });
  } catch (e) {
    setIn(messages, cid, { ...cmFor(cid), loading: false });
    toast(errorText(e), 'error');
  }
}

export async function sendMessage(cid: number, text: string, opts: { replyTo?: number; attachments?: FileMeta[]; retryNonce?: string } = {}) {
  const n = opts.retryNonce ?? crypto.randomUUID();
  const cm = cmFor(cid);
  const attachments = opts.attachments ?? [];
  const pending: Pending = { nonce: n, channel_id: cid, text, created_at: Date.now(), status: 'sending', reply_to: opts.replyTo, attachments };
  setIn(messages, cid, { ...cm, pending: [...cm.pending.filter((p) => p.nonce !== n), pending] });
  // Retries reuse the nonce: the server never stores a duplicate.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { message } = await api().send(cid, { text, nonce: n, reply_to: opts.replyTo || undefined, attachments: attachments.map((a) => a.id) });
      upsertMessage(message);
      return;
    } catch (e) {
      if (e instanceof ApiError && e.status !== 0 && e.status < 500) {
        toast(errorText(e), 'error');
        break;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  const now = cmFor(cid);
  setIn(messages, cid, { ...now, pending: now.pending.map((p) => (p.nonce === n ? { ...p, status: 'failed' } : p)) });
}

export function discardPending(cid: number, n: string) {
  const cm = cmFor(cid);
  setIn(messages, cid, { ...cm, pending: cm.pending.filter((p) => p.nonce !== n) });
}

export async function openDM(userId: number) {
  let c = dmChannelWith(userId);
  if (!c) {
    const { channel } = await api().openDM(userId);
    c = channel;
    setIn(channels, c.id, c);
  }
  view.value = { kind: 'home', channelId: c.id };
  return c;
}

let typingSentAt = 0;
export function sendTyping(cid: number) {
  if (Date.now() - typingSentAt < 3000) return;
  typingSentAt = Date.now();
  sendRealtime({ type: 'typing', channel_id: cid });
}
