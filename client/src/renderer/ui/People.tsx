import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from '@tanstack/virtual-core';
import { t } from '../i18n';
import { errorText, me, people, toast } from '../state';
import { Icon } from './common';
import { useKnownUsers, type useUserPage } from './usePeople';

export function ContactButton({ id, compact = false }: { id: number; compact?: boolean }) {
  const store = people.value;
  const relation = store?.relations.value.get(id);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (store && relation === undefined) void store.ensure([id], true).catch(() => {});
  }, [store, id, relation, store?.contactsVersion.value]);
  if (!store || id === me.value?.id) return null;
  const tx = t().common.people;
  const state = relation?.state ?? 'none';
  const label = state === 'contact' ? compact ? tx.contact : tx.removeContact : state === 'incoming' ? tx.accept : state === 'outgoing' ? tx.cancelRequest : store.mutual ? tx.request : tx.addContact;
  const act = async (action: 'request' | 'accept' | 'decline' | 'cancel' | 'remove') => {
    setBusy(true);
    try { if (store.mutual) await store.act(id, action, relation?.request_id); else await store.setContact(id, state !== 'contact'); }
    catch (error) { if (people.value === store) toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  };
  return <span class="contact-actions">
    <button type="button" class={compact ? 'icon-btn contact-toggle' : 'secondary small-btn'} title={label} aria-label={label} disabled={busy || relation === undefined || (compact && state === 'contact')} onClick={() => void act(state === 'incoming' ? 'accept' : state === 'outgoing' ? 'cancel' : state === 'contact' ? 'remove' : 'request')}>
      <Icon name={state === 'contact' || state === 'incoming' ? 'check' : state === 'outgoing' ? 'x' : 'userPlus'} size={16} />{!compact && label}
    </button>
    {!compact && state === 'incoming' && <button type="button" class="secondary small-btn" disabled={busy} onClick={() => void act('decline')}>{tx.decline}</button>}
  </span>;
}

export function RequestActions({ id }: { id: number }) {
  const store = people.value;
  const relation = store?.relations.value.get(id);
  const [busy, setBusy] = useState(false);
  if (!store || !relation || (relation.state !== 'incoming' && relation.state !== 'outgoing')) return null;
  const tx = t().common.people;
  const act = async (action: 'accept' | 'decline' | 'cancel') => {
    setBusy(true);
    try { await store.act(id, action, relation?.request_id); }
    catch (error) { if (people.value === store) toast(errorText(error), 'error'); }
    finally { setBusy(false); }
  };
  return <div class="request-actions">
    {relation.state === 'incoming' && <button class="secondary small-btn" disabled={busy} onClick={() => void act('accept')}><Icon name="check" size={14} />{tx.accept}</button>}
    <button class="link small" disabled={busy} onClick={() => void act(relation.state === 'incoming' ? 'decline' : 'cancel')}>{relation.state === 'incoming' ? tx.decline : tx.cancelRequest}</button>
  </div>;
}

export function PeopleList({ ids, render, more, hasMore = false, loading = false, error, retry, empty }: {
  ids: number[]; render(id: number): ComponentChildren; more?: () => void; hasMore?: boolean; loading?: boolean;
  error?: unknown; retry?: () => void; empty?: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);
  const getItemKey = useCallback((index: number) => ids[index], [ids]);
  const options = { count: ids.length, getScrollElement: () => scroll.current, estimateSize: () => 64, getItemKey,
    observeElementOffset, observeElementRect, scrollToFn: elementScroll, overscan: 6, onChange: () => redraw((value) => value + 1) };
  const [virtualizer] = useState(() => new Virtualizer<HTMLDivElement, HTMLDivElement>(options));
  virtualizer.setOptions(options);
  useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
  useLayoutEffect(() => virtualizer._willUpdate());
  const rows = virtualizer.getVirtualItems();
  useKnownUsers(rows.map((row) => ids[row.index]));
  const last = rows[rows.length - 1]?.index ?? -1;
  useEffect(() => { if (hasMore && !loading && !error && last >= ids.length - 6) more?.(); }, [last, ids.length, hasMore, loading, error]);
  return <div class="nav-scroll people-scroll" ref={scroll} aria-busy={loading}>
    <div class="people-virtual" style={{ height: virtualizer.getTotalSize() }}>
      {rows.map((row) => <div key={row.key} data-index={row.index} ref={(element) => virtualizer.measureElement(element)} class="people-virtual-row" style={{ transform: `translateY(${row.start}px)` }}>{render(ids[row.index])}</div>)}
    </div>
    {loading && <div class="people-loading" role="status" aria-label={t().common.people.loading}><i /><i /><i /></div>}
    {error ? <div class="history-status small"><span>{t().common.people.failed}</span><button class="link" onClick={retry}>{t().chat.view.retry}</button></div> : !loading && !ids.length && empty && <div class="nav-empty muted small">{empty}</div>}
  </div>;
}

export function UserPageControls({ page }: { page: ReturnType<typeof useUserPage> }) {
  const tx = t().common.people;
  return <>
    {page.loading && <div class="history-status small muted">{tx.loading}</div>}
    {page.error && <div class="history-status small"><span>{tx.failed}</span><button type="button" class="link" onClick={page.retry}>{t().chat.view.retry}</button></div>}
    {!page.loading && !page.error && (page.hasPrevious || page.hasNext) && <div class="history-pages">
      {page.hasPrevious && <button type="button" class="secondary small-btn" onClick={page.previous}>{t().chat.search.previous}</button>}
      {page.hasNext && <button type="button" class="secondary small-btn" onClick={page.next}>{t().chat.search.next}</button>}
    </div>}
  </>;
}
