// Reloads the workspace when a Tauri event fires — the shared listener behind both
// the external-change watcher and the background-sync applied signal. Parameterized
// by event name, log scope/message, and an optional suppression predicate.

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

interface ReloadOnEventOptions {
  event: string;
  logScope: string;
  logMessage: string;
  /** When it returns true, skip the reload (e.g. our own write echo). */
  suppressed?: () => boolean;
}

export function useReloadOnEvent({
  event,
  logMessage,
  logScope,
  suppressed,
}: ReloadOnEventOptions): void {
  const { reload } = useWorkspace();

  // Keep the listener subscribed for the app's lifetime; read the latest reload
  // through a ref so we don't resubscribe on every render.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const log = createLogger(logScope);

    listen(event, () => {
      if (suppressed?.()) return;
      log.info(logMessage);
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
