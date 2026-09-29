// Single-page predicates plus the projections and lookups every page-list owner
// needs. Kept here so a future PageStatus addition (e.g. "in_progress") — or a
// change to how a done clone is linked back to its series — has one place to
// update instead of every list/filter/context site.

import type { Page, PageSummary, Tag } from "../types";

type PageLike = Pick<Page | PageSummary, "status">;

export function isOpen(page: PageLike): boolean {
  return page.status !== "done";
}

export function isDone(page: PageLike): boolean {
  return page.status === "done";
}

/** Drop the heavy content fields — list state holds summaries, never full pages. */
export function toPageSummary(page: Page): PageSummary {
  const { content: _, contentText: _ct, ...summary } = page;
  return summary;
}

/** Tags are derived from pages[].tags on every read, never stored separately —
 * there is no tags table to drift from the pages that carry them. */
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
 * Find the recurring series + date a done clone belongs to, or null — native or
 * synced. Scans the loaded series' completion maps — reliable because active
 * series are always in the page list (the loader fetches all active pages with
 * no folder/range filter), and the done clone's series is active. Skips pages
 * with no completion map in O(1) each, so an uncheck costs ~one property read
 * per page.
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
