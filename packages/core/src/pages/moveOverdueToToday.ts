// Pure planning for the Today view's "Move to today" bulk action on the Overdue
// section. Deciding WHAT moves and WHERE it lands is date math with no I/O in
// it, so it lives here and is tested here; the caller only runs the resulting
// list through the ordinary one-off schedule write.
//
// Two kinds of overdue page are deliberately left where they are:
//
//   * recurring occurrences — an overdue occurrence means the series has a gap,
//     and closing that gap is the recurring-gap dialog's job (skip vs complete
//     the backlog). Silently dragging the anchor forward would erase the gap
//     rather than resolve it.
//   * synced mirrors (`scheduleLocked`) — the reconciler owns their schedule;
//     the backend rejects the write and the row snaps back.
//
// Everything else keeps its wall-clock shape: the whole schedule is shifted by a
// whole number of days, so a 9:00–10:00 from last week is 9:00–10:00 today, and
// an all-day page stays all-day (a two-day all-day span stays two days).

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
  /** Left in place — see the module note. */
  recurringKept: number;
  syncedKept: number;
}

/** Shifts an ISO schedule string by whole days, preserving its all-day/timed
 *  shape. `addDays` (not a ms offset) so the wall-clock time survives DST. */
function shiftByDays(iso: string, days: number): string {
  const shifted = addDays(parseLocalISO(iso), days);
  return isAllDayIso(iso) ? formatDateOnly(shifted) : formatLocalISO(shifted);
}

/**
 * Plans the move for the pages currently in the Overdue section.
 *
 * A page already dated today — a timed 9:00 read at 14:00 is overdue but not
 * from an earlier day — is neither moved nor counted as kept: there is nowhere
 * for it to go, and reporting it as "left" would read as a refusal.
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

/**
 * Toast copy. The clean case names the destination ("Moved 4 to today"); once
 * something stayed behind, the destination is dropped so the sentence still
 * fits the toast's one line ("Moved 4 · 2 recurring left").
 */
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
