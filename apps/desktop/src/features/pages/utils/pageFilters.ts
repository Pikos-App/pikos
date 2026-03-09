import type { Page } from "@pikos/core";

export type SortMode = "manual" | "date" | "title";

/** Local YYYY-MM-DD string (avoids UTC date mismatch in late-evening timezones). */
function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Convert a scheduledStart ISO string to a sort key (milliseconds).
 * All-day strings ('YYYY-MM-DD') for today sort at "now" so they land
 * between overdue (past) and upcoming (future) timed items.
 * All-day strings for other days sort at midnight (start of day).
 * Timed strings are parsed as Date so JS DST normalization applies.
 */
function toSortMs(iso: string): number {
  if (iso.length === 10) {
    if (iso === localToday()) return Date.now();
    const y = parseInt(iso.slice(0, 4));
    const m = parseInt(iso.slice(5, 7)) - 1;
    const d = parseInt(iso.slice(8, 10));
    return new Date(y, m, d, 0, 0, 0).getTime();
  }
  return new Date(iso).getTime();
}

/** Sort a page list by the given mode. Returns a new array. */
export function sortPages(pages: Page[], mode: SortMode): Page[] {
  if (mode === "date") {
    return [...pages].sort((a, b) => {
      const aHas = a.scheduledStart != null;
      const bHas = b.scheduledStart != null;
      // Unscheduled items sink to the bottom
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return toSortMs(a.scheduledStart!) - toSortMs(b.scheduledStart!);
    });
  }
  if (mode === "title") {
    return [...pages].sort((a, b) => a.title.localeCompare(b.title));
  }
  // manual — sort by sortOrder ascending
  return [...pages].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Returns the pages visible for the given view, in sort order. */
export function getVisiblePages(pages: Page[], activeViewId: string): Page[] {
  if (activeViewId === "today") {
    const today = localToday();
    return pages.filter(
      (p) => p.scheduledStart && p.scheduledStart.slice(0, 10) <= today && p.status !== "done"
    );
  }
  if (activeViewId === "inbox") {
    return pages.filter((p) => p.folderId === null);
  }
  return pages.filter((p) => p.folderId === activeViewId);
}

/** Returns pages completed today (status=done, completedAt is today). */
export function getCompletedTodayPages(pages: Page[]): Page[] {
  const today = localToday();
  return pages
    .filter((p) => p.status === "done" && p.completedAt?.slice(0, 10) === today)
    .sort((a, b) => {
      // Most recently completed first
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });
}

/** Splits today-view pages into overdue (before now) and today (today, not yet past).
 *
 * All-day items ('YYYY-MM-DD') use date-only comparison so they stay in "today" all day.
 * Timed items ('YYYY-MM-DDTHH:MM:SS') use a full datetime comparison so past-today
 * times (e.g. 1:45 AM when it is now 10 AM) correctly appear in "overdue".
 */
export function groupTodayPages(pages: Page[]): { overdue: Page[]; today: Page[] } {
  const todayStr = localToday();
  const now = new Date();

  function isOverdue(p: Page): boolean {
    if (!p.scheduledStart) return false;
    // All-day format is exactly 'YYYY-MM-DD' (length 10)
    if (p.scheduledStart.length === 10) return p.scheduledStart < todayStr;
    // Timed: treat as past once the scheduled moment has passed
    return new Date(p.scheduledStart) < now;
  }

  function byScheduledStart(a: Page, b: Page): number {
    return toSortMs(a.scheduledStart ?? "") - toSortMs(b.scheduledStart ?? "");
  }

  return {
    overdue: pages.filter(isOverdue).sort(byScheduledStart),
    today: pages.filter((p) => !isOverdue(p)).sort(byScheduledStart),
  };
}
