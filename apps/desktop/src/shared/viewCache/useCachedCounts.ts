import type { ViewCounts } from "@pikos/core";
import { localToday } from "@pikos/core";
import { useEffect, useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_COUNTS = () => null;
const NONE: ViewCounts = { folders: {}, inbox: 0, today: 0, upcoming: 0 };

/** The badge counts for today when the view cache serves them, else null. Until the first count
 *  lands they read as zero rather than falling back to counting the in-memory list. Both reads are
 *  values that keep their identity, so a change elsewhere in the store re-renders nothing here. */
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
