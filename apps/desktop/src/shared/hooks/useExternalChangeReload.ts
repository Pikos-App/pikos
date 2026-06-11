// Reloads the workspace when another process (the CLI, or a second app
// instance) writes to the DB. The Rust watcher emits "workspace:external-change";
// we ignore the echo of our own writes via the suppression window, then call
// WorkspaceContext.reload() to refetch. Mount once at the app shell.

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { externalChangeSuppressed } from "@/shared/lib/externalChange";
import { createLogger } from "@/shared/logger";

const EXTERNAL_CHANGE_EVENT = "workspace:external-change";

const log = createLogger("external-change");

export function useExternalChangeReload(): void {
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

    listen(EXTERNAL_CHANGE_EVENT, () => {
      if (externalChangeSuppressed()) return;
      log.info("external workspace change detected — reloading");
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
