import type { SortMode } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";

/** The sort a view renders with, defaults resolved. A calendar folder defaults
 *  to date because its manual order is sync-owned and so means nothing; Today
 *  has no manual order at all. A stored choice still wins over either. */
export function useActiveSortMode(): SortMode {
  const { folders } = usePages();
  const { activeViewId, getSortMode } = useUI();

  if (activeViewId === "today") return "date";
  const folder = folders.find((f) => f.id === activeViewId);
  return getSortMode(activeViewId, folder?.isExternalCalendar ? "date" : "manual");
}
