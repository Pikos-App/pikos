import type { ViewCounts } from "@pikos/core";
import { useEffect, useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

import type { ViewCacheController } from "./controller";
import { todayAt } from "./useCachedView";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_VERSION = () => 0;

/** The badge counts for today when the view cache serves them, else null. Until the first count
 *  lands they read as zero rather than falling back to counting the in-memory list. */
export function useCachedCounts(): ViewCounts | null {
  const controller = useViewCacheController();
  const version = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller?.getVersion ?? NO_VERSION
  );
  const today = todayAt(version);
  useEffect(() => {
    controller?.watchCounts(today);
  }, [controller, today]);
  return controller ? readCounts(controller, version) : null;
}

const NONE: ViewCounts = { folders: {}, inbox: 0, today: 0, upcoming: 0 };

/** `version` is an argument so the compiler can't memoize the read; see `readView`. */
function readCounts(controller: ViewCacheController, _version: number): ViewCounts {
  return controller.counts?.counts ?? NONE;
}
