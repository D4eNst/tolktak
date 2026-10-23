import { useState } from 'preact/hooks';
import type { FileMeta, Group } from '../api';
import { t } from '../i18n';
import { api, errorText, groupRole, me, online, toast, userName, users } from '../state';
import { AddMembersDialog } from './Dialogs';
import { Avatar, confirmDialog, GroupAvatar, Icon, Modal, promptDialog } from './common';
import { memberMenu } from './Shell';

const MAX_AVATAR = 8 * 1024 * 1024;

export function pickImage(): Promise<FileMeta | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > MAX_AVATAR) {
        toast(t().groups.settings.imageTooLarge, 'error');
        return resolve(null);
      }
      try {
        const bmp = await createImageBitmap(f).catch(() => null);
        const dims = bmp ? { w: bmp.width, h: bmp.height } : undefined;
        bmp?.close();
        resolve(await api().upload(f, f.name, dims));
      } catch (e) {
        toast(errorText(e), 'error');
        resolve(null);
      }
    };
    input.click();
  });
}

export function GroupSettingsDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const [tab, setTab] = useState<'main' | 'members' | 'channels'>('main');
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description ?? '');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const role = groupRole(group);
  const g = group;
  const ts = t().groups.settings;
  const roleOrder = { owner: 0, mod: 1, member: 2 };

  const save = async (patch: { name?: string; avatar?: string; description?: string }) => {
    setBusy(true);
    try {
      await api().updateGroup(g.id, patch);
      toast(ts.saved);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={ts.title} onClose={onClose} wide>
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
                  <p class="muted small">{ts.imageHint}</p>
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
                  <textarea rows={3} maxLength={300} value={desc} placeholder={ts.descriptionPlaceholder} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
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
              <div class="member-table">
                {[...g.members]
                  .sort((a, b) => roleOrder[groupRole(g, a)] - roleOrder[groupRole(g, b)] || userName(a).localeCompare(userName(b)))
                  .map((id) => {
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
              <p class="muted small">
                {ts.rolesHint}
              </p>
            </>
          )}
          {tab === 'channels' && (
            <>
              <div class="row between">
                <b>{ts.textChannels}</b>
                <button
                  class="secondary"
                  onClick={async () => {
                    const n = await promptDialog(ts.newTextChannel, { max: 40, ok: ts.create });
                    if (n) api().createTextChannel(g.id, n).catch((e) => toast(errorText(e), 'error'));
                  }}
                >
                  <Icon name="plus" size={16} /> {ts.channel}
                </button>
              </div>
              <div class="manage-list">
                {(g.text_channels ?? []).map((ch) => (
                  <div class="manage-row" key={ch.id}>
                    <Icon name="hash" size={16} />
                    <span class="ellipsis">{ch.name}</span>
                    <button
                      class="icon-btn tiny"
                      aria-label={ts.rename}
                      onClick={async () => {
                        const n = await promptDialog(ts.renameChannel, { initial: ch.name, max: 40 });
                        if (n) api().renameTextChannel(ch.id, n).catch((e) => toast(errorText(e), 'error'));
                      }}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    {ch.id !== g.channel_id && (
                      <button
                        class="icon-btn tiny danger"
                        aria-label={ts.delete}
                        onClick={async () => {
                          if (await confirmDialog(ts.deleteChannel(ch.name), { text: ts.deleteChannelText, ok: ts.delete, danger: true }))
                            api().deleteTextChannel(ch.id).catch((e) => toast(errorText(e), 'error'));
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div class="row between">
                <b>{ts.voiceRooms}</b>
                <button
                  class="secondary"
                  onClick={async () => {
                    const n = await promptDialog(ts.newVoiceRoom, { ok: ts.create });
                    if (n) api().createRoom(g.id, n).catch((e) => toast(errorText(e), 'error'));
                  }}
                >
                  <Icon name="plus" size={16} /> {ts.room}
                </button>
              </div>
              <div class="manage-list">
                {g.rooms.map((r) => (
                  <div class="manage-row" key={r.id}>
                    <Icon name="speaker" size={16} />
                    <span class="ellipsis">{r.name}</span>
                    <button
                      class="icon-btn tiny"
                      aria-label={ts.rename}
                      onClick={async () => {
                        const n = await promptDialog(ts.renameRoom, { initial: r.name });
                        if (n) api().renameRoom(r.id, n).catch((e) => toast(errorText(e), 'error'));
                      }}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    {g.rooms.length > 1 && (
                      <button
                        class="icon-btn tiny danger"
                        aria-label={ts.delete}
                        onClick={async () => {
                          if (await confirmDialog(ts.deleteRoom(r.name), { ok: ts.delete, danger: true })) api().deleteRoom(r.id).catch((e) => toast(errorText(e), 'error'));
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {adding && <AddMembersDialog group={g} onClose={() => setAdding(false)} />}
    </Modal>
  );
}
