import { addDays } from "date-fns";

import type { PageSummary } from "../types";
import { formatDateOnly, isAllDayIso, localToday, parseLocalISO } from "../utils/dates";
import { isDone, isOpen } from "../utils/page";
import { emojiAwareCompare } from "../utils/sort";

export type SortMode = "manual" | "date" | "title" | "priority";

/** The views that are computed from the pages themselves rather than folder
 *  membership. Everything else is a folder id. */
export const SMART_VIEW_IDS = ["today", "upcoming", "inbox"] as const;
export type SmartViewId = (typeof SMART_VIEW_IDS)[number];

export function isSmartViewId(viewId: string): viewId is SmartViewId {
  return (SMART_VIEW_IDS as readonly string[]).includes(viewId);
}

/**
 * The folder a view implies for a page created or dropped inside it — null for
 * every smart view, since none of them is a place a page can live. Keeps the
 * "is this id a folder?" question in one place so a fourth smart view can never
 * leak its id into a `folderId` column.
 */
export function folderIdForView(viewId: string): string | null {
  return isSmartViewId(viewId) ? null : viewId;
}

/**
 * Views whose order is derived from the schedule and rendered as sections, so a
 * user-chosen sort (and manual drag-to-reorder) has nothing to act on.
 */
export function isDateGroupedView(viewId: string): boolean {
  return viewId === "today" || viewId === "upcoming";
}

/** How many days the Upcoming view spans, counting today as day one. */
export const UPCOMING_WINDOW_DAYS = 7;

/** Last day (inclusive, 'YYYY-MM-DD') the Upcoming view reaches. */
export function upcomingWindowEnd(todayStr: string): string {
  return formatDateOnly(addDays(parseLocalISO(todayStr), UPCOMING_WINDOW_DAYS - 1));
}

/**
 * True when the page belongs to the given view by scope alone — folder
 * membership for folder views, no-folder for inbox, scheduled today/earlier
 * for today, scheduled inside the next-7-days window for upcoming. Does NOT
 * filter by completion status; callers compose with `isOpen` / `isDone` as
 * needed.
 *
 * Upcoming deliberately starts at today rather than tomorrow: it answers "what
 * is coming", and a window that opens at tomorrow leaves the reader guessing
 * where today went. It deliberately stops at today — nothing overdue leaks in,
 * because chasing what already slipped is the Today view's job and duplicating
 * it here would give the same page two homes with two different meanings.
 */
export function belongsToView(page: PageSummary, viewId: string, todayStr: string): boolean {
  if (viewId === "today") {
    if (page.scheduledStart == null) return false;
    return page.scheduledStart.slice(0, 10) <= todayStr;
  }
  if (viewId === "upcoming") {
    if (page.scheduledStart == null) return false;
    const day = page.scheduledStart.slice(0, 10);
    return day >= todayStr && day <= upcomingWindowEnd(todayStr);
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

/**
 * Schedule order, soonest first — the ordering every date-grouped section uses,
 * so a day group in Upcoming reads exactly like the Today view's sections do.
 */
export function compareByScheduledStart(a: PageSummary, b: PageSummary): number {
  return toSortMs(a.scheduledStart ?? "") - toSortMs(b.scheduledStart ?? "");
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

  return {
    overdue: pages.filter(isOverdue).sort(compareByScheduledStart),
    today: pages.filter((p) => !isOverdue(p)).sort(compareByScheduledStart),
  };
}
