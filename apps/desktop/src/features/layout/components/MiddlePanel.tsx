import {
  DeletePageShortcut,
  ExportPageShortcut,
  PageListProvider,
  SeriesDeleteDialog,
} from "@/features/pages";
import { TrashPanel } from "@/features/trash";
import { PaneErrorFallback } from "@/shared/components/PaneErrorFallback";
import { useUI } from "@/shared/context/UIContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";

import { PageListPanel } from "./PageListPanel";

/**
 * The middle column. The trash gets its own panel rather than a branch in the page list: its rows
 * are deleted pages with their own actions, and selection, drag-to-reorder, virtualization and
 * the status toggle don't apply.
 *
 * Contents are resolved above that branch, so anything that outlives one view (the delete and
 * export shortcuts, a series' delete question) keeps working when the trash takes the column.
 */
export function MiddlePanel({
  onResizeStart,
  width,
}: {
  onResizeStart: (e: React.MouseEvent) => void;
  width: number;
}) {
  const { activeViewId } = useUI();
  return (
    <PageListProvider>
      <DeletePageShortcut />
      <ExportPageShortcut />
      <SeriesDeleteDialog />
      {activeViewId === "trash" ? (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <PaneErrorFallback error={error} label="Trash" onReset={reset} />
          )}
        >
          <TrashPanel onResizeStart={onResizeStart} width={width} />
        </ErrorBoundary>
      ) : (
        <PageListPanel onResizeStart={onResizeStart} width={width} />
      )}
    </PageListProvider>
  );
}
