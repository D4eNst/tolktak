import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Group } from '../api';
import { locale, t } from '../i18n';
import { api, channels, errorText, go, groups, incomingCall, me, online, settingsOpen, switcherOpen, toast, userName, users } from '../state';
import { call, leaveVoice, micOn, ringing, toggleMic } from '../voice';
import { callPerson, confirmReset, enterRoom, openBeside, openPerson, openRoom, openVoice } from './desk';
import { callPeopleOpen } from './Stage';
import { toggleNav } from './Shell';
import { Avatar, GroupAvatar, Icon, Modal } from './common';

export function UserPicker({ exclude, selected, onChange }: { exclude: number[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const [q, setQ] = useState('');
  const list = [...users.value.values()].filter(
    (u) => !exclude.includes(u.id) && (u.display_name.toLowerCase().includes(q.toLowerCase()) || u.username.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div class="user-picker">
      <input placeholder={t().groups.picker.search} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="user-picker-list">
        {list.length === 0 && <div class="muted small">{t().groups.picker.empty}</div>}
        {list.map((u) => (
          <label class={'user-row' + (selected.includes(u.id) ? ' selected' : '')} key={u.id}>
            <input
              type="checkbox"
              checked={selected.includes(u.id)}
              onChange={(e) => onChange((e.target as HTMLInputElement).checked ? [...selected, u.id] : selected.filter((x) => x !== u.id))}
            />
            <Avatar id={u.id} size={30} showPresence />
            <span class="user-row-name">
              <span>{u.display_name}</span>
              <span class="muted small">@{u.username}</span>
            </span>
            <span class="check-circle">
              <Icon name="check" size={14} />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { group } = await api().createGroup(name, members, { room_name: t().shell.group.defaultRoom, channel_name: t().shell.group.defaultChannel });
      go({ kind: 'group', groupId: group.id });
      onClose();
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
    }
  };
  const tc = t().groups.create;
  return (
    <Modal title={tc.title} onClose={onClose}>
      <form onSubmit={create}>
        <label>
          {tc.name}
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={60} required autoFocus placeholder={tc.namePlaceholder} />
        </label>
        <p class="muted small">{tc.hint}</p>
        <UserPicker exclude={[me.value!.id]} selected={members} onChange={setMembers} />
        <div class="modal-actions">
          <button type="button" class="secondary" onClick={onClose}>
            {t().common.cancel}
          </button>
          <button class="primary" disabled={busy || !name.trim()}>
            {tc.create}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AddMembersDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const [sel, setSel] = useState<number[]>([]);
  const add = async () => {
    try {
      await api().addMembers(group.id, sel);
      onClose();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <Modal title={t().groups.addMembers.title(group.name)} onClose={onClose}>
      <UserPicker exclude={group.members} selected={sel} onChange={setSel} />
      <div class="modal-actions">
        <button class="secondary" onClick={onClose}>
          {t().common.cancel}
        </button>
        <button class="primary" disabled={!sel.length} onClick={add}>
          {t().groups.addMembers.add}
        </button>
      </div>
    </Modal>
  );
}

/** `beside` is what Ctrl+Enter does: the same thing in a window next to the main one. */
type Item = { key: string; label: string; hint: string; icon: preact.ComponentChildren; run: () => void; beside?: () => void };

export function QuickSwitcher() {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => (switcherOpen.value = false);

  const ts = t().groups.switcher;
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const dmOf = (uid: number) => [...channels.value.values()].find((c) => c.kind === 'dm' && c.peer_id === uid)?.id;
    for (const g of groups.value.values()) {
      out.push({ key: 'g' + g.id, label: g.name, hint: ts.group, icon: <GroupAvatar id={g.id} size={18} />, run: () => go({ kind: 'group', groupId: g.id }), beside: () => openBeside(g.channel_id) });
      for (const ch of g.text_channels ?? []) {
        if (ch.id === g.channel_id) continue;
        out.push({ key: 't' + ch.id, label: ch.name, hint: ts.channel(g.name), icon: <Icon name="hash" size={16} />, run: () => go({ kind: 'group', groupId: g.id, channelId: ch.id }), beside: () => openBeside(ch.id) });
      }
      for (const r of g.rooms) {
        out.push({
          key: 'r' + r.id,
          label: r.name,
          hint: ts.voice(g.name),
          icon: <Icon name="speaker" size={16} />,
          run: () => enterRoom(g, r),
          beside: () => openRoom(r.id),
        });
      }
    }
    for (const u of users.value.values()) {
      if (u.id === me.value?.id) continue;
      out.push({
        key: 'u' + u.id,
        label: u.display_name,
        hint: '@' + u.username + (online.value.has(u.id) ? ts.online : ''),
        icon: <Avatar id={u.id} size={18} />,
        run: () => openPerson(u.id),
        beside: dmOf(u.id) ? () => openBeside(dmOf(u.id)!) : undefined,
      });
    }
    // Actions, after places and people: «выйти из звонка», «свернуть навигатор» and the like.
    const tc = t().groups.switcher.commands;
    const act = (key: string, label: string, icon: string, run: () => void) => out.push({ key: 'a' + key, label, hint: ts.action, icon: <Icon name={icon} size={16} />, run });
    if (call.value) {
      act('back', tc.backToCall, 'speaker', () => openVoice());
      act('people', tc.callPeople, 'users', () => (openVoice(), (callPeopleOpen.value = true)));
      act('mic', micOn.value ? tc.micOff : tc.micOn, micOn.value ? 'micOff' : 'mic', toggleMic);
      act('leave', tc.leave, 'phoneOff', () => leaveVoice());
    }
    act('nav', tc.nav, 'navigation', toggleNav);
    act('settings', tc.settings, 'settings', () => (settingsOpen.value = 'profile'));
    act('windows', tc.windows, 'tabInside', () => (settingsOpen.value = 'windows'));
    act('reset', tc.reset, 'home', () => confirmReset());
    const s = q.trim().toLowerCase();
    // Without a query the list is places and people; actions show up once typed for.
    const pool = s ? out : out.filter((it) => !it.key.startsWith('a'));
    const dms = new Map([...channels.value.values()].filter((c) => c.kind === 'dm').map((c) => ['u' + c.peer_id, c]));
    const scored = pool
      .map((it) => {
        const l = it.label.toLowerCase();
        const h = it.hint.toLowerCase();
        const score = !s ? 1 : l.startsWith(s) ? 3 : l.includes(s) ? 2 : h.includes(s) ? 1 : 0;
        const unreadBoost = !s && dms.get(it.key)?.unread ? 1 : 0;
        return { it, score: score + unreadBoost };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 30).map((x) => x.it);
  }, [q, groups.value, users.value, online.value, locale.value, call.value, micOn.value]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.children[idx]?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const pick = (it?: Item, beside = false) => {
    if (!it) return;
    close();
    (beside && it.beside ? it.beside : it.run)();
  };

  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="switcher" role="dialog" aria-label={ts.label}>
        <input
          autoFocus
          placeholder={ts.placeholder}
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setIdx(Math.min(idx + 1, items.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setIdx(Math.max(idx - 1, 0)));
            if (e.key === 'Enter') pick(items[idx], e.ctrlKey || e.metaKey);
            if (e.key === 'Escape') (e.preventDefault(), close());
          }}
        />
        <div class="switcher-list" ref={listRef}>
          {items.map((it, i) => (
            <button key={it.key} class={'switcher-item' + (i === idx ? ' active' : '')} onMouseEnter={() => setIdx(i)} onClick={(e) => pick(it, e.ctrlKey || e.metaKey)}>
              {it.icon}
              <span>{it.label}</span>
              <span class="muted small">{it.hint}</span>
            </button>
          ))}
          {items.length === 0 && <div class="muted small pad">{ts.empty}</div>}
        </div>
      </div>
    </div>
  );
}

export function IncomingCallDialog() {
  const c = incomingCall.value;
  useEffect(() => {
    ringing(!!c);
    return () => ringing(false);
  }, [c?.channelId]);
  useEffect(() => {
    if (!c) return;
    const timer = setTimeout(() => (incomingCall.value = null), 45000);
    return () => clearTimeout(timer);
  }, [c?.channelId]);
  if (!c) return null;
  const ti = t().groups.incoming;
  // One voice connection: answering takes you out of the room you are in.
  const busy = call.value && 'room_id' in call.value.target ? call.value.label : undefined;
  const accept = async () => {
    incomingCall.value = null;
    callPerson(c.channelId, true);
  };
  const decline = () => {
    incomingCall.value = null;
    api()
      .decline(c.channelId)
      .catch(() => {});
  };
  return (
    <div class="incoming">
      <Avatar id={c.from} size={56} />
      <div>
        <b>{userName(c.from)}</b>
        <div class="muted small">{busy ? ti.leaveRoom(busy) : ti.calling}</div>
      </div>
      <button class="round danger" onClick={decline} aria-label={ti.decline}>
        <Icon name="phoneOff" />
      </button>
      <button class="round accept" onClick={accept} aria-label={busy ? ti.acceptLeave : ti.accept} title={busy ? ti.acceptLeave : ti.accept}>
        <Icon name="phone" />
      </button>
    </div>
  );
}
