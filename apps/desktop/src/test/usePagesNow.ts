import type { PageSummary } from "@pikos/core";

import { type PagesContextValue, usePages } from "@/shared/context/PagesContext";
import { useViewCacheController } from "@/shared/context/WorkspaceContext";

/**
 * `usePages()` with `pages` read from the view cache's store at the moment a test asks, not as of
 * the last render: a write reaches the store at once and its readers a microtask later. A test
 * asserting what a write did to the data reads this; one asserting what rendered reads
 * `useHeldPages()` inside the render.
 */
export function usePagesNow(): PagesContextValue & { readonly pages: PageSummary[] } {
  const controller = useViewCacheController();
  const value = usePages();
  return {
    ...value,
    get pages() {
      return controller?.heldPages() ?? [];
    },
  };
}
