import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { people, users } from '../state';

export function useKnownUsers(ids: readonly number[]) {
  const store = people.value;
  const key = useMemo(() => crypto.randomUUID(), [store]);
  const signature = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!store || !signature) return;
    const needed = signature.split(',').map(Number);
    store.retain(key, needed);
    void store.ensure(needed).catch(() => {});
    return () => store.release(key);
  }, [store, key, signature]);
}

export function useUserPage(mode: 'directory' | 'contacts', query = '', enabled = true, exclude: number[] = []) {
  const store = people.value;
  const excluded = [...new Set(exclude)].sort((a, b) => a - b).join(',');
  const owner = useMemo(() => crypto.randomUUID(), [store]);
  const scope = `${owner}:${mode}:${query.trim()}:${excluded}`;
  const [navigation, setNavigation] = useState({ scope, cursors: [0] });
  const cursors = navigation.scope === scope ? navigation.cursors : [0];
  const after = cursors[cursors.length - 1];
  const requestKey = `${scope}:${after}`;
  const [page, setPage] = useState({ key: '', ids: [] as number[], next: null as number | null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const version = store?.contactsVersion.value ?? 0;
  const ids = page.key === requestKey && enabled ? page.ids : [];
  useKnownUsers(ids);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setLoading(enabled && !!store);
    if (!enabled || !store) return;
    void (async () => {
      try {
        const result = mode === 'contacts'
          ? await store.contactsPage(after, controller.signal)
          : await store.directory(query.trim(), after, controller.signal, excluded ? excluded.split(',').map(Number) : []);
        if (controller.signal.aborted || people.value !== store) return;
        setPage({ key: requestKey, ids: result.users.map((u) => u.id), next: result.has_more ? result.next_after : null });
      } catch (error) {
        if (!controller.signal.aborted && people.value === store) setError(error);
      } finally {
        if (!controller.signal.aborted && people.value === store) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [store, mode, query, after, requestKey, enabled, attempt, version, excluded]);
  return {
    users: ids.map((id) => users.value.get(id)).filter((u) => u !== undefined),
    loading: enabled && !!store && (loading || (!error && page.key !== requestKey)),
    error,
    hasPrevious: cursors.length > 1,
    hasNext: page.key === requestKey && page.next !== null,
    previous: () => setNavigation({ scope, cursors: cursors.slice(0, -1) }),
    next: () => { if (page.next !== null) setNavigation({ scope, cursors: [...cursors, page.next].slice(-200) }); },
    retry: () => setAttempt((n) => n + 1),
  };
}


export function useUserList(mode: 'directory' | 'dialogs' | 'contact' | 'incoming' | 'outgoing', query: string, enabled = true) {
  const store = people.value;
  const owner = useMemo(() => crypto.randomUUID(), [store]);
  const key = `${owner}:${mode}:${query.trim()}`;
  const order = useMemo(() => new Map<number, { name: string; since: number; online: boolean }>(), [key]);
  const [page, setPage] = useState({ key: '', ids: [] as number[], next: null as number | null });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<{ key: string; error: unknown; more: boolean } | null>(null);
  const error = failure?.key === key ? failure.error : null;
  const [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController | null>(null);
  const revision = store?.listsRevision.value ?? 0;
  const previousRevision = useRef(revision);
  const filteredVersion = query.trim() && mode !== 'directory' && mode !== 'dialogs' ? store?.contactEvents.value ?? 0 : 0;
  const current = useRef(key);
  current.current = key;
  const fetchPage = (after: number, signal: AbortSignal) => mode === 'directory'
    ? store!.directory(query.trim(), after, signal, [store!.uid])
    : mode === 'dialogs' ? store!.dialogsPage(query.trim(), after, signal)
    : store!.contactsPage(after, signal, mode, query.trim());

  useEffect(() => {
    const replace = previousRevision.current !== revision;
    previousRevision.current = revision;
    if (replace) setPage({ key: '', ids: [], next: null });
    active.current?.abort();
    active.current = null;
    setFailure(null);
    setLoadingMore(false);
    setLoading(enabled && !!store);
    if (!enabled || !store) return;
    const controller = new AbortController();
    active.current = controller;
    void fetchPage(0, controller.signal).then((result) => {
      if (controller.signal.aborted || people.value !== store) return;
      const ids = result.users.map((user) => user.id);
      for (const user of result.users) order.set(user.id, { name: user.display_name, since: result.relations?.[user.id]?.since ?? 0, online: !!user.online });
      setPage((old) => {
        if (replace || old.key !== key || !old.ids.length) return { key, ids, next: result.next_after };
        return { key, ids: [...new Set([...old.ids, ...ids])], next: old.next ?? (result.has_more ? old.ids.reduce((after, id) => Math.max(after, id), 0) : null) };
      });
    }).catch((error) => { if (!controller.signal.aborted) setFailure({ key, error, more: false }); })
      .finally(() => { if (!controller.signal.aborted) { active.current = null; setLoading(false); } });
    return () => { active.current?.abort(); active.current = null; };
  }, [store, key, enabled, revision, filteredVersion, attempt]);

  const loaded = enabled && page.key === key ? page.ids : [];
  const ids = [...loaded];
  if (store && mode !== 'directory' && mode !== 'dialogs' && !query.trim() && enabled && page.key === key) {
    const seen = new Set(ids);
    for (const [id, relation] of store.relations.value) {
      if (relation.state !== mode) continue;
      const oldOrder = order.get(id);
      if (oldOrder && oldOrder.since !== relation.since) order.set(id, { ...oldOrder, since: relation.since ?? 0 });
      if (seen.has(id)) continue;
      ids.push(id);
      if (!order.get(id)?.name) {
        const user = users.value.get(id);
        order.set(id, { name: user?.display_name ?? '', since: relation.since ?? 0, online: !!user?.online });
      }
    }
  }
  const matching = mode === 'directory' || mode === 'dialogs' ? ids : ids.filter((id) => {
    const relation = store?.relations.value.get(id);
    return !relation || relation.state === mode;
  });
  const more = async () => {
    if (!store || !enabled || active.current || page.key !== key || page.next === null) return;
    const controller = new AbortController();
    active.current = controller;
    setLoadingMore(true);
    setFailure(null);
    try {
      const result = await fetchPage(page.next, controller.signal);
      if (controller.signal.aborted || people.value !== store || current.current !== key) return;
      for (const user of result.users) order.set(user.id, { name: user.display_name, since: result.relations?.[user.id]?.since ?? 0, online: !!user.online });
      setPage((old) => old.key === key ? { key, ids: [...new Set([...old.ids, ...result.users.map((user) => user.id)])], next: result.next_after } : old);
    } catch (error) { if (!controller.signal.aborted) setFailure({ key, error, more: true }); }
    finally { if (!controller.signal.aborted) { active.current = null; setLoadingMore(false); } }
  };
  return { ids: matching, order, loading: enabled && !!store && (loading || (!error && page.key !== key)), loadingMore, error, hasMore: enabled && page.key === key && page.next !== null,
    more, retry: () => { if (failure?.key === key && failure.more) void more(); else setAttempt((n) => n + 1); } };
}
