// What Today lists for a synced series with an occurrence today. A synced head sits on the oldest
// uncompleted occurrence at or after the connect day and advances only when ticked. Nobody ticks
// a meeting, so a lapsed series' head is dated weeks back while today's occurrence, fine on the
// calendar, reaches no list. The row is also missing after an occurrence moves onto today: the
// move excludes the original date, so the head derives past today.
//
// Synced origin only: the tick must land on the right occurrence, and only a synced series ticks
// per occurrence (a native series funnels every tick to its head, see RecurringGapDialogContext).
// That also makes this safe, since only a synced series has override rows.

import type { PageSummary } from "../types";
import { dateKey, localToday } from "../utils/dates";
import { occurrenceDateOf } from "../utils/recurrence";
import { viewerStart } from "../utils/syncedTime";

/**
 * Replaces a synced series' head row with its occurrence for today. `occurrences` is
 * `useRecurrenceExpansion`'s output; anything that isn't a rendered occurrence is ignored, so the
 * calendar's merged array can be passed whole. Placement reads `scheduledStart`, so a moved
 * instance lands where it was moved while naming the date it replaces, which a completion writes
 * against.
 *
 * The head can be either side of today and both need the swap: behind it for a lapsed series, and
 * ahead because moving an occurrence onto today excludes its original date. A head already on
 * today is left alone, since the expansion suppresses its own date.
 *
 * Run it before the view filter, which reads the head. Today only: elsewhere the head, the oldest
 * uncompleted occurrence, is the right answer, and swapping today's in would hide the one still
 * owed.
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
