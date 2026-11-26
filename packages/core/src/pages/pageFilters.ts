import { addDays } from "date-fns";

import type { PageSummary } from "../types";
import { formatDateOnly, isAllDayIso, localToday, parseLocalISO } from "../utils/dates";
import { isDone, isOpen } from "../utils/page";
import { emojiAwareCompare } from "../utils/sort";
import { viewerStart } from "../utils/syncedTime";

export type SortMode = "manual" | "date" | "title" | "priority";

/** Views computed from the pages themselves, not folder membership; everything else is a folder
 *  id. */
export const SMART_VIEW_IDS = ["today", "upcoming", "inbox", "trash"] as const;
export type SmartViewId = (typeof SMART_VIEW_IDS)[number];

export function isSmartViewId(viewId: string): viewId is SmartViewId {
  return (SMART_VIEW_IDS as readonly string[]).includes(viewId);
}

/**
 * The folder scope a view names; null for every smart view, none of which is a place a page can
 * live, so a smart view id can't leak into a `folderId` column. Answers membership, not
 * permission: an external-calendar folder comes back verbatim. Choosing where to put a page wants
 * `folderIdForNewPage`.
 */
export function folderIdForView(viewId: string): string | null {
  return isSmartViewId(viewId) ? null : viewId;
}

/** Views ordered by schedule and rendered as sections, so a user sort or manual reorder has
 * nothing to act on. */
export function isDateGroupedView(viewId: string): boolean {
  return viewId === "today" || viewId === "upcoming";
}

/** Days Upcoming spans, counting today as day one. */
export const UPCOMING_WINDOW_DAYS = 7;

/** Last day ('YYYY-MM-DD', inclusive) Upcoming reaches. */
export function upcomingWindowEnd(todayStr: string): string {
  return formatDateOnly(addDays(parseLocalISO(todayStr), UPCOMING_WINDOW_DAYS - 1));
}

/**
 * Whether the page belongs to the view by scope alone: folder membership, no folder for inbox,
 * scheduled today or earlier for today, inside the next-7-days window for upcoming. Callers
 * compose with `isOpen`/`isDone` for completion.
 *
 * Upcoming starts at today, not tomorrow, so the reader isn't left guessing where today went. It
 * keeps nothing overdue: chasing what slipped is Today's job, and showing it here would give a
 * page two homes with two meanings.
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
  // The trash reads deleted rows that never reach this list; false stops the folder fallthrough
  // treating "trash" as a folder id.
  if (viewId === "trash") return false;
  return page.folderId === viewId;
}

/** A sort key in ms. An all-day string for today sorts at "now", between overdue and upcoming
 * timed items; other all-day strings sort at midnight. Timed strings parse as a Date, so JS DST
 * normalization applies. */
function toSortMs(page: PageSummary): number {
  const iso = viewerStart(page) ?? "";
  if (isAllDayIso(iso)) {
    if (iso === localToday()) return Date.now();
    return parseLocalISO(iso).getTime();
  }
  return parseLocalISO(iso).getTime();
}

/** Schedule order, soonest first: every date-grouped section uses it, so an Upcoming day reads like
 * Today's sections. */
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
    // 1 urgent ... 4 low, with 0 (none) last; ties by date, then unscheduled after scheduled.
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

/** Splits today-view pages into overdue (an earlier day) and today. Overdue compares days, never
 * the passing moment: a page set for 9am today stays under Today at 2pm, late only through its
 * red time. Grouping on the moment filled Overdue with the day's own plan by afternoon and split
 * a timed page from an all-day one on the same date. */
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
