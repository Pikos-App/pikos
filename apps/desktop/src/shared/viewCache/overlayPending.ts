import type { ListSlot, PageSummary } from "@pikos/core";
import { belongsToView, isOpen, localToday } from "@pikos/core";

import type { CachedView } from "./useCachedView";

/**
 * The cached list with each loaded row replaced by the in-memory list's copy, which carries edits
 * not yet saved, and without rows those edits took out of the view. Until edits are kept beside
 * the cached rows, this is what shows an edit before the save and refresh after it.
 */
export function overlayPending(
  cached: CachedView,
  pages: PageSummary[],
  viewId: string
): CachedView {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const today = localToday();
  const stays = (p: PageSummary) => isOpen(p) && belongsToView(p, viewId, today);
  const current = (p: PageSummary) => byId.get(p.id) ?? p;
  const slots = cached.slots.flatMap((slot): ListSlot[] => {
    if ("placeholder" in slot) return [slot];
    const page = current(slot);
    return stays(page) ? [page] : [];
  });
  return { ...cached, pages: cached.pages.map(current).filter(stays), slots };
}
