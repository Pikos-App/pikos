// Plans the Today view's "Move to today" bulk action on Overdue, as date math with no I/O.
//
// Two kinds of overdue page stay where they are:
//   - recurring occurrences: an overdue occurrence means the series has a gap, which the
//     recurring-gap dialog resolves (skip or complete the backlog). Dragging the anchor forward
//     would erase the gap instead.
//   - synced mirrors (`scheduleLocked`): the reconciler owns their schedule, and the backend
//     rejects the write.
//
// Everything else shifts by whole days, keeping its wall-clock shape: a 9:00-10:00 from last week
// is 9:00-10:00 today, and a two-day all-day span stays two days.

import { addDays, differenceInCalendarDays } from "date-fns";

import type { PageSummary } from "../types";
import {
  dateKey,
  formatDateOnly,
  formatLocalISO,
  isAllDayIso,
  localToday,
  parseLocalISO,
} from "../utils/dates";

export interface OverdueMove {
  pageId: string;
  /** Where the page lands. */
  start: string;
  end: string | undefined;
  /** What it was, so a single undo can put the whole batch back. */
  previousStart: string;
  previousEnd: string | undefined;
}

export interface OverdueMovePlan {
  moves: OverdueMove[];
  /** Left in place; see the module note. */
  recurringKept: number;
  syncedKept: number;
}

/** Shifts an ISO schedule by whole days, keeping its all-day or timed shape. `addDays`, not a ms
 *  offset, so the wall-clock time survives DST. */
function shiftByDays(iso: string, days: number): string {
  const shifted = addDays(parseLocalISO(iso), days);
  return isAllDayIso(iso) ? formatDateOnly(shifted) : formatLocalISO(shifted);
}

/**
 * Plans the move for the Overdue section. A page already dated today is neither moved nor counted
 * as kept: it has nowhere to go, and "left" would read as a refusal. Overdue holds only earlier
 * days, so only a caller assembling its own set can hit that.
 */
export function planMoveOverdueToToday(
  pages: PageSummary[],
  todayStr: string = localToday()
): OverdueMovePlan {
  const today = parseLocalISO(todayStr);
  const moves: OverdueMove[] = [];
  let recurringKept = 0;
  let syncedKept = 0;

  for (const page of pages) {
    const start = page.scheduledStart;
    if (!start) continue;
    if (page.isRecurring) {
      recurringKept++;
      continue;
    }
    if (page.scheduleLocked) {
      syncedKept++;
      continue;
    }
    const shift = differenceInCalendarDays(today, parseLocalISO(dateKey(start)));
    if (shift <= 0) continue;
    moves.push({
      end: page.scheduledEnd ? shiftByDays(page.scheduledEnd, shift) : undefined,
      pageId: page.id,
      previousEnd: page.scheduledEnd ?? undefined,
      previousStart: start,
      start: shiftByDays(start, shift),
    });
  }

  return { moves, recurringKept, syncedKept };
}

/** Toast copy. Once something stayed behind the destination is dropped, so the sentence fits the
 * toast's one line ("Moved 4 · 2 recurring left"). */
export function moveOverdueToTodayLabel(plan: OverdueMovePlan): string {
  const kept: string[] = [];
  if (plan.recurringKept > 0) kept.push(`${plan.recurringKept} recurring`);
  if (plan.syncedKept > 0) kept.push(`${plan.syncedKept} synced`);
  if (plan.moves.length === 0) {
    return kept.length === 0 ? "Nothing to move" : `Nothing to move · ${kept.join(", ")} left`;
  }
  if (kept.length === 0) return `Moved ${plan.moves.length} to today`;
  return `Moved ${plan.moves.length} · ${kept.join(", ")} left`;
}
