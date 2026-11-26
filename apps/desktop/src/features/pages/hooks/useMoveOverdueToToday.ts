// "Move to today" on the Today view's Overdue header. core's `planMoveOverdueToToday` owns the
// shift and exclusions; this is the write half, run through the same `scheduleOnce` as every drag and
// date-picker edit so rollback and recurring-anchor resolution match. Writes are awaited one at a
// time: each also reads the page's schedule rows back, and concurrent readers are the WAL contention
// the bulk status toggle had to serialise away.
//
// Undo is the same loop with the plan's previous start/end, under one toast id. There is no
// confirmation: a move is reversible, cheap and visible.

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
