// Day grouping for Upcoming. Membership is `belongsToView(page, "upcoming")`; this module decides
// how that set is cut into days and what each is called. Only days that hold something get a
// section: an empty header says nothing the next populated one doesn't, and in a virtualised list
// it costs a row.

import { addDays } from "date-fns";

import type { PageSummary } from "../types";
import { dateKey, formatDateOnly, localToday, parseLocalISO } from "../utils/dates";
import { viewerStart } from "../utils/syncedTime";
import { compareByScheduledStart } from "./pageFilters";

export interface UpcomingDaySection {
  /** 'YYYY-MM-DD'; the row key. */
  date: string;
  /** "Today", "Tomorrow", then weekday and date ("Thu, Aug 27"). */
  label: string;
  pages: PageSummary[];
}

/** Locale is left to the system. */
export function upcomingDayLabel(date: string, todayStr: string): string {
  if (date === todayStr) return "Today";
  // addDays, not +86_400_000: across a DST boundary "tomorrow" would land on today or the day after.
  if (date === formatDateOnly(addDays(parseLocalISO(todayStr), 1))) return "Tomorrow";
  return parseLocalISO(date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    weekday: "short",
  });
}

/** Groups pages by scheduled day, ascending, each day sorted as Today sorts. Unscheduled pages
 * are dropped; `belongsToView` already excludes them. */
export function groupUpcomingPages(
  pages: PageSummary[],
  todayStr: string = localToday()
): UpcomingDaySection[] {
  const byDay = new Map<string, PageSummary[]>();
  for (const page of pages) {
    const start = viewerStart(page);
    if (!start) continue;
    const day = dateKey(start);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(page);
    else byDay.set(day, [page]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dayPages]) => ({
      date,
      label: upcomingDayLabel(date, todayStr),
      pages: dayPages.sort(compareByScheduledStart),
    }));
}
