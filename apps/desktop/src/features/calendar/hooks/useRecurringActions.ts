import type { PageSummary } from "@pikos/core";
import { isDone } from "@pikos/core";

import { useRecurringGapDialog } from "@/shared/context/RecurringGapDialogContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useRecurringStatusToggle } from "@/shared/hooks/useRecurringStatusToggle";

interface UseRecurringActionsResult {
  isVirtual: boolean;
  /**
   * Whether the block offers a checkbox. A synced-origin occurrence is ticked where it renders;
   * a native virtual shows the repeat glyph and funnels to its head, the next thing due.
   */
  showsCheckbox: boolean;
  toggleStatus: () => void;
  /**
   * The block's delete gesture. A rendered occurrence — a virtual, or a moved
   * synced instance, which is shaped from its series page and would otherwise
   * trash the whole series — dismisses that one date. Anything else is a real
   * page and goes to the page trash.
   */
  deleteBlock: () => void;
}

export function useRecurringActions(page: PageSummary): UseRecurringActionsResult {
  const togglePageStatus = useRecurringStatusToggle();
  const { requestDelete } = useRecurringGapDialog();
  const { requestDeletePage } = useUndoDelete();

  const isVirtual = "isVirtual" in page && (page as { isVirtual?: boolean }).isVirtual === true;
  const isOccurrence = isVirtual || "originalDate" in page;
  const done = isDone(page);

  function toggleStatus() {
    togglePageStatus(page, done ? "not_started" : "done");
  }

  function deleteBlock() {
    if (isOccurrence) requestDelete(page);
    else requestDeletePage(page);
  }

  return {
    deleteBlock,
    isVirtual,
    showsCheckbox: !isVirtual || !!page.syncState,
    toggleStatus,
  };
}
