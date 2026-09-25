import { DeletePageShortcut, PageListProvider } from "@/features/pages";
import { TrashPanel } from "@/features/trash";
import { PaneErrorFallback } from "@/shared/components/PaneErrorFallback";
import { useUI } from "@/shared/context/UIContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";

import { PageListPanel } from "./PageListPanel";

/**
 * The middle column. Every view but the trash lists live pages, so the trash
 * gets its own panel rather than a branch inside the page list: its rows are
 * deleted pages with their own actions, and none of what the page list is —
 * selection, drag-to-reorder, virtualization, the status toggle — applies to
 * them.
 *
 * The column's contents are resolved here, above that branch, so anything that
 * outlives one view — the delete shortcuts, which act on the active page — keeps
 * working when the trash takes the column.
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
