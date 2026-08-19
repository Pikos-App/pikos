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
 */
export function MiddlePanel({
  onResizeStart,
  width,
}: {
  onResizeStart: (e: React.MouseEvent) => void;
  width: number;
}) {
  const { activeViewId } = useUI();
  if (activeViewId === "trash") {
    return (
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <PaneErrorFallback error={error} label="Trash" onReset={reset} />
        )}
      >
        <TrashPanel onResizeStart={onResizeStart} width={width} />
      </ErrorBoundary>
    );
  }
  return <PageListPanel onResizeStart={onResizeStart} width={width} />;
}
