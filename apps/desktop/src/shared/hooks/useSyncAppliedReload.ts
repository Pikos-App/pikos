// Reloads the workspace after a background calendar-sync pass that changed page
// data. The Rust sync driver emits "calendar-sync:applied" only on real changes,
// and the DB watcher is suppressed around sync writes, so this event is the sole
// reload path for background syncs — authoritative, never an echo of a frontend
// write, so no suppression predicate. Mount once at the app shell.

import { useReloadOnEvent } from "@/shared/hooks/useReloadOnEvent";

export function useSyncAppliedReload(): void {
  useReloadOnEvent({
    event: "calendar-sync:applied",
    logMessage: "background sync changed data — reloading",
    logScope: "calendar-sync",
  });
}
