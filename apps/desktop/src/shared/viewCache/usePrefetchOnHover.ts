import type { PointerEvent } from "react";
import { useRef } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

/**
 * How long the pointer rests on a page before its body is read. Sweeping across a list spends 20 to
 * 60 ms a row, and a click lands 200 to 300 ms after the pointer arrives.
 */
export const PREFETCH_DWELL_MS = 100;

/** Pointer handlers that read `pageId`'s body once the pointer rests on it, unless a button is held
 *  (a drag). Leaving before the read starts cancels it. Empty while the view cache is off. */
export function usePrefetchOnHover(pageId: string) {
  const controller = useViewCacheController();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!controller) return {};

  function stop() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }

  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.buttons !== 0) return;
      stop();
      timer.current = setTimeout(() => {
        timer.current = null;
        controller.prefetch(pageId);
      }, PREFETCH_DWELL_MS);
    },
    onPointerLeave: () => {
      stop();
      controller.cancelPrefetch(pageId);
    },
  };
}
