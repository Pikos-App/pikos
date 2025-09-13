import { writable } from "svelte/store";
import type { Page } from "./fileSystemStore";

const MAX_RECENT_PAGES = 5;

function createRecentPagesStore() {
  const { subscribe, update } = writable<Page[]>([]);

  return {
    subscribe,
    addPage: (page: Page) => {
      update((pages) => {
        // Remove if already exists to avoid duplicates
        const filtered = pages.filter((p) => p.path !== page.path);
        // Add to the beginning of the array
        const updated = [page, ...filtered];
        // Keep only the most recent 5
        return updated.slice(0, MAX_RECENT_PAGES);
      });
    },
    clear: () => update(() => []),
  };
}

export const recentPages = createRecentPagesStore();
