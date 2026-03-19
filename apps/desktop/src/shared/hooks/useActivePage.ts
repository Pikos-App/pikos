import type { PageSummary } from "@pikos/core";

import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

/**
 * Derives the active page summary from activePageId in UIContext.
 * Always reflects the latest page data from WorkspaceContext —
 * never stale even after debounced saves.
 */
export function useActivePage(): PageSummary | null {
  const { activePageId } = useUI();
  const { pages } = useWorkspace();
  if (activePageId === null) return null;
  return pages.find((p) => p.id === activePageId) ?? null;
}
