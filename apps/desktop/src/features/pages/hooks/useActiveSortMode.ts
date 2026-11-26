import type { SortMode } from "@pikos/core";
import { isDateGroupedView } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";

/** The sort a view renders with. A calendar folder defaults to date because its manual order is
 *  sync-owned; Today and Upcoming have no manual order and render as date sections. A stored
 *  choice wins. */
export function useActiveSortMode(): SortMode {
  const { folders } = usePages();
  const { activeViewId, getSortMode } = useUI();

  if (isDateGroupedView(activeViewId)) return "date";
  const folder = folders.find((f) => f.id === activeViewId);
  return getSortMode(activeViewId, folder?.isExternalCalendar ? "date" : "manual");
}
