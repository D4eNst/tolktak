// Dockview layout, window lifecycle and per-account persistence.
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
import { t } from '../i18n';
import {
  addPopWindow,
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
  reopen,
  shownWindows,
  toast,
  userName,
  users,
  view,
  viewChannel,
  voiceRooms,
  type View,
} from '../state';
import { call, joinVoice, peers, startCall } from '../voice';
import { addChatPanel, ChatActions, ChatView, openPanel, setPanel, SidePanel } from './Chat';
import { Avatar, confirmDialog, followInput, GroupAvatar, Icon, type MenuItem, openMenu, Toggle } from './common';
import { copyText, openProfile, ProfileCard } from './Profile';
import { CallPeople, callPeopleOpen, RoomModeToggle, Stage, toggleRoomMode } from './Stage';
import { startTour } from './Tour';
import { paint, theme } from '../theme';
import { SearchField, useSearch } from './search';
import { useKnownUsers } from './usePeople';

export type WindowId = 'main' | 'voice' | 'room' | 'people' | 'profile' | 'chat' | 'callpeople';
// Window IDs use type:arg; chat:12 refers to channel 12.
type WinProps = { arg?: number; bare?: boolean };
type Win = {
  name: () => string;
  minWidth: number;
  minHeight: number;
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
export const findRoom = (rid: number) => {
  for (const g of groups.value.values()) {
    const r = g.rooms.find((x) => x.id === rid);
    if (r) return { g, r };
  }
};
const callRoom = () => {
  const c = call.value;
  return c && 'room_id' in c.target ? c.target.room_id : undefined;
};
// Room calls use their room window; direct calls use voice.
const callWindow = () => {
  const rid = callRoom();
  return rid ? 'room:' + rid : 'voice';
};
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

function RoomHead({ rid, bare }: { rid: number; bare?: boolean }) {
  const f = findRoom(rid);
  const c = call.value;
  const tx = t().shell.stage;
  return (
    <>
      {!bare && f && <GroupAvatar id={f.g.id} size={20} />}
      <Icon name="speaker" size={17} class="win-icon" />
      <span class="win-title">{f?.r.name ?? t().desk.windows.room}</span>
      {c && callRoom() === rid && c.status !== 'connected' && <span class="win-sub">{c.status === 'reconnecting' ? tx.reconnecting : tx.connecting}</span>}
    </>
  );
}

// Viewing a room does not join its call.
function RoomLobby({ rid }: { rid: number }) {
  const f = findRoom(rid);
  const tx = t().desk.room;
  if (!f) return <Empty text={t().desk.empty.noRoom} />;
  const members = voiceRooms.value.get(`g${f.g.id}r${rid}`) ?? [];
  return (
    <div class="room-lobby">
      {members.some((m) => m.screen) && <span class="live">{tx.live}</span>}
      {members.length > 0 && (
        <div class="lobby-faces">
          {members.slice(0, 6).map((m) => (
            <Avatar key={m.user_id} id={m.user_id} size={52} />
          ))}
          {members.length > 6 && <span class="lobby-more">+{members.length - 6}</span>}
        </div>
      )}
      <p class="lobby-who">{members.length ? tx.inside(members.length) : tx.nobody}</p>
      {members.length > 0 && <p class="muted small">{members.slice(0, 3).map((m) => userName(m.user_id)).join(', ') + (members.length > 3 ? '…' : '')}</p>}
      <button class="primary" onClick={() => enterRoom(f.g, f.r)}>
        <Icon name="speaker" size={16} /> {tx.join}
      </button>
    </div>
  );
}

function RoomStage() {
  const close = () => (callPeopleOpen.value = false);
  return (
    <div class="stage-wrap">
      <Stage />
      {callPeopleOpen.value && (
        <SidePanel icon="users" title={t().desk.windows.callPeople} onClose={close} actions={<PopOut id="callpeople" close={close} />}>
          <div class="win-scroll">
            <CallPeople />
          </div>
        </SidePanel>
      )}
    </div>
  );
}
function CallPeopleToggle() {
  const own = shownWindows.value.has('callpeople');
  const on = own || callPeopleOpen.value;
  const label = t().desk.windows.callPeople;
  return (
    <button class={'icon-btn count-btn' + (on ? ' active' : '')} onClick={() => (own ? closeWindow('callpeople') : (callPeopleOpen.value = !on))} title={label} aria-label={label} aria-pressed={on}>
      <Icon name="users" size={17} />
      <span>{peers.value.length}</span>
    </button>
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

// Shared by the main window and fixed chat windows.
function ChatHead({ cid, name, bare }: { cid?: number; name: string; bare?: boolean }) {
  const ch = cid ? channels.value.get(cid) : undefined;
  const g = ch?.group_id ? groups.value.get(ch.group_id) : undefined;
  if (ch?.peer_id)
    return (
      <>
        <Avatar id={ch.peer_id} size={20} showPresence />
        <span class="win-title">{userName(ch.peer_id)}</span>
      </>
    );
  if (g && cid)
    return (
      <>
        {!bare && <GroupAvatar id={g.id} size={20} />}
        <Icon name="hash" size={17} class="win-icon" />
        <span class="win-title">{groupChannelName(g, cid)}</span>
      </>
    );
  return <span class="win-title">{name}</span>;
}
function ChatHeadActions({ cid }: { cid?: number }) {
  if (!cid) return null;
  const dm = !!channels.value.get(cid)?.peer_id;
  return (
    <>
      {dm && <DmCallButton cid={cid} />}
      <ChatActions channelId={cid} />
      <SideToggle cid={cid} panel={dm ? 'profile' : 'people'} icon={dm ? 'user' : 'users'} />
    </>
  );
}
function SideToggle({ cid, panel, icon }: { cid: number; panel: 'people' | 'profile'; icon: string }) {
  const own = shownWindows.value.has(panel);
  const on = own || openPanel(cid) === panel;
  const name = WINDOWS[panel].name();
  return (
    <button class={'icon-btn' + (on ? ' active' : '')} onClick={() => (own ? closeWindow(panel) : setPanel(cid, on ? undefined : panel))} title={name} aria-label={name} aria-pressed={on}>
      <Icon name={icon} size={18} />
    </button>
  );
}
function PopOut({ id, close }: { id: WindowId; close: () => void }) {
  const label = t().desk.menu.openPanel;
  return (
    <button
      class="icon-btn"
      onClick={() => {
        close();
        // Floating groups cannot accept tabs.
        const main = dock?.getPanel('main');
        show(id, main?.group.api.location.type === 'grid' ? { referencePanel: 'main', direction: 'right' } : 'right');
      }}
      title={label}
      aria-label={label}
    >
      <Icon name="copy" size={17} />
    </button>
  );
}
addChatPanel('people', (cid, close) => {
  const gid = channels.value.get(cid)?.group_id;
  const g = gid ? groups.value.get(gid) : undefined;
  return (
    g && (
      <SidePanel icon="users" title={WINDOWS.people.name()} onClose={close} actions={<PopOut id="people" close={close} />}>
        <MembersPanel g={g} />
      </SidePanel>
    )
  );
});
addChatPanel('profile', (cid, close) => {
  const peer = channels.value.get(cid)?.peer_id;
  return (
    peer && (
      <SidePanel icon="user" title={WINDOWS.profile.name()} onClose={close} actions={<PopOut id="profile" close={close} />}>
        <div class="win-scroll profile-pane">
          <ProfileCard id={peer} onClose={close} />
        </div>
      </SidePanel>
    )
  );
});

function ChatBody({ cid }: { cid?: number }) {
  const ch = cid ? channels.value.get(cid) : undefined;
  const g = ch?.group_id ? groups.value.get(ch.group_id) : undefined;
  if (cid && ch?.peer_id) return <ChatView channelId={cid} title={userName(ch.peer_id)} icon={<Avatar id={ch.peer_id} size={64} showPresence />} />;
  if (cid && g) return <ChatView channelId={cid} title={groupChannelName(g, cid)} icon={<Icon name="hash" size={28} />} canModerate={canModerate(g)} />;
  return <Empty text={t().desk.empty.pickChat} />;
}

export const WINDOWS: Record<WindowId, Win> = {
  main: {
    name: () => t().desk.windows.main,
    minWidth: 320,
    minHeight: 220,
    Head: ({ bare }) => <ChatHead cid={viewChannel(view.value)} name={t().desk.windows.main} bare={bare} />,
    Actions: () => <ChatHeadActions cid={viewChannel(view.value)} />,
    Body: () => <ChatBody cid={viewChannel(view.value)} />,
  },
  chat: {
    name: () => t().desk.windows.chat,
    minWidth: 320,
    minHeight: 220,
    Head: ({ arg, bare }) => <ChatHead cid={arg} name={t().desk.windows.chat} bare={bare} />,
    Actions: ({ arg }) => <ChatHeadActions cid={arg} />,
    Body: ({ arg }) => <ChatBody cid={arg} />,
  },
  voice: {
    name: () => t().desk.windows.voice,
    minWidth: 420,
    minHeight: 320,
    Head: () => <VoiceHead />,
    Actions: () => (
      <>
        <CallPeopleToggle />
        <RoomModeToggle />
      </>
    ),
    Body: () => (call.value ? <RoomStage /> : <Empty text={t().desk.empty.noVoice} />),
  },
  room: {
    name: () => t().desk.windows.room,
    minWidth: 420,
    minHeight: 320,
    Head: ({ arg, bare }) => <RoomHead rid={arg!} bare={bare} />,
    Actions: ({ arg }) =>
      callRoom() === arg ? (
        <>
          <CallPeopleToggle />
          <RoomModeToggle />
        </>
      ) : null,
    Body: ({ arg }) => (callRoom() === arg ? <RoomStage /> : <RoomLobby rid={arg!} />),
  },
  callpeople: {
    name: () => t().desk.windows.callPeople,
    minWidth: 260,
    minHeight: 200,
    Head: () => (
      <>
        <Icon name="users" size={17} class="win-icon" />
        <span class="win-title">{t().desk.windows.callPeople}</span>
      </>
    ),
    Body: () =>
      call.value ? (
        <div class="win-scroll">
          <CallPeople />
        </div>
      ) : (
        <Empty text={t().desk.empty.noVoice} />
      ),
  },
  people: {
    name: () => t().desk.windows.people,
    minWidth: 240,
    minHeight: 160,
    Head: () => (
      <>
        <Icon name="users" size={17} class="win-icon" />
        <span class="win-title">{t().desk.windows.people}</span>
      </>
    ),
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
        <div class="win-scroll profile-pane">
          <ProfileCard id={peer} onClose={() => {}} />
        </div>
      ) : (
        <Empty text={t().desk.empty.pickPerson} />
      );
    },
  },
};

// ---------- storage: per server and account, on this device ----------

type Rect = { x: number; y: number; width: number; height: number };
// Restore the saved layout if unchanged; otherwise place the call by its former neighbour.
type VoicePlace = { desk?: SerializedDockview; shape?: string; position?: AddPanelPositionOptions; width?: number; height?: number; floating?: Rect };
type Saved = {
  layout?: SerializedDockview;
  // Minimized windows.
  shelf?: string[];
  // Floating bounds to restore from the shelf.
  shelfFloat?: Record<string, Rect>;
  // Shelved windows that belong behind the edge.
  shelfEdge?: string[];
  opacity?: Record<string, number>;
  // Explicit title placement overrides for single-panel groups.
  plain?: string[];
  capsule?: string[];
  voice?: VoicePlace;
  // Room windows retained after leaving the call.
  pinned?: string[];
  // Windows hidden behind the right edge.
  edge?: string[];
  nav?: number;
  navFolded?: boolean;
  last?: View;
};
// Increment when saved layouts become incompatible.
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
  if (!session.value) return;
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ ...loadDesk(), ...patch }));
  } catch {
    /* storage unavailable */
  }
}

// ---------- behaviour: settings «Окна», per device ----------

type DeskPrefs = { call: 'replace' | 'beside' | 'full'; keepCall?: boolean; autoPin?: boolean; hints?: boolean };
const PREFS_KEY = 'tolktak.deskPrefs';
export const deskPrefs = signal<DeskPrefs>({
  call: 'replace',
  ...(() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    } catch {
      return {};
    }
  })(),
});
export function setDeskPrefs(patch: Partial<DeskPrefs>) {
  deskPrefs.value = { ...deskPrefs.value, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(deskPrefs.value));
  } catch {
    /* storage unavailable */
  }
  // Clear the saved call position when its default placement changes.
  if (patch.call) saveDesk({ voice: undefined });
}

// ---------- navigation ----------

export function enterRoom(g: Group, r: Room) {
  if (callRoom() === r.id) return bringForward(callWindow());
  joinVoice({ room_id: r.id }, r.name).catch((e) => toast(errorText(e), 'error'));
}

export function callPerson(channelId: number, join: boolean) {
  const peer = channels.value.get(channelId)?.peer_id;
  const label = peer ? userName(peer) : '';
  (join ? joinVoice({ channel_id: channelId }, label) : startCall(channelId, label)).catch((e) => toast(errorText(e), 'error'));
}

export const openVoice = () => call.value && bringForward(callWindow());

// Manually opened rooms stay visible outside a call.
export function openRoom(rid: number, position?: AddPanelPositionOptions) {
  if (deskPrefs.value.autoPin !== false && !pinned.value.includes('room:' + rid)) setPinned([...pinned.value, 'room:' + rid]);
  show('room:' + rid, position);
}

export function openPerson(userId: number) {
  openDM(userId).catch((e) => toast(errorText(e), 'error'));
}

// ---------- the engine ----------

let dock: DockviewApi | null = null;
let host: HTMLElement | null = null;
let saveTimer = 0;
// Layout before automatic folding; cleared after a manual layout change.
let intended: SerializedDockview | null = null;
// Distinguish automatic layout changes from user changes.
let fitting = false;
let foldedShape = '';
let observedSize = { width: 0, height: 0 };
let unfoldTimer = 0;
let fitQueued = 0;
let foldHintAt = 0;
export const shelf = signal<string[]>([]);
const opacities = signal<Record<string, number>>({});
const plain = signal<string[]>([]);
const pinned = signal<string[]>([]);
function setPinned(v: string[]) {
  pinned.value = v;
  saveDesk({ pinned: v });
}
const capsule = signal<string[]>([]);
// Invalidates frame styling after layout changes.
const layoutTick = signal(0);
// Call windows and lower rows default to an inset title.
function isPlain(group: DockviewGroupPanel, id: string) {
  // Edge windows always use an inset title.
  if (edge.value.includes(id)) return true;
  if (group.api.location.type !== 'grid') return false;
  // An explicit tab preference applies to its frame.
  const ids = group.panels.map((p) => p.id);
  if (ids.some((x) => plain.value.includes(x))) return true;
  if (ids.some((x) => capsule.value.includes(x))) return false;
  void layoutTick.value;
  return id === 'voice' || id.startsWith('room:') || group.element.getBoundingClientRect().top - host!.getBoundingClientRect().top > 8;
}
export const CHAT_DRAG = 'application/x-tolktak-chat';
export const ROOM_DRAG = 'application/x-tolktak-room';
const DIRECTION = { top: 'above', bottom: 'below', left: 'left', right: 'right', center: 'within' } as const;

function hintFolded() {
  if (deskPrefs.value.hints === false || Date.now() - foldHintAt < 10_000) return;
  foldHintAt = Date.now();
  const h = t().desk.hints.folded;
  toast(h.text, 'info', 7000, h.more);
}

function saveLayout() {
  clearTimeout(saveTimer);
  if (dock) saveDesk({ layout: intended ?? dock.toJSON() });
}
// Restore without recording a user layout change.
function restore(j: SerializedDockview) {
  fitting = true;
  try {
    dock!.fromJSON(j);
    applyConstraints();
  } finally {
    fitting = false;
  }
}

function addWindow(id: string, position?: 'left' | 'right' | AddPanelPositionOptions, size: { width?: number; height?: number } = { width: 360 }) {
  const { w } = parseId(id);
  // Floating groups have no docking neighbours; fall back to the grid edge.
  const ref = position && typeof position !== 'string' && ('referencePanel' in position ? dock!.getPanel(String(typeof position.referencePanel === 'string' ? position.referencePanel : position.referencePanel.id))?.group : 'referenceGroup' in position ? position.referenceGroup : undefined);
  if (ref && typeof ref !== 'string' && ref.api.location.type !== 'grid') position = 'right';
  return dock!.addPanel({
    id,
    component: id.split(':')[0],
    title: w?.name() ?? id,
    minimumWidth: w && w.minWidth + PAD,
    minimumHeight: w && w.minHeight + PAD,
    ...(position && dock!.panels.length ? { position: typeof position === 'string' ? { direction: position } : position, initialWidth: size.width, initialHeight: size.height } : {}),
  });
}
// Use current minimum sizes when restoring an older layout.
function applyConstraints() {
  for (const p of dock!.panels) {
    const { w } = parseId(p.id);
    if (w) p.api.setConstraints({ minimumWidth: w.minWidth + PAD, minimumHeight: w.minHeight + PAD });
  }
}

function setShelf(list: string[]) {
  shelf.value = list;
  saveDesk({ shelf: list });
}

function ensureMain() {
  if (shelf.value.includes('main')) setShelf(shelf.value.filter((x) => x !== 'main'));
  const p = dock?.getPanel('main');
  if (p) {
    // Re-activating the selected panel detaches its content and drops input focus.
    if (!p.api.isActive || !p.api.isGroupActive) p.api.setActive();
    return;
  }
  addWindow('main', 'left');
}

// Grid overflow at minimum panel sizes, including gaps.
function overflow(wide: boolean) {
  const h = host!.getBoundingClientRect();
  const grid = dock!.groups.filter((g) => g.api.location.type === 'grid');
  return Math.max(0, ...grid.map((g) => (wide ? g.element.getBoundingClientRect().right - h.right : g.element.getBoundingClientRect().bottom - h.bottom)));
}

// Dockview adds the title height to the content minimum.
const HEAD = 46;
// Panel padding avoids Dockview gap overflow in nested layouts.
const PAD = 10;
// Detect minimum-size violations after Dockview moves.
function cramped(wide: boolean) {
  for (const g of dock!.groups) {
    if (g.api.location.type !== 'grid') continue;
    const need = Math.max(0, ...g.panels.map((p) => parseId(p.id).w).map((w) => (w ? (wide ? w.minWidth + PAD : w.minHeight + HEAD + PAD) : 0)));
    const r = g.element.getBoundingClientRect();
    const deficit = need - (wide ? r.width : r.height);
    if (deficit > 8) return { g, deficit, need };
  }
  return null;
}

// Recompute grid minimums; Dockview caches can be stale after moves.
type GridNode = { type: 'leaf' | 'branch'; data: { views: string[] } | GridNode[] };
function minSize(j: SerializedDockview): [number, number] {
  const walk = (n: GridNode, vertical: boolean): [number, number] => {
    if (n.type === 'leaf') {
      const ws = (n.data as { views: string[] }).views.map((v) => parseId(v).w).filter((w): w is Win => !!w);
      return [Math.max(0, ...ws.map((w) => w.minWidth + PAD)), Math.max(0, ...ws.map((w) => w.minHeight + HEAD + PAD))];
    }
    const kids = (n.data as GridNode[]).map((c) => walk(c, !vertical));
    const sum = (k: 0 | 1) => kids.reduce((a, c) => a + c[k], 0);
    const max = (k: 0 | 1) => Math.max(0, ...kids.map((c) => c[k]));
    return vertical ? [max(0), sum(1)] : [sum(0), max(1)];
  };
  return walk(j.grid.root as unknown as GridNode, j.grid.orientation === 'VERTICAL');
}

// dockview lays itself out lazily; sizes are read right after each change.
const relayout = () => dock!.layout(host!.clientWidth, host!.clientHeight, true);

// Fold overflowing panels into neighbouring tabs.
function fit(byUser = false) {
  const d = dock;
  // Maximized panels hide their neighbours without squeezing them.
  if (!d || !host || d.hasMaximizedGroup()) return;
  fitting = true;
  let folded = false;
  try {
    // Newly added panels need a layout pass before measuring.
    relayout();
    for (const wide of [true, false]) {
      const tried = new Set<DockviewGroupPanel>();
      let rebuilt = false;
      for (let i = 0; i < 20; i++) {
        const room = wide ? host.clientWidth : host.clientHeight;
        const fits = minSize(d.toJSON())[wide ? 0 : 1] <= room + 1;
        // Rebuild to clear stale Dockview minimums.
        if (fits && overflow(wide) > 1 && !rebuilt) {
          rebuilt = true;
          d.fromJSON(d.toJSON());
          applyConstraints();
          relayout();
        }
        if (fits && overflow(wide) <= 1 && !cramped(wide)) break;
        const out = fits ? 0 : overflow(wide) || 2;
        const squeezed = out > 1 ? null : cramped(wide);
        // Redistribute spare space before folding a panel.
        if (squeezed && !tried.has(squeezed.g)) {
          tried.add(squeezed.g);
          squeezed.g.api.setSize(wide ? { width: squeezed.need } : { height: squeezed.need });
          relayout();
          continue;
        }
        if (out <= 1 && !squeezed) break;
        const grid = d.groups.filter((g) => g.api.location.type === 'grid');
        if (grid.length < 2) break;
        const edge = (g: DockviewGroupPanel) => (wide ? g.element.getBoundingClientRect().right : g.element.getBoundingClientRect().bottom);
        const span = (g: DockviewGroupPanel) => (wide ? g.element.getBoundingClientRect().width : g.element.getBoundingClientRect().height);
        // Prefer the narrowest outer panel over a full-width row.
        const far = Math.max(...grid.map(edge));
        const last = squeezed?.g ?? grid.filter((g) => edge(g) > far - 2).reduce((a, b) => (span(b) < span(a) ? b : a));
        // Try the dropped panel's minimum size before folding it.
        if (!squeezed && !tried.has(last)) {
          tried.add(last);
          const min = Math.max(0, ...last.panels.map((p) => parseId(p.id).w).map((w) => (w ? (wide ? w.minWidth + PAD : w.minHeight + HEAD + PAD) : 0)));
          last.api.setSize(wide ? { width: min } : { height: min });
          relayout();
          continue;
        }
        const into = (d.adjacentGroupInDirection(last, wide ? 'left' : 'up') ?? d.adjacentGroupInDirection(last, wide ? 'right' : 'down') ?? grid.find((g) => g !== last)!) as DockviewGroupPanel;
        intended ??= d.toJSON();
        last.api.moveTo({ group: into, position: 'center' });
        relayout();
        folded = true;
      }
    }
  } finally {
    fitting = false;
  }
  if (intended) foldedShape = shape(d.toJSON());
  if (folded && byUser) hintFolded();
}
// Apply manual changes to the layout before automatic folding.
type Node = { type: 'leaf' | 'branch'; data: Node[] | { views: string[]; activeView?: string; id: string }; size: number };
// Place id beside all columns represented by the folded frame, or return null if they are not adjacent.
export function intendBeside(j: SerializedDockview, views: string[], id: string, direction: 'above' | 'below' | 'left' | 'right'): SerializedDockview | null {
  const copy = structuredClone(j);
  const across = direction === 'above' || direction === 'below';
  const after = direction === 'below' || direction === 'right';
  const holds = (n: Node, v: string): boolean => (n.type === 'leaf' ? (n.data as { views: string[] }).views.includes(v) : (n.data as Node[]).some((k) => holds(k, v)));
  const leaf: Node = { type: 'leaf', data: { views: [id], activeView: id, id: 'g' + Date.now() }, size: 0 };
  const walk = (n: Node, vertical: boolean): boolean => {
    if (n.type === 'leaf') return false;
    const kids = n.data as Node[];
    const hit = kids.map((k, i) => (views.some((v) => holds(k, v)) ? i : -1)).filter((i) => i >= 0);
    if (!hit.length) return false;
    if (hit.length === 1 && kids[hit[0]].type === 'branch' && views.every((v) => holds(kids[hit[0]], v))) return walk(kids[hit[0]], !vertical);
    const [a, b] = [hit[0], hit[hit.length - 1]];
    if (b - a + 1 !== hit.length) return false;
    const range = kids.slice(a, b + 1);
    const total = range.reduce((t, k) => t + k.size, 0);
    if (vertical === across) {
      leaf.size = Math.round(total / (range.length + 1));
      kids.splice(after ? b + 1 : a, 0, leaf);
    } else {
      // Preserve the folded columns as one row or stack.
      const inner: Node = range.length === 1 ? { ...range[0], size: 1 } : { type: 'branch', data: range, size: 1 };
      leaf.size = 1;
      kids.splice(a, range.length, { type: 'branch', data: after ? [inner, leaf] : [leaf, inner], size: total });
    }
    return true;
  };
  return walk(copy.grid.root as unknown as Node, copy.grid.orientation === 'VERTICAL') ? copy : null;
}

function unfoldNow() {
  if (!intended) return;
  const j = intended;
  intended = null;
  restore(j);
}
// ---------- windows of their own ----------

// Popouts share the main renderer's state and call.
const popped = new Map<string, Window>();
// Popouts awaiting return when their native window closes.
const returning = new Set<string>();
window.addEventListener('beforeunload', () => popped.forEach((w) => w.close()));
effect(() => {
  theme.value;
  popped.forEach((w) => paint(w.document));
});

// Native popouts are not restored across application restarts.
function popOut(id: string) {
  // Detach the selected chat, not the navigator-driven main panel.
  const own = id === 'main' ? 'chat:' + viewChannel(view.value) : id;
  if (own === 'chat:undefined' || popped.has(own)) return popped.get(own)?.focus();
  const r = dock?.getPanel(id)?.group.element.getBoundingClientRect();
  const w = window.open('about:blank', 'tolktak-pop-' + own.replace(':', '-'), `width=${Math.round(Math.max(420, r?.width ?? 640))},height=${Math.round(Math.max(320, r?.height ?? 520))}`);
  if (!w) return;
  const doc = w.document;
  doc.title = windowLabel(own);
  const base = doc.createElement('base');
  base.href = location.href;
  doc.head.append(base);
  for (const el of document.head.querySelectorAll('link[rel="stylesheet"], style')) doc.head.append(el.cloneNode(true));
  doc.documentElement.lang = document.documentElement.lang;
  paint(doc);
  const root = doc.createElement('div');
  root.className = 'popout';
  doc.body.append(root);
  if (id !== 'main') closeWindow(id);
  popped.set(own, w);
  followInput(w);
  addPopWindow(w);
  shownWindows.value = new Set([...shownWindows.value, own]);
  render(<PopWindow id={own} />, root);
  w.addEventListener('pagehide', () => {
    render(null, root);
    popped.delete(own);
    shownWindows.value = new Set([...shownWindows.value].filter((x) => x !== own));
    // Reuse the main panel if it already shows this chat.
    if (returning.delete(own) && own !== 'chat:' + viewChannel(view.value)) show(own);
  });
}

function PopWindow({ id }: { id: string }) {
  const { w, arg } = parseId(id);
  if (!w) return null;
  const label = t().desk.menu.backToDesk;
  return (
    <div class="popout-win">
      <div class={'popout-head ' + platform}>
        <div class="win-head">
          <w.Head arg={arg} />
        </div>
        <div class="win-actions">
          {w.Actions && <w.Actions arg={arg} />}
          <button
            class="icon-btn"
            onClick={() => {
              returning.add(id);
              popped.get(id)?.close();
            }}
            title={label}
            aria-label={label}
          >
            <Icon name="home" size={17} />
          </button>
        </div>
      </div>
      <div class="win-body">
        <w.Body arg={arg} />
      </div>
    </div>
  );
}

function closeWindow(id: string) {
  unfoldNow();
  dock?.getPanel(id)?.api.close();
  fit();
}
// After resizing settles, restore the layout and fold only the remaining overflow.
function unfold() {
  if (!intended) return;
  const j = intended;
  intended = null;
  restore(j);
  ensureMain();
  fit();
}
function onResize() {
  if (!host) return;
  placeEdges();
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width === observedSize.width && height === observedSize.height) return;
  const grew = width > observedSize.width || height > observedSize.height;
  observedSize = { width, height };
  clearTimeout(unfoldTimer);
  if (grew && intended) unfoldTimer = window.setTimeout(unfold, 250);
  else fit();
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
  intended = null;
  try {
    if (!saved.layout) throw new Error('no saved layout');
    restore(saved.layout);
  } catch {
    dock!.clear();
    addWindow('main');
  }
  // Unpinned call windows close when the call ends.
  for (const p of [...dock!.panels]) if (!call.value && (p.id === 'voice' || (p.id.startsWith('room:') && !kept(p.id)))) p.api.close();
  if (call.value && !dock!.getPanel(callWindow()) && !popped.has(callWindow())) showVoice(callWindow());
  callWin = call.value ? callWindow() : null;
  ensureMain();
  fit();
}

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
  // Preserve maximization independently of other panels.
  const r = g.element.getBoundingClientRect();
  const h = host!.getBoundingClientRect();
  const near = (a: number, b: number) => Math.abs(a - b) < 4;
  const fullWidth = near(r.left, h.left) && near(r.right, h.right);
  const fullHeight = near(r.top, h.top) && near(r.bottom, h.bottom);
  if (fullWidth && !fullHeight) return { position: { direction: near(r.top, h.top) ? 'above' : 'below' }, height: r.height };
  if (fullHeight && !fullWidth) return { position: { direction: near(r.left, h.left) ? 'left' : 'right' }, width: r.width };
  for (const [dir, place] of [['left', 'right'], ['right', 'left'], ['up', 'below'], ['down', 'above']] as const) {
    const n = dock!.adjacentGroupInDirection(g, dir)?.activePanel;
    if (n) return { position: { referencePanel: n.id, direction: place }, width: g.api.width };
  }
  return { width: g.api.width };
}

const kept = (id: string) => id !== 'voice' && (pinned.value.includes(id) || !!deskPrefs.value.keepCall);

function showVoice(id: string) {
  const d = dock!;
  const place = loadDesk().voice ?? {};
  // An unchanged desk can restore the entire saved layout.
  if (place.desk?.panels[id] && place.shape === shape(d.toJSON())) {
    try {
      intended = null;
      restore(place.desk);
      d.getPanel(id)?.api.setActive();
      return;
    } catch {
      /* place it by its neighbour instead */
    }
  }
  const ref = place.position && 'referencePanel' in place.position ? place.position.referencePanel : undefined;
  // If the former neighbour is gone, use the default call placement.
  const fits = !ref || !!d.getPanel(typeof ref === 'string' ? ref : ref.id);
  if (fits && (place.position || place.floating)) {
    const p = addWindow(id, place.position ?? 'right', { width: place.width ?? 520, height: place.height });
    if (place.floating) d.addFloatingGroup(p, place.floating);
    return p.api.setActive();
  }
  const how = deskPrefs.value.call;
  const p =
    how === 'replace' && d.getPanel('main')
      ? addWindow(id, { referencePanel: 'main', direction: 'left' }, { width: Math.round(host!.clientWidth * 0.6) })
      : addWindow(id, 'right', { width: 520 });
  p.api.setActive();
  if (how === 'full') p.group.api.maximize();
}

// Keep call placement across joins; pinned rooms remain visible after leaving.
let callWin: string | null = null;
effect(() => {
  const id = call.value ? callWindow() : null;
  if (!dock || id === callWin) return;
  const was = callWin;
  callWin = id;
  // Close unpinned native call windows too.
  if (was && !kept(was)) popped.get(was)?.close();
  if (was && !kept(was) && dock.getPanel(was)) {
    // Save the call position from the unfolded layout.
    unfoldNow();
    const v = dock.getPanel(was)!;
    const place = { ...voicePlace(v), desk: dock.toJSON() };
    v.api.close();
    fit();
    saveDesk({ voice: { ...place, shape: shape(dock.toJSON()) } });
  }
  if (id) bringForward(id);
});

function show(id: string, position: 'left' | 'right' | AddPanelPositionOptions = 'right') {
  if (!dock) return;
  const own = popped.get(id);
  if (own) return own.focus();
  if (shelf.value.includes(id)) setShelf(shelf.value.filter((x) => x !== id));
  // Panel IDs survive unfolding; group IDs do not.
  if (typeof position !== 'string' && 'referenceGroup' in position && typeof position.referenceGroup !== 'string') {
    const at = position.referenceGroup.activePanel?.id;
    position = at ? { referencePanel: at, direction: position.direction } : { direction: position.direction === 'within' ? 'right' : position.direction ?? 'right' };
  }
  // Apply the drop to both the visible frame and its unfolded columns.
  const at = typeof position !== 'string' && 'referencePanel' in position ? dock.getPanel(String(position.referencePanel)) : undefined;
  const dir = typeof position !== 'string' ? position.direction : undefined;
  if (intended && at && at.group.api.location.type === 'grid' && dir && dir !== 'within' && !dock.getPanel(id)) {
    const next = intendBeside(intended, at.group.panels.map((p) => p.id), id, dir as 'above' | 'below' | 'left' | 'right');
    if (next) {
      fitting = true;
      try {
        addWindow(id, position).api.setActive();
      } finally {
        fitting = false;
      }
      const now = dock.toJSON();
      // Reuse the position in the unfolded layout.
      next.panels[id] = now.panels[id];
      intended = next;
      foldedShape = shape(now);
      return fit(true);
    }
  }
  unfoldNow();
  (dock.getPanel(id) ?? addWindow(id, position)).api.setActive();
  fit(true);
}
export function bringForward(id: string) {
  const own = popped.get(id);
  if (own) return own.focus();
  if (!call.value || id !== callWindow() || dock?.getPanel(id)) return show(id);
  if (shelf.value.includes(id)) setShelf(shelf.value.filter((x) => x !== id));
  unfoldNow();
  showVoice(id);
  fit(true);
}
export function resetLayout() {
  if (!dock) return;
  saveDesk({ layout: undefined, shelf: [], voice: undefined });
  load();
}
export async function confirmReset() {
  const tx = t().desk.menu;
  if (await confirmDialog(tx.resetConfirm, { text: tx.resetText, ok: tx.resetOk, danger: true })) resetLayout();
}

export function openBeside(cid: number) {
  show('chat:' + cid);
}
function shelve(id: string) {
  const g = dock?.getPanel(id)?.group;
  const rect = g?.api.location.type === 'floating' && !edge.value.includes(id) ? floatRect(g) : undefined;
  saveDesk({ shelfFloat: { ...loadDesk().shelfFloat, [id]: rect! }, shelfEdge: [...(loadDesk().shelfEdge ?? []).filter((x) => x !== id), ...(edge.value.includes(id) ? [id] : [])] });
  setShelf([...shelf.value.filter((x) => x !== id), id]);
  dock?.getPanel(id)?.api.close();
}
function unshelve(id: string) {
  if (id === 'voice' && !call.value) return setShelf(shelf.value.filter((x) => x !== id));
  bringForward(id);
  const rect = loadDesk().shelfFloat?.[id];
  const p = dock?.getPanel(id);
  const edged = loadDesk().shelfEdge ?? [];
  if (p && edged.includes(id)) {
    saveDesk({ shelfEdge: edged.filter((x) => x !== id) });
    toEdge(p);
    edgeOpen.value = id;
  } else if (rect && p) dock!.addFloatingGroup(p, rect);
}
// ---------- behind the edge ----------

const edge = signal<string[]>([]);
const edgeOpen = signal<string | null>(null);
const EDGE_WIDTH = 380;
function setEdge(v: string[]) {
  edge.value = v;
  saveDesk({ edge: v });
}
// Edge windows are full-height floating panels controlled by a tab.
function toEdge(p: IDockviewPanel) {
  const r = host!.getBoundingClientRect();
  // Restore the grid before detaching the panel.
  unfoldNow();
  const q = dock!.getPanel(p.id) ?? p;
  if (q.group.api.location.type !== 'floating') dock!.addFloatingGroup(q, { x: r.width - EDGE_WIDTH, y: 0, width: EDGE_WIDTH, height: r.height });
  setEdge([...edge.value.filter((x) => x !== q.id), q.id]);
  edgeOpen.value = null;
  relayout();
  fit();
}
function fromEdge(p: IDockviewPanel) {
  setEdge(edge.value.filter((x) => x !== p.id));
  const box = p.group.element.closest<HTMLElement>('.dv-resize-container');
  box?.classList.remove('edge-win', 'edge-shut');
}
function placeEdges() {
  if (!dock || !host) return;
  // Docked back or closed: no longer behind the edge.
  const still = edge.value.filter((id) => dock!.getPanel(id)?.group.api.location.type === 'floating');
  if (still.length !== edge.value.length) setEdge(still);
  const W = host.clientWidth;
  for (const id of still) {
    const box = dock.getPanel(id)!.group.element.closest<HTMLElement>('.dv-resize-container');
    if (!box) continue;
    // Leave the edge tabs clickable beside the open panel.
    const w = Math.min(EDGE_WIDTH, W - 90);
    Object.assign(box.style, { top: '10px', left: W - w - 40 + 'px', width: w + 'px', height: host.clientHeight - 20 + 'px' });
    box.classList.add('edge-win');
    box.classList.toggle('edge-shut', edgeOpen.value !== id);
  }
}
effect(() => {
  void edge.value;
  void edgeOpen.value;
  requestAnimationFrame(placeEdges);
});

function EdgeTabs() {
  if (!edge.value.length) return null;
  return (
    <div class="edge-tabs" role="toolbar" aria-label={t().desk.menu.edge}>
      {edge.value.map((id) => {
        const { w, arg } = parseId(id);
        return (
          w && (
            <button key={id} class={'edge-tab' + (edgeOpen.value === id ? ' on' : '')} onClick={() => (edgeOpen.value = edgeOpen.value === id ? null : id)} title={windowLabel(id)} aria-label={windowLabel(id)} aria-expanded={edgeOpen.value === id}>
              <Icon name="chevronRight" size={14} class="edge-arrow" />
              <span class="edge-label">
                <w.Head arg={arg} bare />
              </span>
            </button>
          )
        );
      })}
    </div>
  );
}

// Join the adjacent group or split a tab in the requested direction.
function moveWindow(dir: 'left' | 'right' | 'up' | 'down') {
  const p = dock?.activePanel;
  if (!p || p.group.api.location.type !== 'grid') return;
  const n = dock!.adjacentGroupInDirection(p.group as DockviewGroupPanel, dir);
  if (n) p.api.moveTo({ group: n as DockviewGroupPanel, position: 'center' });
  else if (p.group.panels.length > 1) p.api.moveTo({ group: p.group as DockviewGroupPanel, position: ({ left: 'left', right: 'right', up: 'top', down: 'bottom' } as const)[dir] });
  else return;
  fit(true);
  p.api.setActive();
}

function float(p: IDockviewPanel) {
  const r = host!.getBoundingClientRect();
  dock!.addFloatingGroup(p, { width: 380, height: Math.min(520, r.height - 90), x: r.width - 400, y: 70 });
}
function dockBack(p: IDockviewPanel) {
  const into = dock!.groups.find((g) => g.api.location.type === 'grid' && g !== p.group);
  // Nothing left in the grid: the window becomes its first one.
  if (into) p.api.moveTo({ group: into, position: 'right' });
  else p.api.moveTo({ group: dock!.addGroup(), position: 'center' });
  fit(true);
}
function togglePlain(group: DockviewGroupPanel, id: string) {
  const on = !isPlain(group, id);
  const ids = group.panels.map((p) => p.id);
  plain.value = on ? [...plain.value.filter((x) => !ids.includes(x)), ...ids] : plain.value.filter((x) => !ids.includes(x));
  capsule.value = on ? capsule.value.filter((x) => !ids.includes(x)) : [...capsule.value.filter((x) => !ids.includes(x)), ...ids];
  saveDesk({ plain: plain.value, capsule: capsule.value });
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

function windowLabel(id: string): string {
  const { w, arg } = parseId(id);
  const cid = id === 'main' ? viewChannel(view.value) : id.startsWith('chat:') ? arg : undefined;
  const ch = cid ? channels.value.get(cid) : undefined;
  if (ch?.peer_id) return userName(ch.peer_id);
  const g = ch?.group_id ? groups.value.get(ch.group_id) : undefined;
  if (g && cid) return groupChannelName(g, cid);
  if (id === 'voice' && call.value) return call.value.label;
  if (id.startsWith('room:')) return findRoom(arg!)?.r.name ?? w!.name();
  return w?.name() ?? id;
}
const groupOfWindow = (id: string) => {
  if (id.startsWith('room:')) return findRoom(Number(id.slice(5)))?.g.id;
  const cid = id === 'main' ? viewChannel(view.value) : id.startsWith('chat:') ? Number(id.slice(5)) : undefined;
  return cid ? channels.value.get(cid)?.group_id : undefined;
};
// A shared group avatar replaces per-tab avatars.
const sharedGroup = (group: DockviewGroupPanel) => {
  const owners = group.panels.map((p) => groupOfWindow(p.id));
  return owners.length && owners.every((g) => g !== undefined && g === owners[0]) ? owners[0] : undefined;
};

// Subscribe frame components to Dockview panel changes.
function useFrame(group: DockviewGroupPanel) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const m = group.model;
    const subs = [m.onDidActivePanelChange, m.onDidAddPanel, m.onDidRemovePanel].map((ev) => ev(() => rerender((n) => n + 1)));
    rerender((n) => n + 1);
    return () => subs.forEach((d) => d.dispose());
  }, []);
}

function FrameGroup({ group }: { group: DockviewGroupPanel }) {
  useFrame(group);
  const g = sharedGroup(group);
  return g === undefined ? null : (
    <span class="win-group" title={groups.value.get(g)?.name}>
      <GroupAvatar id={g} size={22} />
    </span>
  );
}

function Tab({ id, api }: { id: string; api: DockviewPanelApi }) {
  const { w, arg } = parseId(id);
  const tx = t().desk.menu;
  // Tabs of one group show its avatar once, on the first tab.
  const [, rerender] = useState(0);
  useEffect(() => {
    let subs: { dispose(): void }[] = [];
    const watch = () => {
      subs.forEach((d) => d.dispose());
      const m = api.group.model;
      subs = [m.onDidAddPanel, m.onDidRemovePanel].map((ev) => ev(() => rerender((n) => n + 1)));
      rerender((n) => n + 1);
    };
    watch();
    const moved = api.onDidGroupChange(watch);
    return () => {
      moved.dispose();
      subs.forEach((d) => d.dispose());
    };
  }, []);
  // Show one avatar per consecutive group of tabs.
  const tabs = api.group.panels.map((p) => p.id);
  const at = tabs.indexOf(id);
  const mine = groupOfWindow(id);
  const prev = at > 0 ? groupOfWindow(tabs[at - 1]) : undefined;
  const bare = sharedGroup(api.group) !== undefined || (mine !== undefined && mine === prev);
  const runStart = at > 0 && (mine === undefined || mine !== prev);
  return (
    <div
      class={'win-head' + (runStart ? ' run-start' : '')}
      onContextMenu={(e) => {
        api.setActive();
        openWindowMenu(e, api.group);
      }}
      onDblClick={() => toggleMax(api.group)}
    >
      {w ? <w.Head arg={arg} bare={bare} /> : id}
      {id === 'main' && (
        <span class="win-main" title={tx.main}>
          <Icon name="navigation" size={12} />
        </span>
      )}
      {pinned.value.includes(id) ? (
        // A kept window closes only from its menu; the pin lets it go.
        <button
          class="win-close win-pin"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setPinned(pinned.value.filter((x) => x !== id));
          }}
          title={tx.unpin}
          aria-label={tx.unpin}
        >
          <Icon name="pin" size={12} />
        </button>
      ) : (
        <button
          class="win-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            closeWindow(id);
          }}
          title={tx.closeTab}
          aria-label={tx.closeTab}
        >
          <Icon name="x" size={12} />
        </button>
      )}
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
  // Floating mode currently supports chats only.
  const canFloat = p.id === 'main' || p.id.startsWith('chat:');
  return [
    ...(floating ? [] : [isPlain(group, p.id) ? { label: tx.capsule, icon: 'tabAbove', run: () => togglePlain(group, p.id) } : { label: tx.plain, icon: 'tabInside', run: () => togglePlain(group, p.id) }]),
    ...(floating ? [] : [{ label: max ? tx.unmaximize : tx.maximize, icon: 'maximize', run: () => toggleMax(group) } as MenuItem]),
    ...(floating || canFloat ? [{ label: floating ? tx.dock : tx.float, icon: floating ? 'home' : 'copy', run: () => (floating ? dockBack(p) : float(p)) } as MenuItem] : []),
    { label: tx.ownWindow, icon: 'external', run: () => popOut(p.id) },
    ...(p.id.startsWith('room:')
      ? [
          pinned.value.includes(p.id)
            ? { label: tx.unpin, icon: 'pin', run: () => setPinned(pinned.value.filter((x) => x !== p.id)) }
            : { label: tx.pin, icon: 'pin', run: () => setPinned([...pinned.value, p.id]) },
        ]
      : []),
    ...(floating && !edge.value.includes(p.id) && p.id !== 'main' && p.id !== 'voice' && !p.id.startsWith('room:') ? [{ label: tx.toEdge, icon: 'chevronRight', run: () => toEdge(p) } as MenuItem] : []),
    ...(edge.value.includes(p.id)
      ? [{ label: tx.float, icon: 'copy', run: () => fromEdge(p) } as MenuItem]
      : !floating && p.id !== 'main' && p.id !== 'voice' && !p.id.startsWith('room:')
        ? [{ label: tx.toEdge, icon: 'chevronRight', run: () => toEdge(p) } as MenuItem]
        : []),
    { label: tx.shelve, icon: 'arrowDown', run: () => shelve(p.id) },
    'sep',
    { label: tx.reset, icon: 'reset', run: confirmReset },
    { label: tx.close, icon: 'x', run: () => closeWindow(p.id) },
  ];
}

function GroupActions({ group }: { group: DockviewGroupPanel }) {
  // Created with the group, before its first panel arrives.
  useFrame(group);
  const id = group.activePanel?.id;
  const { w, arg } = id ? parseId(id) : { w: undefined, arg: undefined };
  const floating = group.api.location.type === 'floating';
  const opacity = (id && opacities.value[id]) || 1;
  // A second tab brings the capsule back: tabs need it.
  const inside = !!id && isPlain(group, id);
  useEffect(() => {
    const box = group.element.closest<HTMLElement>('.dv-resize-container');
    if (box) box.style.opacity = floating ? String(opacity) : '';
    (group.element.closest('.dv-groupview') ?? group.element.querySelector('.dv-groupview'))?.classList.toggle('win-plain', inside);
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
    plain.value = loadDesk().plain ?? [];
    capsule.value = loadDesk().capsule ?? [];
    edge.value = loadDesk().edge ?? [];
    pinned.value = loadDesk().pinned ?? [];
    const d = createDockview(host, {
      theme: { name: 'blue', className: 'dockview-theme-blue', gap: 0, dndOverlayMounting: 'absolute', dndPanelOverlay: 'group' },
      singleTabMode: 'fullwidth',
      floatingGroupBounds: 'boundedWithinViewport',
      createComponent: ({ id }) =>
        mount(div('win-body'), () => {
          const { w, arg } = parseId(id);
          return w ? <w.Body arg={arg} /> : <Empty text="" />;
        }),
      defaultTabComponent: 'win',
      createTabComponent: ({ id }) => mount(div('win-tab'), (p: { api: DockviewPanelApi }) => <Tab id={id} api={p.api} />),
      createRightHeaderActionComponent: (group) => mount(div('win-actions'), () => <GroupActions group={group} />),
      createPrefixHeaderActionComponent: (group) => mount(div('win-prefix'), () => <FrameGroup group={group} />),
    });
    dock = d;
    observedSize = { width: 0, height: 0 };
    load();
    const track = () => (shownWindows.value = new Set([...d.groups.map((g) => g.activePanel?.id).filter((x): x is string => !!x), ...popped.keys()]));
    track();
    const subs = [
      d.onDidLayoutChange(() => {
        layoutTick.value++;
        requestAnimationFrame(placeEdges);
        // A manual change replaces the saved unfolded layout.
        if (!fitting && intended && shape(d.toJSON()) !== foldedShape) intended = null;
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
        const types = e.nativeEvent instanceof DragEvent ? e.nativeEvent.dataTransfer?.types : undefined;
        if (types?.includes(CHAT_DRAG) || types?.includes(ROOM_DRAG)) e.accept();
      }),
      d.onDidDrop((e) => {
        const data = e.nativeEvent instanceof DragEvent ? e.nativeEvent.dataTransfer : null;
        const cid = Number(data?.getData(CHAT_DRAG));
        const rid = Number(data?.getData(ROOM_DRAG));
        if (!cid && !rid) return;
        const id = cid ? 'chat:' + cid : 'room:' + rid;
        d.getPanel(id)?.api.close();
        const direction = DIRECTION[e.position];
        const position = e.group ? { referenceGroup: e.group, direction } : { direction: direction === 'within' ? ('right' as const) : direction };
        if (rid) openRoom(rid, position);
        else show(id, position);
      }),
    ];
    // After dockview has laid itself out for the new size.
    // A mouse wheel scrolls a row of tabs sideways, as a trackpad does.
    const wheel = (e: WheelEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.dv-tabs-container');
      if (!row || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
      row.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    host.addEventListener('wheel', wheel, { passive: false });
    // Dockview's overflow menu is clipped by the capsule; use the app menu.
    const more = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.dv-tabs-overflow-dropdown-default');
      const group = btn && d.groups.find((g) => g.element.contains(btn));
      if (!btn || !group) return;
      e.preventDefault();
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      openMenu(
        { clientX: r.left, clientY: r.bottom + 4 },
        group.panels.map((p) => ({
          label: windowLabel(p.id),
          icon: p === group.activePanel ? 'check' : 'hash',
          hint: p.id === 'main' ? t().desk.menu.mainShort : undefined,
          run: () => p.api.setActive(),
        })),
      );
    };
    host.addEventListener('pointerdown', more, true);
    host.addEventListener('click', more, true);
    const resize = new ResizeObserver(() => requestAnimationFrame(onResize));
    resize.observe(host);
    window.addEventListener('beforeunload', saveLayout);
    return () => {
      saveLayout();
      popped.forEach((w) => w.close());
      window.removeEventListener('beforeunload', saveLayout);
      subs.forEach((s) => s.dispose());
      resize.disconnect();
      clearTimeout(unfoldTimer);
      cancelAnimationFrame(fitQueued);
      fitQueued = 0;
      host?.removeEventListener('wheel', wheel);
      host?.removeEventListener('pointerdown', more, true);
      host?.removeEventListener('click', more, true);
      d.dispose();
      dock = null;
      host = null;
      started = false;
    };
  }, []);

  useEffect(() => {
    ensureMain();
    if (started) saveDesk({ last: v });
  }, [v, reopen.value]);

  // Groups arrive just after the session starts.
  useEffect(() => {
    if (started || !groups.value.size) return;
    started = true;
    if (view.value.kind === 'person' && !view.value.channelId) go(startView());
  }, [groups.value]);

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.modal-backdrop')) return;
      // Preserve macOS word-navigation shortcuts in text fields.
      const wordJump = platform === 'darwin' && typing(e) && !!(e.target as HTMLInputElement).value;
      const arrow = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[e.key as 'ArrowLeft'];
      // Moving a window: ⌘⌥+arrow on macOS, Alt+Shift+arrow elsewhere.
      const moving = platform === 'darwin' ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey : e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
      if (moving && arrow && !typing(e)) {
        e.preventDefault();
        moveWindow(arrow);
        return;
      }
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !wordJump) {
        e.preventDefault();
        goBy(e.key === 'ArrowLeft' ? -1 : 1);
      }
      // macOS back/forward shortcuts.
      if (platform === 'darwin' && e.metaKey && !e.altKey && !e.ctrlKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        goBy(e.code === 'BracketLeft' ? -1 : 1);
      }
      if (e.code === 'KeyF' && !e.altKey && !e.ctrlKey && !e.metaKey && !typing(e) && call.value) toggleRoomMode();
      // F6: the next window, its text field focused when it has one.
      if (e.key === 'F6' && dock?.groups.length) {
        e.preventDefault();
        const all = dock.groups;
        const at = all.findIndex((g) => g.element.contains(document.activeElement));
        const next = all[(at + (e.shiftKey ? all.length - 1 : 1) + all.length) % all.length];
        next.activePanel?.api.setActive();
        (next.element.querySelector<HTMLElement>('textarea') ?? next.element.querySelector<HTMLElement>('.dv-tab'))?.focus();
      }
      // Ctrl+W: close the window in front.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyW' && dock?.activePanel) {
        e.preventDefault();
        closeWindow(dock.activePanel.id);
      }
    };
    const mouse = (e: MouseEvent) => !document.querySelector('.modal-backdrop') && (e.button === 3 || e.button === 4) && goBy(e.button === 3 ? -1 : 1);
    // A window out from behind the edge slides back on a click anywhere else.
    const away = (e: PointerEvent) => !document.querySelector('.modal-backdrop') && edgeOpen.value && !(e.target as HTMLElement).closest('.edge-win, .edge-tabs, .menu') && (edgeOpen.value = null);
    window.addEventListener('keydown', keys);
    window.addEventListener('mouseup', mouse);
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('mouseup', mouse);
      window.removeEventListener('pointerdown', away);
    };
  }, []);

  return (
    <div class="workspace">
      <div class="dock dockview-theme-blue" ref={ref} />
      <EdgeTabs />
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
  const search = useSearch();
  useKnownUsers(g.members);
  const query = search.query.trim().toLocaleLowerCase();
  const sorted = g.members.filter((id) => {
    const user = users.value.get(id);
    return !query || `${userName(id)} ${user?.username ?? ''}`.toLocaleLowerCase().includes(query);
  }).sort((a, b) => {
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
      <SearchField search={search} class="member-search" placeholder={t().groups.settings.findMember} />
      {!sorted.length && <div class="muted small">{t().desk.nav.noMatch}</div>}
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

// ---------- settings «Окна» ----------

export function WindowsSettings() {
  const tx = t().desk.settings;
  const p = deskPrefs.value;
  return (
    <>
      <div class="field-label">{tx.call}</div>
      <div class="scheme-cards" role="radiogroup" aria-label={tx.call}>
        {(['replace', 'beside', 'full'] as const).map((how) => (
          <button key={how} role="radio" aria-checked={p.call === how} class={'scheme-card' + (p.call === how ? ' on' : '')} onClick={() => setDeskPrefs({ call: how })}>
            <span class={'scheme ' + how} aria-hidden="true">
              <span class="sc-nav" />
              {how === 'beside' && <span class="sc-chat" />}
              <span class="sc-call" />
              {how !== 'beside' && <span class="sc-chat" />}
            </span>
            <span>{tx[how === 'replace' ? 'callReplace' : how === 'beside' ? 'callBeside' : 'callFull']}</span>
          </button>
        ))}
      </div>
      <p class="hint">{tx.callHint}</p>
      <Toggle checked={p.autoPin !== false} onChange={(autoPin) => setDeskPrefs({ autoPin })} hint={tx.autoPinHint}>
        {tx.autoPin}
      </Toggle>
      <Toggle checked={!!p.keepCall} onChange={(keepCall) => setDeskPrefs({ keepCall })}>
        {tx.keepCall}
      </Toggle>
      <Toggle checked={p.hints !== false} onChange={(hints) => setDeskPrefs({ hints })} hint={tx.hintsHint}>
        {tx.hints}
      </Toggle>
      <div class="settings-actions">
        <button class="secondary" onClick={() => confirmReset()}>
          <Icon name="reset" size={16} /> {t().desk.menu.reset}
        </button>
        <button class="secondary" onClick={startTour}>
          <Icon name="play" size={16} /> {t().desk.tour.replay}
        </button>
      </div>
    </>
  );
}
