import type { RefObject } from 'preact';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { HistoryAnchor, HistoryView } from '../history';

const activity = new WeakMap<Window, number>();
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
type OwnerWindow = Window & typeof globalThis;
type ReadCallback = (id: number) => void;

/** One controller per list, including a list hosted by a popped-out window. */
class HistoryScroll {
  hidden = false;
  onRead: ReadCallback;
  private dead = false;
  private serial = -1;
  private operation = 0;
  private navigating = false;
  private transition: { token: number; kind: 'latest' | 'back' | 'target'; direction: number } | null = null;
  private applying = false;
  private scrollTarget: number | null = null;
  private animation = 0;
  private settleAnimation?: (completed: boolean) => void;
  private scheduled = 0;
  private readTimer = 0;
  private flashTimer = 0;
  private flashRow: HTMLElement | null = null;
  private visibleSince = new Map<number, number>();
  private highestRead = 0;
  private lastInput = 0;
  private anchors: HistoryAnchor[] = [];
  private height = 0;
  private lastID = 0;
  private children = 0;
  private bottom: boolean | null = null;
  private holding = false;
  private oldOverflowAnchor: string;
  private oldScrollBehavior: string;
  private observed = new Set<Element>();
  private resize: ResizeObserver;
  private mutation: MutationObserver;
  private visibility: MutationObserver;
  private parent: Element | null = null;
  private win: OwnerWindow;
  readonly document: Document;

  constructor(readonly view: HistoryView, readonly list: HTMLDivElement, onRead: ReadCallback, private setBottom: (value: boolean) => void) {
    this.onRead = onRead;
    this.document = list.ownerDocument;
    this.win = this.document.defaultView as OwnerWindow;
    this.oldOverflowAnchor = list.style.overflowAnchor;
    this.oldScrollBehavior = list.style.scrollBehavior;
    list.style.overflowAnchor = 'none';
    list.style.scrollBehavior = 'auto';
    if (this.win.navigator.userActivation?.isActive) activity.set(this.win, Date.now());
    this.lastInput = activity.get(this.win) ?? 0;
    this.resize = new this.win.ResizeObserver(() => this.schedule());
    this.mutation = new this.win.MutationObserver(() => { this.observeChildren(); this.schedule(); });
    this.visibility = new this.win.MutationObserver(() => this.schedule());
    this.mutation.observe(list, { childList: true, subtree: true, characterData: true });
    this.observeChildren();
    this.observeVisibility();
    const doc = list.ownerDocument;
    doc.addEventListener('pointerdown', this.input, true);
    doc.addEventListener('pointermove', this.hover, true);
    doc.addEventListener('keydown', this.input, true);
    doc.addEventListener('input', this.input, true);
    doc.addEventListener('wheel', this.input, { capture: true, passive: true });
    doc.addEventListener('touchstart', this.input, { capture: true, passive: true });
    doc.addEventListener('scroll', this.outerScroll, true);
    doc.addEventListener('visibilitychange', this.focus);
    this.win.addEventListener('blur', this.blur);
    this.win.addEventListener('focus', this.focus);
  }

  private valid = () => !this.dead && !this.view.disposed && this.list.isConnected && this.list.ownerDocument === this.document;
  private row(id: number) { return this.list.querySelector<HTMLElement>(`.msg[data-id="${id}"]:not([data-deleted="true"])`); }
  private rows() { return Array.from(this.list.querySelectorAll<HTMLElement>('.msg[data-id]:not([data-deleted="true"])')); }
  private maximum() { return Math.max(0, this.list.scrollHeight - this.list.clientHeight); }
  private clamp(top: number) { return Math.max(0, Math.min(this.maximum(), top)); }

  private visible() {
    if (!this.valid() || this.hidden || !this.list.getClientRects().length) return false;
    for (let el: Element | null = this.list; el; el = el.parentElement) {
      const style = this.win.getComputedStyle(el);
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return this.list.clientHeight > 0 && this.list.clientWidth > 0;
  }

  private cacheAnchor() {
    if (!this.visible()) return;
    const bounds = this.list.getBoundingClientRect();
    this.anchors = [];
    for (const row of this.rows()) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom && rect.height > 0) this.anchors.push({ id: Number(row.dataset.id), offset: rect.top - bounds.top });
    }
    if (this.anchors.length) this.view.anchor = { ...this.anchors[0] };
  }

  private restoreAnchor() {
    const top = this.list.getBoundingClientRect().top;
    for (const anchor of this.anchors) {
      const row = this.row(anchor.id);
      if (row) {
        this.write(this.list.scrollTop + row.getBoundingClientRect().top - top - anchor.offset);
        return;
      }
    }
    const anchor = this.anchors[0] ?? this.view.anchor;
    const next = anchor && this.rows().find((row) => Number(row.dataset.id) > anchor.id);
    if (anchor && next) this.write(this.list.scrollTop + next.getBoundingClientRect().top - top - anchor.offset);
  }

  private updateBottom() {
    const bottom = !this.holding && !this.view.state.value.hasAfter && this.maximum() - this.list.scrollTop < 80;
    this.view.following = bottom;
    if (bottom !== this.bottom) { this.bottom = bottom; this.setBottom(bottom); }
  }

  private write(top: number) {
    this.list.scrollTop = this.clamp(top);
    this.scrollTarget = this.list.scrollTop;
  }

  private cancelAnimation() {
    this.win.cancelAnimationFrame(this.animation);
    this.animation = 0;
    this.applying = false;
    const settle = this.settleAnimation;
    this.settleAnimation = undefined;
    settle?.(false);
  }

  private animate(target: () => number, duration = 250, direction?: number): Promise<boolean> {
    this.cancelAnimation();
    this.clearRead();
    const destination = this.clamp(target());
    const distance = destination - this.list.scrollTop;
    const reduced = this.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || (direction === undefined && Math.abs(distance) < 1)) {
      this.write(destination);
      this.cacheAnchor();
      this.updateBottom();
      this.schedule();
      return Promise.resolve(true);
    }
    // Replace a distant segment at once; animate at most part of one viewport.
    const travel = Math.min(direction === undefined ? Math.abs(distance) : 160, this.list.clientHeight * 0.65);
    this.write(destination - (direction ?? Math.sign(distance)) * travel);
    const from = this.list.scrollTop;
    const started = this.win.performance.now();
    this.applying = true;
    return new Promise((resolve) => {
      this.settleAnimation = resolve;
      const frame = (now: number) => {
        if (!this.valid()) { this.cancelAnimation(); return; }
        const k = Math.min(1, (now - started) / duration);
        this.write(from + (this.clamp(target()) - from) * (1 - (1 - k) ** 3));
        if (k < 1) this.animation = this.win.requestAnimationFrame(frame);
        else {
          this.animation = 0;
          this.applying = false;
          this.settleAnimation = undefined;
          this.cacheAnchor();
          this.updateBottom();
          this.checkRead();
          resolve(true);
        }
      };
      this.animation = this.win.requestAnimationFrame(frame);
    });
  }

  private center(id: number) {
    const row = this.row(id);
    if (!row) return this.list.scrollTop;
    const bounds = this.list.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return this.list.scrollTop + rect.top - bounds.top - (this.list.clientHeight - rect.height) / 2;
  }

  private flash(id: number) {
    if (this.flashRow) this.flashRow.classList.remove('flash');
    this.win.clearTimeout(this.flashTimer);
    this.flashRow = this.row(id);
    this.flashRow?.classList.add('flash');
    this.flashTimer = this.win.setTimeout(() => { this.flashRow?.classList.remove('flash'); this.flashRow = null; }, 1200);
  }

  private observeChildren() {
    const children = new Set<Element>([this.list, ...this.list.children]);
    for (const old of this.observed) if (!children.has(old)) this.resize.unobserve(old);
    for (const child of children) if (!this.observed.has(child)) this.resize.observe(child);
    this.observed = children;
  }

  private observeVisibility() {
    if (this.parent === this.list.parentElement) return;
    this.parent = this.list.parentElement;
    this.visibility.disconnect();
    for (let el: Element | null = this.list; el; el = el.parentElement) this.visibility.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
  }

  private schedule = () => {
    if (this.scheduled || this.dead) return;
    this.scheduled = this.win.requestAnimationFrame(() => {
      this.scheduled = 0;
      this.reconcile();
    });
  };

  reconcile() {
    if (!this.valid()) {
      this.clearRead();
      return;
    }
    this.observeVisibility();
    if (!this.visible()) {
      this.clearRead();
      return;
    }
    const state = this.view.state.value;
    const rows = this.rows();
    const lastID = Number(rows.at(-1)?.dataset.id ?? 0);
    const height = this.list.scrollHeight;
    const count = this.list.childElementCount;
    if (state.loaded && !state.loading && !state.error && this.serial !== state.position.serial) {
      // Signal updates can precede a child component's DOM commit. Its mutation will retry.
      const ids = state.ids.filter((id) => {
        const item = this.view.store.message(this.view.channelId, id);
        return !!item && !item.deleted;
      });
      if (rows.length !== ids.length || rows.some((row, index) => Number(row.dataset.id) !== ids[index])) {
        this.clearRead();
        return;
      }
      this.serial = state.position.serial;
      const position = state.position;
      const transition = this.transition?.token === this.operation ? this.transition : null;
      this.transition = null;
      if (position.kind === 'latest') {
        if (transition) void this.animate(() => this.maximum(), 140, transition.direction);
        else this.write(this.maximum());
      } else if (position.kind === 'start') {
        const first = rows[0];
        this.write(first ? this.list.scrollTop + first.getBoundingClientRect().top - this.list.getBoundingClientRect().top : 0);
      } else if (position.kind === 'anchor' && position.id !== undefined) {
        const id = position.id;
        const target = () => {
          const row = this.row(id);
          return row ? this.list.scrollTop + row.getBoundingClientRect().top - this.list.getBoundingClientRect().top - (position.offset ?? 0) : this.list.scrollTop;
        };
        if (transition) void this.animate(target, 140, transition.direction);
        else this.write(target());
      } else if (position.kind === 'target' && position.id !== undefined) {
        const id = position.id;
        void this.animate(() => this.center(id), transition ? 140 : 250, transition?.direction).then((done) => { if (done && this.valid()) this.flash(id); });
      }
    } else if (!this.applying && !this.navigating && state.loaded && !state.loading) {
      if (this.bottom && !state.hasAfter) {
        if (height > this.height && this.height > 0 && (lastID > this.lastID || count > this.children)) void this.animate(() => this.maximum(), 420);
        else this.write(this.maximum());
      } else this.restoreAnchor();
    }
    this.height = height;
    this.lastID = lastID;
    this.children = count;
    if (!this.applying && !this.navigating) {
      this.cacheAnchor();
      this.updateBottom();
    }
    this.checkRead();
  }

  private clearRead() {
    this.win.clearTimeout(this.readTimer);
    this.readTimer = 0;
    this.visibleSince.clear();
  }

  private exposedPixels(row: HTMLElement, rect: DOMRect, top: number, bottom: number, left: number, right: number) {
    const content = row.querySelector<HTMLElement>('.msg-main')?.getBoundingClientRect() ?? rect;
    const x0 = Math.max(left, rect.left, content.left);
    const x1 = Math.min(right, rect.right, content.right);
    const y0 = Math.max(top, rect.top);
    const y1 = Math.min(bottom, rect.bottom);
    if (x1 <= x0 || y1 <= y0) return 0;
    // Hit testing includes sibling search panels and other floating windows in this document.
    const bands = Math.min(8, Math.max(1, Math.ceil((y1 - y0) / 40)));
    const width = x1 - x0;
    const xs = [x0 + Math.min(16, width / 2), x0 + width / 2, x1 - Math.min(16, width / 2)];
    let exposed = 0;
    for (let band = 0; band < bands; band++) {
      const y = y0 + ((band + 0.5) / bands) * (y1 - y0);
      if (xs.some((x) => {
        const hit = this.document.elementFromPoint(x, y);
        return !!hit && (hit === row || row.contains(hit));
      })) exposed++;
    }
    return (y1 - y0) * exposed / bands;
  }

  private checkRead = () => {
    this.win.clearTimeout(this.readTimer);
    this.readTimer = 0;
    const state = this.view.state.value;
    const doc = this.list.ownerDocument;
    if (!this.visible() || !doc.hasFocus() || doc.visibilityState !== 'visible' || this.applying || this.navigating || this.serial !== state.position.serial || !state.loaded || state.loading || state.olderLoading || state.newerLoading || state.error || state.olderError || state.newerError || Date.now() - (activity.get(this.win) ?? 0) >= 60_000) return this.clearRead();
    const box = this.list.getBoundingClientRect();
    let top = Math.max(box.top + this.list.clientTop, 0);
    let bottom = Math.min(box.top + this.list.clientTop + this.list.clientHeight, this.win.innerHeight);
    let left = Math.max(box.left, 0);
    let right = Math.min(box.right, this.win.innerWidth);
    for (let parent = this.list.parentElement; parent; parent = parent.parentElement) {
      const style = this.win.getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
    }
    const now = Date.now();
    const visible = new Set<number>();
    const ids = new Set(state.ids);
    for (const row of this.rows()) {
      const id = Number(row.dataset.id);
      const rect = row.getBoundingClientRect();
      const pixels = Math.max(0, Math.min(bottom, rect.bottom) - Math.max(top, rect.top));
      const canonical = this.view.store.message(this.view.channelId, id);
      if (!canonical || canonical.deleted || !ids.has(id) || rect.height <= 0 || Math.min(right, rect.right) <= Math.max(left, rect.left) || pixels < Math.min(rect.height * 0.5, 200)) continue;
      if (this.exposedPixels(row, rect, top, bottom, left, right) < Math.min(rect.height * 0.5, 200)) continue;
      visible.add(id);
      if (!this.visibleSince.has(id)) this.visibleSince.set(id, now);
    }
    let highest = this.highestRead;
    let delay = Infinity;
    for (const [id, since] of this.visibleSince) {
      if (!visible.has(id)) { this.visibleSince.delete(id); continue; }
      if (now - since >= 500) highest = Math.max(highest, id);
      else if (id > this.highestRead) delay = Math.min(delay, 500 - (now - since));
    }
    if (highest > this.highestRead) { this.highestRead = highest; this.onRead(highest); }
    if (Number.isFinite(delay)) this.readTimer = this.win.setTimeout(this.checkRead, Math.max(1, delay));
  };

  private hover = (event: PointerEvent) => {
    if (!this.applying || this.navigating || !this.list.contains(event.target as Node)) return;
    this.cancelAnimation();
    this.cacheAnchor();
    this.holding = true;
    this.bottom = false;
    this.view.following = false;
    this.setBottom(false);
    this.checkRead();
  };

  private blur = () => this.clearRead();
  private focus = () => this.schedule();
  private outerScroll = (event: Event) => { if (event.target !== this.list) this.checkRead(); };
  private input = (event: Event) => {
    const now = Date.now();
    if (now - this.lastInput >= 60_000) this.clearRead();
    this.lastInput = now;
    activity.set(this.win, now);
    // The callback owns the confirmed read cursor. A later activity retries a failed HTTP mark.
    this.highestRead = 0;
    const target = event.target as Element | null;
    const editable = target?.closest?.('input,textarea,select,[contenteditable="true"]');
    const keyboardScroll = event.type === 'keydown' && SCROLL_KEYS.has((event as KeyboardEvent).key) && !editable;
    const pointerScroll = ['wheel', 'touchstart', 'pointerdown'].includes(event.type) && target && this.list.contains(target);
    if (keyboardScroll || pointerScroll) {
      if (keyboardScroll || event.type !== 'pointerdown') this.holding = false;
      this.operation++;
      this.transition = null;
      if (this.navigating) {
        this.view.requests.get('load')?.abort();
        if (!this.view.disposed) this.view.state.value = { ...this.view.state.value, loading: false };
      }
      this.navigating = false;
      this.cancelAnimation();
      this.scrollTarget = null;
      this.cacheAnchor();
      this.updateBottom();
    }
    this.checkRead();
  };

  onScroll = () => {
    const ownScroll = this.scrollTarget !== null && Math.abs(this.list.scrollTop - this.scrollTarget) < 1;
    this.scrollTarget = null;
    if (!this.valid() || ownScroll || this.applying || this.navigating || this.serial !== this.view.state.value.position.serial || !this.visible()) return;
    this.holding = false;
    const previous = this.anchors[0]?.id;
    this.cacheAnchor();
    this.updateBottom();
    this.checkRead();
    const state = this.view.state.value;
    if (!state.loaded || state.loading || state.error) return;
    const nearBefore = this.list.scrollTop < 300 && state.hasBefore && !state.olderLoading && !state.olderError;
    const nearAfter = this.maximum() - this.list.scrollTop < 300 && state.hasAfter && !state.newerLoading && !state.newerError;
    if (nearBefore && (!nearAfter || (this.anchors[0]?.id ?? 0) < (previous ?? Infinity))) void this.view.older();
    else if (nearAfter) void this.view.newer();
  };

  jump = async (id: number): Promise<boolean> => {
    if (!this.valid() || !Number.isSafeInteger(id) || id <= 0) return false;
    const token = ++this.operation;
    this.holding = false;
    this.transition = null;
    if (this.navigating) {
      this.view.requests.get('load')?.abort();
      this.view.state.value = { ...this.view.state.value, loading: false };
    }
    this.navigating = false;
    this.cancelAnimation();
    this.clearRead();
    this.cacheAnchor();
    const anchor = this.view.anchor && { ...this.view.anchor };
    if (this.row(id)) {
      if (anchor) {
        this.view.backStack.push(anchor);
        if (this.view.backStack.length > 20) this.view.backStack.shift();
        // backStack is deliberately plain data; notify consumers of the new Back action.
        this.view.state.value = { ...this.view.state.value };
      }
      this.view.following = false;
      const done = await this.animate(() => this.center(id));
      if (!done || !this.valid() || token !== this.operation) return false;
      this.flash(id);
      return true;
    }
    this.navigating = true;
    const direction = id < (anchor?.id ?? this.lastID) ? -1 : 1;
    this.transition = { token, kind: 'target', direction };
    const outgoing = this.list.scrollTop + direction * Math.min(120, this.list.clientHeight * 0.25);
    const moved = await this.animate(() => outgoing, 110);
    if (!moved || !this.valid() || token !== this.operation) return false;
    this.view.anchor = anchor;
    const loaded = await this.view.jump(id);
    if (!this.valid() || token !== this.operation) return false;
    this.navigating = false;
    this.schedule();
    return loaded;
  };

  private navigate = async (kind: 'latest' | 'back', load: () => Promise<unknown>) => {
    if (!this.valid()) return;
    const token = ++this.operation;
    this.holding = false;
    this.cancelAnimation();
    this.clearRead();
    this.cacheAnchor();
    this.navigating = true;
    const destination = kind === 'latest' ? Infinity : this.view.backStack.at(-1)?.id ?? Infinity;
    const direction = destination < (this.view.anchor?.id ?? this.lastID) ? -1 : 1;
    this.transition = { token, kind, direction };
    const outgoing = this.list.scrollTop + direction * Math.min(120, this.list.clientHeight * 0.25);
    try {
      const moved = await this.animate(() => outgoing, 110);
      if (!moved || !this.valid() || token !== this.operation) return;
      if (await load() === false) this.transition = null;
    }
    finally {
      if (this.valid() && token === this.operation) { this.navigating = false; this.schedule(); }
    }
  };
  latest = () => this.navigate('latest', () => this.view.latest());
  back = () => this.navigate('back', () => this.view.back());

  dispose() {
    this.dead = true;
    this.operation++;
    if (this.navigating) this.view.requests.get('load')?.abort();
    this.cancelAnimation();
    this.win.cancelAnimationFrame(this.scheduled);
    this.clearRead();
    this.win.clearTimeout(this.flashTimer);
    this.flashRow?.classList.remove('flash');
    this.resize.disconnect(); this.mutation.disconnect(); this.visibility.disconnect();
    const doc = this.document;
    doc.removeEventListener('pointerdown', this.input, true);
    doc.removeEventListener('pointermove', this.hover, true);
    doc.removeEventListener('keydown', this.input, true);
    doc.removeEventListener('input', this.input, true);
    doc.removeEventListener('wheel', this.input, true);
    doc.removeEventListener('touchstart', this.input, true);
    doc.removeEventListener('scroll', this.outerScroll, true);
    doc.removeEventListener('visibilitychange', this.focus);
    this.win.removeEventListener('blur', this.blur);
    this.win.removeEventListener('focus', this.focus);
    this.list.style.overflowAnchor = this.oldOverflowAnchor;
    this.list.style.scrollBehavior = this.oldScrollBehavior;
  }
}

export function useHistoryScroll(view: HistoryView | null, listRef: RefObject<HTMLDivElement | null>, onRead: ReadCallback, hidden: boolean): {
  atBottom: boolean; onScroll: () => void; jump: (id: number) => Promise<boolean>; latest: () => Promise<void>; back: () => Promise<void>;
} {
  // Reading these signals makes the owning component reconcile after canonical data changes.
  void view?.state.value;
  void view?.store.updated.value;
  const [atBottom, setAtBottom] = useState(true);
  const controller = useRef<HistoryScroll | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (controller.current && (controller.current.view !== view || controller.current.list !== list || controller.current.document !== list?.ownerDocument || view?.disposed)) {
      controller.current.dispose(); controller.current = null;
    }
    if (!controller.current && view && !view.disposed && list?.ownerDocument.defaultView) controller.current = new HistoryScroll(view, list, onRead, setAtBottom);
    if (controller.current) {
      controller.current.hidden = hidden;
      controller.current.onRead = onRead;
      controller.current.reconcile();
    }
  });
  useLayoutEffect(() => () => { controller.current?.dispose(); controller.current = null; }, []);
  const onScroll = useCallback(() => controller.current?.onScroll(), []);
  const jump = useCallback((id: number) => controller.current?.jump(id) ?? Promise.resolve(false), []);
  const latest = useCallback(() => controller.current?.latest() ?? Promise.resolve(), []);
  const back = useCallback(() => controller.current?.back() ?? Promise.resolve(), []);
  return { atBottom, onScroll, jump, latest, back };
}
