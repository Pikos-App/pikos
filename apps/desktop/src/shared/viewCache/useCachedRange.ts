import type { PageSummary } from "@pikos/core";
import { useEffect, useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

import type { Range } from "./controller";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_PAGES: PageSummary[] = [];
const NOTHING_HELD = () => NO_PAGES;
const NOT_LOADING = () => false;

/**
 * The calendar's pages from the view cache: every page touching the days from `start` to `end`
 * (instants), any status, plus every recurring series' head so occurrences expand whatever day
 * the head sits on, and whether the range is still loading for the first time. Null when the flag
 * is off. Ranges stay held while the calendar is mounted, so going back a week shows at once and
 * refetches only after a write; `neighbours` are loaded behind it, so a step forward does too.
 */
export function useCachedRange(
  start: string | null,
  end: string | null,
  neighbours: readonly Range[] = []
): { loading: boolean; pages: PageSummary[] } | null {
  const controller = useViewCacheController();
  const ready = controller && start && end ? controller : null;
  const subscribe = ready?.subscribe ?? NO_SUBSCRIPTION;
  const pages = useSyncExternalStore(
    subscribe,
    ready && start && end ? () => ready.rangePages(start, end) : NOTHING_HELD
  );
  const loading = useSyncExternalStore(
    subscribe,
    ready && start && end ? () => !ready.rangeLoaded(start, end) : NOT_LOADING
  );
  const neighbourKey = neighbours.map(([s, e]) => `${s}|${e}`).join(",");

  useEffect(() => {
    if (controller && start && end) controller.showRange(start, end, neighbours);
  }, [controller, start, end, neighbourKey]);

  useEffect(() => {
    if (!controller) return;
    return () => controller.hideRanges();
  }, [controller]);

  if (!ready) return null;
  return { loading, pages };
}
