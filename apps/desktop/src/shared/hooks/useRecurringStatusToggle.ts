import type { PageStatus, PageSummary } from "@pikos/core";
import { nowLocalISO } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";
import { useRecurringGapDialog } from "@/shared/context/RecurringGapDialogContext";

/**
 * The shared recurring-aware status toggle. Centralised so a change to how a
 * completion is dispatched can't half-land across call sites — the divergence
 * that produced the synced-completion mis-route.
 */
export function useRecurringStatusToggle(): (page: PageSummary, nextStatus: PageStatus) => void {
  const { maybeUncompleteRecurringClone, recurrenceRules, uncompleteRecurringOrFlip, updatePage } =
    usePages();
  const { requestComplete } = useRecurringGapDialog();

  return (page, nextStatus) => {
    if (maybeUncompleteRecurringClone(page, nextStatus)) return;
    if (recurrenceRules.some((r) => r.pageId === page.id)) {
      if (nextStatus === "done") requestComplete(page);
      else void uncompleteRecurringOrFlip(page.id);
      return;
    }
    updatePage(page.id, {
      completedAt: nextStatus === "done" ? nowLocalISO() : null,
      status: nextStatus,
    });
  };
}
