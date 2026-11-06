import { batch, computed, signal } from '@preact/signals';
import { Api, ApiError, Channel, FileMeta, Group, Message, normalizeServer, type ReadState, ServerInfo, ServerUpdate, User, VoiceMember } from './api';
import { bridge } from './bridge';
import { playSound } from './audio/sounds';
import { t } from './i18n';
import { Realtime } from './realtime';
import { PeopleStore } from './people';
import { HistoryStore } from './history';
import { deleteOutgoingFile, loadOutgoingFile } from './outboxFiles';
import { loadLocalMessages, saveLocalMessages, type Pending } from './localMessages';

export type { Pending } from './localMessages';
export type ChannelMessages = { pending: Pending[] };
// Main-panel selection; groups default to their first channel.
export type View = { kind: 'person'; channelId?: number } | { kind: 'group'; groupId: number; channelId?: number };
export type Toast = { id: number; text: string; kind: 'info' | 'error'; ms: number; more?: string };
export type IncomingCall = { channelId: number; from: number };

export const session = signal<{ api: Api; me: User; server: ServerInfo } | null>(null);
export const booting = signal(true);
export const connection = signal<'online' | 'connecting' | 'offline'>('connecting');
export const serverUpdate = signal<ServerUpdate | null>(null);
// Target version during a server update.
export const serverRestarting = signal<string | null>(null);
export const users = signal<Map<number, User>>(new Map());
export const online = signal<Set<number>>(new Set());
export const channels = signal<Map<number, Channel>>(new Map());
export const groups = signal<Map<number, Group>>(new Map());
export const people = signal<PeopleStore | null>(null);
export const history = signal<HistoryStore | null>(null);
export const messages = signal<Map<number, ChannelMessages>>(new Map());
export const orphanedMessages = computed(() => [...messages.value.values()].flatMap((cm) => cm.pending).filter((p) => !channels.value.has(p.channel_id)));
export const voiceRooms = signal<Map<string, VoiceMember[]>>(new Map());
export const typing = signal<Map<number, Map<number, number>>>(new Map());
export const view = signal<View>({ kind: 'person' });
const trail: View[] = [];
let trailAt = -1;
// Reopening the current selection must also restore a closed main panel.
export const reopen = signal(0);
export function go(v: View) {
  if (JSON.stringify(v) === JSON.stringify(view.value)) return void reopen.value++;
  trail.splice(trailAt + 1, trail.length, v);
  if (trail.length > 50) trail.shift();
  trailAt = trail.length - 1;
  view.value = v;
}
export function goBy(step: -1 | 1) {
  const i = trailAt + step;
  if (i < 0 || i >= trail.length) return;
  trailAt = i;
  view.value = trail[i];
}
export function viewChannel(v: View): number | undefined {
  if (v.kind === 'person') return v.channelId;
  const g = groups.value.get(v.groupId);
  return g && (v.channelId ?? g.channel_id);
}
// Active panel in each visible Dockview group.
export const shownWindows = signal<ReadonlySet<string>>(new Set());
export const toasts = signal<Toast[]>([]);
export const incomingCall = signal<IncomingCall | null>(null);
export const switcherOpen = signal(false);
export const settingsOpen = signal<false | SettingsTab>(false);
export type SettingsTab = 'profile' | 'voice' | 'video' | 'keys' | 'watch' | 'interface' | 'app' | 'server';
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
  if (!session.value) return;
  if (m) setIn(replyTo, cid, m);
  else delIn(replyTo, cid);
  persistMessages();
}
export function setDraft(cid: number, text: string) {
  if (!session.value) return;
  if (text) setIn(drafts, cid, text);
  else delIn(drafts, cid);
  persistMessages();
}

let storageFailureAt = 0;
function persistMessages(pending = [...messages.value.values()].flatMap((cm) => cm.pending)): boolean {
  const s = session.value;
  if (!s) return false;
  try {
    saveLocalMessages(s.api.base, s.me.id, { drafts: [...drafts.value], replies: [...replyTo.value], pending });
    storageFailureAt = 0;
    return true;
  } catch {
    if (Date.now() - storageFailureAt >= 10000) {
      toast(t().core.localSaveFailed, 'error', 10000);
      storageFailureAt = Date.now();
    }
    return false;
  }
}
// Inline markup as Markdown renders it; any other * and _ are text.
const MARKUP = /(\*\*|__|~~)([\s\S]+?)\1|`([^`\n]+)`|\*([^*\s](?:[^*]*[^*\s])?)\*|\b_([^_\s](?:[^_]*[^_\s])?)_\b/g;
const unmark = (s: string): string => s.replace(MARKUP, (_, _mark, inner, code, em, em2) => code ?? unmark(inner ?? em ?? em2));
export function messagePreview(m: { text: string; deleted?: boolean; attachments?: FileMeta[] | number }): string {
  const p = t().core.preview;
  if (m.deleted) return p.deleted;
  if (/^\[\[sticker:[\w-]+\]\]$/.test(m.text)) return p.sticker;
  const text = unmark(
    m.text
      .replace(/```[\s\S]*?```/g, p.code)
      .replace(/\|\|[\s\S]+?\|\|/g, p.spoiler)
      .replace(/^(?:>\s?)+/gm, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
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

const popWindows = new Set<Window>();
// Focus includes native popouts.
export const appFocused = () => document.hasFocus() || [...popWindows].some((w) => w.document.hasFocus());
export function addPopWindow(w: Window) {
  popWindows.add(w);
  w.addEventListener('focus', updateActive);
  w.addEventListener('blur', blurred);
  w.addEventListener('pagehide', () => (popWindows.delete(w), updateActive()));
}

export const appActive = signal(document.hasFocus() && !document.hidden);
const updateActive = () => {
  const v = (document.hasFocus() && !windowHidden.value) || [...popWindows].some((w) => w.document.hasFocus());
  if (appActive.value !== v) appActive.value = v;
};
// Focus moving between the app's own windows blurs one before the other gains it.
const blurred = () => setTimeout(updateActive);
window.addEventListener('focus', updateActive);
window.addEventListener('blur', blurred);
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
// Optional detail opens when the toast is clicked.
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500, more?: string) {
  const item = { id: ++toastSeq, text, kind, ms, more };
  toasts.value = [...toasts.value, item];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== item.id)), ms);
}

function refreshServerUpdate() {
  const s = session.value;
  if (s?.me.is_admin && serverUpdate.value) s.api.serverUpdate().then((u) => {
    if (session.value?.api === s.api) serverUpdate.value = u;
  }, () => {});
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
let authGeneration = 0;

window.addEventListener('online', () => rt?.nudge());
window.addEventListener('tolktak:unauthorized', () => {
  logout();
  toast(t().core.sessionExpired, 'error');
});

export async function boot() {
  const s = await bridge.getSettings();
  if (s.server && s.token && !(await resume(s.server, s.token))) {
    toast(t().core.serverUnavailable, 'error');
    // Retry startup after a temporary network or server outage.
    (async () => {
      for (let delay = 2000; ; delay = Math.min(delay * 2, 30000)) {
        await new Promise((res) => setTimeout(res, delay));
        const now = await bridge.getSettings();
        if (session.value || now.server !== s.server || now.token !== s.token) return;
        if (await resume(s.server, s.token)) return;
      }
    })();
  }
  booting.value = false;
}

/** False when the server could not be reached. */
async function resume(server: string, token: string) {
  const generation = authGeneration;
  try {
    const a = new Api(server, token);
    const [{ user }, info] = await Promise.all([a.me(), a.serverInfo()]);
    if (generation !== authGeneration || session.value) return true;
    await startSession(a, user, info);
  } catch (e) {
    if (generation !== authGeneration || session.value) return true;
    if (e instanceof ApiError && e.status === 0) return false;
    if (e instanceof ApiError && e.status === 401) await bridge.setSettings({ token: '' });
  }
  return true;
}

export async function login(serverInput: string, username: string, password: string) {
  const generation = ++authGeneration;
  const server = normalizeServer(serverInput);
  if (!server) throw new Error(t().core.enterServer);
  const a = new Api(server);
  const info = await a.serverInfo();
  const app = await bridge.appInfo();
  const { token, user } = await a.login(username, password, `TolkTak ${app.version} (${app.platform})`);
  if (generation !== authGeneration) return;
  a.token = token;
  await bridge.setSettings({ server, token });
  if (generation !== authGeneration) return;
  await startSession(a, user, info);
}

export async function logout() {
  ++authGeneration;
  const s = session.value;
  rt?.close();
  rt = null;
  resetSession();
  await bridge.setSettings({ token: '' });
  try {
    await s?.api.logout();
  } catch {
    /* already invalid */
  }
}

function resetSession() {
  window.dispatchEvent(new Event('tolktak:session-reset'));
  for (const timer of Object.values(readTimer)) clearTimeout(timer);
  for (const cid in readTimer) delete readTimer[cid];
  channelLoads.clear();
  channelGroupRemovals.clear();
  groupLoads.clear();
  people.value?.dispose();
  people.value = null;
  history.value?.dispose();
  history.value = null;
  for (const timer of readRefreshTimers.values()) clearTimeout(timer);
  readRefreshTimers.clear();
  readTargets.clear();
  readInFlight.clear();
  delivery.clear();
  clearTimeout(channelRefreshTimer);
  channelRefreshTimer = undefined;
  trail.length = 0;
  trailAt = -1;
  typingSentAt = 0;
  storageFailureAt = 0;
  batch(() => {
    session.value = null;
    users.value = new Map();
    online.value = new Set();
    channels.value = new Map();
    groups.value = new Map();
    messages.value = new Map();
    voiceRooms.value = new Map();
    typing.value = new Map();
    drafts.value = new Map();
    replyTo.value = new Map();
    incomingCall.value = null;
    switcherOpen.value = false;
    settingsOpen.value = false;
    serverUpdate.value = null;
    serverRestarting.value = null;
    connection.value = 'connecting';
    toasts.value = [];
    view.value = { kind: 'person' };
  });
}

async function reloadSession(a: Api) {
  const generation = authGeneration;
  const fresh = new Api(a.base, a.token);
  const [{ user }, info] = await Promise.all([fresh.me(), fresh.serverInfo()]);
  if (session.value?.api === a && generation === authGeneration) await startSession(fresh, user, info);
}

async function verifyHistoryVersion(a: Api, cid: number, version: number) {
  if (session.value?.api !== a) return false;
  const known = channels.value.get(cid)?.history_version ?? 0;
  if (version >= known || session.value.server.capabilities?.changes !== 1) return true;
  try {
    // A concurrent HTTP snapshot may be old; 409 confirms the server itself rewound.
    await a.changes(cid, known);
    return session.value?.api === a;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    await reloadSession(a);
    return false;
  }
}

async function startSession(a: Api, user: User, server: ServerInfo) {
  rt?.close();
  rt = null;
  resetSession();
  session.value = { api: a, me: user, server };
  if (server.capabilities?.users) people.value = new PeopleStore(a, user.id, { profiles: users, online, send: sendRealtime }, (server.capabilities?.contacts ?? 0) >= 2);
  mergeUsers([user]);
  history.value = new HistoryStore(a, {
    users: mergeUsers,
    read: applyReadState,
    message: acceptMessage,
    reset: () => reloadSession(a),
  }, server.capabilities?.changes === 1);
  try {
    const saved = loadLocalMessages(a.base, user.id);
    batch(() => {
      drafts.value = new Map(saved.drafts);
      replyTo.value = new Map(saved.replies);
      const restored = new Map<number, ChannelMessages>();
      for (const p of saved.pending) {
        const cm = restored.get(p.channel_id) ?? cmFor(p.channel_id);
        restored.set(p.channel_id, { ...cm, pending: [...cm.pending, p] });
      }
      messages.value = restored;
    });
  } catch {
    toast(t().core.localLoadFailed, 'error');
  }
  try {
    await refreshAll(a);
    void refreshReplies(a);
  } catch (e) {
    // A failed bootstrap must return to sign-in.
    if (session.value?.api === a) resetSession();
    throw e;
  }
  if (session.value?.api !== a) return;
  rt = new Realtime(a, (ev) => {
    if (session.value?.api === a) handleEvent(ev);
  }, (st) => {
    if (session.value?.api !== a) return;
    const was = connection.value;
    connection.value = st;
    if (st === 'online' && was !== 'online') void resync();
  }, !!people.value);
  rt.connect();
  bridge.setTitle(server.name + ' — TolkTak');
}

export function sendRealtime(frame: Record<string, unknown>) {
  rt?.send(frame);
}

const channelLoads = new Set<Map<number, Channel | null>>();
const channelGroupRemovals = new Set<Set<number>>();
const groupLoads = new Set<Map<number, Group | null>>();

async function refreshCollection<T extends { id: number }>(a: Api, pending: Set<Map<number, T | null>>, load: () => Promise<T[]>, apply: (items: T[]) => void) {
  const updates = new Map<number, T | null>();
  pending.add(updates);
  try {
    const items = await load();
    if (session.value?.api !== a) return;
    const next = new Map(items.map((item) => [item.id, item]));
    for (const [id, item] of updates) {
      if (item) next.set(id, item);
      else next.delete(id);
    }
    apply([...next.values()]);
  } finally {
    pending.delete(updates);
  }
}

function noteChannel(id: number, channel: Channel | null) {
  for (const updates of channelLoads) updates.set(id, channel);
}

async function refreshChannels(a: Api) {
  const removed = new Set<number>();
  channelGroupRemovals.add(removed);
  try {
    await refreshCollection(a, channelLoads, async () => {
      const { channels: list } = await a.channels();
      for (const c of list) if (!await verifyHistoryVersion(a, c.id, c.history_version ?? 0)) return [];
      return list;
    }, (items) => mergeChannels(items.filter((c) => !c.group_id || !removed.has(c.group_id))));
  } finally { channelGroupRemovals.delete(removed); }
}

async function refreshAll(a: Api) {
  const p = people.value;
  const [, , legacy] = await Promise.all([
    refreshChannels(a),
    refreshCollection(a, groupLoads, async () => (await a.groups()).groups, (items) => { groups.value = new Map(items.map((g) => [g.id, g])); }),
    p ? null : a.users(),
  ]);
  if (session.value?.api !== a) return;
  if (legacy) {
    mergeUsers(legacy.users);
    online.value = new Set(legacy.users.filter((x) => x.online).map((x) => x.id));
  }
  if (p) {
    const ids = [...channels.value.values()].flatMap((c) => [c.peer_id, c.last_message?.author_id, c.last_message?.reply?.author_id]).filter((id): id is number => !!id);
    await p.ensure(ids);
  }
}

async function refreshReplies(a: Api) {
  for (const [cid, saved] of replyTo.value) {
    if (session.value?.api !== a) return;
    if (!channels.value.has(cid)) continue;
    try {
      const page = await a.history(cid, { around: saved.id, limit: 1 });
      if (session.value?.api !== a || replyTo.value.get(cid)?.id !== saved.id) continue;
      mergeUsers(page.users);
      const message = page.messages.find((m) => m.id === saved.id);
      if (message) acceptMessage(message);
    } catch (error) {
      if (session.value?.api !== a) return;
      if (error instanceof ApiError && error.status === 404 && replyTo.value.get(cid)?.id === saved.id) {
        setReply(cid, { ...saved, deleted: true, text: '', attachments: [], reactions: [], reply: undefined });
      }
    }
  }
}

export function mergeUsers(list: User[]) {
  if (people.value) {
    people.value.merge(list);
    return;
  }
  const next = new Map(users.value);
  for (const user of list) next.set(user.id, user);
  users.value = next;
}

function mergeChannels(list: Channel[]) {
  const next = new Map<number, Channel>();
  for (const incoming of list) {
    const old = channels.value.get(incoming.id);
    if (old && ((old.history_version ?? 0) > (incoming.history_version ?? 0) || old.last_read_id > incoming.last_read_id)) {
      next.set(incoming.id, { ...incoming, last_message: old.last_message, history_version: Math.max(old.history_version ?? 0, incoming.history_version ?? 0), last_read_id: Math.max(old.last_read_id, incoming.last_read_id), unread: old.unread });
      refreshReadSoon(incoming.id);
    } else next.set(incoming.id, incoming);
  }
  const removed = [...channels.value.keys()].filter((id) => !next.has(id));
  channels.value = next;
  forgetChannels(removed);
}

async function resync() {
  const a = api();
  callEvents.dispatchEvent(new Event('voice.resync'));
  try {
    await refreshAll(a);
    if (session.value?.api !== a) return;
    people.value?.watchNow();
    await history.value?.syncAll();
    if (session.value?.api !== a) return;
    for (const cid of readTargets.keys()) void flushRead(cid, a);
  } catch (e) {
    console.warn('resync failed', e);
  }
}

type Ev = { type: string; data: any };

function handleEvent(ev: Ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'hello': {
      bridge.serverVersion(d.server);
      refreshServerUpdate();
      people.value?.watchNow();
      void people.value?.summary().catch((error) => console.warn('contacts refresh failed', error));
      batch(() => {
        serverRestarting.value = null;
        online.value = new Set(d.online as number[]);
        voiceRooms.value = new Map((d.voice as { room: string; members: VoiceMember[] }[]).map((r) => [r.room, r.members]));
      });
      break;
    }
    case 'server.update':
      serverRestarting.value = d.state === 'restarting' ? d.version : null;
      refreshServerUpdate();
      break;
    case 'presence': {
      if (people.value) { people.value.presence(d); break; }
      const s = new Set(online.value);
      if (d.online) s.add(d.user_id);
      else s.delete(d.user_id);
      online.value = s;
      break;
    }
    case 'user.created':
    case 'user.updated':
      mergeUsers([d as User]);
      if (session.value && d.id === session.value.me.id) session.value = { ...session.value, me: users.value.get(d.id) ?? d };
      break;
    case 'users.snapshot':
      people.value?.snapshot(d);
      break;
    case 'contact.changed':
      people.value?.contact(d);
      break;
    case 'message.created':
      onMessageCreated(d as Message);
      break;
    case 'message.updated':
      upsertMessage(d as Message);
      break;
    case 'channel.created':
      noteChannel(d.id, { last_message: null, last_read_id: 0, unread: 0, ...d } as Channel);
      setIn(channels, d.id, { last_message: null, last_read_id: 0, unread: 0, ...d } as Channel);
      break;
    case 'channel.deleted': {
      noteChannel(d.id, null);
      delIn(channels, d.id);
      forgetChannels([d.id]);
      const v = view.value;
      if (v.kind === 'group' && v.channelId === d.id) view.value = { ...v, channelId: undefined };
      break;
    }
    case 'channel.read': {
      applyReadState(d as ReadState);
      break;
    }
    case 'group.updated': {
      const g = d as Group;
      for (const removed of channelGroupRemovals) removed.delete(g.id);
      const isNew = !groups.value.has(g.id);
      for (const updates of groupLoads) updates.set(g.id, g);
      setIn(groups, g.id, g);
      if (isNew || !channels.value.has(g.channel_id) || (g.text_channels ?? []).some((tc) => !channels.value.has(tc.id))) {
        const a = api();
        void refreshChannels(a).catch(() => {});
      }
      break;
    }
    case 'group.deleted': {
      const g = groups.value.get(d.id);
      for (const removed of channelGroupRemovals) removed.add(d.id);
      for (const updates of groupLoads) updates.set(d.id, null);
      delIn(groups, d.id);
      const ids = [...new Set([...(g ? [g.channel_id, ...(g.text_channels ?? []).map((tc) => tc.id)] : []), ...[...channels.value.values()].filter((c) => c.group_id === d.id).map((c) => c.id)])];
      const m = new Map(channels.value);
      for (const id of ids) { m.delete(id); noteChannel(id, null); }
      channels.value = m;
      forgetChannels(ids);
      const v = view.value;
      if (v.kind === 'group' && v.groupId === d.id) view.value = { kind: 'person' };
      break;
    }
    case 'voice.room':
      if ((d.members as VoiceMember[]).length === 0) delIn(voiceRooms, d.room);
      else setIn(voiceRooms, d.room, d.members);
      break;
    case 'voice.moderation':
      callEvents.dispatchEvent(new CustomEvent(ev.type, { detail: d }));
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
      notify(userName(d.from), t().core.incomingCall, false);
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
    const pending = m.get(id)?.pending ?? [];
    history.value?.forget(id);
    readTargets.delete(id);
    if (pending.length) m.set(id, { pending });
    else m.delete(id);
    t.delete(id);
  }
  messages.value = m;
  typing.value = t;
}

function cmFor(cid: number): ChannelMessages {
  return messages.value.get(cid) ?? { pending: [] };
}

function cleanFiles(pending: Pending[], a = session.value?.api, uid = session.value?.me.id) {
  if (!a || !uid) return;
  const retained = new Set([...messages.value.values()].flatMap((cm) => cm.pending.flatMap((p) => p.attachments.map((f) => f.local_id))));
  for (const p of pending) for (const f of p.attachments) {
    if (f.local_id && !retained.has(f.local_id)) void deleteOutgoingFile(a.base, uid, f.local_id).catch(() => {});
  }
}

function acceptMessage(m: Message) {
  const cm = cmFor(m.channel_id);
  const confirmed = cm.pending.filter((p) => p.nonce === m.nonce && m.author_id === me.value?.id);
  if (confirmed.length) {
    setIn(messages, m.channel_id, { pending: cm.pending.filter((p) => !confirmed.includes(p)) });
    if (persistMessages()) cleanFiles(confirmed);
  }
  const reply = replyTo.value.get(m.channel_id);
  if (reply?.id === m.id && (reply.revision ?? 0) <= (m.revision ?? 0)) {
    setIn(replyTo, m.channel_id, m);
    persistMessages();
  }
  bumpChannel(m);
}

export function upsertMessage(m: Message) {
  history.value?.receive(m);
  acceptMessage(m);
  refreshReadSoon(m.channel_id);
}

let channelRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function refreshChannelsSoon() {
  if (channelRefreshTimer) return;
  const a = session.value?.api;
  if (!a) return;
  channelRefreshTimer = setTimeout(() => {
    channelRefreshTimer = undefined;
    void refreshChannels(a).catch(() => {});
  }, 150);
}

function bumpChannel(m: Message) {
  const c = channels.value.get(m.channel_id);
  if (!c) return;
  let last = c.last_message;
  if (m.deleted) {
    if (last?.id === m.id && (last.revision ?? 0) <= (m.revision ?? 0)) { last = null; refreshChannelsSoon(); }
  } else if (!last || last.id < m.id || (last.id === m.id && (last.revision ?? 0) <= (m.revision ?? 0))) last = m;
  setIn(channels, c.id, { ...c, last_message: last, history_version: Math.max(c.history_version ?? 0, m.revision ?? 0) });
}

function isChannelVisible(cid: number) {
  const v = view.value;
  const own = viewChannel(v) === cid && shownWindows.value.has('main');
  return appFocused() && (own || shownWindows.value.has('chat:' + cid));
}

function onMessageCreated(m: Message) {
  const before = channels.value.get(m.channel_id);
  const fresh = !before || (m.revision ?? 0) > (before.history_version ?? 0);
  upsertMessage(m);
  const mine = m.author_id === session.value?.me.id;
  const c = channels.value.get(m.channel_id);
  if (!c || mine || !fresh || m.id <= c.last_read_id) return;
  setIn(channels, c.id, { ...c, unread: c.unread + 1 });
  if (isChannelVisible(m.channel_id) || channelMuted(c)) return;
  bridge.requestAttention();
  const where = c.kind === 'group' ? groups.value.get(c.group_id!)?.name : undefined;
  notify(where ? t().core.messageIn(userName(m.author_id), where) : userName(m.author_id), messagePreview(m).slice(0, 140));
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

function notify(title: string, body: string, messageSound = true) {
  if (appFocused() || !notificationsOn.value) return;
  if (messageSound) playSound('message');
  try {
    if (Notification.permission === 'granted') new Notification(title, { body, silent: true });
    else if (Notification.permission !== 'denied') Notification.requestPermission();
  } catch {
    /* notifications unavailable */
  }
}

const readTimer: Record<number, number> = {};
const readTargets = new Map<number, number>();
const readInFlight = new Map<number, Promise<void>>();
const readRefreshTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function applyReadState(state: ReadState) {
  const c = channels.value.get(state.channel_id);
  if (!c) return;
  const fresh = state.history_version >= (c.history_version ?? 0) && state.message_id >= c.last_read_id;
  setIn(channels, c.id, { ...c, last_read_id: Math.max(c.last_read_id, state.message_id), unread: fresh ? state.unread : c.unread, history_version: Math.max(c.history_version ?? 0, state.history_version) });
  if ((readTargets.get(c.id) ?? 0) <= state.message_id) readTargets.delete(c.id);
  if (!fresh) refreshReadSoon(c.id);
}

function refreshReadSoon(cid: number) {
  if (readRefreshTimers.has(cid)) return;
  const a = session.value?.api;
  if (!a) return;
  readRefreshTimers.set(cid, setTimeout(() => {
    readRefreshTimers.delete(cid);
    void a.readState(cid).then(async (state) => {
      if (await verifyHistoryVersion(a, cid, state.history_version)) applyReadState(state);
    }).catch(() => {});
  }, 200));
}

export function markRead(cid: number, mid: number) {
  const a = session.value?.api;
  const c = channels.value.get(cid);
  if (!a || !c || mid <= c.last_read_id) return;
  readTargets.set(cid, Math.max(mid, readTargets.get(cid) ?? 0));
  if (readTimer[cid] || readInFlight.has(cid)) return;
  readTimer[cid] = window.setTimeout(() => {
    delete readTimer[cid];
    void flushRead(cid, a);
  }, 250);
}

async function flushRead(cid: number, a: Api) {
  if (session.value?.api !== a || readInFlight.has(cid)) return;
  const target = readTargets.get(cid);
  if (!target) return;
  let succeeded = false;
  const task = (async () => {
    try {
      const state = await a.markRead(cid, target);
      if (session.value?.api !== a) return;
      if (state) applyReadState(state);
      else refreshReadSoon(cid);
      succeeded = true;
    } catch { /* retry on activity or reconnect */ }
  })();
  readInFlight.set(cid, task);
  await task;
  if (session.value?.api !== a || readInFlight.get(cid) !== task) return;
  readInFlight.delete(cid);
  if (succeeded && (readTargets.get(cid) ?? 0) > target) void flushRead(cid, a);
}

export function sendMessage(cid: number, text: string, opts: { replyTo?: number; attachments?: FileMeta[]; retryNonce?: string } = {}): boolean {
  const a = session.value?.api;
  if (!a) return false;
  const n = opts.retryNonce ?? crypto.randomUUID();
  const cm = cmFor(cid);
  const previous = cm.pending.find((p) => p.nonce === n);
  if (previous?.status === 'sending') return false;
  const attachments = opts.attachments ?? [];
  const pending: Pending = { nonce: n, channel_id: cid, text, created_at: previous?.created_at ?? Date.now(), status: 'sending', reply_to: opts.replyTo, attachments };
  const outbox = [...messages.value.values()].flatMap((m) => m.pending).filter((p) => p.nonce !== n);
  if (!persistMessages([...outbox, pending])) return false;
  setIn(messages, cid, { ...cm, pending: [...cm.pending.filter((p) => p.nonce !== n), pending] });
  void pumpMessages(a, cid);
  return true;
}

const delivery = new Map<number, Promise<void>>();
async function pumpMessages(a: Api, cid: number) {
  if (delivery.has(cid)) return;
  const uid = session.value?.me.id;
  if (!uid) return;
  const task = (async () => {
    while (session.value?.api === a) {
      const pending = cmFor(cid).pending.find((p) => p.status === 'sending');
      if (!pending) return;
      if (!await deliverMessage(a, uid, pending)) {
        if (session.value?.api !== a) return;
        setIn(messages, cid, { pending: cmFor(cid).pending.map((p) => ({ ...p, status: 'failed' })) });
        persistMessages();
        return;
      }
    }
  })();
  delivery.set(cid, task);
  await task;
  if (delivery.get(cid) === task) delivery.delete(cid);
}

async function deliverMessage(a: Api, uid: number, pending: Pending): Promise<boolean> {
  const { channel_id: cid, text, nonce: n, reply_to } = pending;
  let attachments = pending.attachments;
  let recovered = false;
  const current = () => session.value?.api === a && cmFor(cid).pending.some((p) => p.nonce === n && p.status === 'sending');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!current()) return session.value?.api === a;
    try {
      const { message } = await a.send(cid, { text, nonce: n, reply_to: reply_to || undefined, attachments: attachments.map((f) => f.id) });
      if (session.value?.api !== a) return false;
      upsertMessage(message);
      return true;
    } catch (e) {
      if (!current()) return session.value?.api === a;
      if (e instanceof ApiError && e.code === 'file_missing' && !recovered) {
        recovered = true;
        try {
          const restored: FileMeta[] = [];
          for (const file of attachments) {
            const local = file.local_id ? await loadOutgoingFile(a.base, uid, file.local_id) : null;
            if (!current()) return false;
            if (!local) throw e;
            const uploaded = await a.upload(local.blob, local.name, file.width && file.height ? { w: file.width, h: file.height } : undefined);
            if (!current()) return false;
            restored.push({ ...uploaded, local_id: file.local_id });
          }
          const updated = { ...pending, attachments: restored };
          const outbox = [...messages.value.values()].flatMap((cm) => cm.pending).map((p) => p.nonce === n ? updated : p);
          if (!persistMessages(outbox)) return false;
          setIn(messages, cid, { pending: cmFor(cid).pending.map((p) => p.nonce === n ? updated : p) });
          attachments = restored;
          attempt--;
          continue;
        } catch (error) {
          if (session.value?.api === a) toast(errorText(error), 'error');
          return false;
        }
      }
      if (e instanceof ApiError && e.status !== 0 && e.status < 500) {
        toast(errorText(e), 'error');
        return false;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return false;
}

export function discardPending(cid: number, n: string) {
  const cm = cmFor(cid);
  if (!persistMessages([...messages.value.values()].flatMap((m) => m.pending).filter((p) => p.nonce !== n))) return;
  setIn(messages, cid, { ...cm, pending: cm.pending.filter((p) => p.nonce !== n) });
  cleanFiles(cm.pending.filter((p) => p.nonce === n));
}

export async function openDM(userId: number) {
  const a = api();
  let c = dmChannelWith(userId);
  if (!c) {
    const { channel } = await a.openDM(userId);
    if (session.value?.api !== a) return;
    c = channel;
    noteChannel(c.id, c);
    setIn(channels, c.id, c);
  }
  go({ kind: 'person', channelId: c.id });
  return c;
}

let typingSentAt = 0;
export function sendTyping(cid: number) {
  if (Date.now() - typingSentAt < 3000) return;
  typingSentAt = Date.now();
  sendRealtime({ type: 'typing', channel_id: cid });
}
