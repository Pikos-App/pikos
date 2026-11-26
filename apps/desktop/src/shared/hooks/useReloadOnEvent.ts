// The shared listener behind the external-change watcher and the background-sync applied signal.

import { useEffect, useRef } from "react";

import { useViewCacheController, useWorkspace } from "@/shared/context/WorkspaceContext";
import { listenAppEvent } from "@/shared/lib/appEvents";
import { createLogger } from "@/shared/logger";

interface ReloadOnEventOptions {
  event: string;
  logScope: string;
  logMessage: string;
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

  // Read the latest reload through a ref so the listener isn't resubscribed on every render.
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
