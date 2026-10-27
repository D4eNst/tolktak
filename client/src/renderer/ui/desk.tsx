// The desk: windows described once each, a default layout per situation, a few rules, and
// dockview as the engine that places them. A new window or situation is a new entry below.
import { effect } from '@preact/signals';
import { render, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
// The ESM build of dockview-core 8 ships no CSS; this build injects its own.
import { createDockview, type DockviewApi, type DockviewGroupPanel, type SerializedDockview } from 'dockview-core/dist/dockview-core.js';
import type { Group, Room } from '../api';
import { platform } from '../bridge';
import { t } from '../i18n';
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
import { Avatar, confirmDialog, Icon, type MenuItem, openMenu, openMenuAt } from './common';
import { copyText, openProfile, ProfileCard } from './Profile';
import { RoomModeToggle, Stage, toggleRoomMode } from './Stage';

type Kind = View['kind'];
export type WindowId = 'dm' | 'channel' | 'room' | 'call' | 'people' | 'profile';
type Win = {
  name: () => string;
  minWidth: number;
  /** Title in the window frame: icon, name, a muted detail. */
  Head: () => VNode | null;
  Actions?: () => VNode | null;
  Body: () => VNode | null;
};

const dmPeer = () => {
  const cid = viewChannel(view.value);
  return cid ? channels.value.get(cid)?.peer_id : undefined;
};
const viewGroup = () => {
  const v = view.value;
  return v.kind === 'group' || v.kind === 'room' ? groups.value.get(v.groupId) : undefined;
};
const groupChannelName = (g: Group, cid: number) => g.text_channels?.find((c) => c.id === cid)?.name ?? t().shell.group.defaultChannel;
export const groupColor = (id: number) => `var(--user-${id % 8})`;
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

function DmCallButton() {
  const cid = viewChannel(view.value);
  const peer = dmPeer();
  if (!cid || !peer || inCallWith(cid)) return null;
  const others = (voiceRooms.value.get('dm' + cid) ?? []).filter((m) => m.user_id !== me.value?.id);
  const tx = t().shell.dm;
  return (
    <button class={others.length ? 'primary small-btn' : 'icon-btn'} title={others.length ? undefined : tx.call} aria-label={others.length ? tx.joinCall : tx.call} onClick={() => callPerson(cid, others.length > 0)}>
      <Icon name="phone" size={17} /> {others.length ? tx.joinCall : ''}
    </button>
  );
}

export const WINDOWS: Record<WindowId, Win> = {
  dm: {
    name: () => t().desk.windows.dm,
    minWidth: 320,
    Head: () => {
      const peer = dmPeer();
      if (!peer) return <span class="win-title">{t().desk.windows.dm}</span>;
      return (
        <>
          <Avatar id={peer} size={22} showPresence />
          <span class="win-title">{userName(peer)}</span>
          <span class="win-sub">{users.value.get(peer)?.status || (online.value.has(peer) ? t().shell.dm.online : t().shell.dm.offline)}</span>
        </>
      );
    },
    Actions: () => {
      const cid = viewChannel(view.value);
      return cid ? (
        <>
          <DmCallButton />
          <ChatActions channelId={cid} />
        </>
      ) : null;
    },
    Body: () => {
      const cid = viewChannel(view.value);
      const peer = dmPeer();
      if (!cid || !peer) return <Empty text={t().desk.empty.pickChat} />;
      return <ChatView channelId={cid} title={userName(peer)} icon={<Avatar id={peer} size={34} showPresence />} />;
    },
  },
  channel: {
    name: () => t().desk.windows.channel,
    minWidth: 320,
    Head: () => {
      const g = viewGroup();
      const cid = viewChannel(view.value);
      if (!g || !cid) return <span class="win-title">{t().desk.windows.channel}</span>;
      return (
        <>
          <span class="group-dot" style={{ background: groupColor(g.id) }} />
          <Icon name="hash" size={17} class="win-icon" />
          <span class="win-title">{groupChannelName(g, cid)}</span>
          <span class="win-sub">{g.name}</span>
        </>
      );
    },
    Actions: () => {
      const cid = viewChannel(view.value);
      return cid ? <ChatActions channelId={cid} /> : null;
    },
    Body: () => {
      const g = viewGroup();
      const cid = viewChannel(view.value);
      if (!g || !cid) return <Empty text={t().desk.empty.pickChat} />;
      return <ChatView channelId={cid} title={groupChannelName(g, cid)} icon={<Icon name="hash" size={28} />} canModerate={canModerate(g)} />;
    },
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
      const peer = dmPeer();
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

type Saved = { layouts?: Partial<Record<Kind, SerializedDockview>>; nav?: number; last?: View };
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
  if ('channel_id' in c) return go({ kind: 'call', channelId: c.channel_id });
  const g = groupOfRoom(c.room_id);
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
let shownKind: Kind | null = null;
let saveTimer = 0;

function saveLayout() {
  clearTimeout(saveTimer);
  if (dock && shownKind) saveDesk({ layouts: { ...loadDesk().layouts, [shownKind]: dock.toJSON() } });
}

function addWindow(id: WindowId, direction?: 'left' | 'right') {
  return dock!.addPanel({
    id,
    component: id,
    title: WINDOWS[id].name(),
    minimumWidth: WINDOWS[id].minWidth,
    ...(direction && dock!.panels.length ? { position: { direction }, initialWidth: 360 } : {}),
  });
}

/** The situation's own window is always there and in front. */
function ensureMain() {
  const id = SITUATIONS[view.value.kind].main;
  (dock?.getPanel(id) ?? addWindow(id, 'left')).api.setActive();
}

function arrange(kind: Kind) {
  saveLayout();
  shownKind = kind;
  const saved = loadDesk().layouts?.[kind];
  try {
    if (!saved) throw new Error('no saved layout');
    dock!.fromJSON(saved);
  } catch {
    dock!.clear();
    SITUATIONS[kind].layout.forEach((id, i) => addWindow(id, i ? 'right' : undefined));
  }
  ensureMain();
}

export function toggleWindow(id: WindowId) {
  const p = dock?.getPanel(id);
  if (p) p.api.close();
  else addWindow(id, 'right');
}
export function resetLayout() {
  if (!dock || !shownKind) return;
  saveDesk({ layouts: { ...loadDesk().layouts, [shownKind]: undefined } });
  shownKind = null;
  arrange(view.value.kind);
}
export const windowShown = (id: WindowId) => !!dock?.getPanel(id);

function mount(el: HTMLElement, node: () => VNode) {
  return { element: el, init: () => render(node(), el), dispose: () => render(null, el) };
}
function div(cls: string) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function Tab({ id }: { id: string }) {
  const w = WINDOWS[id as WindowId];
  return <div class="win-head">{w ? <w.Head /> : id}</div>;
}

function windowMenu(group: DockviewGroupPanel): MenuItem[] {
  const p = group.activePanel;
  const tx = t().desk.menu;
  const max = group.api.isMaximized();
  return [
    { label: max ? tx.restore : tx.maximize, icon: 'maximize', run: () => (max ? group.api.exitMaximized() : group.api.maximize()) },
    ...(p ? [{ label: tx.close, icon: 'x', run: () => p.api.close() } as MenuItem] : []),
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
  const w = id ? WINDOWS[id as WindowId] : undefined;
  return (
    <>
      {w?.Actions && <w.Actions />}
      <button class="icon-btn" onClick={(e) => openMenuAt(e.currentTarget, windowMenu(group))} title={t().desk.menu.label} aria-label={t().desk.menu.label}>
        <Icon name="more" size={18} />
      </button>
    </>
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
    const d = createDockview(ref.current!, {
      theme: { name: 'blue', className: 'dockview-theme-blue', gap: 10, dndOverlayMounting: 'absolute', dndPanelOverlay: 'group' },
      singleTabMode: 'fullwidth',
      disableTabsOverflowList: true,
      createComponent: ({ name }) => mount(div('win-body'), () => {
        const W = WINDOWS[name as WindowId]?.Body;
        return W ? <W /> : <Empty text="" />;
      }),
      defaultTabComponent: 'win',
      createTabComponent: ({ id }) => mount(div('win-tab'), () => <Tab id={id} />),
      createRightHeaderActionComponent: (group) => mount(div('win-actions'), () => <GroupActions group={group} />),
    });
    dock = d;
    const track = () => (shownWindows.value = new Set(d.groups.map((g) => g.activePanel?.id).filter((x): x is string => !!x)));
    const subs = [
      d.onDidLayoutChange(() => {
        track();
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(saveLayout, 300);
      }),
      d.onDidActivePanelChange(track),
    ];
    window.addEventListener('beforeunload', saveLayout);
    return () => {
      saveLayout();
      window.removeEventListener('beforeunload', saveLayout);
      subs.forEach((s) => s.dispose());
      d.dispose();
      dock = null;
      shownKind = null;
      started = false;
    };
  }, []);

  useEffect(() => {
    if (v.kind !== shownKind) arrange(v.kind);
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

  return <div class="workspace dockview-theme-blue" ref={ref} />;
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
