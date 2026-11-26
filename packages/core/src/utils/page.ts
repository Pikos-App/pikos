// Page predicates and projections every list owner needs, kept in one place so a new PageStatus or
// a change to how a done clone links back to its series has one site to update.

import { CONTENT_SCHEMA_VERSION } from "../types";
import type { Page, PageSummary, Tag } from "../types";

type PageLike = Pick<Page | PageSummary, "status">;

export function isOpen(page: PageLike): boolean {
  return page.status !== "done";
}

export function isDone(page: PageLike): boolean {
  return page.status === "done";
}

/** A body a newer Pikos wrote. It opens read-only, because this editor may not know its nodes and
 *  the writer refuses to save over it. */
export function isBodyFromNewerBuild(page: Pick<Page, "contentSchemaVersion">): boolean {
  return page.contentSchemaVersion > CONTENT_SCHEMA_VERSION;
}

/** List state holds summaries, never full pages. */
export function toPageSummary(page: Page): PageSummary {
  const { content: _, ...summary } = page;
  return summary;
}

/** Derived from `pages[].tags` on every read, so there is no tags table to drift. */
export function deriveTags(pages: PageSummary[]): Tag[] {
  const map = new Map<string, { count: number; ids: string[] }>();
  for (const page of pages) {
    for (const tag of page.tags) {
      const entry = map.get(tag);
      if (entry) {
        entry.count++;
        entry.ids.push(page.id);
      } else {
        map.set(tag, { count: 1, ids: [page.id] });
      }
    }
  }
  return Array.from(map.entries()).map(([name, { count, ids }]) => ({
    name,
    pageCount: count,
    pageIds: ids,
  }));
}

/**
 * The recurring series and date a done clone belongs to, or null, native or synced. Scans the
 * loaded series' completion maps, which is reliable because active series are always in the page
 * list and a done clone's series is active.
 */
export function findRecurringOccurrenceClone(
  pages: PageSummary[],
  cloneId: string
): { seriesId: string; occurrenceDate: string } | null {
  for (const p of pages) {
    const map = p.completedOccurrences;
    if (!map) continue;
    const date = Object.keys(map).find((d) => map[d] === cloneId);
    if (date) return { occurrenceDate: date, seriesId: p.id };
  }
  return null;
}
