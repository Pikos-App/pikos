import type { PageSummary } from "@pikos/core";

import { useUI } from "@/shared/context/UIContext";

import { usePageSummary } from "./usePageSummary";

export function useActivePage(): PageSummary | null {
  const { activePageId } = useUI();
  return usePageSummary(activePageId);
}
