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

import { createLogger, throttled } from "@/shared/logger";

import type { ViewCacheConfig } from "./config";
import { WriteMirror } from "./writeMirror";

const log = createLogger("viewCache");
// Every write and doorbell refetches, so a read that keeps failing would log on each one.
const quiet = throttled(log);

/** Fields no list orders, groups, filters or counts by, and the body a save was typed over, which
 *  is a condition on the write rather than a field: a write of only these refetches its row. */
const ROW_ONLY_FIELDS = new Set(["baseContent", "content", "lastOpenedAt"]);

function rowOnlyWrite(method: string, args: unknown[]): string | null {
  if (method !== "updatePage") return null;
  const [id, patch] = args;
  if (typeof id !== "string" || !patch || typeof patch !== "object") return null;
  return Object.keys(patch).every((field) => ROW_ONLY_FIELDS.has(field)) ? id : null;
}

const QUIET_POLL_MS = 10;
/** Long enough to outlast a burst of writes, short enough that a stream of them still shows. */
const QUIET_WAIT_MS = 500;

export type Range = readonly [start: string, end: string];

export class ViewCacheController {
  readonly store = new PageStore();
  readonly cache: ViewCache;
  readonly mirror: WriteMirror;
  private shown: ViewKey[] = [];
  private loadingMore = new Set<string>();
  private fetchingRows = new Set<string>();
  private loadingFirst = new Set<string>();
  private wanted = new Map<string, { first: number; last: number }>();
  private idsLoading = new Map<string, Promise<string[]>>();
  /** Rows a refresh held but didn't refetch. They show as held to every reader, and a list
   *  refetches each when it next comes on screen there. */
  private stale = new Set<string>();
  private version = 0;
  private listeners = new Set<() => void>();
  private bumpQueued = false;
  private leftListeners = new Set<(ids: ReadonlySet<string>) => void>();
  private changedListeners = new Set<() => void>();
  private writesInFlight = 0;
  private writeEpoch = 0;
  private refreshing: Promise<void> | null = null;
  counts: { today: string; counts: ViewCounts } | null = null;
  private countsDay: string | null = null;
  private countsAsked = 0;
  private counter: { epoch: string; seq: number } | null = null;
  private tagList: TagCount[] | null = null;
  private tagListeners = new Set<(tags: TagCount[]) => void>();
  listFetches = 0;
  /**
   * Full pages opened or prefetched, least recently used first, each with the change counter when
   * it was read: while the counter hasn't moved, the copy is current. Not other writers' changes
   * alone: calendar sync writes from inside the app's own process, so it counts as the app's.
   */
  private bodies = new Map<string, { page: Page; seen: number; bytes: number }>();
  private bodyBytes = 0;
  private seen = 0;
  private bodyReads = new Map<string, Promise<Page | null>>();
  private waitingPrefetch: string | null = null;
  bodyHits = 0;
  bodyMisses = 0;
  private ranges = new Map<string, { ids: string[]; stale: boolean }>();
  private shownRange: { start: string; end: string } | null = null;
  private rangeAsked = new Map<string, number>();
  /** Each range's pages as last read, kept while nothing in them changes: the calendar
   *  re-renders for its own week, not for every write or neighbour prefetch. */
  private rangeRead = new Map<string, PageSummary[]>();
  private heads: string[] | null = null;
  private headsSeq = 0;
  private headsRead: PageSummary[] | null = null;
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
    this.rangeEpoch += 1;
  }

  /**
   * A write settled. One that touched only fields no list orders, groups or counts by refetches
   * its row alone; any other refreshes what's on screen, if the change counter moved.
   */
  writeSettled(method: string, args: unknown[]): void {
    this.writesInFlight -= 1;
    this.writeEpoch += 1;
    this.rangeEpoch += 1;
    const [id, patch] = args;
    if (method === "updatePage" && typeof id === "string" && patch && typeof patch === "object") {
      this.patchBody(id, patch);
    }
    const rowOnly = rowOnlyWrite(method, args);
    if (rowOnly) void this.refetchRow(rowOnly);
    else void this.checkCounter();
  }

  doorbell(): void {
    void this.checkCounter(true);
  }

  private async checkCounter(rung = false): Promise<void> {
    let state: ChangeState;
    try {
      state = await this.adapter.changeState();
    } catch (e) {
      quiet.warn("reading the change counter failed; refetching everything", e);
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
    if (rung) for (const listener of this.changedListeners) listener();
  }

  private async refetchRow(id: string): Promise<void> {
    try {
      this.confirm(await this.adapter.getPages([id]));
    } catch (e) {
      // The row stays as held; the next refresh brings it.
      quiet.warn("refetching a written row failed", e);
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

  /** The full page, from memory with no database call while nothing has changed since it was read.
   *  Null is a page that's gone; a read that failed rejects, so the two aren't mistaken. */
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

  prefetch(id: string): void {
    const held = this.bodies.get(id);
    if ((held && held.seen === this.seen) || this.bodyReads.has(id)) return;
    if (this.bodyReads.size > 0) {
      this.waitingPrefetch = id;
      return;
    }
    this.readBody(id).catch((e: unknown) => quiet.warn("prefetching a page failed", e));
  }

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

  private patchBody(id: string, patch: object): void {
    const held = this.bodies.get(id);
    if (held) this.holdBody({ ...held.page, ...patch }, held.seen);
  }

  /** Load `start` to `end` unless a current copy is held, then the `neighbours`, so a step shows its week at once. */
  showRange(start: string, end: string, neighbours: readonly Range[] = []): void {
    this.shownRange = { end, start };
    const held = this.ranges.get(`${start}|${end}`);
    const shown = !held || held.stale ? this.loadRange(start, end) : Promise.resolve();
    void shown.then(() => {
      for (const [s, e] of neighbours) if (!this.ranges.has(`${s}|${e}`)) void this.loadRange(s, e);
    });
    if (this.heads === null) void this.loadHeads();
  }

  /** The calendar will show `start` to `end` when it opens: load it now unless it is held, so the
   *  first open draws its pages with the grid. A calendar on screen loads its own range. */
  preloadRange(start: string, end: string): void {
    const isCalendarShown = this.shownRange !== null;
    if (isCalendarShown || this.ranges.has(`${start}|${end}`)) return;

    void this.loadRange(start, end);
  }

  rangeLoaded(start: string, end: string): boolean {
    return this.ranges.has(`${start}|${end}`) && this.heads !== null;
  }

  headPages(): PageSummary[] {
    const pages = (this.heads ?? []).flatMap((id) => this.store.get(id) ?? []);
    const last = this.headsRead;
    if (last && last.length === pages.length && last.every((p, i) => p === pages[i])) return last;
    this.headsRead = pages;
    return pages;
  }

  headsLoaded(): boolean {
    return this.heads !== null;
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

  /** The calendar unmounted or was hidden: every range but the one on screen goes, and the series
   *  heads stay. Dropping the shown one too would draw the grid empty and its blocks a fetch later;
   *  kept, it shows at once and reloads behind it if a write marked it stale. */
  hideRanges(): void {
    const shown = this.shownRange && `${this.shownRange.start}|${this.shownRange.end}`;
    for (const name of [...this.ranges.keys()]) {
      if (name === shown) continue;

      this.ranges.delete(name);
      this.rangeRead.delete(name);
    }

    this.shownRange = null;
    this.bump();
  }

  rangePages(start: string, end: string): PageSummary[] {
    const name = `${start}|${end}`;
    const ids = this.ranges.get(name)?.ids ?? [];
    const seen = new Set(ids);
    const pages = ids.flatMap((id) => this.store.get(id) ?? []);
    for (const id of this.heads ?? []) {
      const head = seen.has(id) ? undefined : this.store.get(id);
      if (head) pages.push(head);
    }
    const last = this.rangeRead.get(name);
    if (last && last.length === pages.length && last.every((p, i) => p === pages[i])) return last;
    this.rangeRead.set(name, pages);
    return pages;
  }

  /**
   * Only a range's latest load is kept: an earlier one landing after it would undo it. One a write
   * overlapped is kept but stale, and loads again if the range is on screen.
   *
   * Neither a stale load nor one that read before a pending edit reached the database takes a page
   * out of the range: a block made by a click went on screen, off for that load, and on again.
   */
  private async loadRange(start: string, end: string): Promise<void> {
    const name = `${start}|${end}`;
    const asked = (this.rangeAsked.get(name) ?? 0) + 1;
    this.rangeAsked.set(name, asked);
    const epoch = this.rangeEpoch;
    let rows: PageSummary[];
    try {
      rows = await this.adapter.listRange(start, end, getLocalTimezone(), false);
    } catch (e) {
      quiet.warn("loading a calendar range failed", e);
      return;
    }
    if (this.rangeAsked.get(name) !== asked) return;
    this.store.confirm(rows);
    const stale = epoch !== this.rangeEpoch;
    const held = this.ranges.get(name)?.ids ?? [];
    const kept = held.filter((id) => stale || this.store.isPending(id));
    const ids = [...new Set([...rows.map((r) => r.id), ...kept])];
    this.ranges.set(name, { ids, stale });
    this.bump();
    const shown = this.shownRange;
    if (stale && shown?.start === start && shown.end === end) void this.loadRange(start, end);
  }

  /** Every recurring series' head, held from launch: Today swaps a synced series' occurrence in
   *  for its head, and unticking a done clone finds its series, wherever the head is dated. */
  loadSeriesHeads(): Promise<void> {
    return this.loadHeads();
  }

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
    } catch (e) {
      // Occurrences of heads outside the range wait for the next load.
      quiet.warn("loading recurring series heads failed", e);
    }
    this.bump();
  }

  /** Load each listed view's first window unless a current one is held, then evict to the budget keeping `pinnedPages`. */
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
    const evicted = evict(this.cache, this.store, this.config.budgetBytes, {
      pages: new Set([...pinnedPages, ...calendar, ...(this.heads ?? [])]),
      views: new Set(keys.map(viewName)),
    });
    // A load tells readers itself when it lands; showing what's held changes nothing they read,
    // and telling them anyway would draw a returning list twice.
    if (evicted.views.length > 0) this.bump();
  }

  want(key: ViewKey, first: number, last: number): void {
    this.wanted.set(viewName(key), { first, last });
    this.fill(key);
  }

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
    } catch (e) {
      // Badges keep their last counts; the next write recounts.
      quiet.warn("counting the views failed", e);
    }
    this.bump();
  }

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
      for (const row of page.rows) this.stale.delete(row.id);
      loaded = this.cache.receive(token, page, this.store);
    } catch (e) {
      quiet.warn("loading more of a list failed", e);
      this.cache.fail(token);
    } finally {
      this.loadingMore.delete(name);
      this.bump();
    }
    // Not after a failure: an error that persists would otherwise retry without end.
    if (loaded) this.fill(key);
  }

  async allIds(key: ViewKey): Promise<string[]> {
    const entry = this.cache.entry(key);
    if (!entry) return [];
    if (!entry.next) return entry.ids;
    const name = viewName(key);
    const joined = this.idsLoading.get(name);
    if (joined) return joined;
    const next = entry.next;
    const loading = (async () => {
      this.loadingMore.add(name);
      const token = this.cache.begin(key, next, 0);
      try {
        const rest = await this.adapter.listViewIds(key, next, null);
        if (this.cache.extendIds(token, rest)) this.fill(key);
      } finally {
        this.loadingMore.delete(name);
        this.bump();
      }
      return this.cache.entry(key)?.ids ?? [];
    })();
    this.idsLoading.set(name, loading);
    try {
      return await loading;
    } finally {
      this.idsLoading.delete(name);
    }
  }

  /** Summaries for `ids`, fetching the ones not held or held stale. One fetched and not found is
   *  trashed or gone, and is left out rather than answered with the copy held from before. */
  async rows(ids: string[]): Promise<PageSummary[]> {
    const missing = ids.filter((id) => this.needsRow(id) && !this.fetchingRows.has(id));
    const gone = new Set<string>();
    if (missing.length > 0) {
      for (const id of missing) this.fetchingRows.add(id);
      try {
        const fetched = await this.adapter.getPages(missing);
        this.confirm(fetched);
        const found = new Set(fetched.map((p) => p.id));
        for (const id of missing) if (!found.has(id)) gone.add(id);
      } finally {
        for (const id of missing) this.fetchingRows.delete(id);
      }
    }
    return ids.flatMap((id) => (gone.has(id) ? [] : (this.store.get(id) ?? [])));
  }

  /** `rows`, read from the database even when held: whether a page is still open after a change
   *  another process may have made, which no list on screen has to have shown. */
  async currentRows(ids: string[]): Promise<PageSummary[]> {
    for (const id of ids) if (this.store.has(id)) this.stale.add(id);
    return this.rows(ids);
  }

  place(key: ViewKey, moving: string[], place: Placement): void {
    this.cache.place(key, moving, place.after ?? null, place.before ?? null);
    this.bump();
  }

  heldPages(): PageSummary[] {
    return this.store.ids().flatMap((id) => this.store.get(id) ?? []);
  }

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
      for (const listener of this.tagListeners) listener(this.tagList);
    } catch (e) {
      // The next refresh asks again.
      quiet.warn("loading tags failed", e);
    }
  }

  /** Called with the tags when they load or change, apart from the store's other changes. */
  onTags(listener: (tags: TagCount[]) => void): () => void {
    this.tagListeners.add(listener);
    listener(this.tags());
    return () => this.tagListeners.delete(listener);
  }

  /** Called when the doorbell finds the workspace changed. The app's own writes don't call it. */
  onOutsideChange(listener: () => void): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

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
      for (const row of page.rows) this.stale.delete(row.id);
      loaded = this.cache.receive(token, page, this.store);
    } catch (e) {
      quiet.warn("loading a list failed", e);
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

  private fill(key: ViewKey): void {
    const name = viewName(key);
    const want = this.wanted.get(name);
    const entry = this.cache.entry(key);
    if (!want || !entry || entry.status !== "ready" || this.loadingFirst.has(name)) return;
    if (want.last >= entry.ids.length && entry.next && !this.loadingMore.has(name)) {
      if (this.farPast(want.last, entry.ids.length)) void this.allIds(key);
      else void this.loadMore(key);
    }
    const unheld = entry.ids
      .slice(want.first, want.last + 1)
      .filter((id) => this.needsRow(id) && !this.fetchingRows.has(id));
    if (unheld.length > 0) void this.rows(unheld);
  }

  /** Row `last` is far enough past the `loaded` rows that fetching every id beats paging there a
   *  window at a time. */
  private farPast(last: number, loaded: number): boolean {
    return last - loaded > this.config.windowSize * 2;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        await this.writesQuiet();
        this.refreshAgain = false;
        const [views] = await Promise.all([
          Promise.all(this.shown.map((key) => this.refreshView(key))),
          this.loadCounts(),
          this.tagList !== null ? this.loadTags() : undefined,
          this.shownRange ? this.loadRange(this.shownRange.start, this.shownRange.end) : undefined,
          this.shownRange || this.heads !== null ? this.loadHeads() : undefined,
        ]);
        this.markStale(views);
      } while (this.refreshAgain);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /**
   * Refetch one shown list: its first window, then what's on screen past it. Within paging reach of
   * the window, the windows `fill` loads bring their rows; far down, the ids give the order and
   * the rows on screen come by id. Refetching every row loaded would read the whole list on each
   * write once the screen had jumped down it, because a jump loads every id.
   */
  private async refreshView(key: ViewKey): Promise<{ before: string[]; keep: string[] }> {
    const before = this.cache.entry(key)?.ids ?? [];
    const size = this.config.windowSize;
    await this.loadFirst(key);
    // The ids past the first window may already be in: `fill` starts on them as the window lands.
    const first = (this.cache.entry(key)?.ids ?? []).slice(0, size);
    const want = this.wanted.get(viewName(key));
    if (!want || want.last < size) return { before, keep: first };
    if (!this.farPast(want.last, size)) {
      return { before, keep: [...first, ...before.slice(0, want.last + 1)] };
    }
    const onScreen = (await this.allIds(key)).slice(want.first, want.last + 1);
    try {
      this.confirm(await this.adapter.getPages(onScreen));
    } catch (e) {
      // The rows stay as held; the next refresh brings them.
      quiet.warn("refetching the rows on screen failed", e);
    }
    return { before, keep: [...first, ...onScreen] };
  }

  /** Mark the rows a refresh held but didn't refetch, so a list refetches each when it's next on
   *  screen. Not let go: other readers, the completed section among them, show held rows too. */
  private markStale(views: { before: string[]; keep: string[] }[]): void {
    const kept = new Set(views.flatMap((v) => v.keep));
    for (const id of views.flatMap((v) => v.before)) if (!kept.has(id)) this.stale.add(id);
  }

  private needsRow(id: string): boolean {
    return !this.store.has(id) || this.stale.has(id);
  }

  private confirm(rows: PageSummary[]): void {
    for (const row of rows) this.stale.delete(row.id);
    this.store.confirm(rows);
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

  /** Readers hear of changes at most once a microtask: one write lands as several loads, and told
   *  separately each would re-render every reader that many times. */
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
