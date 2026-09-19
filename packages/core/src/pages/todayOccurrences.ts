// What the Today view lists for a synced series that has an occurrence today.
//
// A series is one page (its head), and a synced head sits on the oldest
// un-completed occurrence at or after the connect day, advancing only when
// someone ticks it. Nobody ticks a meeting, so a lapsed series' head is a row
// dated weeks back while today's occurrence, rendered fine on the calendar,
// reaches no list at all. The same row is missing for the opposite reason after
// someone moves an occurrence onto today: the move excludes the original date, so
// the head derives *past* today.
//
// Synced-origin only: the tick has to land on the right occurrence, and only a
// synced-origin series ticks per occurrence (a native series funnels every tick to
// its head — see RecurringGapDialogContext). That is also the invariant that makes
// this safe, since only a synced series has override rows at all.

import type { PageSummary } from "../types";
import { dateKey, localToday } from "../utils/dates";
import { occurrenceDateOf } from "../utils/recurrence";
import { viewerStart } from "../utils/syncedTime";

/**
 * Replaces a synced series' head row with its occurrence for today.
 *
 * `occurrences` is `useRecurrenceExpansion`'s output; anything that isn't a
 * rendered occurrence is ignored, so the calendar's merged array can be passed
 * whole. Placement reads `scheduledStart`, not `originalDate`, so a moved
 * instance lands on the day it was moved to while still naming the date it
 * replaces — which is what the completion writes against.
 *
 * The head can be either side of today and both need the swap. Behind it, for a
 * lapsed series nobody ticks. Ahead of it, because moving an occurrence onto today
 * puts its original date in the exclusion set, so the head derives past today and
 * the one day the series *is* due is the one day it would not be listed. Only a
 * head already sitting on today is left alone: that is the same occurrence, and
 * the expansion suppresses the head's own date anyway.
 *
 * Run this **before** the view filter, not after. The filter reads the head, and
 * the whole point is that the head is on the wrong day.
 */
export function withTodayOccurrences(
  pages: PageSummary[],
  occurrences: PageSummary[],
  todayStr: string = localToday()
): PageSummary[] {
  const todayById = new Map<string, PageSummary>();
  for (const occ of occurrences) {
    const start = viewerStart(occ);
    if (occurrenceDateOf(occ) === null || !start) continue;
    if (dateKey(start) !== todayStr) continue;
    todayById.set(occ.id, occ);
  }
  if (todayById.size === 0) return pages;

  return pages.map((page) => {
    const start = viewerStart(page);
    if (page.syncState == null || !start) return page;
    if (dateKey(start) === todayStr) return page;
    return todayById.get(page.id) ?? page;
  });
}
