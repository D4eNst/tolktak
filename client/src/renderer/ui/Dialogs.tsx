import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Group } from '../api';
import { locale, t } from '../i18n';
import { api, channels, errorText, go, groups, incomingCall, me, online, people, session, settingsOpen, switcherOpen, toast, userName, users } from '../state';
import { call, leaveVoice, micOn, ringing, toggleMic } from '../voice';
import { keyLabel } from '../keys';
import { callPerson, confirmReset, enterRoom, openBeside, openPerson, openRoom, openVoice } from './desk';
import { callPeopleOpen } from './Stage';
import { navFolded, toggleNav } from './Shell';
import { UserPageControls } from './People';
import { useKnownUsers, useUserPage } from './usePeople';
import { SearchField, useSearch } from './search';
import { Avatar, GroupAvatar, Icon, Modal } from './common';

export function UserPicker({ exclude, selected, onChange }: { exclude: number[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const search = useSearch();
  const q = search.query;
  const page = useUserPage('directory', q, !search.pending, exclude);
  useKnownUsers(selected);
  const list = people.value ? page.users : [...users.value.values()].filter(
    (u) => !exclude.includes(u.id) && (u.display_name.toLowerCase().includes(q.toLowerCase()) || u.username.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div class="user-picker">
      <SearchField search={search} busy={page.loading} placeholder={t().groups.picker.search} maxLength={256} />
      <div class={"user-picker-list" + (search.pending ? " search-stale" : "")} inert={search.pending} aria-busy={search.pending || page.loading}>
        {!page.loading && !page.error && list.length === 0 && <div class="muted small">{t().groups.picker.empty}</div>}
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
      {people.value && <UserPageControls page={page} />}
      {selected.length > 0 && <div class="people-selected">{selected.map((id) => <button type="button" class="chip" key={id} onClick={() => onChange(selected.filter((v) => v !== id))}>{userName(id)}<Icon name="x" size={12} /></button>)}</div>}
    </div>
  );
}

export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const create = async (e: Event) => {
    e.preventDefault();
    const a = api();
    setBusy(true);
    try {
      const { group } = await a.createGroup(name, members, { room_name: t().shell.group.defaultRoom, channel_name: t().shell.group.defaultChannel });
      if (session.value?.api !== a) return;
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
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={60} required autoFocus />
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

// Ctrl+Enter opens the result beside the main panel.
type Item = { key: string; label: string; hint: string; icon: preact.ComponentChildren; run: () => void; beside?: () => void };

export function QuickSwitcher() {
  const search = useSearch();
  const q = search.query;
  const waitingPick = useRef<{ query: string; beside: boolean } | null>(null);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => (switcherOpen.value = false);

  const ts = t().groups.switcher;
  const userPage = useUserPage(q.trim() ? 'directory' : 'contacts', q, !search.pending);
  const peerIDs = [...channels.value.values()].flatMap((c) => c.peer_id ? [c.peer_id] : []);
  useKnownUsers(peerIDs);
  const foundUsers = people.value ? q.trim() ? userPage.users : [...new Set([...peerIDs, ...userPage.users.map((u) => u.id)])].map((id) => users.value.get(id)).filter((u) => u !== undefined) : [...users.value.values()];
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const dms = new Map([...channels.value.values()].filter((c) => c.kind === 'dm').map((c) => ['u' + c.peer_id, c]));
    for (const g of groups.value.values()) {
      out.push({ key: 'g' + g.id, label: g.name, hint: ts.group, icon: <GroupAvatar id={g.id} size={18} />, run: () => go({ kind: 'group', groupId: g.id }), beside: () => openBeside(g.channel_id) });
      for (const ch of g.text_channels ?? []) {
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
    for (const u of foundUsers) {
      if (u.id === me.value?.id) continue;
      const dm = dms.get('u' + u.id)?.id;
      out.push({
        key: 'u' + u.id,
        label: u.display_name,
        hint: '@' + u.username + (online.value.has(u.id) ? ts.online : ''),
        icon: <Avatar id={u.id} size={18} />,
        run: () => openPerson(u.id),
        beside: dm ? () => openBeside(dm) : undefined,
      });
    }
    // Rank actions after chats and people.
    const tc = t().groups.switcher.commands;
    const act = (key: string, label: string, icon: string, run: () => void) => out.push({ key: 'a' + key, label, hint: ts.action, icon: <Icon name={icon} size={16} />, run });
    if (call.value) {
      act('back', tc.backToCall, 'speaker', () => openVoice());
      act('people', tc.callPeople, 'users', () => (openVoice(), (callPeopleOpen.value = true)));
      act('mic', micOn.value ? tc.micOff : tc.micOn, micOn.value ? 'micOff' : 'mic', toggleMic);
      act('leave', tc.leave, 'phoneOff', () => leaveVoice());
    }
    act('nav', navFolded.value ? tc.showNav : tc.hideNav, 'navigation', toggleNav);
    act('settings', tc.settings, 'settings', () => (settingsOpen.value = 'profile'));
    act('windows', tc.windows, 'tabInside', () => (settingsOpen.value = 'interface'));
    act('reset', tc.reset, 'reset', () => confirmReset());
    const s = q.trim().toLowerCase();
    // Include actions only in search results.
    const pool = s ? out : out.filter((it) => !it.key.startsWith('a'));
    const scored = pool
      .map((it) => {
        const l = it.label.toLowerCase();
        const h = it.hint.toLowerCase();
        const score = !s ? 1 : people.value && it.key.startsWith('u') ? 2 : l.startsWith(s) ? 3 : l.includes(s) ? 2 : h.includes(s) ? 1 : 0;
        const unreadBoost = !s && dms.get(it.key)?.unread ? 1 : 0;
        return { it, score: score + unreadBoost };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return (s ? scored : scored.slice(0, 30)).map((x) => x.it);
  }, [q, groups.value, users.value, online.value, channels.value, me.value, locale.value, call.value, micOn.value, navFolded.value, userPage.users.map((u) => u.id).join()]);

  useEffect(() => setIdx(0), [q, userPage.users.map((u) => u.id).join()]);
  useEffect(() => {
    listRef.current?.children[idx]?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const pick = (it?: Item, beside = false) => {
    if (!it) return;
    close();
    (beside && it.beside ? it.beside : it.run)();
  };

  useEffect(() => {
    const waiting = waitingPick.current;
    if (!waiting || search.pending || userPage.loading || waiting.query !== q.trim()) return;
    if (userPage.error) { waitingPick.current = null; return; }
    if (items[0]) { waitingPick.current = null; pick(items[0], waiting.beside); }
  }, [q, search.pending, userPage.loading, userPage.error, items]);

  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="switcher" role="dialog" aria-label={ts.label}>
        <SearchField class="switcher-search" search={search} busy={userPage.loading && !!q.trim()} autoFocus placeholder={ts.placeholder} maxLength={256}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); close(); return; }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (search.pending) { search.flush(); return; }
              setIdx(Math.max(0, Math.min(idx + (event.key === 'ArrowDown' ? 1 : -1), items.length - 1)));
            }
            if (event.key === 'Enter') {
              if (search.pending || userPage.loading) waitingPick.current = { query: search.text.trim(), beside: event.ctrlKey || event.metaKey };
              else pick(items[idx], event.ctrlKey || event.metaKey);
            }
          }} />
        {!!q.trim() && people.value && <UserPageControls page={userPage} />}
        <div class={"switcher-list" + (search.pending ? " search-stale" : "")} inert={search.pending} aria-busy={search.pending || userPage.loading} ref={listRef}>
          {items.map((it, i) => (
            <button key={it.key} class={'switcher-item' + (i === idx ? ' active' : '')} onMouseEnter={() => setIdx(i)} onClick={(e) => pick(it, e.ctrlKey || e.metaKey)}>
              {it.icon}
              <span>{it.label}</span>
              <span class="muted small">{it.hint}</span>
            </button>
          ))}
          {items.length === 0 && <div class="muted small pad">{ts.empty}</div>}
        </div>
        {!!items.length && (
          <div class="switcher-help muted small">
            {ts.openHint(keyLabel('Enter'))}
            {items[idx]?.beside && ' · ' + ts.besideHint(keyLabel('Mod Enter'))}
          </div>
        )}
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
  // Answering replaces the current call.
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
