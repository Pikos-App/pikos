import type { ViewCounts } from "@pikos/core";
import { localToday } from "@pikos/core";
import { useEffect, useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_COUNTS = () => null;
const NONE: ViewCounts = { folders: {}, inbox: 0, today: 0, upcoming: 0 };

/** Null when the view cache doesn't serve them. Until the first count lands they read as zero rather
 *  than falling back to counting the in-memory list. */
export function useCachedCounts(): ViewCounts | null {
  const controller = useViewCacheController();
  const subscribe = controller?.subscribe ?? NO_SUBSCRIPTION;
  const today = useSyncExternalStore(subscribe, localToday);
  const counts = useSyncExternalStore(
    subscribe,
    controller ? () => controller.counts?.counts ?? NONE : NO_COUNTS
  );
  useEffect(() => {
    controller?.watchCounts(today);
  }, [controller, today]);
  return counts;
}
