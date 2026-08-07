import type { SortMode } from "@/features/pages";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";

/**
 * The sort order the active view actually renders with, defaults resolved.
 *
 * Today is always date-ordered — it has no manual order to fall back to. An
 * external calendar folder defaults to date because every page in one carries a
 * schedule (a calendar has nothing else) and its manual order is meaningless:
 * placement is sync-owned, so the user can't drag rows into a considered order
 * and new events arrive in whatever sequence the provider returns them.
 *
 * A stored choice always wins, so either default is only a starting point.
 */
export function useActiveSortMode(): SortMode {
  const { folders } = usePages();
  const { activeViewId, getSortMode } = useUI();

  if (activeViewId === "today") return "date";
  const folder = folders.find((f) => f.id === activeViewId);
  return getSortMode(activeViewId, folder?.isExternalCalendar ? "date" : "manual");
}
