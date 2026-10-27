// The desk: one layout of windows that stays put. Each window is described once below; the main
// window shows what the navigator picks, the voice window comes and goes with a call. dockview places them.
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

export type WindowId = 'main' | 'voice' | 'people' | 'profile' | 'chat';
/** `arg` is what a window is fixed to, from its id `type:arg`: `chat:12` is channel 12. */
type WinProps = { arg?: number };
type Win = {
  name: () => string;
  minWidth: number;
  minHeight: number;
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
  return v.kind === 'group' ? groups.value.get(v.groupId) : undefined;
};
const viewPeer = () => {
  const cid = view.value.kind === 'person' ? view.value.channelId : undefined;
  return cid ? channels.value.get(cid)?.peer_id : undefined;
};
const groupChannelName = (g: Group, cid: number) => g.text_channels?.find((c) => c.id === cid)?.name ?? t().shell.group.defaultChannel;
const inCallWith = (cid?: number) => !!cid && !!call.value && 'channel_id' in call.value.target && call.value.target.channel_id === cid;

function Empty({ text }: { text: string }) {
  return <div class="win-empty muted">{text}</div>;
}

function VoiceHead() {
  const c = call.value;
  const tx = t().shell.stage;
  return (
    <>
      <Icon name={c && 'channel_id' in c.target ? 'phone' : 'speaker'} size={17} class="win-icon" />
      <span class="win-title">{c?.label ?? t().desk.windows.voice}</span>
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

// A chat, a person's or a group channel's: the main window and the fixed `chat:` ones.
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

export const WINDOWS: Record<WindowId, Win> = {
  main: {
    name: () => t().desk.windows.main,
    minWidth: 320,
    minHeight: 220,
    Head: () => <ChatHead cid={viewChannel(view.value)} name={t().desk.windows.main} />,
    Actions: () => <ChatHeadActions cid={viewChannel(view.value)} />,
    Body: () => <ChatBody cid={viewChannel(view.value)} />,
  },
  chat: {
    name: () => t().desk.windows.chat,
    minWidth: 320,
    minHeight: 220,
    Head: ({ arg }) => <ChatHead cid={arg} name={t().desk.windows.chat} />,
    Actions: ({ arg }) => <ChatHeadActions cid={arg} />,
    Body: ({ arg }) => <ChatBody cid={arg} />,
  },
  voice: {
    name: () => t().desk.windows.voice,
    minWidth: 420,
    minHeight: 320,
    Head: () => <VoiceHead />,
    Actions: () => <RoomModeToggle />,
    Body: () => (call.value ? <Stage /> : <Empty text={t().desk.empty.noVoice} />),
  },
  people: {
    name: () => t().desk.windows.people,
    minWidth: 240,
    minHeight: 160,
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
      return g ? <MembersPanel g={g} /> : <Empty text={t().desk.empty.pickGroup} />;
    },
  },
  profile: {
    name: () => t().desk.windows.profile,
    minWidth: 260,
    minHeight: 200,
    Head: () => (
      <>
        <Icon name="user" size={17} class="win-icon" />
        <span class="win-title">{t().desk.windows.profile}</span>
      </>
    ),
    Body: () => {
      const peer = viewPeer();
      return peer ? (
        <div class="win-scroll">
          <ProfileCard id={peer} onClose={() => {}} />
        </div>
      ) : (
        <Empty text={t().desk.empty.pickPerson} />
      );
    },
  },
};
/** Windows a person adds from the avatar menu; the main one is always there, the voice one with a call. */
export const EXTRA_WINDOWS: WindowId[] = ['people', 'profile'];

// ---------- storage: per server and account, on this device ----------

/** Where the voice window stood when the last call ended. */
type Rect = { x: number; y: number; width: number; height: number };
/** Where the voice window stood when the last call ended: the whole desk then, the shape of the desk without it, and a neighbour to stand by if the desk changed since. */
type VoicePlace = { desk?: SerializedDockview; shape?: string; position?: AddPanelPositionOptions; width?: number; floating?: Rect };
type Saved = {
  layout?: SerializedDockview;
  /** Windows put away on the shelf. */
  shelf?: string[];
  /** Where windows put on the shelf from floating were floating. */
  shelfFloat?: Record<string, Rect>;
  opacity?: Record<string, number>;
  voice?: VoicePlace;
  nav?: number;
  last?: View;
};
// Bump the version when the stored shape changes: older layouts are then ignored.
const storeKey = () => `tolktak.desk.v2.${session.value?.api.base}.${session.value?.me.id}`;
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

// ---------- navigation ----------

export function enterRoom(g: Group, r: Room) {
  if (call.value && 'room_id' in call.value.target && call.value.target.room_id === r.id) return bringForward('voice');
  joinVoice({ room_id: r.id }, `${r.name} · ${g.name}`).catch((e) => toast(errorText(e), 'error'));
}

export function callPerson(channelId: number, join: boolean) {
  const peer = channels.value.get(channelId)?.peer_id;
  const label = peer ? userName(peer) : '';
  (join ? joinVoice({ channel_id: channelId }, label) : startCall(channelId, label)).catch((e) => toast(errorText(e), 'error'));
}

/** The call's window, back on screen. */
export const openVoice = () => call.value && bringForward('voice');

export function openPerson(userId: number) {
  openDM(userId).catch((e) => toast(errorText(e), 'error'));
}

// ---------- the engine ----------

let dock: DockviewApi | null = null;
let host: HTMLElement | null = null;
let saveTimer = 0;
/** Each fold while folded: along which side, the desk's minimum size before it, and the windows that became tabs with their size. */
let folds: { wide: boolean; min: number; ids: string[]; size: number }[] = [];
let fitQueued = 0;
const hintsShown: Record<string, number> = {};
export const shelf = signal<string[]>([]);
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
  if (dock) saveDesk({ layout: dock.toJSON() });
}

function addWindow(id: string, position?: 'left' | 'right' | AddPanelPositionOptions, width = 360) {
  const { w } = parseId(id);
  return dock!.addPanel({
    id,
    component: id.split(':')[0],
    title: w?.name() ?? id,
    minimumWidth: w?.minWidth,
    minimumHeight: w?.minHeight,
    ...(position && dock!.panels.length ? { position: typeof position === 'string' ? { direction: position } : position, initialWidth: width } : {}),
  });
}

function setShelf(list: string[]) {
  shelf.value = list;
  saveDesk({ shelf: list });
}

/** The main window is always on the desk and shows what was just picked. */
function ensureMain() {
  if (shelf.value.includes('main')) setShelf(shelf.value.filter((x) => x !== 'main'));
  const p = dock?.getPanel('main');
  if (p) return p.api.setActive();
  addWindow('main', 'left');
  hint('mainBack');
}

/** Too small for the windows' minimum sizes: the rightmost (or lowest) become tabs of their neighbour, and come back once there is room. */
function fit(byUser = false) {
  const d = dock;
  if (!d || !host) return;
  const room = (wide: boolean) => (wide ? host!.clientWidth : host!.clientHeight);
  // Moved back rather than reloaded: a reload rebuilds every window and flickers.
  while (folds.length && room(folds[folds.length - 1].wide) >= folds[folds.length - 1].min) {
    const f = folds.pop()!;
    const [first, ...rest] = f.ids.map((id) => d.getPanel(id)).filter((p): p is IDockviewPanel => !!p);
    if (!first) continue;
    first.api.moveTo({ group: first.group, position: f.wide ? 'right' : 'bottom' });
    for (const p of rest) p.api.moveTo({ group: first.group, position: 'center' });
    first.group.api.setSize(f.wide ? { width: f.size } : { height: f.size });
  }
  let folded = false;
  for (const wide of [true, false]) {
    while ((wide ? d.minimumWidth : d.minimumHeight) > room(wide)) {
      const grid = d.groups.filter((g) => g.api.location.type === 'grid');
      if (grid.length < 2) break;
      const edge = (g: DockviewGroupPanel) => (wide ? g.element.getBoundingClientRect().right : g.element.getBoundingClientRect().bottom);
      const last = grid.reduce((a, b) => (edge(b) > edge(a) ? b : a));
      const into = (d.adjacentGroupInDirection(last, wide ? 'left' : 'up') ?? grid.find((g) => g !== last)!) as DockviewGroupPanel;
      folds.push({ wide, min: wide ? d.minimumWidth : d.minimumHeight, ids: last.panels.map((p) => p.id), size: wide ? last.api.width : last.api.height });
      last.api.moveTo({ group: into, position: 'center' });
      folded = true;
    }
  }
  if (folded && byUser) hint('folded');
}
const queueFit = () => {
  if (!fitQueued)
    fitQueued = requestAnimationFrame(() => {
      fitQueued = 0;
      fit(true);
    });
};

function load() {
  const saved = loadDesk();
  shelf.value = saved.shelf ?? [];
  folds = [];
  try {
    if (!saved.layout) throw new Error('no saved layout');
    dock!.fromJSON(saved.layout);
  } catch {
    dock!.clear();
    addWindow('main');
  }
  // The voice window lives only as long as a call.
  if (!call.value) dock!.getPanel('voice')?.api.close();
  else if (!dock!.getPanel('voice')) showVoice();
  ensureMain();
  fit();
}

/** Where the voice window stands now, to put it back there with the next call. */
function floatRect(g: DockviewGroupPanel): Rect | undefined {
  const r = g.element.closest('.dv-resize-container')?.getBoundingClientRect();
  const h = host!.getBoundingClientRect();
  return r && { x: r.left - h.left, y: r.top - h.top, width: r.width, height: r.height };
}
const shape = (j: SerializedDockview) =>
  JSON.stringify([j.grid.orientation, j.grid.root, j.floatingGroups?.map((f) => f.data?.views)], (k, v) => (k === 'size' || k === 'id' || k === 'activeView' ? undefined : v));

function voicePlace(p: IDockviewPanel): VoicePlace {
  const g = p.group;
  if (g.api.location.type === 'floating') return { floating: floatRect(g) };
  const other = g.panels.find((x) => x !== p);
  if (other) return { position: { referencePanel: other.id, direction: 'within' } };
  for (const [dir, place] of [['left', 'right'], ['right', 'left'], ['up', 'below'], ['down', 'above']] as const) {
    const n = dock!.adjacentGroupInDirection(g, dir)?.activePanel;
    if (n) return { position: { referencePanel: n.id, direction: place }, width: g.api.width };
  }
  return { width: g.api.width };
}

function showVoice() {
  const d = dock!;
  const place = loadDesk().voice ?? {};
  // Nothing moved since the call ended: the desk comes back exactly as it was with the call.
  if (place.desk && place.shape === shape(d.toJSON())) {
    try {
      d.fromJSON(place.desk);
      d.getPanel('voice')?.api.setActive();
      return;
    } catch {
      /* place it by its neighbour instead */
    }
  }
  const ref = place.position && 'referencePanel' in place.position ? place.position.referencePanel : undefined;
  // The window it stood by is gone: the voice window comes in as a new one, on the right.
  const fits = !ref || !!d.getPanel(typeof ref === 'string' ? ref : ref.id);
  const p = addWindow('voice', fits ? (place.position ?? 'right') : 'right', place.width ?? 520);
  if (place.floating) d.addFloatingGroup(p, place.floating);
  p.api.setActive();
}

// The voice window comes with a call and goes when it ends, keeping its place.
let hadCall = false;
effect(() => {
  const c = call.value;
  if (!dock || !!c === hadCall) return;
  hadCall = !!c;
  const p = dock.getPanel('voice');
  if (c && !p) {
    if (shelf.value.includes('voice')) setShelf(shelf.value.filter((x) => x !== 'voice'));
    showVoice();
    fit(true);
  } else if (!c && p) {
    const place = { ...voicePlace(p), desk: dock.toJSON() };
    p.api.close();
    saveDesk({ voice: { ...place, shape: shape(dock.toJSON()) } });
  }
});

function show(id: string, position: 'left' | 'right' | AddPanelPositionOptions = 'right') {
  if (!dock) return;
  if (shelf.value.includes(id)) setShelf(shelf.value.filter((x) => x !== id));
  (dock.getPanel(id) ?? addWindow(id, position)).api.setActive();
  fit(true);
}
/** Shows a window on screen, as a new one if it was closed. */
export function bringForward(id: WindowId) {
  if (id !== 'voice' || dock?.getPanel('voice')) return show(id);
  if (shelf.value.includes('voice')) setShelf(shelf.value.filter((x) => x !== 'voice'));
  showVoice();
  fit(true);
}
export function toggleWindow(id: WindowId) {
  const p = dock?.getPanel(id);
  if (p) p.api.close();
  else show(id);
}
export function resetLayout() {
  if (!dock) return;
  saveDesk({ layout: undefined, shelf: [], voice: undefined });
  load();
}
export const windowShown = (id: WindowId) => !!dock?.getPanel(id);

/** A chat in its own window next to the main one. */
export function openBeside(cid: number) {
  show('chat:' + cid);
}
function shelve(id: string) {
  const g = dock?.getPanel(id)?.group;
  const rect = g?.api.location.type === 'floating' ? floatRect(g) : undefined;
  saveDesk({ shelfFloat: { ...loadDesk().shelfFloat, [id]: rect! } });
  setShelf([...shelf.value.filter((x) => x !== id), id]);
  dock?.getPanel(id)?.api.close();
  hint('shelf', 2);
}
function unshelve(id: string) {
  if (id === 'voice' && !call.value) return setShelf(shelf.value.filter((x) => x !== id));
  bringForward(id as WindowId);
  const rect = loadDesk().shelfFloat?.[id];
  const p = dock?.getPanel(id);
  if (rect && p) dock!.addFloatingGroup(p, rect);
}
function float(p: IDockviewPanel) {
  const r = host!.getBoundingClientRect();
  dock!.addFloatingGroup(p, { width: 380, height: Math.min(520, r.height - 90), x: r.width - 400, y: 70 });
  hint('floating', 2);
}
function dockBack(p: IDockviewPanel) {
  const into = dock!.groups.find((g) => g.api.location.type === 'grid' && g !== p.group);
  if (into) p.api.moveTo({ group: into, position: 'right' });
  fit(true);
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
      {id === 'main' && (
        <span class="win-main" title={tx.main}>
          <Icon name="navigation" size={13} />
        </span>
      )}
      {w ? <w.Head arg={arg} /> : id}
      <button
        class="win-close"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          dock?.getPanel(id)?.api.close();
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
  // shortcut: the voice window floats only once it has a compact view (spec «Режимы окна»).
  const canFloat = p.id !== 'voice';
  return [
    ...(floating ? [] : [{ label: max ? tx.unmaximize : tx.maximize, icon: 'maximize', run: () => toggleMax(group) } as MenuItem]),
    ...(floating || canFloat ? [{ label: floating ? tx.dock : tx.float, icon: floating ? 'home' : 'copy', run: () => (floating ? dockBack(p) : float(p)) } as MenuItem] : []),
    { label: tx.shelve, icon: 'arrowDown', run: () => shelve(p.id) },
    'sep',
    { label: tx.close, icon: 'x', run: () => p.api.close() },
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
    opacities.value = loadDesk().opacity ?? {};
    const d = createDockview(host, {
      theme: { name: 'blue', className: 'dockview-theme-blue', gap: 10, dndOverlayMounting: 'absolute', dndPanelOverlay: 'group' },
      singleTabMode: 'fullwidth',
      disableTabsOverflowList: true,
      floatingGroupBounds: 'boundedWithinViewport',
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
    hadCall = !!call.value;
    load();
    const track = () => (shownWindows.value = new Set(d.groups.map((g) => g.activePanel?.id).filter((x): x is string => !!x)));
    track();
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
      started = false;
    };
  }, []);

  useEffect(() => {
    ensureMain();
    if (started) saveDesk({ last: v });
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
        goBy(e.key === 'ArrowLeft' ? -1 : 1);
      }
      if (e.code === 'KeyF' && !e.altKey && !e.ctrlKey && !e.metaKey && !typing(e) && call.value) toggleRoomMode();
    };
    const mouse = (e: MouseEvent) => (e.button === 3 || e.button === 4) && goBy(e.button === 3 ? -1 : 1);
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
