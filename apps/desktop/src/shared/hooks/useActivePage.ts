import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import type { Page } from "@pikos/core";

/**
 * Derives the active Page from activePageId in UIContext.
 * Always reflects the latest page data from WorkspaceContext —
 * never stale even after debounced saves.
 */
export function useActivePage(): Page | null {
  const { activePageId } = useUI();
  const { pages } = useWorkspace();
  if (activePageId === null) return null;
  return pages.find((p) => p.id === activePageId) ?? null;
}
