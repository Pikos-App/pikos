import type { PageSummary } from "@pikos/core";
import { useEffect, useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

import type { ViewCacheController } from "./controller";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_VERSION = () => 0;

/**
 * The calendar's pages from the view cache: every page touching the days from `start` to `end`
 * (instants), any status, plus every recurring series' head so occurrences expand whatever day
 * the head sits on. Null when the flag is off. Ranges stay held while the calendar is mounted, so
 * going back a week shows at once and refetches only after a write.
 */
export function useCachedRange(start: string | null, end: string | null): PageSummary[] | null {
  const controller = useViewCacheController();
  const version = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller?.getVersion ?? NO_VERSION
  );

  useEffect(() => {
    if (controller && start && end) controller.showRange(start, end);
  }, [controller, start, end]);

  useEffect(() => {
    if (!controller) return;
    return () => controller.hideRanges();
  }, [controller]);

  if (!controller || !start || !end) return null;
  return readRange(controller, start, end, version);
}

/** `version` is an argument so the compiler can't memoize the read; see `readView`. */
function readRange(
  controller: ViewCacheController,
  start: string,
  end: string,
  _version: number
): PageSummary[] {
  return controller.rangePages(start, end);
}
