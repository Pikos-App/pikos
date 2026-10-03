// The view cache as the app drives it: loads a list's first window when it's shown and more as it
// scrolls, refreshes the shown list after every write, evicts what wasn't shown recently, and in
// test lanes checks every cached list it shows against a fresh query.

import type {
  ChangeState,
  Page,
  PageSummary,
  Placement,
  StorageAdapter,
  TagCount,
  ViewCounts,
  ViewKey,
} from "@pikos/core";
import { getLocalTimezone } from "@pikos/core";
import { evict, PageStore, summaryBytes, toPageSummary, ViewCache, viewName } from "@pikos/core";
import { differenceInMilliseconds, startOfTomorrow } from "date-fns";

import { createLogger } from "@/shared/logger";

import type { ViewCacheConfig } from "./config";
import { WriteMirror } from "./writeMirror";

const log = createLogger("viewCache");

/** Fields no list orders, groups, filters or counts by: a write of only these refetches its row. */
const ROW_ONLY_FIELDS = new Set(["content", "contentText", "lastOpenedAt"]);

/** The page an `updatePage` of only row-only fields wrote, else null. */
function rowOnlyWrite(method: string, args: unknown[]): string | null {
  if (method !== "updatePage") return null;
  const [id, patch] = args;
  if (typeof id !== "string" || !patch || typeof patch !== "object") return null;
  return Object.keys(patch).every((field) => ROW_ONLY_FIELDS.has(field)) ? id : null;
}

const QUIET_POLL_MS = 10;
/** Long enough to outlast a burst of writes, short enough that a stream of them still shows. */
const QUIET_WAIT_MS = 500;

export class ViewCacheController {
  readonly store = new PageStore();
  readonly cache: ViewCache;
  /** The app's optimistic edits, carried into `store` as pending writes. */
  readonly mirror: WriteMirror;
  /** The lists on screen: one, or a view's sections. */
  private shown: ViewKey[] = [];
  private loadingMore = new Set<string>();
  private fetchingRows = new Set<string>();
  /** Views whose first window is being fetched; what's held may be about to be replaced. */
  private loadingFirst = new Set<string>();
  /** The rows each view has on screen, kept so loading carries on after every fetch lands. */
  private wanted = new Map<string, { first: number; last: number }>();
  private version = 0;
  private listeners = new Set<() => void>();
  private bumpQueued = false;
  private leftListeners = new Set<(ids: ReadonlySet<string>) => void>();
  /** Writes started and not yet settled. */
  private writesInFlight = 0;
  /** Bumped by every write's start and settle, so a check can tell whether one overlapped it. */
  private writeEpoch = 0;
  private refreshing: Promise<void> | null = null;
  /** The sidebar's badges, for the day they were counted on; null until first asked for. */
  counts: { today: string; counts: ViewCounts } | null = null;
  /** The day the sidebar shows badges for, once it has asked; a write recounts it. */
  private countsDay: string | null = null;
  private countsAsked = 0;
  /** The change counter as the last refresh found it; null until first read. */
  private counter: { epoch: string; seq: number } | null = null;
  private tagList: TagCount[] | null = null;
  /** List windows fetched, for the test that typing doesn't refetch lists. */
  listFetches = 0;
  /**
   * Full pages opened or prefetched, least recently used first, each with the change counter when
   * it was read: while the counter hasn't moved, the copy is current. Not other writers' changes
   * alone: calendar sync writes from inside the app's own process, so it counts as the app's.
   */
  private bodies = new Map<string, { page: Page; seen: number; bytes: number }>();
  private bodyBytes = 0;
  /** The change counter, as the last read found it. */
  private seen = 0;
  /** Body reads in flight, so a click joins the prefetch its hover started. */
  private bodyReads = new Map<string, Promise<Page | null>>();
  /** The one prefetch allowed to wait for the one in flight; a later hover replaces it. */
  private waitingPrefetch: string | null = null;
  /** Body reads that found a current copy, and that had to ask the database: the hit rate. */
  bodyHits = 0;
  bodyMisses = 0;
  /** Calendar ranges visited while the calendar is mounted, by `start|end`: their pages' ids. */
  private ranges = new Map<string, { ids: string[]; stale: boolean }>();
  private shownRange: { start: string; end: string } | null = null;
  /** Loads asked of each range, so only the latest is kept. */
  private rangeAsked = new Map<string, number>();
  /** Every recurring series' head, which a range needs for occurrences of heads outside it. */
  private heads: string[] | null = null;
  /** The newest change among the heads held, for reading only those changed since. */
  private headsSeq = 0;
  /** Bumped by every write, so a range read that a write overlapped is kept but marked stale. */
  private rangeEpoch = 0;
  private refreshAgain = false;

  constructor(
    private readonly adapter: StorageAdapter,
    readonly config: ViewCacheConfig
  ) {
    this.cache = new ViewCache({ windowSize: config.windowSize });
    this.mirror = new WriteMirror(this.store, (ids) => this.adapter.getPages(ids));
    this.store.subscribe(() => this.bump());
    this.waitForMidnight();
    window.addEventListener("focus", () => this.doorbell());
  }

  /** Today's sections and the badges are keyed by the date their readers compute at render, so
   *  turning the day only needs a render. A second past midnight, so the date has turned. */
  private waitForMidnight(): void {
    const wait = differenceInMilliseconds(startOfTomorrow(), new Date()) + 1000;
    setTimeout(() => {
      this.bump();
      this.waitForMidnight();
    }, wait);
  }

  writeStarted(): void {
    this.writesInFlight += 1;
    this.writeEpoch += 1;
  }

  /**
   * A write settled. One that touched only fields no list orders, groups or counts by refetches
   * its row alone; any other refreshes what's on screen, if the change counter moved.
   */
  writeSettled(method: string, args: unknown[]): void {
    this.writesInFlight -= 1;
    this.writeEpoch += 1;
    const [id, patch] = args;
    if (method === "updatePage" && typeof id === "string" && patch && typeof patch === "object") {
      this.patchBody(id, patch);
    }
    const rowOnly = rowOnlyWrite(method, args);
    if (rowOnly) void this.refetchRow(rowOnly);
    else void this.checkCounter();
  }

  /** Another process may have written: refresh if the change counter says so. */
  doorbell(): void {
    void this.checkCounter();
  }

  /** Refresh what's on screen unless the counter is where the last refresh left it. A new epoch
   *  (a restore, an import, a reset) drops everything held. */
  private async checkCounter(): Promise<void> {
    let state: ChangeState;
    try {
      state = await this.adapter.changeState();
    } catch {
      state = { epoch: "", ownChanges: 0, seq: -1 };
    }
    if (this.counter && state.epoch === this.counter.epoch && state.seq === this.counter.seq) {
      return;
    }
    if (this.counter && state.epoch !== this.counter.epoch) this.forget();
    this.counter = { epoch: state.epoch, seq: state.seq };
    this.seen = state.seq;
    this.cache.invalidate();
    this.rangeEpoch += 1;
    for (const range of this.ranges.values()) range.stale = true;
    this.bump();
    void this.refresh();
  }

  private async refetchRow(id: string): Promise<void> {
    try {
      this.store.confirm(await this.adapter.getPages([id]));
    } catch {
      // The row stays as held; the next refresh brings it.
    }
  }

  /** Everything held, gone: another epoch's rows can't be compared with this one's. */
  private forget(): void {
    this.cache.clear();
    this.store.clear();
    this.ranges.clear();
    this.heads = null;
    this.headsSeq = 0;
    this.counts = null;
    this.bodies.clear();
    this.bodyBytes = 0;
  }

  /** The full page: from memory with no database call while nothing has changed since it was
   *  read, else only a newer copy is fetched. A read already in flight is joined. */
  body(id: string): Promise<Page | null> {
    const answer = this.openBody(id);
    if (this.config.shadow) {
      window.__PIKOS_BODY_READS__ = { hits: this.bodyHits, misses: this.bodyMisses };
    }
    return answer;
  }

  private openBody(id: string): Promise<Page | null> {
    const held = this.bodies.get(id);
    if (held && held.seen === this.seen) {
      this.bodyHits += 1;
      this.touchBody(id, held);
      return Promise.resolve(held.page);
    }
    const reading = this.bodyReads.get(id);
    if (reading) {
      this.bodyHits += 1;
      return reading;
    }
    this.bodyMisses += 1;
    return this.readBody(id);
  }

  /** Read `id`'s body ahead of a click: one read at a time, the latest hover waiting its turn. */
  prefetch(id: string): void {
    const held = this.bodies.get(id);
    if ((held && held.seen === this.seen) || this.bodyReads.has(id)) return;
    if (this.bodyReads.size > 0) {
      this.waitingPrefetch = id;
      return;
    }
    void this.readBody(id);
  }

  /** A hover left before its prefetch started. */
  cancelPrefetch(id: string): void {
    if (this.waitingPrefetch === id) this.waitingPrefetch = null;
  }

  private readBody(id: string): Promise<Page | null> {
    const held = this.bodies.get(id);
    const seen = this.seen;
    const read = (async () => {
      try {
        if (held) {
          const answer = await this.adapter.getPageIfNewer(id, held.page.rowSeq ?? null);
          if (answer.kind === "missing") return this.dropBody(id);
          const page = answer.kind === "newer" ? answer.page : held.page;
          this.holdBody(page, seen);
          return page;
        }
        const page = await this.adapter.getPage(id);
        if (!page) return this.dropBody(id);
        this.holdBody(page, seen);
        return page;
      } catch {
        // Errors aren't kept: the next open reads again.
        return null;
      } finally {
        this.bodyReads.delete(id);
        const next = this.waitingPrefetch;
        this.waitingPrefetch = null;
        if (next) this.prefetch(next);
      }
    })();
    this.bodyReads.set(id, read);
    return read;
  }

  private holdBody(page: Page, seen: number): void {
    this.store.confirm([toPageSummary(page)]);
    const old = this.bodies.get(page.id);
    if (old) this.bodyBytes -= old.bytes;
    const bytes = (page.content?.length ?? 0) * 2 + summaryBytes(page);
    this.bodies.delete(page.id);
    this.bodies.set(page.id, { bytes, page, seen });
    this.bodyBytes += bytes;
    for (const [id, entry] of this.bodies) {
      if (this.bodyBytes <= this.config.bodyBudgetBytes || id === page.id) break;
      this.bodies.delete(id);
      this.bodyBytes -= entry.bytes;
    }
  }

  private touchBody(id: string, entry: { page: Page; seen: number; bytes: number }): void {
    this.bodies.delete(id);
    this.bodies.set(id, entry);
  }

  private dropBody(id: string): null {
    const held = this.bodies.get(id);
    if (held) this.bodyBytes -= held.bytes;
    this.bodies.delete(id);
    return null;
  }

  /** The app wrote `patch` to `id`: the held body takes it, so it stays current. */
  private patchBody(id: string, patch: object): void {
    const held = this.bodies.get(id);
    if (held) this.holdBody({ ...held.page, ...patch }, held.seen);
  }

  /** The calendar shows `start` to `end`: load it unless a current copy is held. */
  showRange(start: string, end: string): void {
    this.shownRange = { end, start };
    const held = this.ranges.get(`${start}|${end}`);
    if (!held || held.stale) void this.loadRange(start, end);
    if (this.heads === null) void this.loadHeads();
    this.bump();
  }

  /** A page this app just created: held, and on the calendar range on screen, ahead of the
   *  refetch that would bring it, so a block made by a click is there to open its popover. */
  adoptCreated(page: PageSummary): void {
    this.store.confirm([page]);
    const range =
      this.shownRange && this.ranges.get(`${this.shownRange.start}|${this.shownRange.end}`);
    if (range && !range.ids.includes(page.id)) range.ids = [...range.ids, page.id];
    this.bump();
  }

  /** The calendar unmounted: its ranges go; the series heads stay. */
  hideRanges(): void {
    this.ranges.clear();
    this.shownRange = null;
    this.bump();
  }

  /** A range's pages, and every series head not among them. */
  rangePages(start: string, end: string): PageSummary[] {
    const ids = this.ranges.get(`${start}|${end}`)?.ids ?? [];
    const seen = new Set(ids);
    const pages = ids.flatMap((id) => this.store.get(id) ?? []);
    for (const id of this.heads ?? []) {
      const head = seen.has(id) ? undefined : this.store.get(id);
      if (head) pages.push(head);
    }
    return pages;
  }

  /** Only a range's latest load is kept: an earlier one landing after it would undo it. One a
   *  write overlapped is kept but stale, and loads again if the range is on screen. */
  private async loadRange(start: string, end: string): Promise<void> {
    const name = `${start}|${end}`;
    const asked = (this.rangeAsked.get(name) ?? 0) + 1;
    this.rangeAsked.set(name, asked);
    const epoch = this.rangeEpoch;
    let rows: PageSummary[];
    try {
      rows = await this.adapter.listRange(start, end, getLocalTimezone(), false);
    } catch {
      return;
    }
    if (this.rangeAsked.get(name) !== asked) return;
    this.store.confirm(rows);
    const stale = epoch !== this.rangeEpoch;
    this.ranges.set(name, { ids: rows.map((r) => r.id), stale });
    this.bump();
    const shown = this.shownRange;
    if (stale && shown?.start === start && shown.end === end) void this.loadRange(start, end);
  }

  /** Every recurring series' head, held from launch: Today swaps a synced series' occurrence in
   *  for its head, and unticking a done clone finds its series, wherever the head is dated. */
  loadSeriesHeads(): Promise<void> {
    return this.loadHeads();
  }

  /** After the first load, only heads changed since the newest one held are read. */
  private async loadHeads(): Promise<void> {
    try {
      const since = this.heads === null ? null : this.headsSeq;
      const heads = await this.adapter.listSeriesHeads(false, since);
      if (since !== null && heads.length === 0) return;
      this.store.confirm(heads);
      const held = new Set(since === null ? [] : (this.heads ?? []));
      for (const head of heads) held.add(head.id);
      this.heads = [...held];
      for (const head of heads) this.headsSeq = Math.max(this.headsSeq, head.rowSeq ?? 0);
    } catch {
      // Occurrences of heads outside the range wait for the next load.
    }
    this.bump();
  }

  /**
   * The lists on screen are `keys`. Loads each one's first window unless a current one is held,
   * in which case the shadow check runs; then evicts down to the budget, keeping `pinnedPages`.
   */
  show(keys: ViewKey[], pinnedPages: Iterable<string>): void {
    this.shown = keys;
    for (const key of keys) {
      this.cache.touch(key);
      const entry = this.cache.entry(key);
      if (!entry || entry.stale || entry.status === "error") void this.loadFirst(key);
      else if (
        this.config.shadow &&
        entry.status === "ready" &&
        !this.loadingFirst.has(viewName(key))
      )
        void this.shadowCheck(key);
    }
    const calendar = [...this.ranges.values()].flatMap((r) => r.ids);
    evict(this.cache, this.store, this.config.budgetBytes, {
      pages: new Set([...pinnedPages, ...calendar, ...(this.heads ?? [])]),
      views: new Set(keys.map(viewName)),
    });
    this.bump();
  }

  /** Rows `first` through `last` of `key` are on screen: load them, and keep loading as fetches
   *  land until they're all held. */
  want(key: ViewKey, first: number, last: number): void {
    this.wanted.set(viewName(key), { first, last });
    this.fill(key);
  }

  /** The sidebar shows badges for `today`: count them unless they're held for that day. */
  watchCounts(today: string): void {
    this.countsDay = today;
    if (this.counts?.today !== today) void this.loadCounts();
  }

  private async loadCounts(): Promise<void> {
    const today = this.countsDay;
    if (!today) return;
    const asked = ++this.countsAsked;
    try {
      const counts = await this.adapter.countViews(getLocalTimezone(), today);
      // An older count landing after a newer one would undo it.
      if (asked === this.countsAsked) this.counts = { counts, today };
    } catch {
      // Badges keep their last counts; the next write recounts.
    }
    this.bump();
  }

  /** Load the next window of `key`, unless one is loading or the list is complete. */
  async loadMore(key: ViewKey): Promise<void> {
    const name = viewName(key);
    const entry = this.cache.entry(key);
    if (!entry?.next || entry.status !== "ready" || this.loadingMore.has(name)) return;
    if (this.loadingFirst.has(name)) return;
    this.loadingMore.add(name);
    const token = this.cache.begin(key, entry.next, 0);
    let loaded = false;
    try {
      const page = await this.adapter.listView(key, entry.next, this.config.windowSize);
      loaded = this.cache.receive(token, page, this.store);
    } catch {
      this.cache.fail(token);
    } finally {
      this.loadingMore.delete(name);
      this.bump();
    }
    // Not after a failure: an error that persists would otherwise retry without end.
    if (loaded) this.fill(key);
  }

  /** Every id in `key`, in order, loading the rest of them without their rows. */
  async allIds(key: ViewKey): Promise<string[]> {
    const entry = this.cache.entry(key);
    if (!entry) return [];
    if (!entry.next) return entry.ids;
    const name = viewName(key);
    this.loadingMore.add(name);
    const token = this.cache.begin(key, entry.next, 0);
    try {
      const rest = await this.adapter.listViewIds(key, entry.next, null);
      if (this.cache.extendIds(token, rest)) this.fill(key);
    } finally {
      this.loadingMore.delete(name);
      this.bump();
    }
    return this.cache.entry(key)?.ids ?? [];
  }

  /** Summaries for `ids`, fetching the ones not held. */
  async rows(ids: string[]): Promise<PageSummary[]> {
    const missing = ids.filter((id) => !this.store.has(id) && !this.fetchingRows.has(id));
    if (missing.length > 0) {
      for (const id of missing) this.fetchingRows.add(id);
      try {
        this.store.confirm(await this.adapter.getPages(missing));
      } finally {
        for (const id of missing) this.fetchingRows.delete(id);
      }
    }
    return ids.flatMap((id) => this.store.get(id) ?? []);
  }

  place(key: ViewKey, moving: string[], place: Placement): void {
    this.cache.place(key, moving, place.after ?? null, place.before ?? null);
    this.bump();
  }

  /** Every page held, as shown: what the page list is while the view cache is its only copy. */
  heldPages(): PageSummary[] {
    return this.store.ids().flatMap((id) => this.store.get(id) ?? []);
  }

  /** Tags on open pages, most used first; empty until first asked for, then kept current. */
  tags(): TagCount[] {
    if (this.tagList === null) {
      this.tagList = [];
      void this.loadTags();
    }
    return this.tagList;
  }

  private async loadTags(): Promise<void> {
    try {
      this.tagList = await this.adapter.listTags();
    } catch {
      // The next refresh asks again.
    }
    this.bump();
  }

  /** Called with the ids a refresh took out of a list on screen. */
  onLeft(listener: (ids: ReadonlySet<string>) => void): () => void {
    this.leftListeners.add(listener);
    return () => this.leftListeners.delete(listener);
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private async loadFirst(key: ViewKey, limit = this.config.windowSize): Promise<void> {
    const name = viewName(key);
    const before = this.cache.entry(key)?.ids ?? [];
    const token = this.cache.begin(key, null, 0);
    this.loadingFirst.add(name);
    this.bump();
    let loaded = false;
    try {
      this.listFetches += 1;
      if (this.config.shadow) window.__PIKOS_LIST_FETCHES__ = this.listFetches;
      const page = await this.adapter.listView(key, null, limit);
      loaded = this.cache.receive(token, page, this.store);
    } catch {
      this.cache.fail(token);
    } finally {
      this.loadingFirst.delete(name);
    }
    this.bump();
    if (loaded) {
      this.reportLeft(key, before);
      this.fill(key);
    }
  }

  /** Ids a refetch dropped from a list on screen. Only where the refetch covers what was loaded,
   *  so a row pushed past the end isn't taken for one that left. */
  private reportLeft(key: ViewKey, before: string[]): void {
    const entry = this.cache.entry(key);
    const name = viewName(key);
    if (!entry || before.length === 0 || !this.shown.some((k) => viewName(k) === name)) return;
    if (entry.next && entry.ids.length < before.length) return;
    const now = new Set(entry.ids);
    const left = new Set(before.filter((id) => !now.has(id)));
    if (left.size === 0) return;
    for (const listener of this.leftListeners) listener(left);
  }

  /** Start whatever loading the rows on screen still need. Far past what's loaded, fetching every
   *  id beats paging there a window at a time. */
  private fill(key: ViewKey): void {
    const name = viewName(key);
    const want = this.wanted.get(name);
    const entry = this.cache.entry(key);
    if (!want || !entry || entry.status !== "ready" || this.loadingFirst.has(name)) return;
    if (want.last >= entry.ids.length && entry.next && !this.loadingMore.has(name)) {
      if (want.last - entry.ids.length > this.config.windowSize * 2) void this.allIds(key);
      else void this.loadMore(key);
    }
    const unheld = entry.ids
      .slice(want.first, want.last + 1)
      .filter((id) => !this.store.has(id) && !this.fetchingRows.has(id));
    if (unheld.length > 0) void this.rows(unheld);
  }

  /** Refetch the shown list over the span already loaded. One at a time; writes that land during
   *  one run it again after. */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        await this.writesQuiet();
        this.refreshAgain = false;
        await Promise.all([
          ...this.shown.map((key) =>
            this.loadFirst(
              key,
              Math.max(this.config.windowSize, this.cache.entry(key)?.ids.length ?? 0)
            )
          ),
          this.loadCounts(),
          this.tagList !== null ? this.loadTags() : undefined,
          this.shownRange ? this.loadRange(this.shownRange.start, this.shownRange.end) : undefined,
          this.shownRange || this.heads !== null ? this.loadHeads() : undefined,
        ]);
      } while (this.refreshAgain);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /** Resolves once no write is in flight, or after `QUIET_WAIT_MS` at most, so a burst of writes
   *  (a seed, an import, a bulk tick) costs one refresh after it rather than one per write. */
  private async writesQuiet(): Promise<void> {
    for (
      let waited = 0;
      this.writesInFlight > 0 && waited < QUIET_WAIT_MS;
      waited += QUIET_POLL_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_POLL_MS));
    }
  }

  /** Compare a cached list with the database. Skipped when a write overlaps it, since the two
   *  reads would then legitimately differ. */
  private async shadowCheck(key: ViewKey): Promise<void> {
    const entry = this.cache.entry(key);
    if (!entry || this.writesInFlight > 0) return;
    const epoch = this.writeEpoch;
    const ids = [...entry.ids];
    const complete = !entry.next;
    const [fresh, rows] = await Promise.all([
      this.adapter.listViewIds(key, null, null),
      this.adapter.getPages(ids),
    ]);
    if (this.writeEpoch !== epoch || this.writesInFlight > 0) return;
    const problems: string[] = [];
    const expected = complete ? fresh : fresh.slice(0, ids.length);
    if (expected.join() !== ids.join()) {
      problems.push(`order: cached [${ids.join(", ")}], database [${expected.join(", ")}]`);
    }
    for (const row of rows) {
      const held = this.store.get(row.id);
      if (held && !this.store.isPending(row.id) && held.rowSeq !== row.rowSeq) {
        problems.push(`row ${row.id}: cached change ${held.rowSeq}, database ${row.rowSeq}`);
      }
    }
    if (problems.length === 0) return;
    const message = `[view-cache] ${viewName(key)} differs from the database: ${problems.join("; ")}`;
    (window.__PIKOS_SHADOW_MISMATCHES__ ??= []).push(message);
    log.error(message);
  }

  /** Readers hear of changes at most once a microtask: one write lands as several loads, and each
   *  told separately re-rendered every reader that many times. */
  private bump(): void {
    if (this.bumpQueued) return;
    this.bumpQueued = true;
    queueMicrotask(() => {
      this.bumpQueued = false;
      this.version += 1;
      for (const listener of this.listeners) listener();
    });
  }
}
