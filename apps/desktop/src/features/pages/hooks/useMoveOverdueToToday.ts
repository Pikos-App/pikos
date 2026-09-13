// "Move to today" on the Today view's Overdue section header.
//
// Nothing here decides dates — core's `planMoveOverdueToToday` owns the shift
// and the exclusions. This hook is the write half: it runs the plan through the
// same `scheduleOnce` every drag and date-picker edit goes through, so the
// optimistic apply / rollback and the recurring-anchor resolution behave exactly
// as they do for a single reschedule. Writes are awaited one at a time rather
// than fired concurrently: `scheduleOnce` queues per page, but each one also
// reads the page's schedule rows back, and a burst of concurrent readers is the
// same WAL contention the bulk status toggle had to serialise away.
//
// Undo composes with the existing toast: the plan carries each page's previous
// start/end, so undo is the same loop with those values, under one toast id.
// There is no confirmation step — a move is reversible, cheap, and visible.

import type { PageSummary } from "@pikos/core";
import { moveOverdueToTodayLabel, planMoveOverdueToToday } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("moveOverdueToToday");

export function useMoveOverdueToToday() {
  const { scheduleOnce } = usePages();
  const { requestUndoableAction, showNotice } = useUndoDelete();

  async function apply(
    entries: { pageId: string; start: string; end: string | undefined }[]
  ): Promise<void> {
    for (const entry of entries) {
      try {
        await scheduleOnce(entry.pageId, entry.start, entry.end);
      } catch (err) {
        // scheduleOnce already rolled this page back and surfaced the error
        // state; keep going so one locked row can't strand the rest.
        log.error(`scheduleOnce(${entry.pageId}) failed during bulk move`, err);
      }
    }
  }

  /** Reschedules the movable pages of the Overdue section onto today. */
  function moveOverdueToToday(overduePages: PageSummary[]): void {
    const plan = planMoveOverdueToToday(overduePages);
    const label = moveOverdueToTodayLabel(plan);

    if (plan.moves.length === 0) {
      showNotice(label);
      return;
    }

    void apply(plan.moves);
    // Random id, not a page id: the toast is about the batch, and a second move
    // must never be deduplicated against the first one's still-pending entry.
    requestUndoableAction(
      `move-overdue:${crypto.randomUUID()}`,
      label,
      () =>
        void apply(
          plan.moves.map((m) => ({ end: m.previousEnd, pageId: m.pageId, start: m.previousStart }))
        )
    );
  }

  return { moveOverdueToToday };
}
