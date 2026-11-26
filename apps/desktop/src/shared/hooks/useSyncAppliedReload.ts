// "calendar-sync:applied" fires only on real changes and the DB watcher is suppressed around sync
// writes, so this is the sole reload path for background syncs. It is never an echo of a
// frontend write, so there is no suppression predicate.

import { useReloadOnEvent } from "@/shared/hooks/useReloadOnEvent";

export function useSyncAppliedReload(): void {
  useReloadOnEvent({
    event: "calendar-sync:applied",
    logMessage: "background sync changed data — reloading",
    logScope: "calendar-sync",
  });
}
