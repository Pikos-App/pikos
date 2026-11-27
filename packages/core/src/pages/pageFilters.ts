import { addDays, endOfDay } from "date-fns";

import type { PageSummary } from "../types";
import { formatDateOnly, isAllDayIso, localToday, parseLocalISO } from "../utils/dates";
import { isDone, isOpen } from "../utils/page";
import { emojiAwareCompare } from "../utils/sort";
import { viewerStart } from "../utils/syncedTime";

export type SortMode = "manual" | "date" | "title" | "priority";

/** The views computed from the pages themselves. Everything else is a folder id. */
export const SMART_VIEW_IDS = ["today", "upcoming", "inbox", "trash"] as const;
export type SmartViewId = (typeof SMART_VIEW_IDS)[number];

export function isSmartViewId(viewId: string): viewId is SmartViewId {
  return (SMART_VIEW_IDS as readonly string[]).includes(viewId);
}

/**
 * The folder a view names, or null for a smart view, so a smart view's id can never leak
 * into a `folderId` column.
 *
 * Answers membership, not permission: an external-calendar folder comes back verbatim.
 * Choosing where to put a page wants `folderIdForNewPage`, which excludes folders that can't hold one.
 */
export function folderIdForView(viewId: string): string | null {
  return isSmartViewId(viewId) ? null : viewId;
}

/** Views ordered by the schedule and rendered as sections, so a chosen sort or manual reorder has nothing to act on. */
export function isDateGroupedView(viewId: string): boolean {
  return viewId === "today" || viewId === "upcoming";
}

/** Days the Upcoming view spans, today included. */
export const UPCOMING_WINDOW_DAYS = 7;

/** Last day (inclusive, 'YYYY-MM-DD') the Upcoming view reaches. */
export function upcomingWindowEnd(todayStr: string): string {
  return formatDateOnly(addDays(parseLocalISO(todayStr), UPCOMING_WINDOW_DAYS - 1));
}

/**
 * True when the page belongs to the view by scope alone: folder membership, no folder for
 * inbox, scheduled today or earlier for today, inside the Upcoming window for upcoming.
 * Completion status is not filtered; callers compose with `isOpen` / `isDone`.
 *
 * Upcoming starts at today so the window doesn't leave the reader guessing where today
 * went, and nothing overdue leaks in: that is the Today view's job, and duplicating it
 * would give a page two homes with two meanings.
 */
export function belongsToView(page: PageSummary, viewId: string, todayStr: string): boolean {
  if (viewId === "today") {
    const start = viewerStart(page);
    if (start == null) return false;
    return start.slice(0, 10) <= todayStr;
  }
  if (viewId === "upcoming") {
    const start = viewerStart(page);
    if (start == null) return false;
    const day = start.slice(0, 10);
    return day >= todayStr && day <= upcomingWindowEnd(todayStr);
  }
  if (viewId === "inbox") return page.folderId === null;
  // Deleted rows never reach this list; false stops "trash" falling through as a folder id.
  if (viewId === "trash") return false;
  return page.folderId === viewId;
}

/** A page's start as a sort key in ms. An all-day page sorts at the last moment of its day, after that day's timed pages. */
function toSortMs(page: PageSummary): number {
  const iso = viewerStart(page) ?? "";
  if (isAllDayIso(iso)) return endOfDay(parseLocalISO(iso)).getTime();
  return parseLocalISO(iso).getTime();
}

/** Schedule order, soonest first, shared by every date-grouped section. */
export function compareByScheduledStart(a: PageSummary, b: PageSummary): number {
  return toSortMs(a) - toSortMs(b);
}

/** Returns a new array. */
export function sortPages(pages: PageSummary[], mode: SortMode): PageSummary[] {
  if (mode === "date") {
    return [...pages].sort((a, b) => {
      const aHas = a.scheduledStart != null;
      const bHas = b.scheduledStart != null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return toSortMs(a) - toSortMs(b);
    });
  }
  if (mode === "title") {
    return [...pages].sort((a, b) => emojiAwareCompare(a.title, b.title));
  }
  if (mode === "priority") {
    // 1 is most urgent and 0 (none) sorts last; within a tier, scheduled pages come first, soonest first.
    return [...pages].sort((a, b) => {
      const aP = a.priority === 0 ? 5 : a.priority;
      const bP = b.priority === 0 ? 5 : b.priority;
      if (aP !== bP) return aP - bP;
      const aHas = a.scheduledStart != null;
      const bHas = b.scheduledStart != null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return toSortMs(a) - toSortMs(b);
    });
  }
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

/**
 * Splits today-view pages into overdue (an earlier day) and today.
 *
 * Overdue compares days, never the passing moment: grouping on the moment moved a page to
 * Overdue the minute its time passed, which by afternoon filled the section with the day's
 * own plan, and it split a timed page from an all-day one on the same date.
 */
export function groupTodayPages(
  pages: PageSummary[],
  now: Date = new Date()
): {
  overdue: PageSummary[];
  today: PageSummary[];
} {
  const todayStr = formatDateOnly(now);

  function isOverdue(p: PageSummary): boolean {
    const start = viewerStart(p);
    if (!start) return false;
    return start.slice(0, 10) < todayStr;
  }

  return {
    overdue: pages.filter(isOverdue).sort(compareByScheduledStart),
    today: pages.filter((p) => !isOverdue(p)).sort(compareByScheduledStart),
  };
}
