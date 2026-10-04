import type { PageSummary } from "@pikos/core";
import { useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

import type { ViewCacheController } from "./controller";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_VERSION = () => 0;

/** `version` is an argument so the compiler can't memoize the read; see `readView`. */
function held(controller: ViewCacheController, _version: number): PageSummary[] {
  return controller.heldPages();
}

/**
 * The pages the view cache holds, unsaved edits included, re-rendering with every change to them;
 * null outside a workspace. Only a reader that needs them live subscribes, so a change to the
 * store doesn't re-render every reader of `usePages()`. `enabled` false skips the subscription, for
 * a reader that needs them only while open.
 */
export function useHeldPages(enabled = true): PageSummary[] | null {
  const controller = useViewCacheController();
  const live = controller && enabled ? controller : null;
  const version = useSyncExternalStore(
    live?.subscribe ?? NO_SUBSCRIPTION,
    live?.getVersion ?? NO_VERSION
  );
  return live ? held(live, version) : null;
}

/** Finds one held page when an action needs it, without subscribing. */
export function usePageLookup(): (id: string) => PageSummary | undefined {
  const controller = useViewCacheController();
  return (id) => controller?.store.get(id);
}

const NO_HEADS = () => null;

/** Every recurring series' head, re-rendering only when one changes; null outside a workspace or
 *  when `enabled` is false. Today needs the heads to place its occurrences, not every held page. */
export function useSeriesHeads(enabled = true): PageSummary[] | null {
  const controller = useViewCacheController();
  const live = controller && enabled ? controller : null;
  return useSyncExternalStore(
    live?.subscribe ?? NO_SUBSCRIPTION,
    live ? () => live.headPages() : NO_HEADS
  );
}
