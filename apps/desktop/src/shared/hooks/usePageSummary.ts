import type { PageSummary } from "@pikos/core";
import { useSyncExternalStore } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useViewCacheController } from "@/shared/context/WorkspaceContext";

const NO_SUBSCRIPTION = () => () => undefined;
const NOTHING = () => undefined;

/**
 * The summary of page `id` as the app shows it, unsaved edits included. Under the view cache it
 * reads the one row from the cache and re-renders only when that row changes: the store keeps a
 * row's object until it changes, so an edit to another page leaves this reader alone.
 */
export function usePageSummary(id: string | null): PageSummary | null {
  const { pages } = usePages();
  const controller = useViewCacheController();
  const held = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller && id !== null ? () => controller.store.get(id) : NOTHING
  );
  if (id === null) return null;
  if (controller) return held ?? null;
  return pages.find((p) => p.id === id) ?? null;
}
