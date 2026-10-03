// Reloads the workspace when an app event fires — the shared listener behind both
// the external-change watcher and the background-sync applied signal. Parameterized
// by event name, log scope/message, and an optional suppression predicate.

import { useEffect, useRef } from "react";

import { useViewCacheController, useWorkspace } from "@/shared/context/WorkspaceContext";
import { listenAppEvent } from "@/shared/lib/appEvents";
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
  const viewCache = useViewCacheController();

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

    listenAppEvent(event, () => {
      // The cache asks the change counter whose change it was, so it needs no echo window.
      viewCache?.doorbell();
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
