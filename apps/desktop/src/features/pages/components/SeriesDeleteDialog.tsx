import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useRecurringGapDialog } from "@/shared/context/RecurringGapDialogContext";

import { usePageListContext } from "../PageListContext";

/** Asks a series' Delete "this date or all of them", for the row menu and the shortcuts alike. */
export function SeriesDeleteDialog() {
  const { deletingSeries, dismissSeriesDelete, handleDeleteRequest } = usePageListContext();
  const { skipDate } = useRecurringGapDialog();

  return (
    <ConfirmDialog
      alternative={{
        label: "Skip This Date",
        onSelect: () => {
          dismissSeriesDelete();
          if (deletingSeries) skipDate(deletingSeries);
        },
      }}
      confirmLabel="Delete All Dates"
      description="It repeats. Skip just this date, or delete it and every date it has left."
      onConfirm={() => {
        dismissSeriesDelete();
        if (deletingSeries) handleDeleteRequest(deletingSeries);
      }}
      onOpenChange={(open) => {
        if (!open) dismissSeriesDelete();
      }}
      open={deletingSeries !== null}
      title={`Delete “${deletingSeries?.title || "Untitled"}”?`}
      variant="destructive"
    />
  );
}
