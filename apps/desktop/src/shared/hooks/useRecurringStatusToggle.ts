import type { PageStatus, PageSummary } from "@pikos/core";
import { nowLocalISO } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";
import { useRecurringCompleteDialog } from "@/shared/context/RecurringCompleteDialogContext";

/**
 * The shared recurring-aware status toggle. Centralised so a change to how a
 * completion is dispatched can't half-land across call sites — the divergence
 * that produced the synced-completion mis-route.
 */
export function useRecurringStatusToggle(): (page: PageSummary, nextStatus: PageStatus) => void {
  const { maybeToggleRecurringOccurrence, recurrenceRules, uncompleteRecurringOrFlip, updatePage } =
    usePages();
  const { request: requestRecurringComplete } = useRecurringCompleteDialog();

  return (page, nextStatus) => {
    if (maybeToggleRecurringOccurrence(page, nextStatus)) return;
    if (recurrenceRules.some((r) => r.pageId === page.id)) {
      if (nextStatus === "done") requestRecurringComplete(page.id);
      else void uncompleteRecurringOrFlip(page.id);
      return;
    }
    updatePage(page.id, {
      completedAt: nextStatus === "done" ? nowLocalISO() : null,
      status: nextStatus,
    });
  };
}
