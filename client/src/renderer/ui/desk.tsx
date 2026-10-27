// The desk: windows described once each, a default layout per situation, a few rules, and
// dockview as the engine that places them. A new window or situation is a new entry below.
import { effect, signal } from '@preact/signals';
import { render, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
// The ESM build of dockview-core 8 ships no CSS; this build injects its own.
import {
  type AddPanelPositionOptions,
  createDockview,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewPanelApi,
  type IDockviewPanel,
  type SerializedDockview,
} from 'dockview-core/dist/dockview-core.js';
import type { Group, Room } from '../api';
import { platform } from '../bridge';
import { type Messages, t } from '../i18n';
import {
  api,
  canModerate,
  channels,
  errorText,
  go,
  goBy,
  groupRole,
  groups,
  me,
  online,
  openDM,
  session,
  shownWindows,
  toast,
  userName,
  users,
  view,
  viewChannel,
  voiceRooms,
  type View,
} from '../state';
import { call, joinVoice, startCall } from '../voice';
import { ChatActions, ChatView } from './Chat';
import { Avatar, confirmDialog, GroupAvatar, Icon, type MenuItem, openMenu } from './common';
import { copyText, openProfile, ProfileCard } from './Profile';
import { RoomModeToggle, Stage, toggleRoomMode } from './Stage';

type Kind = View['kind'];
export type WindowId = 'dm' | 'channel' | 'room' | 'call' | 'people' | 'profile' | 'chat';
/** `arg` is what a window is fixed to, from its id `type:arg`: `chat:12` is channel 12 wherever you are. */
type WinProps = { arg?: number };
type Win = {
  name: () => string;
  minWidth: number;
  /** Title in the window frame: icon, name, a muted detail. */
  Head: (p: WinProps) => VNode | null;
  Actions?: (p: WinProps) => VNode | null;
  Body: (p: WinProps) => VNode | null;
};
const parseId = (id: string) => {
  const [type, arg] = id.split(':');
  return { w: WINDOWS[type as WindowId] as Win | undefined, arg: arg ? Number(arg) : undefined };
};

const viewGroup = () => {
  const v = view.value;
  return v.kind === 'group' || v.kind === 'room' ? groups.value.get(v.groupId) : undefined;
};
const groupChannelName = (g: Group, cid: number) => g.text_channels?.find((c) => c.id === cid)?.name ?? t().shell.group.defaultChannel;
const inCallWith = (cid?: number) => !!cid && !!call.value && 'channel_id' in call.value.target && call.value.target.channel_id === cid;

function Empty({ text }: { text: string }) {
  return <div class="win-empty muted">{text}</div>;
}

function VoiceHead({ icon }: { icon: string }) {
  const c = call.value;
  const tx = t().shell.stage;
  return (
    <>
      <Icon name={icon} size={17} class="win-icon" />
      <span class="win-title">{c?.label ?? t().desk.windows[icon === 'phone' ? 'call' : 'room']}</span>
      {c && c.status !== 'connected' && <span class="win-sub">{c.status === 'ringing' ? tx.ringing : c.status === 'reconnecting' ? tx.reconnecting : tx.connecting}</span>}
    </>
  );
}

function DmCallButton({ cid }: { cid: number }) {
  if (inCallWith(cid)) return null;
  const others = (voiceRooms.value.get('dm' + cid) ?? []).filter((m) => m.user_id !== me.value?.id);
  const tx = t().shell.dm;
  return (
    <button class={others.length ? 'primary small-btn' : 'icon-btn'} title={others.length ? undefined : tx.call} aria-label={others.length ? tx.joinCall : tx.call} onClick={() => callPerson(cid, others.length > 0)}>
      <Icon name="phone" size={17} /> {others.length ? tx.joinCall : ''}
    </button>
  );
}

// A chat window, a person's or a group channel's, shared by the situation windows and the fixed `chat:` ones.
function ChatHead({ cid, name }: { cid?: number; name: string }) {
  const ch = cid ? channels.value.get(cid) : undefined;
  const g = ch?.group_id ? groups.value.get(ch.group_id) : undefined;
  if (ch?.peer_id)
    return (
      <>
        <Avatar id={ch.peer_id} size={22} showPresence />
        <span class="win-title">{userName(ch.peer_id)}</span>
        <span class="win-sub">{users.value.get(ch.peer_id)?.status || (online.value.has(ch.peer_id) ? t().shell.dm.online : t().shell.dm.offline)}</span>
      </>
    );
  if (g && cid)
    return (
      <>
        <GroupAvatar id={g.id} size={22} />
        <Icon name="hash" size={17} class="win-icon" />
        <span class="win-title">{groupChannelName(g, cid)}</span>
        <span class="win-sub">{g.name}</span>
      </>
    );
  return <span class="win-title">{name}</span>;
}
function ChatHeadActions({ cid }: { cid?: number }) {
  if (!cid) return null;
  return (
    <>
      {channels.value.get(cid)?.peer_id && <DmCallButton cid={cid} />}
      <ChatActions channelId={cid} />
    </>
  );
}
function ChatBody({ cid }: { cid?: number }) {
  const ch = cid ? channels.value.get(cid) : undefined;
  const g = ch?.group_id ? groups.value.get(ch.group_id) : undefined;
  if (cid && ch?.peer_id) return <ChatView channelId={cid} title={userName(ch.peer_id)} icon={<Avatar id={ch.peer_id} size={34} showPresence />} />;
  if (cid && g) return <ChatView channelId={cid} title={groupChannelName(g, cid)} icon={<Icon name="hash" size={28} />} canModerate={canModerate(g)} />;
  return <Empty text={t().desk.empty.pickChat} />;
}
const situationChat = (kind: 'dm' | 'channel') => {
  const v = view.value;
  return (kind === 'dm') === (v.kind === 'person' || v.kind === 'call') ? viewChannel(v) : undefined;
};

export const WINDOWS: Record<WindowId, Win> = {
  dm: {
    name: () => t().desk.windows.dm,
    minWidth: 320,
    Head: () => <ChatHead cid={situationChat('dm')} name={t().desk.windows.dm} />,
    Actions: () => <ChatHeadActions cid={situationChat('dm')} />,
    Body: () => <ChatBody cid={situationChat('dm')} />,
  },
  channel: {
    name: () => t().desk.windows.channel,
    minWidth: 320,
    Head: () => <ChatHead cid={situationChat('channel')} name={t().desk.windows.channel} />,
    Actions: () => <ChatHeadActions cid={situationChat('channel')} />,
    Body: () => <ChatBody cid={situationChat('channel')} />,
  },
  chat: {
    name: () => t().desk.windows.chat,
    minWidth: 320,
    Head: ({ arg }) => <ChatHead cid={arg} name={t().desk.windows.chat} />,
    Actions: ({ arg }) => <ChatHeadActions cid={arg} />,
    Body: ({ arg }) => <ChatBody cid={arg} />,
  },
  room: {
    name: () => t().desk.windows.room,
    minWidth: 420,
    Head: () => <VoiceHead icon="speaker" />,
    Actions: () => <RoomModeToggle />,
    Body: () => (call.value ? <Stage /> : <Empty text={t().desk.empty.noVoice} />),
  },
  call: {
    name: () => t().desk.windows.call,
    minWidth: 320,
    Head: () => <VoiceHead icon="phone" />,
    Actions: () => <RoomModeToggle />,
    Body: () => (call.value ? <Stage /> : <Empty text={t().desk.empty.noVoice} />),
  },
  people: {
    name: () => t().desk.windows.people,
    minWidth: 240,
    Head: () => {
      const g = viewGroup();
      return (
        <>
          <Icon name="users" size={17} class="win-icon" />
          <span class="win-title">{t().desk.windows.people}</span>
          {g && <span class="win-sub">{t().shell.home.onlineCount(g.members.filter((id) => online.value.has(id)).length)}</span>}
        </>
      );
    },
    Body: () => {
      const g = viewGroup();
      return g ? <MembersPanel g={g} /> : <Empty text={t().desk.empty.pickChat} />;
    },
  },
  profile: {
    name: () => t().desk.windows.profile,
    minWidth: 260,
    Head: () => (
      <>
        <Icon name="user" size={17} class="win-icon" />
        <span class="win-title">{t().desk.windows.profile}</span>
      </>
    ),
    Body: () => {
      const cid = situationChat('dm');
      const peer = cid ? channels.value.get(cid)?.peer_id : undefined;
      return peer ? (
        <div class="win-scroll">
          <ProfileCard id={peer} onClose={() => {}} />
        </div>
      ) : (
        <Empty text={t().desk.empty.pickChat} />
      );
    },
  },
};

/** Per situation: the window it is about, the windows it may show, and its default columns, left to right. */
export const SITUATIONS: Record<Kind, { main: WindowId; windows: WindowId[]; layout: WindowId[] }> = {
  person: { main: 'dm', windows: ['dm', 'profile'], layout: ['dm'] },
  group: { main: 'channel', windows: ['channel', 'people'], layout: ['channel'] },
  room: { main: 'room', windows: ['room', 'channel', 'people'], layout: ['room', 'channel'] },
  call: { main: 'call', windows: ['call', 'dm', 'profile'], layout: ['call', 'dm'] },
};

// ---------- storage: per server and account, on this device ----------

type Saved = {
  layouts?: Partial<Record<Kind, SerializedDockview>>;
  /** Windows put away on each situation's shelf. */
  shelf?: Partial<Record<Kind, string[]>>;
  /** Windows kept on the desk in every situation. */
  pinned?: string[];
  opacity?: Record<string, number>;
  nav?: number;
  last?: View;
};
// Bump the version when the stored shape changes: older layouts are then ignored.
const storeKey = () => `tolktak.desk.v1.${session.value?.api.base}.${session.value?.me.id}`;
export function loadDesk(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey()) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
export function saveDesk(patch: Saved) {
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ ...loadDesk(), ...patch }));
  } catch {
    /* storage unavailable */
  }
}

// ---------- navigation and rules ----------

const isVoice = (v: View) => v.kind === 'room' || v.kind === 'call';
const groupOfRoom = (roomId: number) => [...groups.value.values()].find((g) => g.rooms.some((r) => r.id === roomId));
/** A room or call situation whose call is over: history skips it. */
const deadVoice = (v: View) => {
  const c = call.value?.target;
  if (v.kind === 'room') return !c || !('room_id' in c) || groupOfRoom(c.room_id)?.id !== v.groupId;
  return v.kind === 'call' && !inCallWith(v.channelId);
};
const chatOf = (groupId: number) => {
  const v = view.value;
  return (v.kind === 'group' || v.kind === 'room') && v.groupId === groupId ? v.channelId : undefined;
};

export function enterRoom(g: Group, r: Room) {
  const here = call.value && 'room_id' in call.value.target && call.value.target.room_id === r.id;
  if (here && view.value.kind === 'room' && view.value.groupId === g.id) return bringForward('room');
  go({ kind: 'room', groupId: g.id, channelId: chatOf(g.id) });
  if (!here)
    joinVoice({ room_id: r.id }, `${r.name} · ${g.name}`).catch((e) => {
      toast(errorText(e), 'error');
      goBy(-1, deadVoice);
    });
}

export function callPerson(channelId: number, join: boolean) {
  const peer = channels.value.get(channelId)?.peer_id;
  const label = peer ? userName(peer) : '';
  go({ kind: 'call', channelId });
  (join ? joinVoice({ channel_id: channelId }, label) : startCall(channelId, label)).catch((e) => {
    toast(errorText(e), 'error');
    goBy(-1, deadVoice);
  });
}

/** Back to the situation of the call you are in. */
export function openVoice() {
  const c = call.value?.target;
  if (!c) return;
  const v = view.value;
  if ('channel_id' in c) {
    if (v.kind === 'call' && v.channelId === c.channel_id) return bringForward('call');
    return go({ kind: 'call', channelId: c.channel_id });
  }
  const g = groupOfRoom(c.room_id);
  if (g && v.kind === 'room' && v.groupId === g.id) return bringForward('room');
  if (g) go({ kind: 'room', groupId: g.id, channelId: chatOf(g.id) });
}

/** A person: their call if you are in it, else the chat with them. */
export function openPerson(userId: number) {
  const c = [...channels.value.values()].find((x) => x.kind === 'dm' && x.peer_id === userId);
  if (c && inCallWith(c.id)) return go({ kind: 'call', channelId: c.id });
  openDM(userId).catch((e) => toast(errorText(e), 'error'));
}

// Rule: the call ended → leave its situation for the one you came from (a call stays in its chat).
let hadCall = false;
effect(() => {
  const c = call.value;
  if (c) hadCall = true;
  if (c || !hadCall) return;
  hadCall = false;
  const v = view.peek();
  if (v.kind === 'call') go({ kind: 'person', channelId: v.channelId });
  else if (v.kind === 'room' && !goBy(-1, (x) => isVoice(x) || deadVoice(x))) go({ kind: 'group', groupId: v.groupId, channelId: v.channelId });
});

// ---------- the engine ----------

let dock: DockviewApi | null = null;
let host: HTMLElement | null = null;
let shownKind: Kind | null = null;
let saveTimer = 0;
/** Each fold while folded: the desk's minimum width before it, and the windows that became tabs with their width. */
let folds: { min: number; ids: string[]; width: number }[] = [];
let fitQueued = 0;
const hintsShown: Record<string, number> = {};
export const shelf = signal<string[]>([]);
export const pinned = signal<string[]>([]);
const opacities = signal<Record<string, number>>({});
export const CHAT_DRAG = 'application/x-tolktak-chat';
const DIRECTION = { top: 'above', bottom: 'below', left: 'left', right: 'right', center: 'within' } as const;

/** A short note on what just happened, at most `times` per device and once in 10 s; a click opens the details. */
function hint(key: keyof Messages['desk']['hints'], times = Infinity) {
  if (Date.now() - (hintsShown[key] ?? 0) < 10_000) return;
  try {
    const n = Number(localStorage.getItem('tolktak.hint.' + key)) || 0;
    if (n >= times) return;
    localStorage.setItem('tolktak.hint.' + key, String(n + 1));
  } catch {
    /* storage unavailable */
  }
  hintsShown[key] = Date.now();
  const h = t().desk.hints[key];
  toast(h.text, 'info', 7000, h.more);
}

function saveLayout() {
  clearTimeout(saveTimer);
  if (dock && shownKind) saveDesk({ layouts: { ...loadDesk().layouts, [shownKind]: dock.toJSON() } });
}

function addWindow(id: string, position?: 'left' | 'right' | AddPanelPositionOptions) {
  const { w } = parseId(id);
  return dock!.addPanel({
    id,
    component: id.split(':')[0],
    title: w?.name() ?? id,
    minimumWidth: w?.minWidth,
    ...(position && dock!.panels.length ? { position: typeof position === 'string' ? { direction: position } : position, initialWidth: 360 } : {}),
  });
}

function setShelf(list: string[]) {
  shelf.value = list;
  if (shownKind) saveDesk({ shelf: { ...loadDesk().shelf, [shownKind]: list } });
}

/** The situation's own window is always there and in front. */
function ensureMain() {
  const id = SITUATIONS[view.value.kind].main;
  if (shelf.value.includes(id)) setShelf(shelf.value.filter((x) => x !== id));
  const p = dock?.getPanel(id);
  if (p) return p.api.setActive();
  addWindow(id, 'left');
  hint('mainBack');
}

/** Too narrow for the windows' minimum widths: the rightmost become tabs of their neighbour, and come back once there is room. */
function fit(byUser = false) {
  const d = dock;
  if (!d || !host) return;
  const width = host.clientWidth;
  // Moved back rather than reloaded: a reload rebuilds every window and flickers.
  while (folds.length && width >= folds[folds.length - 1].min) {
    const f = folds.pop()!;
    const [first, ...rest] = f.ids.map((id) => d.getPanel(id)).filter((p): p is IDockviewPanel => !!p);
    if (!first) continue;
    first.api.moveTo({ group: first.group, position: 'right' });
    for (const p of rest) p.api.moveTo({ group: first.group, position: 'center' });
    first.group.api.setSize({ width: f.width });
  }
  let folded = false;
  while (d.minimumWidth > width) {
    const grid = d.groups.filter((g) => g.api.location.type === 'grid');
    if (grid.length < 2) break;
    const right = (g: DockviewGroupPanel) => g.element.getBoundingClientRect().right;
    const last = grid.reduce((a, b) => (right(b) > right(a) ? b : a));
    const into = (d.adjacentGroupInDirection(last, 'left') ?? grid.find((g) => g !== last)!) as DockviewGroupPanel;
    folds.push({ min: d.minimumWidth, ids: last.panels.map((p) => p.id), width: last.api.width });
    last.api.moveTo({ group: into, position: 'center' });
    folded = true;
  }
  if (folded) d.getPanel(SITUATIONS[view.value.kind].main)?.api.setActive();
  if (folded && byUser) hint('folded');
}
const queueFit = () => {
  if (!fitQueued)
    fitQueued = requestAnimationFrame(() => {
      fitQueued = 0;
      fit(true);
    });
};

function arrange(kind: Kind) {
  saveLayout();
  folds = [];
  shownKind = kind;
  const saved = loadDesk();
  shelf.value = saved.shelf?.[kind] ?? [];
  try {
    if (!saved.layouts?.[kind]) throw new Error('no saved layout');
    dock!.fromJSON(saved.layouts[kind]!);
  } catch {
    dock!.clear();
    SITUATIONS[kind].layout.forEach((id, i) => addWindow(id, i ? 'right' : undefined));
  }
  for (const id of pinned.value) if (!dock!.getPanel(id) && !shelf.value.includes(id)) addWindow(id, 'right');
  ensureMain();
  fit();
  if (isVoice(view.value)) hint(view.value.kind as 'room' | 'call', 2);
}

function show(id: string, position: 'left' | 'right' | AddPanelPositionOptions = 'right') {
  if (!dock) return;
  (dock.getPanel(id) ?? addWindow(id, position)).api.setActive();
  fit(true);
}
/** Shows a window of the situation on screen, as a new one if it was closed. */
export const bringForward = (id: WindowId) => show(id);
export function toggleWindow(id: WindowId) {
  const p = dock?.getPanel(id);
  if (p) p.api.close();
  else show(id);
}
export function resetLayout() {
  if (!dock || !shownKind) return;
  saveDesk({ layouts: { ...loadDesk().layouts, [shownKind]: undefined }, shelf: { ...loadDesk().shelf, [shownKind]: [] } });
  shownKind = null;
  arrange(view.value.kind);
}
export const windowShown = (id: WindowId) => !!dock?.getPanel(id);

export function togglePin(id: string) {
  const on = !pinned.value.includes(id);
  pinned.value = on ? [...pinned.value, id] : pinned.value.filter((x) => x !== id);
  saveDesk({ pinned: pinned.value });
  if (on) hint('pinned', 2);
}
/** A chat in its own window next to the situation; pinned, it stays in every situation. */
export function openBeside(cid: number, pin = false) {
  const id = 'chat:' + cid;
  if (pin && !pinned.value.includes(id)) togglePin(id);
  show(id);
}
function shelve(id: string) {
  setShelf([...shelf.value.filter((x) => x !== id), id]);
  dock?.getPanel(id)?.api.close();
  hint('shelf', 2);
}
function unshelve(id: string) {
  setShelf(shelf.value.filter((x) => x !== id));
  show(id);
}
function closeWindow(p: IDockviewPanel) {
  if (pinned.value.includes(p.id)) togglePin(p.id);
  p.api.close();
}
function float(p: IDockviewPanel) {
  const r = host!.getBoundingClientRect();
  dock!.addFloatingGroup(p, { width: 380, height: Math.min(520, r.height - 90), x: r.width - 400, y: 70 });
  hint('floating', 2);
}
function dockBack(p: IDockviewPanel) {
  const into = dock!.groups.find((g) => g.api.location.type === 'grid' && g !== p.group);
  if (into) p.api.moveTo({ group: into, position: 'right' });
  fit();
}
function setOpacity(id: string, v: number) {
  opacities.value = { ...opacities.value, [id]: v };
  saveDesk({ opacity: opacities.value });
}

function mount<P>(el: HTMLElement, node: (p: P) => VNode) {
  return { element: el, init: (p: P) => render(node(p), el), dispose: () => render(null, el) };
}
function div(cls: string) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function openWindowMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, group: DockviewGroupPanel) {
  const p = group.activePanel;
  openMenu(e, windowMenu(group), group.api.location.type === 'floating' && p ? <OpacitySlider id={p.id} /> : undefined);
}
const toggleMax = (group: DockviewGroupPanel) => group.api.location.type === 'grid' && (group.api.isMaximized() ? group.api.exitMaximized() : group.api.maximize());

function Tab({ id, api }: { id: string; api: DockviewPanelApi }) {
  const { w, arg } = parseId(id);
  const tx = t().desk.menu;
  return (
    <div
      class="win-head"
      onContextMenu={(e) => {
        api.setActive();
        openWindowMenu(e, api.group);
      }}
      onDblClick={() => toggleMax(api.group)}
    >
      {SITUATIONS[view.value.kind].main === id && (
        <span class="win-main" title={tx.main}>
          <Icon name="navigation" size={13} />
        </span>
      )}
      {pinned.value.includes(id) && <Icon name="pin" size={14} class="win-icon" />}
      {w ? <w.Head arg={arg} /> : id}
      <button
        class="win-close"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const p = dock?.getPanel(id);
          if (p) closeWindow(p);
        }}
        title={tx.closeTab}
        aria-label={tx.closeTab}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function OpacitySlider({ id }: { id: string }) {
  const v = opacities.value[id] || 1;
  return (
    <label class="menu-slider">
      <span>{t().desk.menu.opacity}</span>
      <input type="range" min="0.3" max="1" step="0.05" value={v} onInput={(e) => setOpacity(id, Number(e.currentTarget.value))} />
      <span class="muted">{Math.round(v * 100)}%</span>
    </label>
  );
}

function windowMenu(group: DockviewGroupPanel): MenuItem[] {
  const p = group.activePanel;
  if (!p) return [];
  const tx = t().desk.menu;
  const floating = group.api.location.type === 'floating';
  const max = group.api.isMaximized();
  // shortcut: a room or call floats only once it has a compact view (spec «Режимы окна»).
  const canFloat = p.id !== 'room' && p.id !== 'call';
  return [
    ...(floating ? [] : [{ label: max ? tx.unmaximize : tx.maximize, icon: 'maximize', run: () => toggleMax(group) } as MenuItem]),
    ...(floating || canFloat ? [{ label: floating ? tx.dock : tx.float, icon: floating ? 'home' : 'copy', run: () => (floating ? dockBack(p) : float(p)) } as MenuItem] : []),
    { label: tx.shelve, icon: 'arrowDown', run: () => shelve(p.id) },
    ...(p.id.startsWith('chat:') ? [{ label: pinned.value.includes(p.id) ? tx.unpin : tx.pin, icon: 'pin', run: () => togglePin(p.id) } as MenuItem] : []),
    'sep',
    { label: tx.close, icon: 'x', run: () => closeWindow(p) },
  ];
}

function GroupActions({ group }: { group: DockviewGroupPanel }) {
  // Created with the group, before its first panel arrives.
  const [, rerender] = useState(0);
  useEffect(() => {
    const m = group.model;
    const subs = [m.onDidActivePanelChange, m.onDidAddPanel, m.onDidRemovePanel].map((ev) => ev(() => rerender((n) => n + 1)));
    rerender((n) => n + 1);
    return () => subs.forEach((d) => d.dispose());
  }, []);
  const id = group.activePanel?.id;
  const { w, arg } = id ? parseId(id) : { w: undefined, arg: undefined };
  const floating = group.api.location.type === 'floating';
  const opacity = (id && opacities.value[id]) || 1;
  useEffect(() => {
    const box = group.element.closest<HTMLElement>('.dv-resize-container');
    if (box) box.style.opacity = floating ? String(opacity) : '';
  });
  return (
    <>
      {w?.Actions && <w.Actions arg={arg} />}
      <button
        class="icon-btn"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openWindowMenu({ clientX: r.left, clientY: r.bottom + 4 }, group);
        }}
        title={t().desk.menu.label}
        aria-label={t().desk.menu.label}
      >
        <Icon name="more" size={18} />
      </button>
    </>
  );
}

function Shelf() {
  if (!shelf.value.length) return null;
  return (
    <div class="shelf" role="toolbar" aria-label={t().desk.menu.shelf}>
      {shelf.value.map((id) => {
        const { w, arg } = parseId(id);
        return (
          w && (
            <button key={id} class="shelf-item" onClick={() => unshelve(id)}>
              <w.Head arg={arg} />
            </button>
          )
        );
      })}
    </div>
  );
}

const typing = (e: Event) => {
  const el = e.target as HTMLElement;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

let started = false;
function startView(): View {
  const last = loadDesk().last;
  if (last?.kind === 'person' && (!last.channelId || channels.value.has(last.channelId))) return last;
  if (last?.kind === 'group' && groups.value.has(last.groupId) && (!last.channelId || channels.value.has(last.channelId))) return last;
  const g = [...groups.value.values()][0];
  return g ? { kind: 'group', groupId: g.id } : { kind: 'person' };
}

export function Workspace() {
  const ref = useRef<HTMLDivElement>(null);
  const v = view.value;

  useEffect(() => {
    host = ref.current!;
    const saved = loadDesk();
    pinned.value = saved.pinned ?? [];
    opacities.value = saved.opacity ?? {};
    const d = createDockview(host, {
      theme: { name: 'blue', className: 'dockview-theme-blue', gap: 10, dndOverlayMounting: 'absolute', dndPanelOverlay: 'group' },
      singleTabMode: 'fullwidth',
      disableTabsOverflowList: true,
      createComponent: ({ id }) =>
        mount(div('win-body'), () => {
          const { w, arg } = parseId(id);
          return w ? <w.Body arg={arg} /> : <Empty text="" />;
        }),
      defaultTabComponent: 'win',
      createTabComponent: ({ id }) => mount(div('win-tab'), (p: { api: DockviewPanelApi }) => <Tab id={id} api={p.api} />),
      createRightHeaderActionComponent: (group) => mount(div('win-actions'), () => <GroupActions group={group} />),
    });
    dock = d;
    const track = () => (shownWindows.value = new Set(d.groups.map((g) => g.activePanel?.id).filter((x): x is string => !!x)));
    const subs = [
      d.onDidLayoutChange(() => {
        track();
        queueFit();
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(saveLayout, 300);
      }),
      d.onDidActivePanelChange(track),
      // A floating window holds one window: nothing docks into it.
      d.onWillShowOverlay((e) => {
        if (e.group?.api.location.type === 'floating') e.preventDefault();
      }),
      d.onUnhandledDragOver((e) => {
        if (e.nativeEvent instanceof DragEvent && e.nativeEvent.dataTransfer?.types.includes(CHAT_DRAG)) e.accept();
      }),
      d.onDidDrop((e) => {
        const cid = e.nativeEvent instanceof DragEvent ? Number(e.nativeEvent.dataTransfer?.getData(CHAT_DRAG)) : 0;
        if (!cid) return;
        const id = 'chat:' + cid;
        d.getPanel(id)?.api.close();
        const direction = DIRECTION[e.position];
        show(id, e.group ? { referenceGroup: e.group, direction } : { direction: direction === 'within' ? 'right' : direction });
      }),
    ];
    const resize = new ResizeObserver(() => fit());
    resize.observe(host);
    window.addEventListener('beforeunload', saveLayout);
    return () => {
      saveLayout();
      window.removeEventListener('beforeunload', saveLayout);
      subs.forEach((s) => s.dispose());
      resize.disconnect();
      d.dispose();
      dock = null;
      host = null;
      shownKind = null;
      started = false;
    };
  }, []);

  const prev = useRef(v);
  useEffect(() => {
    const p = prev.current;
    prev.current = v;
    if (v.kind !== shownKind) arrange(v.kind);
    // In a room a picked channel shows in the chat beside it.
    else if (v.kind === 'room' && p.kind === 'room' && v.channelId !== p.channelId) show('channel');
    else ensureMain();
    if (started && !isVoice(v)) saveDesk({ last: v });
  }, [v]);

  // Groups arrive just after the session starts.
  useEffect(() => {
    if (started || !groups.value.size) return;
    started = true;
    if (view.value.kind === 'person' && !view.value.channelId) go(startView());
  }, [groups.value]);

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      // On macOS Option+arrow moves by word: a field with text keeps it.
      const wordJump = platform === 'darwin' && typing(e) && !!(e.target as HTMLInputElement).value;
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !wordJump) {
        e.preventDefault();
        goBy(e.key === 'ArrowLeft' ? -1 : 1, deadVoice);
      }
      if (e.code === 'KeyF' && !e.altKey && !e.ctrlKey && !e.metaKey && !typing(e) && isVoice(view.value)) toggleRoomMode();
    };
    const mouse = (e: MouseEvent) => (e.button === 3 || e.button === 4) && goBy(e.button === 3 ? -1 : 1, deadVoice);
    window.addEventListener('keydown', keys);
    window.addEventListener('mouseup', mouse);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('mouseup', mouse);
    };
  }, []);

  return (
    <div class="workspace">
      <div class="dock dockview-theme-blue" ref={ref} />
      <Shelf />
    </div>
  );
}

// ---------- group people ----------

export function memberMenu(g: Group, id: number, e: MouseEvent) {
  const myRole = groupRole(g);
  const theirRole = groupRole(g, id);
  const self = id === me.value?.id;
  const tx = t().shell.member;
  const items: MenuItem[] = [
    { label: tx.profile, icon: 'user', run: () => openProfile(id, e.clientX, e.clientY) },
    ...(!self ? [{ label: tx.message, icon: 'chat', run: () => openPerson(id) } as MenuItem] : []),
    { label: t().shell.self.copyUsername, icon: 'copy', run: () => copyText(users.value.get(id)?.username ?? '', t().shell.self.usernameCopied) },
  ];
  if (!self && myRole === 'owner' && theirRole !== 'owner') {
    items.push('sep', {
      label: theirRole === 'mod' ? tx.removeMod : tx.makeMod,
      icon: 'shield',
      run: () => api().setRole(g.id, id, theirRole === 'mod' ? 'member' : 'mod').catch((er) => toast(errorText(er), 'error')),
    });
  }
  const canKick = !self && theirRole !== 'owner' && (myRole === 'owner' || (myRole === 'mod' && theirRole === 'member'));
  if (canKick) {
    items.push({
      label: tx.kick,
      icon: 'door',
      danger: true,
      run: async () => {
        if (await confirmDialog(tx.kickConfirm(userName(id)), { text: tx.kickText, ok: tx.kickOk, danger: true }))
          api()
            .removeMember(g.id, id)
            .catch((er) => toast(errorText(er), 'error'));
      },
    });
  }
  openMenu(e, items);
}

function MembersPanel({ g }: { g: Group }) {
  const tx = t().shell.member;
  const sorted = [...g.members].sort((a, b) => {
    const rank = (id: number) => ({ owner: 0, mod: 1, member: 2 })[groupRole(g, id)];
    return Number(online.value.has(b)) - Number(online.value.has(a)) || rank(a) - rank(b) || userName(a).localeCompare(userName(b));
  });
  const on = sorted.filter((id) => online.value.has(id));
  const off = sorted.filter((id) => !online.value.has(id));
  const row = (id: number) => {
    const role = groupRole(g, id);
    const u = users.value.get(id);
    return (
      <button key={id} class={'member' + (online.value.has(id) ? '' : ' offline')} onClick={(e) => openProfile(id, e.clientX - 330, e.clientY - 60)} onContextMenu={(e) => memberMenu(g, id, e)}>
        <Avatar id={id} size={32} showPresence />
        <span class="member-main">
          <span class="member-name">
            <span class="ellipsis">{userName(id)}</span>
            {role === 'owner' && (
              <span class="role-ico owner" title={tx.owner}>
                <Icon name="crown" size={13} />
              </span>
            )}
            {role === 'mod' && (
              <span class="role-ico mod" title={tx.mod}>
                <Icon name="shield" size={13} />
              </span>
            )}
          </span>
          {u?.status && <span class="member-status ellipsis">{u.status}</span>}
        </span>
      </button>
    );
  };
  return (
    <div class="members-panel win-scroll">
      <div class="side-label">
        <span>{tx.online}</span>
        <span class="side-label-count">{on.length}</span>
      </div>
      {on.map(row)}
      {off.length > 0 && (
        <div class="side-label">
          <span>{tx.offline}</span>
          <span class="side-label-count">{off.length}</span>
        </div>
      )}
      {off.map(row)}
    </div>
  );
}
