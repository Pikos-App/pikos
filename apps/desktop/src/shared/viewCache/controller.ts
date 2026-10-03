// The view cache as the app drives it: loads a list's first window when it's shown and more as it
// scrolls, refreshes the shown list after every write, evicts what wasn't shown recently, and in
// test lanes checks every cached list it shows against a fresh query.

import type { PageSummary, Placement, StorageAdapter, ViewKey } from "@pikos/core";
import { evict, PageStore, ViewCache, viewName } from "@pikos/core";

import { createLogger } from "@/shared/logger";

import type { ViewCacheConfig } from "./config";

const log = createLogger("viewCache");

export class ViewCacheController {
  readonly store = new PageStore();
  readonly cache: ViewCache;
  private shown: ViewKey | null = null;
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
  private refreshAgain = false;

  constructor(
    private readonly adapter: StorageAdapter,
    readonly config: ViewCacheConfig
  ) {
    this.cache = new ViewCache({ windowSize: config.windowSize });
    this.store.subscribe(() => this.bump());
  }

  writeStarted(): void {
    this.writesInFlight += 1;
    this.writeEpoch += 1;
  }

  /** Every view may now be out of date: mark them all, and refetch the one on screen. */
  writeSettled(): void {
    this.writesInFlight -= 1;
    this.writeEpoch += 1;
    this.cache.invalidate();
    this.bump();
    void this.refresh();
  }

  /**
   * The list on screen is `key`. Loads its first window unless a current one is held, in which
   * case the shadow check runs; then evicts down to the budget, keeping `pinnedPages`.
   */
  show(key: ViewKey, pinnedPages: Iterable<string>): void {
    this.shown = key;
    this.cache.touch(key);
    const entry = this.cache.entry(key);
    if (!entry || entry.stale || entry.status === "error") void this.loadFirst(key);
    else if (
      this.config.shadow &&
      entry.status === "ready" &&
      !this.loadingFirst.has(viewName(key))
    )
      void this.shadowCheck(key);
    evict(this.cache, this.store, this.config.budgetBytes, {
      pages: new Set(pinnedPages),
      views: new Set([viewName(key)]),
    });
    this.bump();
  }

  /** Rows `first` through `last` of `key` are on screen: load them, and keep loading as fetches
   *  land until they're all held. */
  want(key: ViewKey, first: number, last: number): void {
    this.wanted.set(viewName(key), { first, last });
    this.fill(key);
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
        this.refreshAgain = false;
        const key = this.shown;
        if (!key) break;
        const loaded = this.cache.entry(key)?.ids.length ?? 0;
        await this.loadFirst(key, Math.max(this.config.windowSize, loaded));
      } while (this.refreshAgain);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /** Compare a cached list with the database. Skipped when a write overlaps it, since the two
   *  reads would then legitimately differ. */
  private async shadowCheck(key: ViewKey): Promise<void> {
    const entry = this.cache.entry(key);
    if (!entry || this.writesInFlight > 0) return;
    const epoch = this.writeEpoch;
    const ids = [...entry.ids];
    const [fresh, rows] = await Promise.all([
      this.adapter.listViewIds(key, null, null),
      this.adapter.getPages(ids),
    ]);
    if (this.writeEpoch !== epoch || this.writesInFlight > 0) return;
    const problems: string[] = [];
    const complete = !entry.next;
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
