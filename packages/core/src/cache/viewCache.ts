// The lists the app has loaded, a window at a time: for each view, the ids loaded from the top,
// where the next window starts, the total, and when it was last shown. Rows themselves live in the
// `PageStore`; a view holds only ids, so holding many views costs little.

import type { ViewCursor, ViewKey, ViewWindow } from "../types";
import type { PageStore } from "./pageStore";

export interface ViewEntry {
  key: ViewKey;
  status: "loading" | "ready" | "error";
  /** The rows loaded so far, in order, from the top of the list. */
  ids: string[];
  /** Where the next window starts; null once the whole list is loaded. */
  next: ViewCursor | null;
  /** Every row in the view, from the first window. */
  total: number | null;
  /** The change counter when the first window was asked for, so an outside change after it marks
   *  the view stale. */
  readAt: number;
  /** When it was last on screen, for eviction: least recently shown goes first. */
  lastShown: number;
  /** Something changed since it loaded. It still shows while it refetches. */
  stale: boolean;
  /** Bumped by every invalidation, so a fetch that began before one is ignored when it lands. */
  generation: number;
}

/** A fetch in progress, to hand back with what it got. */
export interface FetchToken {
  name: string;
  generation: number;
  /** Null for the first window, which replaces what's loaded; a cursor for one that appends. */
  after: ViewCursor | null;
}

/** One name per view, whatever order the key's fields were written in. */
export function viewName(key: ViewKey): string {
  const scope = key.scope.kind === "folder" ? `folder:${key.scope.folderId}` : key.scope.kind;
  const dates = key.dates ? `${key.dates.from ?? ""}..${key.dates.until}` : "";
  return [scope, key.sort, key.zone, dates].join("|");
}

/** Roughly what a view's id list takes: a 36-character id at two bytes a character, and a slot. */
const BYTES_PER_ID = 80;

export class ViewCache {
  private views = new Map<string, ViewEntry>();
  private clock = 0;

  constructor(readonly options: { windowSize: number }) {}

  entry(key: ViewKey): ViewEntry | undefined {
    return this.views.get(viewName(key));
  }

  entries(): ViewEntry[] {
    return [...this.views.values()];
  }

  /** Start a fetch: the first window when `after` is null, else the window after it. */
  begin(key: ViewKey, after: ViewCursor | null, readAt: number): FetchToken {
    const name = viewName(key);
    const held = this.views.get(name);
    if (!held) {
      this.views.set(name, {
        generation: 0,
        ids: [],
        key,
        lastShown: ++this.clock,
        next: null,
        readAt,
        stale: false,
        status: "loading",
        total: null,
      });
    } else if (after === null) {
      held.readAt = readAt;
      if (held.status === "error") held.status = "loading";
    }
    return { after, generation: this.views.get(name)!.generation, name };
  }

  /**
   * A window arrived. Its rows go to the store either way, since they're the newest the database
   * had; the view takes the window only if nothing invalidated it since the fetch began, and
   * returns whether it did.
   */
  receive(token: FetchToken, window: ViewWindow, store: PageStore): boolean {
    store.confirm(window.rows);
    const entry = this.views.get(token.name);
    if (!entry || entry.generation !== token.generation) return false;
    const ids = window.rows.map((r) => r.id);
    if (token.after === null) {
      entry.ids = ids;
      entry.total = window.total ?? entry.total;
      entry.stale = false;
    } else {
      const loaded = new Set(entry.ids);
      entry.ids = [...entry.ids, ...ids.filter((id) => !loaded.has(id))];
    }
    entry.next = window.next ?? null;
    entry.status = "ready";
    return true;
  }

  /** The rest of a view's ids arrived without their rows, so the list is complete. */
  extendIds(token: FetchToken, ids: string[]): boolean {
    const entry = this.views.get(token.name);
    if (!entry || entry.generation !== token.generation) return false;
    const loaded = new Set(entry.ids);
    entry.ids = [...entry.ids, ...ids.filter((id) => !loaded.has(id))];
    entry.next = null;
    return true;
  }

  fail(token: FetchToken): void {
    const entry = this.views.get(token.name);
    if (entry && entry.generation === token.generation && entry.ids.length === 0) {
      entry.status = "error";
    }
  }

  /** Show `moving` between `after` and `before` at once, ahead of the write that moves them; the
   *  refetch after the write confirms or corrects it. */
  place(key: ViewKey, moving: string[], after: string | null, before: string | null): void {
    const entry = this.views.get(viewName(key));
    if (!entry) return;
    const set = new Set(moving);
    const rest = entry.ids.filter((id) => !set.has(id));
    const at =
      after !== null ? rest.indexOf(after) + 1 : before !== null ? rest.indexOf(before) : 0;
    if (at < 0 || (after !== null && at === 0)) return;
    rest.splice(at, 0, ...moving);
    entry.ids = rest;
  }

  /** Mark views stale, every view or those `matches` picks. A fetch already in flight for one is
   *  ignored when it lands, since it may have read from before the change. */
  invalidate(matches: (key: ViewKey) => boolean = () => true): void {
    for (const entry of this.views.values()) {
      if (!matches(entry.key)) continue;
      entry.stale = true;
      entry.generation += 1;
    }
  }

  touch(key: ViewKey): void {
    const entry = this.views.get(viewName(key));
    if (entry) entry.lastShown = ++this.clock;
  }

  remove(name: string): void {
    this.views.delete(name);
  }

  clear(): void {
    this.views.clear();
  }

  estimateBytes(): number {
    let bytes = 0;
    for (const entry of this.views.values()) bytes += entry.ids.length * BYTES_PER_ID;
    return bytes;
  }
}
