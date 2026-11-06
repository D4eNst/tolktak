import { batch, signal } from '@preact/signals';
import { Api, ApiError, type HistoryPage, type HistoryQuery, type Message, type ReadState, type ReplyPreview, type User } from './api';

const PAGE_SIZE = 100;
const WINDOW_LIMIT = 300;
const TOTAL_LIMIT = 2400;
const EVENT_LIMIT = 200;
const revision = (m: { revision?: number }) => m.revision ?? 0;

export type HistoryAnchor = { id: number; offset: number };
export type HistoryPosition = { kind: 'latest' | 'start' | 'target' | 'anchor'; id?: number; offset?: number; serial: number };
export type WindowState = {
  ids: number[];
  hasBefore: boolean;
  hasAfter: boolean;
  loaded: boolean;
  loading: boolean;
  olderLoading: boolean;
  newerLoading: boolean;
  error: unknown;
  olderError: unknown;
  newerError: unknown;
  position: HistoryPosition;
};
type ChannelData = {
  items: Map<number, Message>;
  events: Map<number, Message>;
  floor: number;
  synced: number | null;
  seen: Set<number>;
  sync?: Promise<void>;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  needsReset?: boolean;
};
type Collection = { channelId: number; ids: number[] };
type Callbacks = { users(users: User[]): void; read(state: ReadState): void; message?(message: Message): void; reset?(): Promise<void> };

export function replyPreview(m: Message): ReplyPreview {
  return {
    id: m.id,
    author_id: m.author_id,
    text: m.deleted ? '' : m.text.slice(0, 160) + (m.text.length > 160 ? '…' : ''),
    deleted: m.deleted,
    attachments: m.deleted ? 0 : m.attachments.length,
    revision: revision(m),
  };
}

export class HistoryView {
  readonly state = signal<WindowState>({
    ids: [],
    hasBefore: false,
    hasAfter: false,
    loaded: false,
    loading: false,
    olderLoading: false,
    newerLoading: false,
    error: null,
    olderError: null,
    newerError: null,
    position: { kind: 'latest', serial: 0 },
  });
  anchor: HistoryAnchor | null = null;
  following = true;
  edgeID = 0;
  generation = 0;
  requests = new Map<string, AbortController>();
  backStack: HistoryAnchor[] = [];
  query: HistoryQuery = {};
  queryPosition: Omit<HistoryPosition, 'serial'> = { kind: 'latest' };
  disposed = false;

  constructor(readonly store: HistoryStore, readonly channelId: number) {}

  get items() {
    this.store.updated.value;
    return this.state.value.ids.map((id) => this.store.message(this.channelId, id)).filter((m): m is Message => !!m && !m.deleted);
  }

  open(read: { last_read_id: number; unread: number }) {
    return this.store.load(this, read.unread ? { after: read.last_read_id } : {}, read.unread ? { kind: 'start' } : { kind: 'latest' });
  }

  older() { return this.store.edge(this, 'older'); }
  newer() { return this.store.edge(this, 'newer'); }
  latest() {
    this.backStack = [];
    return this.store.load(this, {}, { kind: 'latest' });
  }

  async jump(id: number) {
    if (this.anchor) {
      this.backStack.push({ ...this.anchor });
      if (this.backStack.length > 20) this.backStack.shift();
    }
    this.following = false;
    return this.store.load(this, { around: id }, { kind: 'target', id });
  }

  async back() {
    const anchor = this.backStack.pop();
    if (!anchor) return this.latest();
    return this.store.load(this, { around: anchor.id }, { kind: 'anchor', ...anchor }, true);
  }

  refresh() {
    const state = this.state.value;
    if (!state.loaded) return this.store.load(this, this.query, this.queryPosition, true);
    if (this.following && !state.hasAfter) return this.store.load(this, {}, { kind: 'latest' });
    const first = state.ids[0] ?? this.edgeID;
    const anchor = this.anchor ?? (first ? { id: first, offset: 0 } : null);
    if (anchor) return this.store.load(this, { around: anchor.id }, { kind: 'anchor', ...anchor }, true);
    return this.store.load(this, this.query, { kind: 'start' });
  }

  retry() { return this.store.retry(this); }
  dispose() { this.store.remove(this); }
}

export class HistoryStore {
  readonly updated = signal(0);
  readonly collectionsVersion = signal(new Map<number, number>());
  readonly views = new Set<HistoryView>();
  private channels = new Map<number, ChannelData>();
  private collections = new Map<string, Collection>();
  private disposed = false;
  private recovery?: Promise<void>;

  constructor(readonly api: Api, private callbacks: Callbacks, private supportsChanges = true) {}

  private channel(cid: number) {
    let data = this.channels.get(cid);
    if (!data) {
      data = { items: new Map(), events: new Map(), floor: 0, synced: null, seen: new Set() };
      this.channels.set(cid, data);
    }
    return data;
  }

  createView(cid: number) {
    const view = new HistoryView(this, cid);
    this.views.add(view);
    this.channel(cid);
    this.collect();
    return view;
  }

  message(cid: number, id: number) {
    const channel = this.channels.get(cid);
    return channel?.items.get(id) ?? channel?.events.get(id);
  }

  collection(key: string) {
    this.updated.value;
    const c = this.collections.get(key);
    return c ? c.ids.map((id) => this.message(c.channelId, id)).filter((m): m is Message => !!m && !m.deleted) : [];
  }

  retain(key: string, cid: number, items: Message[], version?: number) {
    if (this.disposed) return;
    const c = this.channel(cid);
    if (version !== undefined && version < c.floor) return false;
    if (c.synced === null && version !== undefined) this.establish(c, cid, version);
    for (const m of items) this.merge(c, m);
    for (const m of c.events.values()) this.merge(c, m);
    this.collections.set(key, { channelId: cid, ids: items.slice(0, WINDOW_LIMIT).map((m) => m.id) });
    this.collect();
    this.updated.value++;
    return true;
  }

  release(key: string) {
    this.collections.delete(key);
    this.collect();
  }

  private merge(c: ChannelData, incoming: Message) {
    const old = c.items.get(incoming.id);
    let next = !old || revision(incoming) >= revision(old) ? incoming : old;
    let reply = next.reply;
    for (const candidate of [old?.reply, incoming.reply]) {
      if (candidate && (!reply || revision(candidate) > revision(reply))) reply = candidate;
    }
    if (reply) {
      const target = c.items.get(reply.id) ?? c.events.get(reply.id);
      if (target && revision(target) >= revision(reply)) reply = replyPreview(target);
    }
    if (reply !== next.reply) next = { ...next, reply };
    c.items.set(next.id, next);
    const preview = replyPreview(next);
    for (const [id, item] of c.items) {
      if (item.reply_to === next.id && (!item.reply || revision(item.reply) <= revision(preview))) c.items.set(id, { ...item, reply: preview });
    }
    return next;
  }

  receive(message: Message) {
    if (this.disposed) return;
    const c = this.channels.get(message.channel_id);
    if (!c) return;
    if (revision(message) <= c.floor) return;
    const known = c.items.get(message.id) ?? c.events.get(message.id);
    const changed = revision(message) > revision(known ?? {}) && (!!known || message.deleted || !!message.edited_at || !!message.pinned_at);
    const previous = c.events.get(message.id);
    if (!previous || revision(previous) <= revision(message)) c.events.set(message.id, message);
    if (c.events.size > EVENT_LIMIT) {
      const oldest = [...c.events.values()].sort((a, b) => revision(a) - revision(b))[0];
      c.events.delete(oldest.id);
      c.floor = Math.max(c.floor, revision(oldest));
    }
    const m = this.merge(c, message);
    batch(() => {
      for (const view of this.views) {
        if (view.channelId !== m.channel_id || !view.state.value.loaded) continue;
        const s = view.state.value;
        view.edgeID = Math.max(view.edgeID, s.ids.at(-1) ?? 0);
        let ids = s.ids.filter((id) => id !== m.id || !m.deleted);
        const inside = ids.length > 0 && m.id >= ids[0] && m.id <= ids[ids.length - 1];
        const tail = !s.hasAfter && m.id > view.edgeID;
        if (!m.deleted && (inside || tail) && !ids.includes(m.id)) ids = [...ids, m.id].sort((a, b) => a - b);
        view.edgeID = Math.max(view.edgeID, ids.at(-1) ?? 0);
        view.state.value = { ...s, ids };
      }
      this.collect();
      this.updated.value++;
      if (changed) this.invalidateCollections(message.channel_id);
    });
    this.rememberRevision(c, message.channel_id, revision(message));
  }

  private establish(c: ChannelData, cid: number, version: number) {
    c.synced = version;
    c.floor = Math.max(c.floor, version);
    for (const message of c.events.values()) this.rememberRevision(c, cid, revision(message));
  }

  private rememberRevision(c: ChannelData, cid: number, rev: number) {
    if (c.synced !== null && rev > c.synced) {
      c.seen.add(rev);
      while (c.seen.delete(c.synced + 1)) c.synced++;
      if (c.seen.size > EVENT_LIMIT) c.seen.clear();
      if (rev > c.synced && !c.timer) c.timer = setTimeout(() => {
        c.timer = undefined;
        void this.sync(cid).catch(() => {});
      }, 500);
    }
  }

  private consume(cid: number, page: Pick<HistoryPage, 'users' | 'read' | 'history_version'>) {
    this.callbacks.users(page.users);
    this.callbacks.read({ channel_id: cid, ...page.read, history_version: page.history_version });
  }

  private invalidateCollections(cid: number) {
    const versions = new Map(this.collectionsVersion.value);
    versions.set(cid, (versions.get(cid) ?? 0) + 1);
    this.collectionsVersion.value = versions;
  }

  private async page(view: HistoryView, query: HistoryQuery, generation: number, controller: AbortController) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await this.api.history(view.channelId, { ...query, limit: PAGE_SIZE }, controller.signal);
      if (!this.valid(view, generation, controller)) return null;
      if (page.history_version >= this.channel(view.channelId).floor) return page;
    }
    throw new Error('history_changed');
  }

  private eventsAfter(c: ChannelData, boundary: number, version: number) {
    return [...c.events.values()].filter((m) => !m.deleted && m.id > boundary && revision(m) > version).map((m) => m.id);
  }

  async load(view: HistoryView, query: HistoryQuery, position: Omit<HistoryPosition, 'serial'>, allowMissing = false) {
    if (this.disposed || view.disposed) return false;
    view.generation++;
    for (const controller of view.requests.values()) controller.abort();
    view.requests.clear();
    view.query = query;
    view.queryPosition = position;
    const generation = view.generation;
    const controller = new AbortController();
    view.requests.set('load', controller);
    view.state.value = { ...view.state.value, loading: true, olderLoading: false, newerLoading: false, error: null, olderError: null, newerError: null };
    try {
      let page: HistoryPage | null;
      try {
        page = await this.page(view, query, generation, controller);
      } catch (error) {
        if (!allowMissing || !query.around || !(error instanceof ApiError) || error.status !== 404) throw error;
        page = await this.page(view, { after: query.around }, generation, controller);
        if (page && !page.messages.length) page = await this.page(view, { before: query.around }, generation, controller);
        position = { kind: 'start' };
      }
      if (!page || !this.valid(view, generation, controller)) return false;
      const c = this.channel(view.channelId);
      if (page.history_version < c.floor) throw new Error('history_changed');
      for (const m of page.messages) this.merge(c, m);
      for (const m of c.events.values()) if (revision(m) > page.history_version) this.merge(c, m);
      let ids = page.messages.map((m) => m.id).filter((id) => !c.items.get(id)?.deleted);
      view.edgeID = page.last_id ?? query.after ?? query.around ?? query.before ?? 0;
      if (!page.has_after) ids = [...new Set([...ids, ...this.eventsAfter(c, view.edgeID, page.history_version)])].sort((a, b) => a - b);
      view.edgeID = Math.max(view.edgeID, ids.at(-1) ?? 0);
      if (c.synced === null) this.establish(c, view.channelId, page.history_version);
      view.following = position.kind === 'latest';
      batch(() => {
        view.state.value = {
          ids,
          hasBefore: page.has_before,
          hasAfter: page.has_after,
          loaded: true,
          loading: false,
          olderLoading: false,
          newerLoading: false,
          error: null,
          olderError: null,
          newerError: null,
          position: { ...position, serial: view.state.value.position.serial + 1 },
        };
        this.consume(view.channelId, page);
        for (const m of page.messages) this.callbacks.message?.(m);
        this.collect();
        this.updated.value++;
      });
      return true;
    } catch (error) {
      if (this.valid(view, generation, controller)) view.state.value = { ...view.state.value, loading: false, error };
      return false;
    } finally {
      if (view.requests.get('load') === controller) view.requests.delete('load');
    }
  }

  private valid(view: HistoryView, generation: number, controller: AbortController) {
    return !this.disposed && !view.disposed && !controller.signal.aborted && view.generation === generation;
  }

  retry(view: HistoryView) {
    if (this.channels.get(view.channelId)?.needsReset) return this.sync(view.channelId).then(() => true, () => false);
    return this.load(view, view.query, view.queryPosition, true);
  }

  async edge(view: HistoryView, direction: 'older' | 'newer') {
    const state = view.state.value;
    if (this.disposed || view.disposed || !state.loaded || state.loading || view.requests.has(direction)) return;
    const older = direction === 'older';
    if (!(older ? state.hasBefore : state.hasAfter)) return;
    const cursor = older ? state.ids[0] : state.ids[state.ids.length - 1];
    if (cursor === undefined) return view.refresh();
    const controller = new AbortController();
    view.requests.set(direction, controller);
    const generation = view.generation;
    const loading = older ? 'olderLoading' : 'newerLoading';
    const errorKey = older ? 'olderError' : 'newerError';
    view.state.value = { ...state, [loading]: true, [errorKey]: null };
    try {
      const page = await this.page(view, { [older ? 'before' : 'after']: cursor }, generation, controller);
      if (!page || !this.valid(view, generation, controller)) return;
      const c = this.channel(view.channelId);
      if (page.history_version < c.floor) throw new Error('history_changed');
      for (const m of page.messages) this.merge(c, m);
      for (const m of c.events.values()) if (revision(m) > page.history_version) this.merge(c, m);
      const now = view.state.value;
      const added = page.messages.map((m) => m.id);
      if (!older && !page.has_after) added.push(...this.eventsAfter(c, page.last_id ?? cursor, page.history_version));
      const ids = [...new Set([...now.ids, ...added])].filter((id) => !c.items.get(id)?.deleted).sort((a, b) => a - b);
      view.edgeID = Math.max(view.edgeID, ids.at(-1) ?? 0);
      view.state.value = { ...now, ids, [loading]: false, [older ? 'hasBefore' : 'hasAfter']: older ? page.has_before : page.has_after };
      this.consume(view.channelId, page);
      for (const m of page.messages) this.callbacks.message?.(m);
      this.collect();
      this.updated.value++;
    } catch (error) {
      if (this.valid(view, generation, controller)) view.state.value = { ...view.state.value, [loading]: false, [errorKey]: error };
    } finally {
      if (view.requests.get(direction) === controller) view.requests.delete(direction);
    }
  }

  async sync(cid: number) {
    const c = this.channels.get(cid);
    if (!c || this.disposed) return;
    if (c.sync) return c.sync;
    const task = async () => {
      const views = [...this.views].filter((view) => view.channelId === cid);
      if (c.synced === null || !this.supportsChanges) {
        await Promise.all(views.map((view) => view.refresh()));
        return;
      }
      const controller = new AbortController();
      c.controller = controller;
      const changes = await this.api.changes(cid, c.synced, controller.signal);
      if (this.disposed || controller.signal.aborted || this.channels.get(cid) !== c) return;
      this.consume(cid, changes);
      for (const m of changes.messages) {
        this.receive(m);
        this.callbacks.message?.(m);
      }
      if (!changes.complete) {
        c.floor = Math.max(c.floor, changes.history_version);
        for (const collection of this.collections.values()) if (collection.channelId === cid) collection.ids = [];
        this.invalidateCollections(cid);
        const reloaded = await Promise.all(views.map((view) => view.refresh()));
        if (reloaded.some((ok) => !ok)) return;
      }
      if (this.channels.get(cid) !== c || this.disposed) return;
      c.synced = Math.max(c.synced ?? 0, changes.history_version);
      for (const rev of c.seen) if (rev <= c.synced) c.seen.delete(rev);
      while (c.seen.delete(c.synced + 1)) c.synced++;
      this.collect();
      this.updated.value++;
    };
    c.sync = task().catch(async (error) => {
      if (!this.disposed && this.channels.get(cid) === c) {
        if (error instanceof ApiError && error.status === 409 && this.callbacks.reset) {
          c.needsReset = true;
          try {
            this.recovery ??= this.callbacks.reset().finally(() => { this.recovery = undefined; });
            await this.recovery;
            return;
          } catch (failure) {
            error = failure;
          }
        }
        for (const view of this.views) if (view.channelId === cid && !view.disposed) view.state.value = { ...view.state.value, error };
      }
      throw error;
    }).finally(() => { c.sync = undefined; });
    return c.sync;
  }

  async syncAll() { await Promise.all([...this.channels.keys()].map((cid) => this.sync(cid))); }

  remove(view: HistoryView) {
    view.disposed = true;
    for (const controller of view.requests.values()) controller.abort();
    view.requests.clear();
    this.views.delete(view);
    this.collect();
  }

  forget(cid: number) {
    for (const view of this.views) if (view.channelId === cid) this.remove(view);
    for (const [key, collection] of this.collections) if (collection.channelId === cid) this.collections.delete(key);
    const c = this.channels.get(cid);
    c?.controller?.abort();
    clearTimeout(c?.timer);
    this.channels.delete(cid);
    const versions = new Map(this.collectionsVersion.value);
    versions.delete(cid);
    this.collectionsVersion.value = versions;
    this.updated.value++;
  }

  private collect() {
    const count = this.views.size + this.collections.size;
    const limit = Math.max(1, Math.min(WINDOW_LIMIT, Math.floor(TOTAL_LIMIT / Math.max(1, count))));
    const retained = new Map<number, Set<number>>();
    const keep = (cid: number, ids: number[]) => {
      let set = retained.get(cid);
      if (!set) retained.set(cid, set = new Set());
      for (const id of ids) set.add(id);
    };
    for (const view of this.views) {
      const s = view.state.value;
      if (s.ids.length > limit) {
        const index = view.following ? s.ids.length : Math.max(0, s.ids.indexOf(view.anchor?.id ?? s.position.id ?? s.ids[0]));
        const start = Math.max(0, Math.min(s.ids.length - limit, index - Math.floor(limit / 2)));
        view.state.value = { ...s, ids: s.ids.slice(start, start + limit), hasBefore: s.hasBefore || start > 0, hasAfter: s.hasAfter || start + limit < s.ids.length };
      }
      keep(view.channelId, view.state.value.ids);
    }
    for (const c of this.collections.values()) {
      c.ids = c.ids.slice(0, limit);
      keep(c.channelId, c.ids);
    }
    const eventBudget = Math.max(1, Math.min(EVENT_LIMIT, Math.floor(TOTAL_LIMIT / Math.max(1, retained.size))));
    for (const [cid, c] of this.channels) {
      const ids = retained.get(cid);
      if (!ids) {
        c.controller?.abort();
        clearTimeout(c.timer);
        this.channels.delete(cid);
        if (this.collectionsVersion.peek().has(cid)) {
          const versions = new Map(this.collectionsVersion.peek());
          versions.delete(cid);
          this.collectionsVersion.value = versions;
        }
        continue;
      }
      for (const id of c.items.keys()) if (!ids.has(id)) c.items.delete(id);
      const events = [...c.events.values()].sort((a, b) => revision(b) - revision(a));
      for (const m of events.slice(eventBudget)) {
        c.events.delete(m.id);
        c.floor = Math.max(c.floor, revision(m));
      }
      if (c.seen.size > eventBudget) c.seen.clear();
    }
  }

  dispose() {
    this.disposed = true;
    for (const view of [...this.views]) this.remove(view);
    for (const c of this.channels.values()) {
      c.controller?.abort();
      clearTimeout(c.timer);
    }
    this.collections.clear();
    this.channels.clear();
  }
}
