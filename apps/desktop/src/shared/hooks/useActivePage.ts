import type { PageSummary } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";

export function useActivePage(): PageSummary | null {
  const { activePageId } = useUI();
  const { pages } = usePages();
  if (activePageId === null) return null;
  return pages.find((p) => p.id === activePageId) ?? null;
}
