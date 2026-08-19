// Day grouping for the Upcoming smart view.
//
// Membership (which pages reach here at all) is `belongsToView(page, "upcoming")`
// in pageFilters — today through today+6, open only, nothing overdue. This module
// only decides how that set is cut into days and what each day is called.
//
// Only days that actually hold something get a section: an empty day header is a
// row of furniture that says nothing the next-populated header doesn't already
// say, and in a virtualised list it costs a real row.

import { addDays } from "date-fns";

import type { PageSummary } from "../types";
import { dateKey, formatDateOnly, localToday, parseLocalISO } from "../utils/dates";
import { compareByScheduledStart } from "./pageFilters";

export interface UpcomingDaySection {
  /** 'YYYY-MM-DD' — the row key, and what a test asserts against. */
  date: string;
  /** "Today", "Tomorrow", then weekday + date ("Thu, Aug 27"). */
  label: string;
  pages: PageSummary[];
}

/** Locale is left to the system, the way every other date surface here reads. */
function dayLabel(date: string, todayStr: string): string {
  if (date === todayStr) return "Today";
  // addDays, not +86_400_000: a DST boundary inside the window would otherwise
  // land "tomorrow" on today or the day after.
  if (date === formatDateOnly(addDays(parseLocalISO(todayStr), 1))) return "Tomorrow";
  return parseLocalISO(date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    weekday: "short",
  });
}

/**
 * Groups Upcoming's pages by scheduled day, ascending, each day sorted the way
 * the Today view sorts. Pages with no schedule can't be placed on a day and are
 * dropped — `belongsToView` already excludes them, so this is belt-and-braces.
 */
export function groupUpcomingPages(
  pages: PageSummary[],
  todayStr: string = localToday()
): UpcomingDaySection[] {
  const byDay = new Map<string, PageSummary[]>();
  for (const page of pages) {
    if (!page.scheduledStart) continue;
    const day = dateKey(page.scheduledStart);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(page);
    else byDay.set(day, [page]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dayPages]) => ({
      date,
      label: dayLabel(date, todayStr),
      pages: dayPages.sort(compareByScheduledStart),
    }));
}
