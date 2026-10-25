import { useState } from 'preact/hooks';
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
  groupRole,
  groups,
  isMuted,
  logout,
  me,
  messagePreview,
  online,
  openDM,
  serverRestarting,
  session,
  setMuted,
  settingsOpen,
  switcherOpen,
  toast,
  userName,
  users,
  view,
  voiceRooms,
} from '../state';
import { call, deafened, joinVoice, leaveVoice, micOn, prefs, sharing, speaking, startCall, toggleDeafen, toggleMic } from '../voice';
import { ChatView } from './Chat';
import { AddMembersDialog, CreateGroupDialog } from './Dialogs';
import { Avatar, confirmDialog, GroupAvatar, Icon, type MenuItem, openMenu, openMenuAt, Popover } from './common';
import { createRoom, createTextChannel, deleteRoom, deleteTextChannel, GroupSettingsDialog, renameRoom, renameTextChannel } from './GroupSettings';
import { copyText, openProfile, ProfileCard } from './Profile';
import { Stage } from './Stage';

const roomKey = (r: Room) => `g${r.group_id}r${r.id}`;

const groupTextChannels = (g: Group): TextChannel[] => (g.text_channels?.length ? g.text_channels : [{ id: g.channel_id, name: t().shell.group.defaultChannel, position: 0 }]);

export function TitleBar() {
  const s = session.value;
  return (
    <div class={'titlebar ' + platform}>
      <div class="titlebar-brand">
        <span class="logo-mark" aria-hidden="true" />
        <span class="titlebar-name">TolkTak</span>
        {s && <span class="titlebar-server">{s.server.name}</span>}
      </div>
      {s && (
        <button class="titlebar-search" onClick={() => (switcherOpen.value = true)}>
          <Icon name="search" size={14} />
          <span>{t().shell.titleBar.search}</span>
          <kbd>Ctrl K</kbd>
        </button>
      )}
      <div class="titlebar-spacer" />
    </div>
  );
}

function Rail() {
  const v = view.value;
  const [creating, setCreating] = useState(false);
  const tx = t().shell.rail;
  const dmUnread = [...channels.value.values()].filter((c) => c.kind === 'dm' && !channelMuted(c)).reduce((n, c) => n + c.unread, 0);
  return (
    <nav class="rail" aria-label={tx.label}>
      <button class={'rail-btn home' + (v.kind === 'home' ? ' active' : '')} onClick={() => (view.value = { kind: 'home' })} title={tx.directMessages}>
        <span class="rail-pill" />
        <Icon name="chat" size={22} />
        {dmUnread > 0 && <span class="badge">{dmUnread > 99 ? '99+' : dmUnread}</span>}
      </button>
      <div class="rail-sep" />
      {[...groups.value.values()].map((g) => {
        const unread = [g.channel_id, ...(g.text_channels ?? []).map((c) => c.id)]
          .filter((id, i, a) => a.indexOf(id) === i)
          .map((id) => channels.value.get(id))
          .reduce((n, c) => n + (c && !channelMuted(c) ? c.unread : 0), 0);
        const live = g.rooms.some((r) => (voiceRooms.value.get(roomKey(r)) ?? []).length > 0);
        const active = v.kind === 'group' && v.groupId === g.id;
        return (
          <button
            key={g.id}
            class={'rail-btn group' + (active ? ' active' : '') + (unread ? ' has-unread' : '')}
            onClick={() => (view.value = { kind: 'group', groupId: g.id })}
            title={g.name}
          >
            <span class="rail-pill" />
            <GroupAvatar id={g.id} size={44} />
            {unread > 0 && <span class="badge">{unread > 99 ? '99+' : unread}</span>}
            {live && <span class="rail-live" title={tx.voiceActive} />}
          </button>
        );
      })}
      <button class="rail-btn add" onClick={() => setCreating(true)} title={tx.newGroup} aria-label={tx.newGroup}>
        <Icon name="plus" size={22} />
      </button>
      {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
    </nav>
  );
}

function SelfPanel() {
  const u = me.value;
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null);
  if (!u) return null;
  const tx = t().shell.self;
  const ptt = prefs.value.micMode === 'ptt';
  const conn = connection.value;
  return (
    <div class="self-panel">
      <button class="self-id" onClick={(e) => setPop({ x: e.clientX, y: e.clientY - 420 })} title={tx.profile}>
        <Avatar id={u.id} size={36} showPresence speaking={!!call.value && speaking.value.has(String(u.id))} />
        <span class="self-text">
          <span class="self-name ellipsis">{u.display_name}</span>
          <span class="self-sub ellipsis">{conn === 'online' ? u.status || '@' + u.username : conn === 'connecting' ? tx.connecting : tx.offline}</span>
        </span>
      </button>
      <button
        class={'icon-btn' + (micOn.value ? '' : ' off')}
        onClick={toggleMic}
        title={micOn.value ? tx.micOff : tx.micOn}
        aria-label={tx.micLabel}
        aria-pressed={!micOn.value}
      >
        <Icon name={micOn.value ? 'mic' : 'micOff'} size={19} />
        {ptt && micOn.value && <span class="ptt-tag">PTT</span>}
      </button>
      <button class={'icon-btn' + (deafened.value ? ' off' : '')} onClick={toggleDeafen} title={deafened.value ? tx.soundOn : tx.soundOff} aria-label={tx.soundLabel} aria-pressed={deafened.value}>
        <Icon name={deafened.value ? 'headphonesOff' : 'headphones'} size={19} />
      </button>
      <button class="icon-btn" onClick={() => (settingsOpen.value = 'voice')} title={tx.settings} aria-label={tx.settings}>
        <Icon name="settings" size={19} />
      </button>
      {pop && (
        <Popover x={pop.x} y={pop.y} onClose={() => setPop(null)} class="profile-pop">
          <ProfileCard id={u.id} onClose={() => setPop(null)} />
          <div class="self-menu">
            <button onClick={() => (setPop(null), copyText(u.username, tx.usernameCopied))}>
              <Icon name="copy" size={16} /> {tx.copyUsername}
            </button>
            <button onClick={() => (setPop(null), (settingsOpen.value = 'profile'))}>
              <Icon name="settings" size={16} /> {tx.settings}
            </button>
            <button
              class="danger-text"
              onClick={async () => {
                setPop(null);
                if (await confirmDialog(tx.logOutConfirm, { ok: tx.logOut, danger: true })) logout();
              }}
            >
              <Icon name="logout" size={16} /> {tx.logOut}
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}

function CallCard() {
  const c = call.value;
  if (!c) return null;
  const st = c.status;
  const tx = t().shell.callCard;
  return (
    <div class="call-card pop-in">
      <div class="call-card-info">
        <span class={'dot ' + (st === 'connected' ? 'ok' : 'wait')} />
        <div class="call-card-text">
          <div class={'call-state ' + (st === 'connected' ? 'ok' : 'wait')}>
            {st === 'connected' ? tx.connected : st === 'ringing' ? tx.ringing : st === 'reconnecting' ? tx.reconnecting : tx.connecting}
          </div>
          <button class="link small ellipsis" onClick={() => openCallView()}>
            {c.label}
          </button>
          {sharing.value && <div class="small live-text">{tx.live}</div>}
        </div>
      </div>
      <button class="icon-btn danger" onClick={leaveVoice} title={tx.disconnect} aria-label={tx.leaveVoice}>
        <Icon name="phoneOff" size={19} />
      </button>
    </div>
  );
}

// "voicebar" is the class the e2e tests look for.
function Dock() {
  return (
    <div class="dock voicebar">
      <div class="voicebar-call">
        <CallCard />
      </div>
      <SelfPanel />
    </div>
  );
}

function openCallView() {
  const c = call.value;
  if (!c) return;
  if ('room_id' in c.target) {
    const rid = c.target.room_id;
    const g = [...groups.value.values()].find((x) => x.rooms.some((r) => r.id === rid));
    if (g) view.value = { kind: 'group', groupId: g.id, stage: true };
  } else view.value = { kind: 'home', channelId: c.target.channel_id };
}

function HomeSidebar() {
  const v = view.value;
  const [q, setQ] = useState('');
  const myId = me.value?.id;
  const tx = t().shell.home;
  const dms = new Map([...channels.value.values()].filter((c) => c.kind === 'dm').map((c) => [c.peer_id, c]));
  const people = [...users.value.values()]
    .filter((u) => u.id !== myId && (u.display_name.toLowerCase().includes(q.toLowerCase()) || u.username.includes(q.toLowerCase())))
    .sort((a, b) => {
      const ca = dms.get(a.id)?.last_message?.id ?? 0;
      const cb = dms.get(b.id)?.last_message?.id ?? 0;
      if (ca !== cb) return cb - ca;
      return Number(online.value.has(b.id)) - Number(online.value.has(a.id)) || a.display_name.localeCompare(b.display_name);
    });
  return (
    <aside class="sidebar">
      <header class="side-head">
        <div class="side-title">{tx.title}</div>
        <div class="side-search-wrap">
          <Icon name="search" size={15} />
          <input class="side-search" placeholder={tx.searchPlaceholder} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
      </header>
      <div class="side-list">
        <div class="side-label">
          <span>{tx.people}</span>
          <span class="side-label-count">{tx.onlineCount(people.filter((p) => online.value.has(p.id)).length)}</span>
        </div>
        {people.map((u) => {
          const ch = dms.get(u.id);
          const active = v.kind === 'home' && ch && v.channelId === ch.id;
          const inCall = ch && (voiceRooms.value.get('dm' + ch.id) ?? []).length > 0;
          const sub = ch?.last_message ? messagePreview(ch.last_message) : u.status || '@' + u.username;
          return (
            <button
              key={u.id}
              class={'side-item person' + (active ? ' active' : '') + (ch?.unread ? ' unread' : '') + (ch && channelMuted(ch) ? ' muted' : '')}
              onClick={() => openDM(u.id).catch((e) => toast(errorText(e), 'error'))}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: tx.profile, icon: 'user', run: () => openProfile(u.id, e.clientX, e.clientY) },
                  { label: tx.call, icon: 'phone', run: async () => startCall((await openDM(u.id)).id, u.display_name).catch((er) => toast(errorText(er), 'error')) },
                  { label: t().shell.self.copyUsername, icon: 'copy', run: () => copyText(u.username, t().shell.self.usernameCopied) },
                  ...(ch ? (['sep', ...muteMenuItems('c' + ch.id)] as MenuItem[]) : []),
                ])
              }
            >
              <Avatar id={u.id} size={36} showPresence />
              <span class="side-item-main">
                <span class="side-item-name">{u.display_name}</span>
                <span class="side-item-sub">{sub}</span>
              </span>
              {inCall && (
                <span class="in-call" title={tx.inCall}>
                  <Icon name="phone" size={14} />
                </span>
              )}
              {ch && channelMuted(ch) && <Icon name="bellOff" size={14} class="mute-icon" />}
              {!!ch?.unread && <span class="badge inline">{ch.unread}</span>}
            </button>
          );
        })}
        {people.length === 0 && <div class="muted small pad">{q ? tx.noResults : tx.noUsers}</div>}
      </div>
    </aside>
  );
}

function RoomItem({ g, r, mod }: { g: Group; r: Room; mod: boolean }) {
  const members = voiceRooms.value.get(roomKey(r)) ?? [];
  const inThis = call.value && 'room_id' in call.value.target && call.value.target.room_id === r.id;
  const tx = t().shell.group;
  const join = () => {
    view.value = { kind: 'group', groupId: g.id, stage: true };
    if (!inThis) joinVoice({ room_id: r.id }, `${r.name} · ${g.name}`).catch((e) => toast(errorText(e), 'error'));
  };
  const menu = (e: MouseEvent) =>
    mod &&
    openMenu(e, [
      { label: t().groups.channels.rename, icon: 'edit', run: () => renameRoom(r) },
      ...(g.rooms.length > 1 ? [{ label: tx.deleteRoom, icon: 'trash', danger: true, run: () => deleteRoom(r) } as MenuItem] : []),
    ]);
  return (
    <div class={'room' + (members.length ? ' occupied' : '')}>
      <div class={'side-item room-head' + (inThis ? ' active' : '')} onContextMenu={menu}>
        <button class="room-join" onClick={join} title={inThis ? tx.openRoom : tx.joinRoom}>
          <Icon name="speaker" size={17} />
          <span class="side-item-name">{r.name}</span>
          {members.length > 0 && <span class="room-count">{members.length}</span>}
        </button>
      </div>
      {members.map((m) => (
        <button class="room-member" key={m.user_id} onClick={(e) => openProfile(m.user_id, e.clientX + 10, e.clientY - 60)}>
          <Avatar id={m.user_id} size={22} />
          <span class="ellipsis">{userName(m.user_id)}</span>
          {m.screen && <span class="live small">LIVE</span>}
          {m.camera && <Icon name="video" size={13} />}
          {m.muted && <Icon name="micOff" size={13} />}
          {m.deafened && <Icon name="headphonesOff" size={13} />}
        </button>
      ))}
    </div>
  );
}

function TextChannelItem({ g, channel, active, mod }: { g: Group; channel: TextChannel; active: boolean; mod: boolean }) {
  const unread = channels.value.get(channel.id)?.unread ?? 0;
  const muted = isMuted('c' + channel.id) || isMuted('g' + g.id);
  const main = channel.id === g.channel_id;
  const tx = t().shell.group;
  return (
    <button
      class={'side-item channel' + (active ? ' active' : '') + (unread ? ' unread' : '') + (muted ? ' muted' : '')}
      onClick={() => (view.value = { kind: 'group', groupId: g.id, channelId: channel.id })}
      onContextMenu={(e) =>
        openMenu(e, [
          ...muteMenuItems('c' + channel.id),
          ...(mod ? (['sep'] as MenuItem[]) : []),
          ...(!mod ? [] : [
          { label: t().groups.channels.rename, icon: 'edit', run: () => renameTextChannel(channel) },
          ...(!main ? [{ label: tx.deleteChannel, icon: 'trash', danger: true, run: () => deleteTextChannel(channel) } as MenuItem] : []),
          ]),
        ])
      }
    >
      <Icon name="hash" size={17} />
      <span class="side-item-name">{channel.name}</span>
      {muted && <Icon name="bellOff" size={14} class="mute-icon" />}
      {unread > 0 && <span class="badge inline">{unread}</span>}
    </button>
  );
}

const HOUR = 3600_000;
function muteMenuItems(key: string): MenuItem[] {
  const tx = t().shell.notifications;
  if (isMuted(key)) return [{ label: tx.unmute, icon: 'bell', run: () => setMuted(key, null) }];
  return [
    { label: tx.mute1h, icon: 'bellOff', run: () => setMuted(key, Date.now() + HOUR) },
    { label: tx.mute8h, icon: 'bellOff', run: () => setMuted(key, Date.now() + 8 * HOUR) },
    { label: tx.muteForever, icon: 'bellOff', run: () => setMuted(key, 0) },
  ];
}

export function groupMenuItems(g: Group, open: (d: 'settings' | 'add') => void): MenuItem[] {
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
              view.value = { kind: 'home' };
            } catch (e) {
              toast(errorText(e), 'error');
            }
          },
        },
  ];
}

function GroupSidebar({ g }: { g: Group }) {
  const v = view.value;
  const mod = canModerate(g);
  const [dialog, setDialog] = useState<null | 'settings' | 'add'>(null);
  const activeChannel = v.kind === 'group' && !v.stage ? (v.channelId ?? g.channel_id) : 0;
  const tx = t().shell.group;
  const tc = t().groups.channels;
  const textChannels = groupTextChannels(g);
  const menuItems = groupMenuItems(g, setDialog);
  return (
    <aside class="sidebar">
      <header class={'side-head group-head' + (g.avatar ? ' with-cover' : '')}>
        <button class="group-title" onClick={(e) => openMenuAt(e.currentTarget, menuItems)}>
          <GroupAvatar id={g.id} size={30} />
          <span class="ellipsis">{g.name}</span>
          <Icon name="chevronDown" size={18} />
        </button>
        {g.description && <div class="group-desc">{g.description}</div>}
      </header>
      <div class="side-list">
        <div class="side-label">
          <span>{tx.textChannels}</span>
          {mod && (
            <button class="icon-btn tiny" onClick={() => createTextChannel(g)} title={tc.newTextChannel} aria-label={tc.newTextChannel}>
              <Icon name="plus" size={14} />
            </button>
          )}
        </div>
        {textChannels.map((c) => (
          <TextChannelItem key={c.id} g={g} channel={c} active={activeChannel === c.id} mod={mod} />
        ))}
        <div class="side-label">
          <span>{tx.voiceRooms}</span>
          {mod && (
            <button class="icon-btn tiny" onClick={() => createRoom(g)} title={tc.newVoiceRoom} aria-label={tc.newVoiceRoom}>
              <Icon name="plus" size={14} />
            </button>
          )}
        </div>
        {g.rooms.map((r) => (
          <RoomItem key={r.id} g={g} r={r} mod={mod} />
        ))}
      </div>
      {dialog === 'settings' && <GroupSettingsDialog group={g} onClose={() => setDialog(null)} />}
      {dialog === 'add' && <AddMembersDialog group={g} onClose={() => setDialog(null)} />}
    </aside>
  );
}

export function memberMenu(g: Group, id: number, e: MouseEvent) {
  const myRole = groupRole(g);
  const theirRole = groupRole(g, id);
  const self = id === me.value?.id;
  const tx = t().shell.member;
  const items: MenuItem[] = [
    { label: tx.profile, icon: 'user', run: () => openProfile(id, e.clientX, e.clientY) },
    ...(!self ? [{ label: tx.message, icon: 'chat', run: () => openDM(id).catch((er) => toast(errorText(er), 'error')) } as MenuItem] : []),
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
    <aside class="members-panel slide-in">
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
    </aside>
  );
}

function DMMain({ channelId }: { channelId: number }) {
  const ch = channels.value.get(channelId);
  const peer = ch?.peer_id;
  const c = call.value;
  const inThisCall = c && 'channel_id' in c.target && c.target.channel_id === channelId;
  const others = (voiceRooms.value.get('dm' + channelId) ?? []).filter((m) => m.user_id !== me.value?.id);
  if (!ch || !peer) return <Empty />;
  const pu = users.value.get(peer);
  const tx = t().shell.dm;
  const actions = inThisCall ? null : (
    <button
      class={others.length ? 'primary pulse-btn' : 'icon-btn'}
      title={others.length ? undefined : tx.call}
      aria-label={others.length ? tx.joinCall : tx.call}
      onClick={() => {
        const label = userName(peer);
        (others.length ? joinVoice({ channel_id: channelId }, label) : startCall(channelId, label)).catch((e) => toast(errorText(e), 'error'));
      }}
    >
      <Icon name="phone" size={18} /> {others.length ? tx.joinCall : ''}
    </button>
  );
  return (
    <div class={'main-split' + (inThisCall ? ' with-stage' : '')}>
      {inThisCall && <Stage />}
      <ChatView
        channelId={channelId}
        title={userName(peer)}
        icon={
          <button class="avatar-btn" onClick={(e) => openProfile(peer, e.clientX, e.clientY + 20)}>
            <Avatar id={peer} size={34} showPresence />
          </button>
        }
        subtitle={pu?.status || (online.value.has(peer) ? tx.online : tx.offline)}
        actions={actions}
      />
    </div>
  );
}

function GroupMain({ g, stage, channelId }: { g: Group; stage?: boolean; channelId?: number }) {
  const c = call.value;
  const [members, setMembers] = useState(window.innerWidth > 1180);
  const tx = t().shell.group;
  const inGroupCall = !!c && 'room_id' in c.target && g.rooms.some((r) => 'room_id' in c.target && r.id === c.target.room_id);
  if (stage && inGroupCall) {
    return (
      <div class="main-split with-stage">
        <Stage
          extra={
            <button class="secondary" onClick={() => (view.value = { kind: 'group', groupId: g.id, channelId })}>
              <Icon name="chat" size={16} /> {tx.openChat}
            </button>
          }
        />
      </div>
    );
  }
  const textChannels = groupTextChannels(g);
  const tc = textChannels.find((c) => c.id === channelId) ?? textChannels[0];
  const actions = (
    <>
      {inGroupCall && (
        <button class="secondary" onClick={() => (view.value = { kind: 'group', groupId: g.id, channelId, stage: true })}>
          <Icon name="speaker" size={16} /> {tx.toRoom}
        </button>
      )}
      <button class={'icon-btn' + (members ? ' active' : '')} onClick={() => setMembers(!members)} title={tx.members} aria-label={tx.members}>
        <Icon name="users" />
      </button>
    </>
  );
  return (
    <div class="main-split">
      <ChatView
        channelId={tc.id}
        title={tc.name}
        icon={
          <span class="head-hash">
            <Icon name="hash" size={22} />
          </span>
        }
        subtitle={`${g.name} · ${tx.memberCount(g.members.length)}`}
        actions={actions}
        canModerate={canModerate(g)}
      />
      {members && <MembersPanel g={g} />}
    </div>
  );
}

function Empty() {
  const name = me.value?.display_name ?? '';
  const tx = t().shell.empty;
  return (
    <div class="empty">
      <div class="empty-art" aria-hidden="true">
        <span class="logo-mark big" />
      </div>
      <h2>{tx.greeting(name)}</h2>
      <p class="muted">
        {tx.hint} <kbd>Ctrl</kbd> + <kbd>K</kbd> {tx.searchHint}
      </p>
    </div>
  );
}

export function Shell() {
  const v = view.value;
  const g = v.kind === 'group' ? groups.value.get(v.groupId) : undefined;
  return (
    <div class="shell">
      <Rail />
      <div class="side-col island">
        {v.kind === 'home' || !g ? <HomeSidebar /> : <GroupSidebar g={g} />}
        <Dock />
      </div>
      <main class="main island">
        {connection.value === 'offline' && (
          <div class="banner">{serverRestarting.value === null ? t().shell.offlineBanner : t().shell.restartingBanner(serverRestarting.value)}</div>
        )}
        {v.kind === 'home' && (v.channelId ? <DMMain channelId={v.channelId} /> : <Empty />)}
        {v.kind === 'group' && g && <GroupMain g={g} stage={v.stage} channelId={v.channelId} />}
        {v.kind === 'group' && !g && <Empty />}
      </main>
    </div>
  );
}
