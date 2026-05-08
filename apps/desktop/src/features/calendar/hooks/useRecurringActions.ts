// useRecurringActions — shared logic for recurring page interactions on calendar blocks.
// Used by both PageBlock (timed) and AllDayChip (all-day) to avoid duplicating
// recurring detection, completion, and skip-occurrence logic.

import type { PageStatus, PageSummary, VirtualOccurrence } from "@pikos/core";
import { nowLocalISO } from "@pikos/core";

import { useRecurringCompleteDialog } from "@/shared/context/RecurringCompleteDialogContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

interface UseRecurringActionsResult {
  /** True when the page is a virtual rrule occurrence (not a real DB page). */
  isRecurring: boolean;
  /** Toggle status — routes through recurring completion for recurring pages. */
  toggleStatus: () => void;
  /** Skip a virtual occurrence (add to exdates) with undo toast. No-op for non-virtual pages. */
  skipOccurrence: () => Promise<void>;
}

export function useRecurringActions(page: PageSummary): UseRecurringActionsResult {
  const { recurrenceRules, skipOccurrence: skipOccurrenceFn, updatePage } = useWorkspace();
  const { request: requestRecurringComplete } = useRecurringCompleteDialog();
  const { requestUndoableAction } = useUndoDelete();

  const isRecurring = "isVirtual" in page && (page as { isVirtual?: boolean }).isVirtual === true;
  const isDone = page.status === "done";

  function toggleStatus() {
    const newStatus: PageStatus = isDone ? "not_started" : "done";
    if (newStatus === "done" && recurrenceRules.some((r) => r.pageId === page.id)) {
      // Routes through the gap-resolution dialog. If today > head's
      // scheduledStart there are missed days that need a policy decision;
      // otherwise the request resolves immediately to advance.
      requestRecurringComplete(page.id);
      return;
    }
    updatePage(page.id, {
      completedAt: newStatus === "done" ? nowLocalISO() : null,
      status: newStatus,
    });
  }

  async function handleSkipOccurrence() {
    if (!isRecurring) return;
    const virtual = page as VirtualOccurrence;
    const undoFn = await skipOccurrenceFn(virtual.ruleId, virtual.originalDate);
    const undoId = `skip:${virtual.ruleId}:${virtual.originalDate}`;
    requestUndoableAction(undoId, `Skipped ${page.title || "occurrence"}`, undoFn);
  }

  return {
    isRecurring,
    skipOccurrence: handleSkipOccurrence,
    toggleStatus,
  };
}
