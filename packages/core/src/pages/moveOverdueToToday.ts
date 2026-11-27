// Plans the Overdue section's "Move to today". Two kinds of overdue page stay put:
//
//   * recurring occurrences: an overdue one means the series has a gap, which the
//     recurring-gap dialog closes (skip vs complete). Dragging the anchor forward would
//     erase the gap instead.
//   * synced mirrors (`scheduleLocked`): the reconciler owns their schedule, and the
//     backend rejects the write.
//
// Everything else shifts by whole days, so it keeps its wall-clock shape: a 9:00-10:00 from
// last week is 9:00-10:00 today, and an all-day span keeps its length.

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
  /** What it was, for undo. */
  previousStart: string;
  previousEnd: string | undefined;
}

export interface OverdueMovePlan {
  moves: OverdueMove[];
  /** Left in place, per the module note. */
  recurringKept: number;
  syncedKept: number;
}

/** Shifts an ISO schedule string by whole days. `addDays`, not a ms offset, so the wall-clock time survives DST. */
function shiftByDays(iso: string, days: number): string {
  const shifted = addDays(parseLocalISO(iso), days);
  return isAllDayIso(iso) ? formatDateOnly(shifted) : formatLocalISO(shifted);
}

/**
 * Plans the move for the pages in the Overdue section. A page already dated today is neither
 * moved nor counted as kept: reporting it as "left" would read as a refusal.
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

function countPages(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

/** Toast copy: what moved, then what stayed and why ("Moved 4 pages to today. Left 2 repeating pages to catch up"). */
export function moveOverdueToTodayLabel(plan: OverdueMovePlan): string {
  const moved =
    plan.moves.length === 0 ? "Nothing to move" : `Moved ${countPages(plan.moves.length)} to today`;
  const kept: string[] = [];
  if (plan.recurringKept > 0) {
    kept.push(
      `${plan.recurringKept} repeating ${plan.recurringKept === 1 ? "page" : "pages"} to catch up`
    );
  }
  if (plan.syncedKept > 0) kept.push(`${countPages(plan.syncedKept)} set by a synced calendar`);

  if (kept.length === 0) return moved;

  return `${moved}. Left ${kept.join(" and ")}`;
}
