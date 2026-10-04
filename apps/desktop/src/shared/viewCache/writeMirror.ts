// Carries the app's optimistic edits into the page store as pending writes, one per write, so the
// lists, the calendar and the editor show an edit from the store rather than from the in-memory
// list. Edits are recorded where the write paths already make them: every change a write's
// optimistic step makes to the in-memory list is diffed into the store, so no write path had to
// be rewritten. A write settles its entries when it does: confirmed with the row as the database
// now has it, or dropped on failure.

import type { PageStore, PageSummary } from "@pikos/core";

export class WriteMirror {
  /** Write ids recorded by the optimistic step running now; null outside one. */
  private recording: number[] | null = null;
  private pageOf = new Map<number, string>();

  constructor(
    private readonly store: PageStore,
    private readonly read: (ids: string[]) => Promise<PageSummary[]>
  ) {}

  /** Run a write's optimistic step, recording what it changes. Returns the writes it made. */
  capture(apply: () => void): number[] {
    const outer = this.recording;
    const writes: number[] = [];
    this.recording = writes;
    try {
      apply();
    } finally {
      this.recording = outer;
    }
    return writes;
  }

  /** The page list went from `prev` to `next` with the store as its only copy: an edit inside a
   *  write's `capture`, else the app's own settled copy (a write's echo or its follow-up, a
   *  rollback), adopted. */
  apply(prev: PageSummary[], next: PageSummary[]): void {
    if (this.recording) {
      this.changed(prev, next);
      return;
    }
    const kept = new Set<string>();
    const before = new Map(prev.map((p) => [p.id, p]));
    for (const page of next) {
      kept.add(page.id);
      if (before.get(page.id) !== page) this.store.adopt([page]);
    }
    for (const id of before.keys()) if (!kept.has(id)) this.store.remove(id);
  }

  /** The in-memory list went from `prev` to `next`. Recorded only inside `capture`: a load or a
   *  rollback changes the list too, and isn't an edit. */
  changed(prev: PageSummary[], next: PageSummary[]): void {
    const writes = this.recording;
    if (!writes) return;
    const before = new Map(prev.map((p) => [p.id, p]));
    const after = new Set<string>();
    for (const page of next) {
      after.add(page.id);
      const old = before.get(page.id);
      if (old === page) continue;
      if (!old) {
        this.store.confirm([page]);
        continue;
      }
      if (!this.store.has(page.id)) continue;
      const fields: Partial<PageSummary> = {};
      for (const key of Object.keys(page) as (keyof PageSummary)[]) {
        if (page[key] !== old[key]) Object.assign(fields, { [key]: page[key] });
      }
      this.record(writes, page.id, this.store.write(page.id, fields));
    }
    for (const id of before.keys()) {
      if (!after.has(id) && this.store.has(id))
        this.record(writes, id, this.store.write(id, {}, true));
    }
  }

  /** One page's edit, recorded straight into the store: what `changed` would find, without
   *  diffing the whole list for it. The body goes in too: the editor lays the row over the body it
   *  loaded, which is how typing not yet saved survives a switch away and back. */
  patch(id: string, fields: Partial<PageSummary>): void {
    const writes = this.recording;
    if (!writes || !this.store.has(id)) return;
    this.record(writes, id, this.store.write(id, fields));
  }

  /** A row the database just returned for a write, held as confirmed. */
  confirmRow(row: PageSummary): void {
    this.store.confirm([row]);
  }

  /** The writes landed: settle each with its page as the database now has it. */
  async confirm(writes: number[]): Promise<void> {
    if (writes.length === 0) return;
    const ids = [...new Set(writes.flatMap((w) => this.pageOf.get(w) ?? []))];
    let rows: PageSummary[] = [];
    try {
      rows = await this.read(ids);
    } catch {
      // Settled without rows; the next refresh brings them.
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const write of writes) {
      const row = byId.get(this.pageOf.get(write) ?? "");
      this.store.settle(write, row ? { kind: "confirmed", row } : { kind: "confirmed" });
      this.pageOf.delete(write);
    }
  }

  /** The writes failed: drop their entries, or with `keep` hold them on screen, as for typing the
   *  editor still shows. */
  fail(writes: number[], keep = false): void {
    for (const write of writes) {
      this.store.settle(write, { keep, kind: "failed" });
      if (!keep) this.pageOf.delete(write);
    }
  }

  private record(writes: number[], pageId: string, write: number): void {
    writes.push(write);
    this.pageOf.set(write, pageId);
  }
}
