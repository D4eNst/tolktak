import { signal } from '@preact/signals';
import { cmd, keyLabel } from '../keys';
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
  people,
  serverRestarting,
  session,
  setMuted,
  settingsOpen,
  orphanedMessages,
  switcherOpen,
  toast,
  userName,
  users,
  view,
  viewChannel,
  voiceRooms,
} from '../state';
import { call, deafened, leaveVoice, mediaAllowed, micOn, sharing, speaking, stopShare, toggleDeafen, toggleMic } from '../voice';
import { ContactButton, PeopleList, RequestActions } from './People';
import { useUserList } from './usePeople';
import { SearchField, useSearch, type SearchState } from './search';
import { AddMembersDialog, CreateGroupDialog } from './Dialogs';
import { Avatar, confirmDialog, GroupAvatar, Icon, type MenuItem, openMenu, openMenuAt, Popover } from './common';
import { canModerateRoom, openRestrictions, participantModerationItems } from './Moderation';
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
  // Retain the label through the closing animation.
  const label = useRef('');
  if (c) label.current = c.label;
  return (
    <div class={'capsule' + (c ? ' in-call' : '')}>
      <button class="capsule-room" onClick={openVoice} title={c ? tx.back : undefined} tabIndex={c ? 0 : -1} aria-hidden={!c}>
        <span class={'dot ' + (!c ? 'idle' : c.status === 'connected' ? 'ok live' : 'wait')} />
        <span class="capsule-label ellipsis">{label.current}</span>
      </button>
      <button class={'icon-btn' + (micOn.value ? '' : ' off')} onClick={toggleMic} title={mediaAllowed('microphone') ? micOn.value ? ts.micOff : ts.micOn : t().moderation.permissionDenied('microphone')} aria-label={ts.micLabel} aria-pressed={!micOn.value} disabled={!mediaAllowed('microphone')}>
        <Icon name={micOn.value ? 'mic' : 'micOff'} size={18} />
      </button>
      <button class={'icon-btn' + (deafened.value ? ' off' : '')} onClick={toggleDeafen} title={deafened.value ? ts.soundOn : ts.soundOff} aria-label={ts.soundLabel} aria-pressed={deafened.value}>
        <Icon name={deafened.value ? 'headphonesOff' : 'headphones'} size={18} />
      </button>
      <span class="capsule-extra" aria-hidden={!c}>
        <button class={'icon-btn' + (sharing.value ? ' accent' : '')} onClick={() => (sharing.value ? stopShare() : setPicker(true))} title={mediaAllowed('screen') ? sharing.value ? tx.stopShare : tx.share : t().moderation.permissionDenied('screen')} aria-label={sharing.value ? tx.stopShare : tx.share} tabIndex={c ? 0 : -1} disabled={!mediaAllowed('screen')}>
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
            {orphanedMessages.value.length > 0 && <button onClick={() => (close(), (settingsOpen.value = 'app'))}>
              <Icon name="chat" size={16} /> {t().settings.unsent.title} <span class="badge">{orphanedMessages.value.length}</span>
            </button>}
            <button onClick={() => (close(), (settingsOpen.value = 'profile'))}>
              <Icon name="settings" size={16} /> {tx.settings}
            </button>
            <button
              class="danger-text"
              onClick={async () => {
                close();
                if (await confirmDialog(tx.logOutConfirm, { ok: tx.logOut, danger: true })) leaveVoice().finally(logout);
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
  // Choose the mute duration in a submenu.
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
// Position the submenu at the preceding click.
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
            ...(canModerateRoom(r.id) ? [{ label: t().moderation.restrictions, icon: 'shield', run: () => openRestrictions(r.id) }] : []),
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
        <button class="nav-sub" key={m.user_id} onClick={(e) => openProfile(m.user_id, e.clientX + 10, e.clientY - 60)} onContextMenu={(e) => {
          const items = participantModerationItems(e, r.id, m.user_id);
          if (items.length) openMenu(e, items);
        }}>
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
// null shows all groups; undefined follows the active chat.
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
        <button class="icon-btn tiny" onClick={(e) => openMenuAt(e.currentTarget, groupMenuItems(g, (d) => onDialog(g, d)))} title={t().shell.group.menu} aria-label={t().shell.group.menu}>
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

function NavPeople({ search, onBusy }: { search: SearchState; onBusy(busy: boolean): void }) {
  const v = view.value;
  const store = people.value;
  const [section, setSection] = useState<'dialogs' | 'contacts' | 'requests' | 'all'>('dialogs');
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const tx = t().common.people;
  const q = search.query.trim();
  const dms = new Map([...channels.value.values()].filter((channel) => channel.kind === 'dm').map((channel) => [channel.peer_id!, channel]));
  const mode = section === 'all' ? 'directory' : section === 'requests' ? direction : section === 'dialogs' ? 'dialogs' : 'contact';
  const enabled = !search.pending && !!store && (section === 'dialogs' ? !!q && store.mutual : section !== 'all' || !!q);
  const page = useUserList(mode, q, enabled);
  useEffect(() => { onBusy(page.loading || page.loadingMore); return () => onBusy(false); }, [page.loading, page.loadingMore, onBusy]);
  const localMatch = (id: number) => {
    const user = users.value.get(id);
    return !q || `${user?.display_name ?? ''} ${user?.username ?? ''}`.toLocaleLowerCase().includes(q.toLocaleLowerCase());
  };
  const list = section === 'dialogs' && (!q || !store?.mutual) ? [...dms.keys()].filter(localMatch)
    : section === 'all' && !store ? q ? [...users.value.keys()].filter((id) => id !== me.value?.id && localMatch(id)) : []
    : section === 'contacts' && !store?.mutual ? page.ids.filter(localMatch) : page.ids;
  const serverList = !!store && (section !== 'dialogs' || !!q && store.mutual);
  const sorted = section === 'all' ? list : list.toSorted((a, b) => {
    if (section === 'requests') return (page.order.get(b)?.since ?? 0) - (page.order.get(a)?.since ?? 0) || a - b;
    const last = (dms.get(b)?.last_message?.id ?? 0) - (dms.get(a)?.last_message?.id ?? 0);
    if (section === 'dialogs') return last || (dms.get(b)?.id ?? 0) - (dms.get(a)?.id ?? 0);
    return last || Number(page.order.get(b)?.online) - Number(page.order.get(a)?.online) || (page.order.get(a)?.name ?? '').localeCompare(page.order.get(b)?.name ?? '') || a - b;
  });
  const count = store?.incomingCount.value ?? 0;
  const render = (id: number) => {
    const user = users.value.get(id);
    if (!user) return <div data-user-id={id} class="person-skeleton" aria-label={tx.loading} />;
    const channel = dms.get(id);
    const active = v.kind === 'person' && channel?.id === v.channelId;
    const muted = !!channel && channelMuted(channel);
    const relation = store?.relations.value.get(id);
    return <div data-user-id={id} class={'nav-person-item' + (section === 'requests' ? ' request-item' : '')}>
      <div class="nav-person-row">
        <button class={'nav-person' + (active ? ' active' : '') + (channel?.unread && !muted ? ' unread' : '') + (muted ? ' muted' : '')}
          draggable={!!channel} onDragStart={channel && dragChat(channel.id)}
          onClick={(event) => section === 'requests' ? openProfile(id, event.clientX, event.clientY) : openPerson(id)}
          onContextMenu={(event) => openMenu(event, [
            ...(channel ? besideItems(channel.id) : []),
            { label: t().shell.home.profile, icon: 'user', run: () => openProfile(id, event.clientX, event.clientY) },
            { label: t().shell.self.copyUsername, icon: 'copy', run: () => copyText(user.username, t().shell.self.usernameCopied) },
            ...(channel ? (['sep', ...muteMenuItems('c' + channel.id)] as MenuItem[]) : []),
          ])}>
          <Avatar id={id} size={36} showPresence />
          <span class="nav-person-text">
            <span class="ellipsis nav-person-name">{user.display_name}</span>
            <span class="ellipsis nav-person-sub">{section === 'requests' ? <><Icon name={relation?.state === 'incoming' ? 'arrowDown' : 'external'} size={12} />{relation?.state === 'incoming' ? tx.received : tx.requested}</> : channel?.last_message ? messagePreview(channel.last_message) : user.status || '@' + user.username}</span>
          </span>
          {channel && (voiceRooms.value.get('dm' + channel.id) ?? []).length > 0 && <Icon name="phone" size={14} class="talk" />}
          {muted && <Icon name="bellOff" size={14} class="quiet" />}
          {!!channel?.unread && !muted && <span class="badge inline">{channel.unread}</span>}
        </button>
        {section === 'all' && <ContactButton id={id} compact />}
      </div>
      {section === 'requests' && <RequestActions id={id} />}
    </div>;
  };
  const empty = section === 'all' && !q ? tx.find : q ? t().desk.nav.noMatch : section === 'dialogs' ? tx.noDialogs : section === 'contacts' ? tx.noContacts : direction === 'incoming' ? tx.noIncoming : tx.noOutgoing;
  return <div class="nav-people">
    <div class="seg-toggle people-tabs" role="tablist" aria-label={t().desk.nav.direct}>
      {(['dialogs', 'contacts', 'requests', 'all'] as const).filter((tab) => tab !== 'requests' || store?.mutual).map((tab) => <button key={tab} role="tab" aria-selected={section === tab} class={section === tab ? 'on' : ''} onClick={() => setSection(tab)}>{tx[tab]}{tab === 'requests' && count > 0 && <span class="request-count">{count}</span>}</button>)}
    </div>
    {section === 'requests' && <div class="request-filters" role="tablist" aria-label={tx.requests}>
      {(['incoming', 'outgoing'] as const).map((filter) => <button role="tab" aria-selected={direction === filter} class={direction === filter ? 'on' : ''} onClick={() => setDirection(filter)}>{tx[filter]}{filter === 'incoming' && count > 0 && <span class="request-count">{count}</span>}</button>)}
    </div>}
    <div class={'people-results' + (search.pending ? ' search-stale' : '')} inert={search.pending}>
      <PeopleList key={`${section}:${direction}:${q}`} ids={sorted} render={render} more={() => void page.more()} hasMore={serverList && page.hasMore} loading={search.pending || (serverList && (page.loading || page.loadingMore))} error={serverList ? page.error : null} retry={page.retry} empty={empty} />
    </div>
  </div>;
}

function Navigator() {
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ g: Group; d: 'settings' | 'add' } | null>(null);
  const search = useSearch();
  const [peopleBusy, setPeopleBusy] = useState(false);
  const tx = t().desk.nav;
  const tab = navTab.value;
  const all = [...groups.value.values()];
  const q = search.query.trim().toLowerCase();
  const list = q ? all.filter((g) => g.name.toLowerCase().includes(q)) : all;
  const open = !q && tab === 'groups' ? groups.value.get(shownGroup() ?? -1) : undefined;
  const peopleUnread = (people.value?.incomingCount.value ?? 0) > 0 || [...channels.value.values()].some((c) => c.kind === 'dm' && c.unread && !channelMuted(c));
  const groupsUnread = all.some((g) => groupUnread(g) > 0);
  return (
    <nav class="win navigator" aria-label={tx.label}>
      <div class="nav-top">
        <div class="nav-top-row">
        <div class="seg-toggle nav-tabs" role="tablist">
          {(['groups', 'people'] as const).map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} class={tab === x ? 'on' : ''} onClick={() => { if (navTab.value !== x) search.setText(''); navTab.value = x; }}>
              {x === 'groups' ? tx.groups : tx.direct}
              {(x === 'groups' ? groupsUnread : peopleUnread) && tab !== x && <span class="nav-tab-dot" />}
            </button>
          ))}
        </div>
        <button class="icon-btn tiny" onClick={toggleNav} title={tx.fold + ' (' + keyLabel('Mod \\') + ')'} aria-label={tx.fold}>
          <Icon name="chevronRight" size={16} class="flip" />
        </button>
        </div>
        <SearchField class="nav-search" search={search} busy={tab === 'people' && peopleBusy} placeholder={tab === 'groups' ? tx.findGroup : tx.findPerson} maxLength={256} />
      </div>
      {tab === 'people' ? (
        <NavPeople search={search} onBusy={setPeopleBusy} />
      ) : open ? (
        <div class="nav-split" inert={search.pending}>
          <GroupStrip list={all} current={open.id} />
          <GroupPage g={open} onDialog={(g, d) => setDialog({ g, d })} />
        </div>
      ) : (
        <div class={"nav-scroll" + (search.pending ? " search-stale" : "")} inert={search.pending}>
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
export const navFolded = signal(false);
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
      <button class="icon-btn nav-unfold" onClick={toggleNav} title={tx.unfold + ' (' + keyLabel('Mod \\') + ')'} aria-label={tx.unfold}>
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
      if (e.defaultPrevented || document.querySelector('.modal-backdrop')) return;
      if (cmd(e) && !e.altKey && e.code === 'Backslash') {
        e.preventDefault();
        toggleNav();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  const folded = navFolded.value;
  const clamp = (w: number) => Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, w)));
  const set = (w: number) => {
    const n = clamp(w);
    setNav(n);
    saveDesk({ nav: n });
  };
  const drag = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let n = nav;
    const move = (m: PointerEvent) => setNav((n = clamp(nav + m.clientX - x0)));
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => (el.removeEventListener('pointermove', move), saveDesk({ nav: n })), { once: true });
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
