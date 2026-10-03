import type { PageSummary } from "@pikos/core";
import { useSyncExternalStore } from "react";

import { usePages } from "@/shared/context/PagesContext";
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
 * null while the flag is off. Only a reader that needs them live subscribes, so a change to the
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

/** Finds one page when an action needs it, without subscribing: from the view cache's store with
 *  the flag on, else from the full list. */
export function usePageLookup(): (id: string) => PageSummary | undefined {
  const controller = useViewCacheController();
  const { pages } = usePages();
  return (id) => (controller ? controller.store.get(id) : pages.find((p) => p.id === id));
}
