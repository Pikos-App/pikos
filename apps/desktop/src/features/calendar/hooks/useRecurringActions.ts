import type { PageSummary, VirtualOccurrence } from "@pikos/core";
import { isDone } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useRecurringStatusToggle } from "@/shared/hooks/useRecurringStatusToggle";

interface UseRecurringActionsResult {
  /** True when the page is a virtual rrule occurrence (not a real DB page). */
  isRecurring: boolean;
  /** Toggle status — routes through recurring completion for recurring pages. */
  toggleStatus: () => void;
  /** Skip a virtual occurrence (add to exdates) with undo toast. No-op for non-virtual pages. */
  skipOccurrence: () => Promise<void>;
}

export function useRecurringActions(page: PageSummary): UseRecurringActionsResult {
  const { skipOccurrence: skipOccurrenceFn } = usePages();
  const togglePageStatus = useRecurringStatusToggle();
  const { requestUndoableAction } = useUndoDelete();

  const isRecurring = "isVirtual" in page && (page as { isVirtual?: boolean }).isVirtual === true;
  const done = isDone(page);

  function toggleStatus() {
    togglePageStatus(page, done ? "not_started" : "done");
  }

  async function handleSkipOccurrence() {
    if (!isRecurring) return;
    const virtual = page as VirtualOccurrence;
    const undoFn = await skipOccurrenceFn(virtual.id, virtual.originalDate);
    const undoId = `skip:${virtual.id}:${virtual.originalDate}`;
    requestUndoableAction(undoId, `Skipped ${page.title || "occurrence"}`, undoFn);
  }

  return {
    isRecurring,
    skipOccurrence: handleSkipOccurrence,
    toggleStatus,
  };
}
