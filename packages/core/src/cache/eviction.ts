// Keeping what was visited and letting go of what wasn't. What must stay is passed in, worked out
// from what's live at the moment of eviction (the view on screen, the open page, the selection,
// a drag, open dialogs, undo toasts, search results, the series of every loaded clone) rather than
// counted up and down as things open and close, so nothing can be held by a count that drifted.

import type { PageStore } from "./pageStore";
import type { ViewCache } from "./viewCache";
import { viewName } from "./viewCache";

export interface Pinned {
  /** Views that stay, by `viewName`. */
  views: Set<string>;
  /** Pages that stay whatever view they're in. */
  pages: Set<string>;
}

export interface Evicted {
  views: string[];
  pages: string[];
}

/**
 * Drop the least recently shown views until the store and cache fit `budgetBytes`, then the pages
 * no remaining view or pin holds. Pages with a write in flight or a recorded error always stay;
 * the store refuses to forget them.
 */
export function evict(
  cache: ViewCache,
  store: PageStore,
  budgetBytes: number,
  pinned: Pinned
): Evicted {
  const evicted: Evicted = { pages: [], views: [] };
  const size = () => cache.estimateBytes() + store.estimateBytes();
  if (size() <= budgetBytes) return evicted;

  const candidates = cache
    .entries()
    .filter((e) => !pinned.views.has(viewName(e.key)))
    .sort((a, b) => a.lastShown - b.lastShown);
  for (const entry of candidates) {
    if (size() <= budgetBytes) break;
    const name = viewName(entry.key);
    cache.remove(name);
    evicted.views.push(name);
    evicted.pages.push(...store.forget(unheld(cache, store, pinned)));
  }
  return evicted;
}

/** Pages in the store that no view lists and nothing pins. */
function unheld(cache: ViewCache, store: PageStore, pinned: Pinned): string[] {
  const held = new Set(pinned.pages);
  for (const entry of cache.entries()) for (const id of entry.ids) held.add(id);
  return store.ids().filter((id) => !held.has(id));
}
