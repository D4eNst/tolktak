import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Api, Group, ModerationDuration, ModerationPage, ModerationRule, VoiceModerationEvent, VoiceSource } from '../api';
import { intlLocale, t } from '../i18n';
import { callEvents, errorText, groupRole, groups, mergeUsers, session, toast, userName } from '../state';
import { Avatar, confirmDialog, Icon, type MenuItem, Modal, openMenu } from './common';

type Target = { api: Api; room: number; user: number; source: VoiceSource };
const restrictions = signal<{ api: Api; room: number } | null>(null);
const durationTarget = signal<Target | null>(null);
const revision = signal(0);
const pending = new Map<string, Api>();

window.addEventListener('tolktak:session-reset', () => {
  restrictions.value = null;
  durationTarget.value = null;
  pending.clear();
});
callEvents.addEventListener('voice.moderation', (event) => {
  const d = (event as CustomEvent<VoiceModerationEvent>).detail;
  if (restrictions.value?.room === d.room_id) revision.value++;
});
callEvents.addEventListener('voice.resync', () => revision.value++);

function groupFor(room: number) {
  return [...groups.value.values()].find((g) => g.rooms.some((r) => r.id === room));
}

export function canModerateRoom(room: number, user?: number) {
  const s = session.value;
  const g = groupFor(room);
  if (!s?.server.capabilities?.moderation || !g || groupRole(g) === 'member') return false;
  return user === undefined || canModerateUser(g, user, s.me.id);
}

function canModerateUser(g: Group, user: number, self: number) {
  if (user === self || user === g.owner_id) return false;
  return groupRole(g) === 'owner' || groupRole(g, user) === 'member';
}

export function openRestrictions(room: number) {
  const s = session.value;
  if (s && canModerateRoom(room)) restrictions.value = { api: s.api, room };
}

async function mutate(a: Api, key: string, run: () => Promise<unknown>) {
  if (session.value?.api !== a || pending.get(key) === a) return false;
  pending.set(key, a);
  try {
    await run();
    if (session.value?.api !== a) return false;
    revision.value++;
    return true;
  } catch (error) {
    if (session.value?.api === a) toast(errorText(error), 'error');
    return false;
  } finally { if (pending.get(key) === a) pending.delete(key); }
}

const restrict = (target: Target, duration: ModerationDuration) => mutate(target.api, `${target.room}:${target.user}:${target.source}`, () => target.api.restrictVoice(target.room, target.user, target.source, duration));

export function participantModerationItems(point: { clientX: number; clientY: number }, room: number, user: number): MenuItem[] {
  const a = session.value?.api;
  if (!a || !canModerateRoom(room, user)) return [];
  const tx = t().moderation;
  const show = (items: MenuItem[]) => openMenu(point, items, <div class="menu-header">{userName(user)}</div>);
  const durations = (source: VoiceSource) => {
    const target = { api: a, room, user, source };
    show([
      { label: tx[source], icon: 'arrowLeft', run: () => actions(source) },
      'sep',
      { label: tx.fiveMinutes, run: () => { void restrict(target, { duration: 'time', seconds: 300 }); } },
      { label: tx.thirtyMinutes, run: () => { void restrict(target, { duration: 'time', seconds: 1800 }); } },
      { label: tx.hour, run: () => { void restrict(target, { duration: 'time', seconds: 3600 }); } },
      { label: tx.custom, run: () => { durationTarget.value = target; } },
      'sep',
      { label: tx.untilEnd, run: () => { void restrict(target, { duration: 'call' }); } },
      { label: tx.permanent, run: () => { void restrict(target, { duration: 'permanent' }); } },
    ]);
  };
  const actions = (source: VoiceSource) => show([
    { label: tx.turnOff, icon: source === 'microphone' ? 'micOff' : source === 'camera' ? 'videoOff' : 'stop', run: () => { void mutate(a, `${room}:${user}:${source}`, () => a.turnOffVoice(room, user, source)); } },
    { label: tx.restrict, icon: 'shield', hint: '›', run: () => durations(source) },
  ]);
  return [
    ...(['microphone', 'camera', 'screen'] as const).map((source): MenuItem => ({ label: tx[source], icon: source === 'microphone' ? 'mic' : source === 'camera' ? 'video' : 'screen', hint: '›', run: () => actions(source) })),
    { label: tx.restrictions, icon: 'shield', run: () => openRestrictions(room) },
    'sep',
    { label: tx.kick, icon: 'phoneOff', danger: true, run: async () => {
      if (await confirmDialog(tx.kickTitle(userName(user)), { text: tx.kickText, ok: tx.kick, danger: true })) {
        await mutate(a, `${room}:${user}:entry`, () => a.kickVoice(room, user));
      }
    } },
  ];
}

function ruleDuration(rule: ModerationRule) {
  const tx = t().moderation;
  if (rule.duration === 'call') return tx.untilEnd;
  if (rule.duration === 'permanent') return tx.permanent;
  return tx.until(new Date(rule.expires_at ?? 0).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }));
}

function RestrictionDialog({ room, api: a, onClose }: { room: number; api: Api; onClose: () => void }) {
  const [cursors, setCursors] = useState([0]);
  const [page, setPage] = useState<ModerationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const currentRevision = revision.value;
  const after = cursors.at(-1)!;
  const tx = t().moderation;
  const allowed = canModerateRoom(room);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    a.moderation(room, after, controller.signal).then((result) => {
      if (controller.signal.aborted || session.value?.api !== a) return;
      mergeUsers(result.users);
      if (!result.rules.length && after) { setCursors((list) => list.slice(0, -1)); return; }
      setPage(result);
      setLoading(false);
    }).catch((e) => {
      if (controller.signal.aborted || session.value?.api !== a) return;
      setError(errorText(e));
      setLoading(false);
    });
    return () => controller.abort();
  }, [room, a, after, currentRevision]);
  useEffect(() => { if (!allowed) onClose(); }, [allowed]);
  return <Modal title={tx.restrictions} onClose={onClose}>
    <div class="muted small">{groupFor(room)?.rooms.find((r) => r.id === room)?.name}</div>
    {loading ? <div class="history-status muted">{t().common.people.loading}</div> : error ?
      <div class="history-status"><span>{error}</span><button class="link" onClick={() => revision.value++}>{t().chat.view.retry}</button></div> : <>
        {!page?.rules.length && <div class="history-status muted">{tx.empty}</div>}
        <div class="moderation-list">{page?.rules.map((rule) => <div class="moderation-row" key={rule.id}>
          <Avatar id={rule.user_id} size={32} />
          <div class="moderation-details"><strong>{userName(rule.user_id)}</strong><span>{tx[rule.source]}</span><small class="muted">{ruleDuration(rule)}</small></div>
          {canModerateRoom(room, rule.user_id) && <button class="icon-btn" disabled={busy !== null} title={tx.remove} aria-label={`${tx.remove}: ${userName(rule.user_id)}, ${tx[rule.source]}`} onClick={async () => {
            setBusy(rule.id);
            await mutate(a, `${room}:${rule.user_id}:${rule.source}`, () => a.allowVoice(room, rule.user_id, rule.source));
            setBusy(null);
          }}><Icon name="x" size={16} /></button>}
        </div>)}</div>
        {(cursors.length > 1 || page?.has_more) && <div class="history-pages">
          {cursors.length > 1 && <button class="secondary small-btn" onClick={() => { setPage(null); setCursors((list) => list.slice(0, -1)); }}>{t().chat.search.previous}</button>}
          {page?.has_more && page.next_after !== null && <button class="secondary small-btn" onClick={() => { setCursors((list) => [...list, page.next_after!]); setPage(null); }}>{t().chat.search.next}</button>}
        </div>}
      </>}
  </Modal>;
}

function DurationDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(false);
  const value = Number(minutes);
  const tx = t().moderation;
  return <Modal title={tx.duration} onClose={onClose}>
    <p class="muted">{userName(target.user)} · {tx[target.source]}</p>
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!Number.isInteger(value) || value < 1 || value > 525600 || busy) return;
      setBusy(true);
      if (await restrict(target, { duration: 'time', seconds: value * 60 })) onClose();
      setBusy(false);
    }}>
      <label class="field">{tx.minutes}<input type="number" min="1" max="525600" step="1" value={minutes} onInput={(e) => setMinutes(e.currentTarget.value)} autoFocus required /></label>
      <div class="modal-actions"><button type="button" class="secondary" onClick={onClose}>{t().common.cancel}</button><button class="primary" disabled={busy || !Number.isInteger(value) || value < 1 || value > 525600}>{tx.restrict}</button></div>
    </form>
  </Modal>;
}

export function ModerationHost() {
  const r = restrictions.value;
  const d = durationTarget.value;
  if (d && d.api === session.value?.api) return <DurationDialog key={`${d.room}:${d.user}:${d.source}`} target={d} onClose={() => { durationTarget.value = null; }} />;
  if (r && r.api === session.value?.api) return <RestrictionDialog key={r.room} room={r.room} api={r.api} onClose={() => { restrictions.value = null; }} />;
  return null;
}
