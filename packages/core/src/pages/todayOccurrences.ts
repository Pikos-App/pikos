// What the Today view lists for a synced series that has an occurrence today.
//
// A series is one page (its head), and a synced head sits on the oldest
// un-completed occurrence at or after the connect day, advancing only when
// someone ticks it. Nobody ticks a meeting, so a lapsed series' head is a row
// dated weeks back while today's occurrence, rendered fine on the calendar,
// reaches no list at all. Synced-origin only: the tick has to land on the right
// occurrence, and only a synced-origin series ticks per occurrence (a native
// series funnels every tick to its head — see RecurringGapDialogContext).

import type { PageSummary } from "../types";
import { dateKey, localToday } from "../utils/dates";
import { occurrenceDateOf } from "../utils/recurrence";

/**
 * Replaces a lapsed synced series' head row with its occurrence for today.
 *
 * `occurrences` is `useRecurrenceExpansion`'s output; anything that isn't a
 * rendered occurrence is ignored, so the calendar's merged array can be passed
 * whole. Placement reads `scheduledStart`, not `originalDate`, so a moved
 * instance lands on the day it was moved to while still naming the date it
 * replaces — which is what the completion writes against.
 *
 * A head already on today (or later) is left alone: it is the same occurrence,
 * and the expansion suppresses the head's own date anyway.
 */
export function withTodayOccurrences(
  pages: PageSummary[],
  occurrences: PageSummary[],
  todayStr: string = localToday()
): PageSummary[] {
  const todayById = new Map<string, PageSummary>();
  for (const occ of occurrences) {
    if (occurrenceDateOf(occ) === null || !occ.scheduledStart) continue;
    if (dateKey(occ.scheduledStart) !== todayStr) continue;
    todayById.set(occ.id, occ);
  }
  if (todayById.size === 0) return pages;

  return pages.map((page) => {
    if (page.syncState == null || !page.scheduledStart) return page;
    if (dateKey(page.scheduledStart) >= todayStr) return page;
    return todayById.get(page.id) ?? page;
  });
}
