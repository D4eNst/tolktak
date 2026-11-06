import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { FileMeta, Group, Room, TextChannel } from '../api';
import { t } from '../i18n';
import { api, errorText, go, groupRole, me, online, session, toast, userName, users } from '../state';
import { AddMembersDialog } from './Dialogs';
import { Avatar, confirmDialog, GroupAvatar, Icon, Modal, promptDialog } from './common';
import { memberMenu } from './desk';
import { useKnownUsers } from './usePeople';
import { SearchField, useSearch } from './search';

export const MAX_IMAGE_MB = 8;

export function pickImage(): Promise<FileMeta | null> {
  const owner = api();
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > MAX_IMAGE_MB * 1024 * 1024) {
        toast(t().groups.settings.imageTooLarge(MAX_IMAGE_MB), 'error');
        return resolve(null);
      }
      try {
        const bmp = await createImageBitmap(f).catch(() => null);
        const dims = bmp ? { w: bmp.width, h: bmp.height } : undefined;
        bmp?.close();
        if (session.value?.api !== owner) return resolve(null);
        const file = await owner.upload(f, f.name, dims);
        resolve(session.value?.api === owner ? file : null);
      } catch (e) {
        toast(errorText(e), 'error');
        resolve(null);
      }
    };
    input.click();
  });
}

export async function createTextChannel(g: Group) {
  const owner = api();
  const tc = t().groups.channels;
  const name = await promptDialog(tc.newTextChannel, { max: 40, ok: tc.create });
  if (!name || session.value?.api !== owner) return;
  try {
    const { channel } = await owner.createTextChannel(g.id, name);
    if (session.value?.api !== owner) return;
    go({ kind: 'group', groupId: g.id, channelId: channel.id });
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export async function renameTextChannel(ch: TextChannel) {
  const name = await promptDialog(t().groups.channels.renameChannel, { initial: ch.name, max: 40 });
  if (name) api().renameTextChannel(ch.id, name).catch((e) => toast(errorText(e), 'error'));
}

export async function deleteTextChannel(ch: TextChannel) {
  const tc = t().groups.channels;
  if (await confirmDialog(tc.deleteChannelConfirm(ch.name), { text: tc.deleteChannelText, ok: tc.delete, danger: true }))
    api().deleteTextChannel(ch.id).catch((e) => toast(errorText(e), 'error'));
}

export async function createRoom(g: Group) {
  const tc = t().groups.channels;
  const name = await promptDialog(tc.newVoiceRoom, { ok: tc.create });
  if (name) api().createRoom(g.id, name).catch((e) => toast(errorText(e), 'error'));
}

export async function renameRoom(r: Room) {
  const name = await promptDialog(t().groups.channels.renameRoom, { initial: r.name });
  if (name) api().renameRoom(r.id, name).catch((e) => toast(errorText(e), 'error'));
}

export async function deleteRoom(r: Room) {
  const tc = t().groups.channels;
  if (await confirmDialog(tc.deleteRoomConfirm(r.name), { ok: tc.delete, danger: true })) api().deleteRoom(r.id).catch((e) => toast(errorText(e), 'error'));
}

type OrderKind = 'channel' | 'room';

// Pointer capture keeps dragging within the originating list, including while it scrolls.
function OrderList({ items, kind, mainId, busy, reorder, rename, remove }: {
  items: { id: number; name: string }[]; kind: OrderKind; mainId?: number; busy: boolean;
  reorder: (kind: OrderKind, ids: number[]) => void;
  rename: (id: number) => void; remove: (id: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<number, number>());
  const animations = useRef<Animation[]>([]);
  const drag = useRef<{
    id: number; ids: number[]; startX: number; startY: number; x: number; y: number;
    active: boolean; before: number | null; frame: number; win: Window; handle: HTMLElement; pointer: number;
  } | null>(null);
  const [marker, setMarker] = useState<{ id: number; before: number | null } | null>(null);
  const signature = items.map((item) => item.id).join(',');
  const tc = t().groups.channels;
  const finish = (commit = false, unmount = false) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.win.cancelAnimationFrame(d.frame);
    if (d.handle.hasPointerCapture(d.pointer)) d.handle.releasePointerCapture(d.pointer);
    if (!unmount) setMarker(null);
    if (!commit || !d.active || busy || d.ids.join(',') !== signature) return;
    const ids = d.ids.filter((id) => id !== d.id);
    const index = d.before === null ? ids.length : ids.indexOf(d.before);
    if (index < 0) return;
    ids.splice(index, 0, d.id);
    if (ids.join(',') !== d.ids.join(',')) reorder(kind, ids);
  };
  useLayoutEffect(() => { finish(); }, [signature, busy]);
  useEffect(() => () => { finish(false, true); animations.current.forEach((animation) => animation.cancel()); }, []);
  useEffect(() => {
    const win = list.current?.ownerDocument.defaultView;
    const cancel = () => finish();
    win?.addEventListener('blur', cancel);
    return () => win?.removeEventListener('blur', cancel);
  }, []);
  useLayoutEffect(() => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('.manage-row') ?? [])];
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    const reduced = list.current?.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<number, number>();
    for (const row of rows) {
      const id = Number(row.dataset.id), top = row.offsetTop, previous = positions.current.get(id);
      next.set(id, top);
      if (!reduced && previous !== undefined && previous !== top) animations.current.push(row.animate(
        [{ transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' }],
        { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' },
      ));
    }
    positions.current = next;
  }, [signature]);
  const track = (repeat = true) => {
    const d = drag.current, el = list.current;
    if (!d || !el || !d.active) return;
    const rect = el.getBoundingClientRect();
    const parent = el.closest('.settings-body')!.getBoundingClientRect();
    const top = Math.max(rect.top, parent.top), bottom = Math.min(rect.bottom, parent.bottom);
    const inside = d.x >= rect.left && d.x <= rect.right && d.y >= top - 24 && d.y <= bottom + 24;
    if (inside) {
      const edge = 38;
      const speed = d.y < top + edge ? -Math.min(12, (top + edge - d.y) / 3)
        : d.y > bottom - edge ? Math.min(12, (d.y - bottom + edge) / 3) : 0;
      if (speed) el.scrollTop += speed;
      const rows = [...el.querySelectorAll<HTMLElement>('.manage-row')].filter((row) => Number(row.dataset.id) !== d.id);
      const before = rows.find((row) => { const r = row.getBoundingClientRect(); return d.y < r.top + r.height / 2; });
      const id = before ? Number(before.dataset.id) : null;
      if (d.before !== id) { d.before = id; setMarker({ id: d.id, before: id }); }
    }
    if (repeat) d.frame = d.win.requestAnimationFrame(() => track());
  };
  return <div ref={list} class={'manage-list reorder-list' + (marker?.before === null ? ' drop-end' : '')}>
    {items.map((item, index) => <div key={item.id} data-id={item.id}
      class={'manage-row' + (marker?.id === item.id ? ' dragging' : '') + (marker?.before === item.id ? ' drop-before' : '')}>
      <button class="icon-btn tiny reorder-handle" disabled={busy} aria-label={tc.drag(item.name)} title={tc.drag(item.name)}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType !== 'mouse' || busy) return;
          const handle = event.currentTarget, win = handle.ownerDocument.defaultView!;
          drag.current = { id: item.id, ids: items.map((row) => row.id), startX: event.clientX, startY: event.clientY,
            x: event.clientX, y: event.clientY, active: false, before: null, frame: 0, win, handle, pointer: event.pointerId };
          handle.focus({ preventScroll: true });
          handle.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d || d.pointer !== event.pointerId) return;
          if (event.buttons === 0) { finish(); return; }
          d.x = event.clientX; d.y = event.clientY;
          if (!d.active && Math.hypot(d.x - d.startX, d.y - d.startY) > 4) {
            d.active = true; d.before = d.id; setMarker({ id: d.id, before: d.id }); track();
          }
        }}
        onPointerUp={(event) => {
          if (drag.current?.active) { drag.current.x = event.clientX; drag.current.y = event.clientY; track(false); }
          const rect = list.current?.getBoundingClientRect();
          finish(!!rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
        }} onPointerCancel={() => finish()} onLostPointerCapture={() => finish()}
        onKeyDown={(event) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(); } }}>
        <Icon name={kind === 'channel' ? 'hash' : 'speaker'} size={16} />
      </button>
      <span class="ellipsis">{item.name}</span>
      <button class="icon-btn tiny" disabled={busy || index === 0} aria-label={tc.moveUp} title={tc.moveUp}
        onClick={() => { const ids = items.map((row) => row.id); [ids[index], ids[index - 1]] = [ids[index - 1], ids[index]]; reorder(kind, ids); }}><Icon name="chevronUp" size={14} /></button>
      <button class="icon-btn tiny" disabled={busy || index === items.length - 1} aria-label={tc.moveDown} title={tc.moveDown}
        onClick={() => { const ids = items.map((row) => row.id); [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]; reorder(kind, ids); }}><Icon name="chevronDown" size={14} /></button>
      <button class="icon-btn tiny" aria-label={tc.rename} onClick={() => rename(item.id)}><Icon name="edit" size={14} /></button>
      <button class="icon-btn tiny danger" disabled={item.id === mainId || (kind === 'room' && items.length === 1)}
        aria-label={tc.delete} title={item.id === mainId ? tc.mainChannel : tc.delete} onClick={() => remove(item.id)}><Icon name="trash" size={14} /></button>
    </div>)}
  </div>;
}

export function GroupSettingsDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const owner = api();
  const [tab, setTab] = useState<'main' | 'members' | 'channels'>('main');
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description ?? '');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const memberSearch = useSearch();
  const ordering = useRef(false);
  useKnownUsers(group.members);
  const role = groupRole(group);
  const g = group;
  const ts = t().groups.settings;
  const roleOrder = { owner: 0, mod: 1, member: 2 };

  const save = async (patch: { name?: string; avatar?: string; description?: string }) => {
    if (session.value?.api !== owner) return;
    setBusy(true);
    try {
      await owner.updateGroup(g.id, patch);
      if (session.value?.api !== owner) return;
      toast(ts.saved);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const reorder = async (kind: OrderKind, ids: number[]) => {
    if (ordering.current || busy || !['owner', 'mod'].includes(role) || session.value?.api !== owner) return;
    ordering.current = true;
    setBusy(true);
    try {
      await (kind === 'channel' ? owner.reorderChannels(g.id, ids) : owner.reorderRooms(g.id, ids));
    } catch (error) { if (session.value?.api === owner) toast(errorText(error), 'error'); }
    finally { ordering.current = false; setBusy(false); }
  };
  const query = memberSearch.query.trim().toLocaleLowerCase();
  const members = [...g.members].filter((id) => {
    const user = users.value.get(id);
    return !query || `${userName(id)} ${user?.username ?? ''}`.toLocaleLowerCase().includes(query);
  }).sort((a, b) => roleOrder[groupRole(g, a)] - roleOrder[groupRole(g, b)] || userName(a).localeCompare(userName(b)));

  return (
    <Modal title={ts.title} onClose={onClose} wide class="group-settings">
      <div class="settings">
        <nav class="settings-nav">
          <button class={tab === 'main' ? 'active' : ''} onClick={() => setTab('main')}>
            <Icon name="sparkles" size={16} /> {ts.tabs.main}
          </button>
          <button class={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
            <Icon name="users" size={16} /> {ts.tabs.members}
          </button>
          <button class={tab === 'channels' ? 'active' : ''} onClick={() => setTab('channels')}>
            <Icon name="hash" size={16} /> {ts.tabs.channels}
          </button>
        </nav>
        <div class="settings-body">
          {tab === 'main' && (
            <>
              <div class="avatar-edit">
                <button
                  class="avatar-edit-btn"
                  disabled={busy}
                  onClick={async () => {
                    const f = await pickImage();
                    if (f) save({ avatar: f.id });
                  }}
                  title={ts.changeImage}
                >
                  <GroupAvatar id={g.id} size={96} />
                  <span class="avatar-edit-hover">
                    <Icon name="image" />
                  </span>
                </button>
                <div>
                  <div class="strong">{ts.image}</div>
                  <p class="muted small">{ts.imageHint(MAX_IMAGE_MB)}</p>
                  <div class="row">
                    <button
                      class="secondary"
                      disabled={busy}
                      onClick={async () => {
                        const f = await pickImage();
                        if (f) save({ avatar: f.id });
                      }}
                    >
                      {ts.upload}
                    </button>
                    {g.avatar && (
                      <button class="link" onClick={() => save({ avatar: '' })}>
                        {ts.remove}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  save({ name: name.trim(), description: desc.trim() });
                }}
              >
                <label>
                  {ts.name}
                  <input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
                </label>
                <label>
                  {ts.description}
                  <textarea rows={3} maxLength={300} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
                </label>
                <div class="modal-actions">
                  <button class="primary" disabled={busy || !name.trim() || (name === g.name && desc === (g.description ?? ''))}>
                    {ts.save}
                  </button>
                </div>
              </form>
            </>
          )}
          {tab === 'members' && (
            <>
              <div class="row between">
                <span class="muted">
                  {ts.membersSummary(g.members.length, g.members.filter((id) => online.value.has(id)).length)}
                </span>
                <button class="primary" onClick={() => setAdding(true)}>
                  <Icon name="userPlus" size={16} /> {ts.invite}
                </button>
              </div>
              <SearchField search={memberSearch} class="member-search" placeholder={ts.findMember} />
              <div class="member-table">
                {members.length === 0 && <p class="muted small">{t().groups.picker.empty}</p>}
                {members.map((id) => {
                    const r = groupRole(g, id);
                    return (
                      <div class="member-row" key={id}>
                        <Avatar id={id} size={36} showPresence />
                        <div class="member-row-main">
                          <b>{userName(id)}</b>
                          <span class="muted small">@{users.value.get(id)?.username}</span>
                        </div>
                        <span class={'role-chip role-' + r}>{t().groups.roles[r]}</span>
                        {id !== me.value?.id && r !== 'owner' && (role === 'owner' || (role === 'mod' && r === 'member')) && (
                          <button class="icon-btn" onClick={(e) => memberMenu(g, id, e)} aria-label={ts.actions}>
                            <Icon name="more" />
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            </>
          )}
          {tab === 'channels' && (
            <>
              <div class="row between">
                <b>{ts.textChannels}</b>
                <button class="secondary" onClick={() => createTextChannel(g)}>
                  <Icon name="plus" size={16} /> {ts.channel}
                </button>
              </div>
              <OrderList kind="channel" items={g.text_channels ?? []} mainId={g.channel_id} busy={busy} reorder={reorder}
                rename={(id) => renameTextChannel(g.text_channels.find((ch) => ch.id === id)!)}
                remove={(id) => deleteTextChannel(g.text_channels.find((ch) => ch.id === id)!)} />
              <div class="row between">
                <b>{ts.voiceRooms}</b>
                <button class="secondary" onClick={() => createRoom(g)}>
                  <Icon name="plus" size={16} /> {ts.room}
                </button>
              </div>
              <OrderList kind="room" items={g.rooms} busy={busy} reorder={reorder}
                rename={(id) => renameRoom(g.rooms.find((room) => room.id === id)!)}
                remove={(id) => deleteRoom(g.rooms.find((room) => room.id === id)!)} />
            </>
          )}
        </div>
      </div>
      {adding && <AddMembersDialog group={g} onClose={() => setAdding(false)} />}
    </Modal>
  );
}
