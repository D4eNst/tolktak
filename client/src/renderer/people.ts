import { batch, computed, signal, type Signal } from '@preact/signals';
import { ApiError, type Api, type ContactState, type ProfilesPage, type Relation, type User, type UserPage } from './api';

const CACHE_LIMIT = 2000;
const WATCH_LIMIT = 500;
const BATCH_LIMIT = 100;
const validID = (id: number) => Number.isSafeInteger(id) && id > 0;
const revision = (user: User) => user.profile_revision ?? 0;
const aborted = () => new DOMException('Profile request cancelled', 'AbortError');
type Context = { profiles: Signal<Map<number, User>>; online: Signal<Set<number>>; send(frame: Record<string, unknown>): void };
type Waiting = { promise: Promise<void>; resolve(): void; reject(error: unknown): void; running: boolean };
export type PeopleSnapshot = { users: User[]; user_ids: number[]; request_id?: string };

/** Session-owned canonical profiles, partial contact knowledge and bounded presence watches. */
export class PeopleStore {
  readonly relations = signal(new Map<number, Relation>());
  readonly contacts = computed(() => new Map([...this.relations.value].map(([id, relation]) => [id, relation.state === 'contact'])));
  readonly contactsVersion = signal(0);
  readonly incomingCount = signal(0);
  readonly listsRevision = signal(0);
  readonly contactEvents = signal(0);
  private disposed = false;
  private controllers = new Set<AbortController>();
  private refs = new Map<string, number[]>();
  private lookups = new Map<number, number>();
  private touched = new Map<number, number>();
  private clock = 0;
  private presenceClock = 0;
  private presenceFloor = 0;
  private presenceVersions = new Map<number, number>();
  private waiting = new Map<number, Waiting>();
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private activeBatches = 0;
  private requestNumber = 0;
  private identity = crypto.randomUUID();
  private watch: { id: string; ids: Set<number>; epoch: number } | null = null;

  constructor(readonly api: Api, readonly uid: number, private context: Context, readonly mutual = false) { this.prune(); }

  private alive() { if (this.disposed) throw aborted(); }
  private touch(id: number) { this.touched.set(id, ++this.clock); }
  private pinned() {
    const ids = new Set<number>([this.uid, ...this.lookups.keys(), ...this.waiting.keys()]);
    for (const list of this.refs.values()) for (const id of list) ids.add(id);
    return ids;
  }

  private async request<T>(call: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    this.alive();
    if (external?.aborted) throw aborted();
    const controller = new AbortController();
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    this.controllers.add(controller);
    let rejectAbort!: (error: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await Promise.race([call(signal), cancellation]);
      this.alive();
      if (signal.aborted) throw aborted();
      return response;
    } finally {
      this.controllers.delete(controller);
      signal.removeEventListener('abort', onAbort);
    }
  }

  merge(users: User[], presenceEpoch?: number): void {
    if (this.disposed) return;
    const epoch = presenceEpoch ?? ++this.presenceClock;
    const profiles = new Map(this.context.profiles.peek());
    const online = new Set(this.context.online.peek());
    for (const incoming of users) {
      if (!validID(incoming.id)) continue;
      const old = profiles.get(incoming.id);
      let knownOnline = old?.online;
      if (knownOnline === undefined && (this.presenceVersions.has(incoming.id) || online.has(incoming.id))) {
        knownOnline = online.has(incoming.id);
      }
      let user = old && revision(old) > revision(incoming) ? old : { ...incoming };
      if (user !== old) {
        if (knownOnline === undefined) delete user.online;
        else user.online = knownOnline;
      }
      if (typeof incoming.online === 'boolean' && epoch >= (this.presenceVersions.get(incoming.id) ?? this.presenceFloor)) {
        this.presenceVersions.set(incoming.id, epoch);
        if (incoming.online) online.add(incoming.id);
        else online.delete(incoming.id);
        if (user.online !== incoming.online) user = { ...user, online: incoming.online };
      }
      profiles.set(user.id, user);
      this.touch(user.id);
    }
    batch(() => {
      this.context.profiles.value = profiles;
      this.context.online.value = online;
      this.prune();
    });
  }

  private membership(response: ProfilesPage) {
    const version = response.contacts_version;
    if (version < this.contactsVersion.peek()) return;
    if (version > this.contactsVersion.peek() && this.relations.peek().size) this.listsRevision.value++;
    const next = version > this.contactsVersion.peek() ? new Map<number, Relation>() : new Map(this.relations.peek());
    const selected = new Set(response.contact_ids);
    for (const user of response.users) {
      next.set(user.id, response.relations?.[user.id] ?? { state: selected.has(user.id) ? 'contact' : 'none', request_id: null, since: null });
      this.touch(user.id);
    }
    this.relations.value = next;
    this.contactsVersion.value = version;
    if (response.incoming_count !== undefined) this.incomingCount.value = response.incoming_count;
    this.prune();
  }

  private ingest<T extends ProfilesPage>(response: T, epoch: number): T {
    batch(() => {
      this.merge(response.users, epoch);
      this.membership(response);
    });
    return { ...response, users: response.users.map((user) => this.context.profiles.peek().get(user.id) ?? user) };
  }

  async directory(q = '', after = 0, signal?: AbortSignal, exclude: number[] = []): Promise<UserPage> {
    const epoch = ++this.presenceClock;
    const response = await this.request((controller) => this.api.directory(q, after, controller, exclude), signal);
    this.alive();
    return this.ingest(response, epoch);
  }

  async contactsPage(after = 0, signal?: AbortSignal, relation: 'contact' | 'incoming' | 'outgoing' = 'contact', query = ''): Promise<UserPage> {
    const epoch = ++this.presenceClock;
    const response = await this.request((controller) => this.api.contacts(after, controller, this.mutual ? relation : undefined, this.mutual ? query : ''), signal);
    this.alive();
    return this.ingest(response, epoch);
  }

  async dialogsPage(query = '', after = 0, signal?: AbortSignal): Promise<UserPage> {
    const epoch = ++this.presenceClock;
    const response = await this.request((controller) => this.api.dialogUsers(query, after, controller), signal);
    return this.ingest(response, epoch);
  }

  async profile(id: number, signal?: AbortSignal): Promise<User> {
    this.alive();
    this.lookups.set(id, (this.lookups.get(id) ?? 0) + 1);
    const epoch = ++this.presenceClock;
    try {
      const response = await this.request((controller) => this.api.profile(id, controller), signal);
      this.alive();
      this.ingest({ users: [response.user], contact_ids: response.contact ? [id] : [], contacts_version: response.contacts_version, relations: response.relation ? { [id]: response.relation } : undefined, incoming_count: response.incoming_count }, epoch);
      return this.context.profiles.peek().get(id) ?? response.user;
    } finally {
      const remaining = (this.lookups.get(id) ?? 1) - 1;
      if (remaining > 0) this.lookups.set(id, remaining);
      else this.lookups.delete(id);
      this.prune();
    }
  }

  async ensure(ids: number[], force = false): Promise<void> {
    this.alive();
    const promises: Promise<void>[] = [];
    for (const id of new Set(ids.filter(validID))) {
      const existing = this.waiting.get(id);
      if (existing) {
        promises.push(existing.promise);
        continue;
      }
      if (!force && this.context.profiles.peek().has(id)) {
        this.touch(id);
        continue;
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.waiting.set(id, { promise, resolve, reject, running: false });
      promises.push(promise);
    }
    if (this.waiting.size && !this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = undefined;
        this.drain();
      }, 10);
    }
    await Promise.all(promises);
    this.alive();
  }

  private drain() {
    if (this.disposed) return;
    while (this.activeBatches < 2) {
      const ids = [...this.waiting].filter(([, entry]) => !entry.running).slice(0, BATCH_LIMIT).map(([id]) => id);
      if (!ids.length) return;
      for (const id of ids) this.waiting.get(id)!.running = true;
      this.activeBatches++;
      void this.fetchBatch(ids).finally(() => {
        this.activeBatches--;
        this.drain();
      });
    }
  }

  private async fetchBatch(ids: number[]) {
    const epoch = ++this.presenceClock;
    try {
      const response = await this.request((controller) => this.api.profiles(ids, controller));
      this.alive();
      this.ingest(response, epoch);
      const found = new Set(response.users.map((user) => user.id));
      for (const id of ids) {
        const entry = this.waiting.get(id);
        this.waiting.delete(id);
        if (found.has(id)) entry?.resolve();
        else entry?.reject(new Error(`Profile ${id} is unavailable`));
      }
    } catch (error) {
      for (const id of ids) {
        this.waiting.get(id)?.reject(error);
        this.waiting.delete(id);
      }
    } finally {
      this.prune();
    }
  }

  retain(key: string, ids: number[]) {
    if (this.disposed) return;
    const next = [...new Set(ids.filter(validID))];
    const old = this.refs.get(key);
    if (old?.length === next.length && old.every((id, index) => id === next[index])) return;
    this.refs.delete(key);
    this.refs.set(key, next);
    for (const id of next) this.touch(id);
    this.prune();
    this.scheduleWatch();
  }

  release(key: string) {
    if (this.disposed || !this.refs.delete(key)) return;
    this.prune();
    this.scheduleWatch();
  }

  private scheduleWatch() {
    if (!this.watchTimer) this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      if (!this.disposed) this.sendWatch(false);
    }, 10);
  }

  private sendWatch(force: boolean) {
    const ids = new Set<number>([this.uid]);
    for (const list of [...this.refs.values()].reverse()) {
      for (const id of list) if (ids.size < WATCH_LIMIT) ids.add(id);
      if (ids.size >= WATCH_LIMIT) break;
    }
    const current = this.watch;
    if (!force && current && ids.size === current.ids.size && [...ids].every((id) => current.ids.has(id))) return;
    const request_id = `${this.identity}:${++this.requestNumber}`;
    this.watch = { id: request_id, ids, epoch: ++this.presenceClock };
    this.context.send({ type: 'users.watch', user_ids: [...ids], request_id });
  }

  /** Force a full watch on each new hello, even if the retained IDs did not change. */
  watchNow() {
    if (this.disposed) return;
    clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.sendWatch(true);
  }

  presence(event: { user_id: number; online: boolean }) {
    if (this.disposed || !validID(event.user_id)) return;
    this.presenceVersions.set(event.user_id, ++this.presenceClock);
    const next = new Set(this.context.online.peek());
    if (event.online) next.add(event.user_id);
    else next.delete(event.user_id);
    batch(() => {
      this.context.online.value = next;
      const old = this.context.profiles.peek().get(event.user_id);
      if (old && old.online !== event.online) this.context.profiles.value = new Map(this.context.profiles.peek()).set(old.id, { ...old, online: event.online });
      this.prune();
    });
  }

  snapshot(snapshot: PeopleSnapshot) {
    const watch = this.watch;
    if (this.disposed || !watch || snapshot.request_id !== watch.id) return;
    if (snapshot.user_ids.length !== watch.ids.size || new Set(snapshot.user_ids).size !== watch.ids.size || snapshot.user_ids.some((id) => !watch.ids.has(id))) return;
    this.merge(snapshot.users.filter((user) => watch.ids.has(user.id)), watch.epoch);
  }

  contact(state: ContactState) {
    if (this.disposed || !validID(state.user_id) || state.contacts_version < this.contactsVersion.peek()) return;
    const relation = state.relation ?? { state: state.contact ? 'contact' as const : 'none' as const, request_id: null, since: null };
    const old = this.relations.peek().get(state.user_id);
    if (state.contacts_version === this.contactsVersion.peek() && old?.state === relation.state && old?.request_id === relation.request_id && old?.since === relation.since) return;
    const gap = state.contacts_version > this.contactsVersion.peek() + 1;
    const next = gap ? new Map<number, Relation>() : new Map(this.relations.peek());
    next.set(state.user_id, relation);
    this.touch(state.user_id);
    batch(() => {
      this.relations.value = next;
      this.contactsVersion.value = state.contacts_version;
      if (state.incoming_count !== undefined) this.incomingCount.value = state.incoming_count;
      this.contactEvents.value++;
      if (gap) this.listsRevision.value++;
      this.prune();
    });
    if (this.mutual && !this.context.profiles.peek().has(state.user_id)) void this.ensure([state.user_id]).catch(() => {});
  }

  async summary() {
    if (!this.mutual) return;
    const result = await this.request((signal) => this.api.contactsSummary(signal));
    if (result.contacts_version < this.contactsVersion.peek()) return;
    batch(() => {
      if (result.contacts_version > this.contactsVersion.peek()) this.relations.value = new Map();
      this.contactsVersion.value = result.contacts_version;
      this.incomingCount.value = result.incoming_count;
      this.listsRevision.value++;
    });
  }

  async act(id: number, action: 'request' | 'accept' | 'decline' | 'cancel' | 'remove', expected = this.relations.peek().get(id)?.request_id) {
    try {
      const state = await this.request(() => this.api.contactAction(id, action, expected));
      this.alive();
      this.contact(state);
      return state;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await this.profile(id);
      throw error;
    }
  }

  async setContact(id: number, contact: boolean): Promise<ContactState> {
    if (this.mutual) return this.act(id, contact ? 'request' : 'remove');
    const state = await this.request(() => this.api.setContact(id, contact));
    this.alive();
    this.contact(state);
    return { user_id: id, contact: this.contacts.peek().get(id) ?? state.contact, contacts_version: this.contactsVersion.peek() };
  }

  private prune() {
    if (this.disposed) return;
    const keep = this.pinned();
    const trim = <T>(source: Map<number, T>) => {
      if (source.size <= CACHE_LIMIT) return source;
      const next = new Map(source);
      const cold = [...next.keys()].filter((id) => !keep.has(id)).sort((a, b) => (this.touched.get(a) ?? 0) - (this.touched.get(b) ?? 0));
      for (const id of cold) {
        if (next.size <= CACHE_LIMIT) break;
        next.delete(id);
      }
      return next;
    };
    const profiles = trim(this.context.profiles.peek());
    const relations = trim(this.relations.peek());
    // Retain recent presence events until in-flight directory pages reveal their user IDs.
    if (this.presenceVersions.size > CACHE_LIMIT) {
      const cold = [...this.presenceVersions].filter(([id]) => !keep.has(id)).sort((a, b) => a[1] - b[1]);
      for (const [id, epoch] of cold) {
        if (this.presenceVersions.size <= CACHE_LIMIT) break;
        this.presenceVersions.delete(id);
        this.presenceFloor = Math.max(this.presenceFloor, epoch);
      }
    }
    const known = new Set([...keep, ...profiles.keys(), ...relations.keys(), ...this.presenceVersions.keys()]);
    const online = this.context.online.peek();
    batch(() => {
      if (profiles !== this.context.profiles.peek()) this.context.profiles.value = profiles;
      if (relations !== this.relations.peek()) this.relations.value = relations;
      if ([...online].some((id) => !known.has(id))) this.context.online.value = new Set([...online].filter((id) => known.has(id)));
    });
    for (const id of this.touched.keys()) if (!known.has(id)) this.touched.delete(id);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.batchTimer);
    clearTimeout(this.watchTimer);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const entry of this.waiting.values()) entry.reject(aborted());
    this.waiting.clear();
    this.refs.clear();
    this.lookups.clear();
    this.touched.clear();
    this.presenceVersions.clear();
    this.watch = null;
  }
}
