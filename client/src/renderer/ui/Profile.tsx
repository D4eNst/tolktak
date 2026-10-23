import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { bridge } from '../bridge';
import { t } from '../i18n';
import { api, errorText, me, online, openDM, settingsOpen, toast, userName, users } from '../state';
import { startCall } from '../voice';
import { Avatar, Icon, Popover } from './common';

const profileAt = signal<{ id: number; x: number; y: number } | null>(null);

export function openProfile(id: number, x: number, y: number) {
  profileAt.value = { id, x, y };
}

export function copyText(text: string, done = t().common.copied) {
  bridge
    .copy(text)
    .then(() => toast(done))
    .catch(() => toast(t().common.copyFailed, 'error'));
}

export async function setStatus(status: string) {
  try {
    await api().updateMe({ status });
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export function ProfileCard({ id, onClose }: { id: number; onClose: () => void }) {
  const u = users.value.get(id);
  const self = id === me.value?.id;
  const [statusEdit, setStatusEdit] = useState<string | null>(null);
  if (!u) return null;
  const tp = t().common.profile;
  return (
    <div class="profile-card">
      <div class="profile-banner" style={{ '--c': u.color }} />
      <div class="profile-avatar">
        <Avatar id={id} size={84} showPresence />
      </div>
      <div class="profile-body">
        <div class="profile-name">{u.display_name}</div>
        <button class="profile-username" onClick={() => copyText(u.username, tp.usernameCopied)} title={tp.copyUsername}>
          @{u.username}
          <Icon name="copy" size={13} />
        </button>
        {statusEdit !== null ? (
          <form
            class="status-edit"
            onSubmit={(e) => {
              e.preventDefault();
              setStatus(statusEdit);
              setStatusEdit(null);
            }}
          >
            <input autoFocus maxLength={80} value={statusEdit} placeholder={tp.statusPlaceholder} onInput={(e) => setStatusEdit((e.target as HTMLInputElement).value)} />
            <div class="status-presets">
              {tp.statusPresets.map((s) => (
                <button type="button" key={s} onClick={() => (setStatus(s), setStatusEdit(null))}>
                  {s}
                </button>
              ))}
              {u.status && (
                <button type="button" class="danger-text" onClick={() => (setStatus(''), setStatusEdit(null))}>
                  {tp.clearStatus}
                </button>
              )}
            </div>
          </form>
        ) : u.status ? (
          <button class="profile-status" disabled={!self} onClick={() => setStatusEdit(u.status)}>
            {u.status}
          </button>
        ) : (
          self && (
            <button class="profile-status empty" onClick={() => setStatusEdit('')}>
              <Icon name="smilePlus" size={14} /> {tp.setStatus}
            </button>
          )
        )}
        {u.about && (
          <div class="profile-section">
            <div class="profile-label">{tp.about}</div>
            <div class="profile-about">{u.about}</div>
          </div>
        )}
        <div class="profile-section muted small">
          {online.value.has(id) ? <span class="online-text">{tp.online}</span> : tp.offline}
          {!!u.created_at && ' · ' + tp.memberSince(new Date(u.created_at))}
        </div>
        <div class="profile-actions">
          {self ? (
            <button
              class="primary"
              onClick={() => {
                onClose();
                settingsOpen.value = 'profile';
              }}
            >
              <Icon name="edit" size={16} /> {tp.editProfile}
            </button>
          ) : (
            <>
              <button
                class="primary"
                onClick={() => {
                  onClose();
                  openDM(id).catch((e) => toast(errorText(e), 'error'));
                }}
              >
                <Icon name="chat" size={16} /> {tp.message}
              </button>
              <button
                class="secondary"
                onClick={async () => {
                  onClose();
                  try {
                    const c = await openDM(id);
                    await startCall(c.id, userName(id));
                  } catch (e) {
                    toast(errorText(e), 'error');
                  }
                }}
                aria-label={tp.call}
              >
                <Icon name="phone" size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProfileHost() {
  const p = profileAt.value;
  if (!p) return null;
  const close = () => (profileAt.value = null);
  return (
    <Popover x={p.x} y={p.y} onClose={close} class="profile-pop">
      <ProfileCard id={p.id} onClose={close} />
    </Popover>
  );
}
