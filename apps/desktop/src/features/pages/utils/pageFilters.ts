import type { PageSummary } from "@pikos/core";
import {
  emojiAwareCompare,
  isAllDayIso,
  isDone,
  isOpen,
  localToday,
  parseLocalISO,
} from "@pikos/core";

export type SortMode = "manual" | "date" | "title" | "priority";

/**
 * True when the page belongs to the given view by scope alone — folder
 * membership for folder views, no-folder for inbox, scheduled today/earlier
 * for today. Does NOT filter by completion status; callers compose with
 * `isOpen` / `isDone` as needed.
 */
export function belongsToView(page: PageSummary, viewId: string, todayStr: string): boolean {
  if (viewId === "today") {
    return page.scheduledStart != null && page.scheduledStart.slice(0, 10) <= todayStr;
  }
  if (viewId === "inbox") return page.folderId === null;
  return page.folderId === viewId;
}

/**
 * Convert a scheduledStart ISO string to a sort key (milliseconds).
 * All-day strings ('YYYY-MM-DD') for today sort at "now" so they land
 * between overdue (past) and upcoming (future) timed items.
 * All-day strings for other days sort at midnight (start of day).
 * Timed strings are parsed as Date so JS DST normalization applies.
 */
function toSortMs(iso: string): number {
  if (isAllDayIso(iso)) {
    if (iso === localToday()) return Date.now();
    return parseLocalISO(iso).getTime();
  }
  return parseLocalISO(iso).getTime();
}

/** Returns a new array. */
export function sortPages(pages: PageSummary[], mode: SortMode): PageSummary[] {
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
    return [...pages].sort((a, b) => emojiAwareCompare(a.title, b.title));
  }
  if (mode === "priority") {
    // Lower priority number = higher urgency (1=urgent … 4=low). 0=none sinks to bottom.
    // Within the same priority tier, sort by date ascending (soonest/most overdue first).
    // Unscheduled items within a tier sort after scheduled ones.
    return [...pages].sort((a, b) => {
      const aP = a.priority === 0 ? 5 : a.priority;
      const bP = b.priority === 0 ? 5 : b.priority;
      if (aP !== bP) return aP - bP;
      const aHas = a.scheduledStart != null;
      const bHas = b.scheduledStart != null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return toSortMs(a.scheduledStart!) - toSortMs(b.scheduledStart!);
    });
  }
  // manual — sort by sortOrder ascending
  return [...pages].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getVisiblePages(pages: PageSummary[], activeViewId: string): PageSummary[] {
  const today = localToday();
  return pages.filter((p) => isOpen(p) && belongsToView(p, activeViewId, today));
}

function sortByCompletedDesc(pages: PageSummary[]): PageSummary[] {
  return [...pages].sort((a, b) => {
    const aTime = a.completedAt ? parseLocalISO(a.completedAt).getTime() : 0;
    const bTime = b.completedAt ? parseLocalISO(b.completedAt).getTime() : 0;
    return bTime - aTime;
  });
}

export function getCompletedTodayPages(pages: PageSummary[]): PageSummary[] {
  const today = localToday();
  return sortByCompletedDesc(
    pages.filter((p) => isDone(p) && p.completedAt?.slice(0, 10) === today)
  );
}

export function getCompletedViewPages(pages: PageSummary[], activeViewId: string): PageSummary[] {
  const today = localToday();
  return sortByCompletedDesc(
    pages.filter((p) => isDone(p) && belongsToView(p, activeViewId, today))
  );
}

/** Splits today-view pages into overdue (before now) and today (today, not yet past).
 *
 * All-day items ('YYYY-MM-DD') use date-only comparison so they stay in "today" all day.
 * Timed items ('YYYY-MM-DDTHH:MM:SS') use a full datetime comparison so past-today
 * times (e.g. 1:45 AM when it is now 10 AM) correctly appear in "overdue".
 */
export function groupTodayPages(pages: PageSummary[]): {
  overdue: PageSummary[];
  today: PageSummary[];
} {
  const todayStr = localToday();
  const now = new Date();

  function isOverdue(p: PageSummary): boolean {
    if (!p.scheduledStart) return false;
    if (isAllDayIso(p.scheduledStart)) return p.scheduledStart < todayStr;
    // Timed: treat as past once the scheduled moment has passed
    return parseLocalISO(p.scheduledStart) < now;
  }

  function byScheduledStart(a: PageSummary, b: PageSummary): number {
    return toSortMs(a.scheduledStart ?? "") - toSortMs(b.scheduledStart ?? "");
  }

  return {
    overdue: pages.filter(isOverdue).sort(byScheduledStart),
    today: pages.filter((p) => !isOverdue(p)).sort(byScheduledStart),
  };
}
