// Reloads the workspace when a background calendar-sync pass changed page
// data. The Rust sync driver emits "calendar-sync:applied" only when a pass
// actually applied changes (the DB watcher is suppressed around sync writes,
// so this event is the sole reload path for background syncs). Unlike the
// external-change path there's no suppression window — the event is
// authoritative, never an echo of a frontend write. Mount once at the app
// shell.

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

const SYNC_APPLIED_EVENT = "calendar-sync:applied";

const log = createLogger("calendar-sync");

export function useSyncAppliedReload(): void {
  const { reload } = useWorkspace();

  // Keep the listener subscribed for the app's lifetime; read the latest
  // reload through a ref so we don't resubscribe on every render.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listen(SYNC_APPLIED_EVENT, () => {
      log.info("background sync changed data — reloading");
      void reloadRef.current();
    })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        /* listener failed to attach; non-fatal */
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
