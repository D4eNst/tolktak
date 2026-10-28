import { signal } from '@preact/signals';
import { cmd } from '../keys';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Group, Room, TextChannel } from '../api';
import { platform } from '../bridge';
import { t } from '../i18n';
import {
  api,
  canModerate,
  channelMuted,
  channels,
  connection,
  errorText,
  go,
  groupRole,
  groups,
  isMuted,
  logout,
  me,
  messagePreview,
  online,
  serverRestarting,
  session,
  setMuted,
  settingsOpen,
  switcherOpen,
  toast,
  userName,
  users,
  view,
  viewChannel,
  voiceRooms,
} from '../state';
import { call, deafened, leaveVoice, micOn, sharing, speaking, stopShare, toggleDeafen, toggleMic } from '../voice';
import { AddMembersDialog, CreateGroupDialog } from './Dialogs';
import { Avatar, confirmDialog, GroupAvatar, Icon, type MenuItem, openMenu, openMenuAt, Popover } from './common';
import { CHAT_DRAG, enterRoom, loadDesk, openBeside, openPerson, openRoom, openVoice, ROOM_DRAG, saveDesk, Workspace } from './desk';
import { createRoom, createTextChannel, deleteRoom, deleteTextChannel, GroupSettingsDialog, renameRoom, renameTextChannel } from './GroupSettings';
import { copyText, openProfile, ProfileCard } from './Profile';
import { SharePicker } from './SharePicker';

const roomKey = (r: Room) => `g${r.group_id}r${r.id}`;
const groupTextChannels = (g: Group): TextChannel[] => (g.text_channels?.length ? g.text_channels : [{ id: g.channel_id, name: t().shell.group.defaultChannel, position: 0 }]);
const inRoom = (r: Room) => !!call.value && 'room_id' in call.value.target && call.value.target.room_id === r.id;
const besideItems = (cid: number): MenuItem[] => [
  { label: t().desk.menu.openBeside, icon: 'copy', run: () => openBeside(cid) },
  'sep',
];
const dragChat = (cid: number) => (e: DragEvent) => e.dataTransfer?.setData(CHAT_DRAG, String(cid));

// ---------- top bar ----------

function VoiceCapsule() {
  const c = call.value;
  const [picker, setPicker] = useState(false);
  const tx = t().desk.voice;
  const ts = t().shell.self;
  // The label outlives the call so it can fade out while the capsule closes.
  const label = useRef('');
  if (c) label.current = c.label;
  return (
    <div class={'capsule' + (c ? ' in-call' : '')}>
      <button class="capsule-room" onClick={openVoice} title={c ? tx.back : undefined} tabIndex={c ? 0 : -1} aria-hidden={!c}>
        <span class={'dot ' + (!c ? 'idle' : c.status === 'connected' ? 'ok live' : 'wait')} />
        <span class="capsule-label ellipsis">{label.current}</span>
      </button>
      <button class={'icon-btn' + (micOn.value ? '' : ' off')} onClick={toggleMic} title={micOn.value ? ts.micOff : ts.micOn} aria-label={ts.micLabel} aria-pressed={!micOn.value}>
        <Icon name={micOn.value ? 'mic' : 'micOff'} size={18} />
      </button>
      <button class={'icon-btn' + (deafened.value ? ' off' : '')} onClick={toggleDeafen} title={deafened.value ? ts.soundOn : ts.soundOff} aria-label={ts.soundLabel} aria-pressed={deafened.value}>
        <Icon name={deafened.value ? 'headphonesOff' : 'headphones'} size={18} />
      </button>
      <span class="capsule-extra" aria-hidden={!c}>
        <button class={'icon-btn' + (sharing.value ? ' accent' : '')} onClick={() => (sharing.value ? stopShare() : setPicker(true))} title={sharing.value ? tx.stopShare : tx.share} aria-label={sharing.value ? tx.stopShare : tx.share} tabIndex={c ? 0 : -1}>
          <Icon name="screen" size={18} />
        </button>
        <button class="icon-btn leave" onClick={leaveVoice} title={tx.leave} aria-label={tx.leave} tabIndex={c ? 0 : -1}>
          <Icon name="phoneOff" size={18} />
        </button>
      </span>
      {picker && <SharePicker onClose={() => setPicker(false)} />}
    </div>
  );
}

function AvatarMenu() {
  const u = me.value;
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null);
  if (!u) return null;
  const tx = t().shell.self;
  const close = () => setPop(null);
  const conn = connection.value;
  return (
    <>
      <button class="topbar-avatar" onClick={(e) => setPop({ x: e.clientX - 330, y: e.clientY + 24 })} title={tx.profile} aria-label={tx.profile}>
        <Avatar id={u.id} size={34} showPresence speaking={!!call.value && speaking.value.has(String(u.id))} />
        {conn !== 'online' && <span class="topbar-conn">{conn === 'connecting' ? tx.connecting : tx.offline}</span>}
      </button>
      {pop && (
        <Popover x={pop.x} y={pop.y} onClose={close} class="profile-pop">
          <ProfileCard id={u.id} onClose={close} />
          <div class="self-menu">
            <button onClick={() => (close(), copyText(u.username, tx.usernameCopied))}>
              <Icon name="copy" size={16} /> {tx.copyUsername}
            </button>
            <button onClick={() => (close(), (settingsOpen.value = 'profile'))}>
              <Icon name="settings" size={16} /> {tx.settings}
            </button>
            <button
              class="danger-text"
              onClick={async () => {
                close();
                if (await confirmDialog(tx.logOutConfirm, { ok: tx.logOut, danger: true })) logout();
              }}
            >
              <Icon name="logout" size={16} /> {tx.logOut}
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}

export function TitleBar() {
  const s = session.value;
  return (
    <header class={'topbar ' + platform}>
      <span class="logo-mark" aria-hidden="true" />
      <span class="topbar-name">TolkTak</span>
      {s && (
        <>
          <button class="topbar-search" onClick={() => (switcherOpen.value = true)}>
            <Icon name="search" size={16} />
            <span>{t().desk.search}</span>
          </button>
          <div class="topbar-spacer" />
          <VoiceCapsule />
          <AvatarMenu />
        </>
      )}
    </header>
  );
}

// ---------- navigator ----------

const HOUR = 3600_000;
function muteMenuItems(key: string): MenuItem[] {
  const tx = t().shell.notifications;
  if (isMuted(key)) return [{ label: tx.unmute, icon: 'bell', run: () => setMuted(key, null) }];
  // One item, then how long: a menu of three near-identical lines is hard to read.
  return [
    {
      label: t().desk.menu.muteFor,
      icon: 'bellOff',
      run: () =>
        setTimeout(() => {
          openMenu({ clientX: lastMenuPoint.x, clientY: lastMenuPoint.y }, [
            { label: tx.mute1h, icon: 'bellOff', run: () => setMuted(key, Date.now() + HOUR) },
            { label: tx.mute8h, icon: 'bellOff', run: () => setMuted(key, Date.now() + 8 * HOUR) },
            { label: tx.muteForever, icon: 'bellOff', run: () => setMuted(key, 0) },
          ]);
        }),
    },
  ];
}
// Where the last menu item was clicked: the follow-up menu opens there.
const lastMenuPoint = { x: 0, y: 0 };
window.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest?.('.menu')) Object.assign(lastMenuPoint, { x: e.clientX, y: e.clientY });
}, true);

function groupMenuItems(g: Group, open: (d: 'settings' | 'add') => void): MenuItem[] {
  const role = groupRole(g);
  const mod = role !== 'member';
  const tx = t().shell.group;
  const tc = t().groups.channels;
  return [
    ...(mod
      ? ([
          { label: tx.invite, icon: 'userPlus', run: () => open('add') },
          { label: tx.settings, icon: 'settings', run: () => open('settings') },
          { label: tc.newTextChannel, icon: 'hash', run: () => createTextChannel(g) },
          { label: tc.newVoiceRoom, icon: 'speaker', run: () => createRoom(g) },
          'sep',
        ] as MenuItem[])
      : []),
    ...muteMenuItems('g' + g.id),
    'sep',
    role === 'owner'
      ? {
          label: tx.deleteGroup,
          icon: 'trash',
          danger: true,
          run: async () => {
            if (await confirmDialog(tx.deleteGroupConfirm(g.name), { text: tx.deleteGroupText, ok: tx.deleteForever, danger: true }))
              api().deleteGroup(g.id).catch((e) => toast(errorText(e), 'error'));
          },
        }
      : {
          label: tx.leaveGroup,
          icon: 'door',
          danger: true,
          run: async () => {
            if (!(await confirmDialog(tx.leaveGroupConfirm(g.name), { text: tx.leaveGroupText, ok: tx.leave, danger: true }))) return;
            try {
              await api().removeMember(g.id, me.value!.id);
            } catch (e) {
              toast(errorText(e), 'error');
            }
          },
        },
  ];
}

function RoomItem({ g, r, mod }: { g: Group; r: Room; mod: boolean }) {
  const members = voiceRooms.value.get(roomKey(r)) ?? [];
  const here = inRoom(r);
  const tx = t().shell.group;
  const menu = (e: MouseEvent) =>
    openMenu(e, [
      here ? { label: t().desk.voice.leave, icon: 'phoneOff', danger: true, run: leaveVoice } : { label: tx.joinRoom, icon: 'speaker', run: () => enterRoom(g, r) },
      { label: t().desk.menu.openBeside, icon: 'copy', run: () => openRoom(r.id) },
      ...(mod
        ? ([
            'sep',
            { label: t().groups.channels.rename, icon: 'edit', run: () => renameRoom(r) },
            ...(g.rooms.length > 1 ? [{ label: tx.deleteRoom, icon: 'trash', danger: true, run: () => deleteRoom(r) } as MenuItem] : []),
          ] as MenuItem[])
        : []),
    ]);
  return (
    <>
      <button class={'nav-row' + (here ? ' active' : '')} onClick={() => enterRoom(g, r)} onContextMenu={menu} title={here ? tx.openRoom : tx.joinRoom} draggable onDragStart={(e) => e.dataTransfer?.setData(ROOM_DRAG, String(r.id))}>
        <Icon name="speaker" size={17} class={members.length ? 'talk' : 'quiet'} />
        <span class="ellipsis">{r.name}</span>
        {here ? <span class="nav-note">{t().desk.nav.youAreHere}</span> : members.length > 0 && <span class="nav-note">{members.length}</span>}
      </button>
      {members.map((m) => (
        <button class="nav-sub" key={m.user_id} onClick={(e) => openProfile(m.user_id, e.clientX + 10, e.clientY - 60)}>
          <Avatar id={m.user_id} size={20} speaking={here && speaking.value.has(String(m.user_id))} />
          <span class="ellipsis">{userName(m.user_id)}</span>
          <span class="nav-sub-icons">
            {m.screen && <Icon name="screen" size={14} class="live-icon" />}
            {m.camera && <Icon name="video" size={14} />}
            {m.muted && <Icon name="micOff" size={14} />}
            {m.deafened && <Icon name="headphonesOff" size={14} />}
          </span>
        </button>
      ))}
    </>
  );
}

function ChannelItem({ g, c, mod }: { g: Group; c: TextChannel; mod: boolean }) {
  const v = view.value;
  const unread = channels.value.get(c.id)?.unread ?? 0;
  const muted = isMuted('c' + c.id) || isMuted('g' + g.id);
  const active = v.kind === 'group' && v.groupId === g.id && viewChannel(v) === c.id;
  const tx = t().shell.group;
  const tc = t().groups.channels;
  return (
    <button
      class={'nav-row' + (active ? ' active' : '') + (unread && !muted ? ' unread' : '') + (muted ? ' muted' : '')}
      onClick={() => go({ kind: 'group', groupId: g.id, channelId: c.id })}
      draggable
      onDragStart={dragChat(c.id)}
      onContextMenu={(e) =>
        openMenu(e, [
          ...besideItems(c.id),
          ...muteMenuItems('c' + c.id),
          ...(mod
            ? ([
                'sep',
                { label: tc.rename, icon: 'edit', run: () => renameTextChannel(c) },
                ...(c.id !== g.channel_id ? [{ label: tx.deleteChannel, icon: 'trash', danger: true, run: () => deleteTextChannel(c) } as MenuItem] : []),
              ] as MenuItem[])
            : []),
        ])
      }
    >
      <Icon name="hash" size={17} class="quiet" />
      <span class="ellipsis">{c.name}</span>
      {muted && <Icon name="bellOff" size={14} class="quiet" />}
      {unread > 0 && !muted && <span class="badge inline">{unread}</span>}
    </button>
  );
}

const groupUnread = (g: Group) =>
  groupTextChannels(g).reduce((n, c) => {
    const ch = channels.value.get(c.id);
    return n + (ch && !channelMuted(ch) ? ch.unread : 0);
  }, 0);
const groupLive = (g: Group) => g.rooms.some((r) => (voiceRooms.value.get(roomKey(r)) ?? []).length > 0);

const navTab = signal<'groups' | 'people'>('groups');
// The group whose page the navigator shows: null is the list of groups, undefined follows the open chat.
const navGroup = signal<number | null | undefined>(undefined);
const shownGroup = () => {
  const v = view.value;
  return navGroup.value !== undefined ? navGroup.value : v.kind === 'group' ? v.groupId : null;
};
function openGroup(g: Group) {
  navGroup.value = g.id;
  const v = view.value;
  go({ kind: 'group', groupId: g.id, channelId: v.kind === 'group' && v.groupId === g.id ? v.channelId : undefined });
}

function GroupRow({ g }: { g: Group }) {
  const unread = groupUnread(g);
  return (
    <button class={'nav-grouprow' + (unread ? ' unread' : '')} onClick={() => openGroup(g)}>
      <GroupAvatar id={g.id} size={34} />
      <span class="ellipsis nav-person-name">{g.name}</span>
      {groupLive(g) && <Icon name="speaker" size={15} class="talk" />}
      {unread > 0 && <span class="badge inline">{unread}</span>}
    </button>
  );
}

function GroupStrip({ list, current }: { list: Group[]; current: number }) {
  return (
    <div class="nav-strip">
      {list.map((g) => (
        <button key={g.id} class={'nav-strip-item' + (g.id === current ? ' active' : '')} onClick={() => openGroup(g)} title={g.name} aria-label={g.name}>
          <GroupAvatar id={g.id} size={36} />
          {groupUnread(g) > 0 && <span class="nav-strip-dot unread" />}
          {groupLive(g) && <span class="nav-strip-dot live" />}
        </button>
      ))}
    </div>
  );
}

function GroupPage({ g, onDialog }: { g: Group; onDialog: (g: Group, d: 'settings' | 'add') => void }) {
  const mod = canModerate(g);
  const tx = t().desk.nav;
  const tc = t().groups.channels;
  return (
    <div class="nav-page">
      <div class="nav-page-head">
        <button class="icon-btn tiny nav-back" onClick={() => (navGroup.value = null)} title={tx.back} aria-label={tx.back}>
          <Icon name="chevronRight" size={16} />
        </button>
        <span class="ellipsis nav-page-name">{g.name}</span>
        <button class="icon-btn tiny" onClick={(e) => openMenuAt(e.currentTarget, groupMenuItems(g, (d) => onDialog(g, d)))} title={t().desk.menu.label} aria-label={t().desk.menu.label}>
          <Icon name="more" size={16} />
        </button>
      </div>
      <div class="nav-scroll">
        <div class="nav-sec">
          {tx.channels}
          {mod && (
            <button class="icon-btn tiny" onClick={() => createTextChannel(g)} title={tc.newTextChannel} aria-label={tc.newTextChannel}>
              <Icon name="plus" size={15} />
            </button>
          )}
        </div>
        {groupTextChannels(g).map((c) => (
          <ChannelItem key={c.id} g={g} c={c} mod={mod} />
        ))}
        <div class="nav-sec">
          {tx.rooms}
          {mod && (
            <button class="icon-btn tiny" onClick={() => createRoom(g)} title={tc.newVoiceRoom} aria-label={tc.newVoiceRoom}>
              <Icon name="plus" size={15} />
            </button>
          )}
        </div>
        {g.rooms.map((r) => (
          <RoomItem key={r.id} g={g} r={r} mod={mod} />
        ))}
      </div>
    </div>
  );
}

function NavPeople({ query }: { query: string }) {
  const v = view.value;
  const myId = me.value?.id;
  const tx = t().shell.home;
  const q = query.trim().toLowerCase();
  const dms = new Map([...channels.value.values()].filter((c) => c.kind === 'dm').map((c) => [c.peer_id, c]));
  const people = [...users.value.values()]
    .filter((u) => u.id !== myId && (!q || u.display_name.toLowerCase().includes(q) || u.username.includes(q)))
    .sort((a, b) => {
      const ca = dms.get(a.id)?.last_message?.id ?? 0;
      const cb = dms.get(b.id)?.last_message?.id ?? 0;
      if (ca !== cb) return cb - ca;
      return Number(online.value.has(b.id)) - Number(online.value.has(a.id)) || a.display_name.localeCompare(b.display_name);
    });
  if (!people.length) return <div class="nav-empty muted small">{q ? t().desk.nav.noMatch : tx.noUsers}</div>;
  return (
    <>
      {people.map((u) => {
        const ch = dms.get(u.id);
        const active = v.kind === 'person' && !!ch && v.channelId === ch.id;
        const inCall = ch && (voiceRooms.value.get('dm' + ch.id) ?? []).length > 0;
        const muted = !!ch && channelMuted(ch);
        return (
          <button
            key={u.id}
            class={'nav-person' + (active ? ' active' : '') + (ch?.unread && !muted ? ' unread' : '') + (muted ? ' muted' : '')}
            onClick={() => openPerson(u.id)}
            draggable={!!ch}
            onDragStart={ch && dragChat(ch.id)}
            onContextMenu={(e) =>
              openMenu(e, [
                ...(ch ? besideItems(ch.id) : []),
                { label: tx.profile, icon: 'user', run: () => openProfile(u.id, e.clientX, e.clientY) },
                { label: t().shell.self.copyUsername, icon: 'copy', run: () => copyText(u.username, t().shell.self.usernameCopied) },
                ...(ch ? (['sep', ...muteMenuItems('c' + ch.id)] as MenuItem[]) : []),
              ])
            }
          >
            <Avatar id={u.id} size={36} showPresence />
            <span class="nav-person-text">
              <span class="ellipsis nav-person-name">{u.display_name}</span>
              <span class="ellipsis nav-person-sub">{ch?.last_message ? messagePreview(ch.last_message) : u.status || '@' + u.username}</span>
            </span>
            {inCall && <Icon name="phone" size={14} class="talk" />}
            {muted && <Icon name="bellOff" size={14} class="quiet" />}
            {!!ch?.unread && !muted && <span class="badge inline">{ch.unread}</span>}
          </button>
        );
      })}
    </>
  );
}

function Navigator() {
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ g: Group; d: 'settings' | 'add' } | null>(null);
  const [query, setQuery] = useState('');
  const tx = t().desk.nav;
  const tab = navTab.value;
  const all = [...groups.value.values()];
  const q = query.trim().toLowerCase();
  const list = q ? all.filter((g) => g.name.toLowerCase().includes(q)) : all;
  const open = !q && tab === 'groups' ? groups.value.get(shownGroup() ?? -1) : undefined;
  const peopleUnread = [...channels.value.values()].some((c) => c.kind === 'dm' && c.unread && !channelMuted(c));
  const groupsUnread = all.some((g) => groupUnread(g) > 0);
  return (
    <nav class="win navigator" aria-label={tx.label}>
      <div class="nav-top">
        <div class="nav-top-row">
        <div class="seg-toggle nav-tabs" role="tablist">
          {(['groups', 'people'] as const).map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} class={tab === x ? 'on' : ''} onClick={() => (navTab.value = x)}>
              {x === 'groups' ? tx.groups : tx.direct}
              {(x === 'groups' ? groupsUnread : peopleUnread) && tab !== x && <span class="nav-tab-dot" />}
            </button>
          ))}
        </div>
        <button class="icon-btn tiny" onClick={toggleNav} title={tx.fold} aria-label={tx.fold}>
          <Icon name="chevronRight" size={16} class="flip" />
        </button>
        </div>
        <div class="nav-search">
          <Icon name="search" size={15} />
          <input value={query} onInput={(e) => setQuery(e.currentTarget.value)} placeholder={tab === 'groups' ? tx.findGroup : tx.findPerson} aria-label={tab === 'groups' ? tx.findGroup : tx.findPerson} />
        </div>
      </div>
      {tab === 'people' ? (
        <div class="nav-scroll">
          <NavPeople query={query} />
        </div>
      ) : open ? (
        <div class="nav-split">
          <GroupStrip list={all} current={open.id} />
          <GroupPage g={open} onDialog={(g, d) => setDialog({ g, d })} />
        </div>
      ) : (
        <div class="nav-scroll">
          {list.map((g) => (
            <GroupRow key={g.id} g={g} />
          ))}
          {q && list.length === 0 && <div class="nav-empty muted small">{tx.noMatch}</div>}
          {!q && (
            <button class={all.length ? 'nav-newgroup' : 'nav-create'} onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> {all.length ? tx.newGroup : tx.createFirst}
            </button>
          )}
        </div>
      )}
      {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
      {dialog?.d === 'settings' && groups.value.get(dialog.g.id) && <GroupSettingsDialog group={groups.value.get(dialog.g.id)!} onClose={() => setDialog(null)} />}
      {dialog?.d === 'add' && groups.value.get(dialog.g.id) && <AddMembersDialog group={groups.value.get(dialog.g.id)!} onClose={() => setDialog(null)} />}
    </nav>
  );
}

// ---------- the frame ----------

const NAV_MIN = 220;
const NAV_MAX = 440;

// Ctrl+\ folds the navigator into a strip of avatars and back.
const navFolded = signal(false);
export const toggleNav = () => {
  navFolded.value = !navFolded.value;
  saveDesk({ navFolded: navFolded.value });
};

function NavRail() {
  const v = view.value;
  const tx = t().desk.nav;
  const dms = [...channels.value.values()]
    .filter((c) => c.kind === 'dm' && c.peer_id)
    .sort((a, b) => (b.last_message?.id ?? 0) - (a.last_message?.id ?? 0))
    .slice(0, 8);
  return (
    <nav class="win navigator nav-rail" aria-label={tx.label}>
      <button class="icon-btn nav-unfold" onClick={toggleNav} title={tx.unfold} aria-label={tx.unfold}>
        <Icon name="chevronRight" size={18} />
      </button>
      <div class="nav-rail-list">
        {[...groups.value.values()].map((g) => (
          <button key={g.id} class={'nav-strip-item' + (v.kind === 'group' && v.groupId === g.id ? ' active' : '')} onClick={() => openGroup(g)} title={g.name} aria-label={g.name}>
            <GroupAvatar id={g.id} size={36} />
            {groupUnread(g) > 0 && <span class="nav-strip-dot unread" />}
            {groupLive(g) && <span class="nav-strip-dot live" />}
          </button>
        ))}
        <span class="nav-rail-sep" />
        {dms.map((c) => (
          <button key={c.id} class={'nav-strip-item' + (v.kind === 'person' && v.channelId === c.id ? ' active' : '')} onClick={() => openPerson(c.peer_id!)} title={userName(c.peer_id!)} aria-label={userName(c.peer_id!)}>
            <Avatar id={c.peer_id!} size={36} showPresence />
            {c.unread > 0 && !channelMuted(c) && <span class="nav-strip-dot unread" />}
          </button>
        ))}
      </div>
    </nav>
  );
}

export function Shell() {
  const [nav, setNav] = useState(() => loadDesk().nav ?? 300);
  useEffect(() => {
    navFolded.value = !!loadDesk().navFolded;
    const keys = (e: KeyboardEvent) => {
      if (cmd(e) && !e.altKey && e.code === 'Backslash') {
        e.preventDefault();
        toggleNav();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  const folded = navFolded.value;
  const set = (w: number) => {
    const n = Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, w)));
    setNav(n);
    saveDesk({ nav: n });
  };
  const drag = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = nav;
    const move = (m: PointerEvent) => set(w0 + m.clientX - x0);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
  };
  return (
    <div class="shell" style={{ '--nav-w': (folded ? 64 : nav) + 'px' }}>
      {connection.value === 'offline' && <div class="banner">{serverRestarting.value === null ? t().shell.offlineBanner : t().shell.restartingBanner(serverRestarting.value)}</div>}
      <div class="desk">
        <div class="persistent">{folded ? <NavRail /> : <Navigator />}</div>
        <div
          hidden={folded}
          class="nav-sash"
          role="separator"
          aria-orientation="vertical"
          aria-label={t().desk.nav.resize}
          aria-valuenow={nav}
          aria-valuemin={NAV_MIN}
          aria-valuemax={NAV_MAX}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={(e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && set(nav + (e.key === 'ArrowLeft' ? -16 : 16))}
        />
        <Workspace />
      </div>
    </div>
  );
}
