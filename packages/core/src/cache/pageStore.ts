// The pages the app holds: for each, the summary the database last confirmed and the writes not
// yet settled, shown in order on top of it. A write removes only its own entry when it settles,
// so a later write's fields stay on screen whatever happens to an earlier one, and a failure rolls
// back that write alone.

import type { PageSummary } from "../types";

export type WriteOutcome =
  /** Settled. `row` is the page as the write left it, when the write returns one; a write that
   *  returns nothing should refetch the row first and settle with it, so its fields don't flicker
   *  back to the older confirmed ones in between. */
  | { kind: "confirmed"; row?: PageSummary }
  /** Failed. `keep` holds the entry, for a content write whose text the editor still shows, until
   *  a later write to the page is confirmed. */
  | { kind: "failed"; keep?: boolean };

interface PendingWrite {
  id: number;
  fields: Partial<PageSummary>;
  /** A failed write held on screen; see `WriteOutcome`. */
  kept: boolean;
}

export class PageStore {
  private confirmed = new Map<string, PageSummary>();
  private pending = new Map<string, PendingWrite[]>();
  private pageOf = new Map<number, string>();
  private errored = new Set<string>();
  private nextWrite = 1;
  private version = 0;
  private listeners = new Set<() => void>();

  /** Rows read from the database. Each replaces the one held only if it's at least as new by its
   *  change number, so a read that started before a write can't undo it on arrival. */
  confirm(rows: PageSummary[]): void {
    let changed = false;
    for (const row of rows) {
      const held = this.confirmed.get(row.id);
      if (held?.rowSeq != null && row.rowSeq != null && row.rowSeq < held.rowSeq) continue;
      this.confirmed.set(row.id, row);
      changed = true;
    }
    if (changed) this.bump();
  }

  /** Show `fields` on the page at once. Returns the write's id, for `settle`. */
  write(pageId: string, fields: Partial<PageSummary>): number {
    const id = this.nextWrite++;
    const entries = this.pending.get(pageId) ?? [];
    entries.push({ fields, id, kept: false });
    this.pending.set(pageId, entries);
    this.pageOf.set(id, pageId);
    this.bump();
    return id;
  }

  settle(writeId: number, outcome: WriteOutcome): void {
    const pageId = this.pageOf.get(writeId);
    if (pageId === undefined) return;
    const entries = this.pending.get(pageId) ?? [];
    let remaining: PendingWrite[];
    if (outcome.kind === "confirmed") {
      // A confirmed write also releases the failed ones before it that were held on screen.
      remaining = entries.filter((e) => e.id !== writeId && !(e.kept && e.id < writeId));
      this.errored.delete(pageId);
      this.pageOf.delete(writeId);
      if (outcome.row) this.confirm([outcome.row]);
    } else {
      this.errored.add(pageId);
      if (outcome.keep) {
        remaining = entries.map((e) => (e.id === writeId ? { ...e, kept: true } : e));
      } else {
        remaining = entries.filter((e) => e.id !== writeId);
        this.pageOf.delete(writeId);
      }
    }
    if (remaining.length > 0) this.pending.set(pageId, remaining);
    else this.pending.delete(pageId);
    this.bump();
  }

  /** The page as shown: the confirmed summary with every unsettled write applied in order. */
  get(id: string): PageSummary | undefined {
    const base = this.confirmed.get(id);
    const entries = this.pending.get(id);
    if (!base || !entries) return base;
    return entries.reduce<PageSummary>((page, e) => ({ ...page, ...e.fields }), base);
  }

  has(id: string): boolean {
    return this.confirmed.has(id);
  }

  ids(): string[] {
    return [...this.confirmed.keys()];
  }

  /** Writes still in flight, or failed ones held on screen. Such a page is never evicted. */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** A write to the page failed and no later one has succeeded. */
  hasError(id: string): boolean {
    return this.errored.has(id);
  }

  /** Let go of pages nothing shows any more. Pages with writes in flight or a recorded error stay. */
  forget(ids: Iterable<string>): string[] {
    const gone: string[] = [];
    for (const id of ids) {
      if (this.pending.has(id) || this.errored.has(id) || !this.confirmed.has(id)) continue;
      this.confirmed.delete(id);
      gone.push(id);
    }
    if (gone.length > 0) this.bump();
    return gone;
  }

  /** The page is gone from the database: trashed, deleted, or cleared by a new epoch. */
  remove(id: string): void {
    this.confirmed.delete(id);
    this.pending.delete(id);
    this.errored.delete(id);
    this.bump();
  }

  clear(): void {
    this.confirmed.clear();
    this.pending.clear();
    this.pageOf.clear();
    this.errored.clear();
    this.bump();
  }

  /** Changes on every change to what `get` returns, for `useSyncExternalStore`. */
  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Roughly what the held summaries take in memory, for the eviction budget. */
  estimateBytes(): number {
    let bytes = 0;
    for (const page of this.confirmed.values()) bytes += summaryBytes(page);
    return bytes;
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** Two bytes a character for the strings a summary carries, plus a fixed cost for the object and
 *  its numbers and flags. The large fields (mirror attendees, occurrence maps) count in full. */
export function summaryBytes(page: PageSummary): number {
  let chars = 0;
  for (const value of Object.values(page)) {
    if (typeof value === "string") chars += value.length;
    else if (Array.isArray(value)) chars += value.join("").length + value.length * 8;
    else if (value && typeof value === "object") chars += JSON.stringify(value).length;
  }
  return chars * 2 + SUMMARY_OVERHEAD_BYTES;
}

/** An object with some thirty fields, in a JavaScript engine. */
const SUMMARY_OVERHEAD_BYTES = 400;
