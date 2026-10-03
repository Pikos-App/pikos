import type { PageSummary } from "@pikos/core";
import { useSyncExternalStore } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useViewCacheController } from "@/shared/context/WorkspaceContext";
import type { ViewCacheController } from "@/shared/viewCache/controller";

const NO_SUBSCRIPTION = () => () => undefined;
const NO_VERSION = () => 0;

/** `version` is an argument so the compiler can't memoize the read; see `readView`. */
function readHeld(
  controller: ViewCacheController,
  id: string,
  _version: number
): PageSummary | undefined {
  return controller.store.get(id);
}

/**
 * The summary of page `id` as the app shows it, unsaved edits included. Under the view cache
 * this reads the one row from the cache, so it costs the same however many rows are held.
 */
export function usePageSummary(id: string | null): PageSummary | null {
  const { pages } = usePages();
  const controller = useViewCacheController();
  const version = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller?.getVersion ?? NO_VERSION
  );
  if (id === null) return null;
  if (controller) return readHeld(controller, id, version) ?? null;
  return pages.find((p) => p.id === id) ?? null;
}
