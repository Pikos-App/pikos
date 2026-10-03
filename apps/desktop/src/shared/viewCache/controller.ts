// The view cache as the app drives it: loads a list's first window when it's shown and more as it
// scrolls, refreshes the shown list after every write, evicts what wasn't shown recently, and in
// test lanes checks every cached list it shows against a fresh query.

import type { PageSummary, Placement, StorageAdapter, ViewCounts, ViewKey } from "@pikos/core";
import { getLocalTimezone } from "@pikos/core";
import { evict, PageStore, ViewCache, viewName } from "@pikos/core";
import { differenceInMilliseconds, startOfTomorrow } from "date-fns";

import { createLogger } from "@/shared/logger";

import type { ViewCacheConfig } from "./config";

const log = createLogger("viewCache");

const QUIET_POLL_MS = 10;
/** Long enough to outlast a burst of writes, short enough that a stream of them still shows. */
const QUIET_WAIT_MS = 500;

export class ViewCacheController {
  readonly store = new PageStore();
  readonly cache: ViewCache;
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
  /** Calendar ranges visited while the calendar is mounted, by `start|end`: their pages' ids. */
  private ranges = new Map<string, { ids: string[]; stale: boolean }>();
  private shownRange: { start: string; end: string } | null = null;
  /** Loads asked of each range, so only the latest is kept. */
  private rangeAsked = new Map<string, number>();
  /** Every recurring series' head, which a range needs for occurrences of heads outside it. */
  private heads: string[] | null = null;
  /** Bumped by every write, so a range read that a write overlapped is kept but marked stale. */
  private rangeEpoch = 0;
  private refreshAgain = false;

  constructor(
    private readonly adapter: StorageAdapter,
    readonly config: ViewCacheConfig
  ) {
    this.cache = new ViewCache({ windowSize: config.windowSize });
    this.store.subscribe(() => this.bump());
    this.waitForMidnight();
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

  /** Every view may now be out of date: mark them all, and refetch the ones on screen. */
  writeSettled(): void {
    this.writesInFlight -= 1;
    this.writeEpoch += 1;
    this.cache.invalidate();
    this.rangeEpoch += 1;
    for (const range of this.ranges.values()) range.stale = true;
    this.bump();
    void this.refresh();
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

  /** The calendar unmounted: its ranges go. */
  hideRanges(): void {
    this.ranges.clear();
    this.shownRange = null;
    this.heads = null;
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

  private async loadHeads(): Promise<void> {
    try {
      const heads = await this.adapter.listSeriesHeads(false);
      this.store.confirm(heads);
      this.heads = heads.map((h) => h.id);
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
      const window = await this.adapter.listView(key, entry.next, this.config.windowSize);
      loaded = this.cache.receive(token, window, this.store);
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

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private async loadFirst(key: ViewKey, limit = this.config.windowSize): Promise<void> {
    const name = viewName(key);
    const token = this.cache.begin(key, null, 0);
    this.loadingFirst.add(name);
    this.bump();
    let loaded = false;
    try {
      const window = await this.adapter.listView(key, null, limit);
      loaded = this.cache.receive(token, window, this.store);
    } catch {
      this.cache.fail(token);
    } finally {
      this.loadingFirst.delete(name);
    }
    this.bump();
    if (loaded) this.fill(key);
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
          this.shownRange ? this.loadRange(this.shownRange.start, this.shownRange.end) : undefined,
          this.heads !== null ? this.loadHeads() : undefined,
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

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
