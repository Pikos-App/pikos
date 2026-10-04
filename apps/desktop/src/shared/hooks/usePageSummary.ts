import type { PageSummary } from "@pikos/core";
import { useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

const NO_SUBSCRIPTION = () => () => undefined;
const NOTHING = () => undefined;

/**
 * The summary of page `id` as the app shows it, unsaved edits included. Reads the one row from the
 * cache and re-renders only when that row changes: the store keeps a row's object until it
 * changes, so an edit to another page leaves this reader alone.
 */
export function usePageSummary(id: string | null): PageSummary | null {
  const controller = useViewCacheController();
  const held = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller && id !== null ? () => controller.store.get(id) : NOTHING
  );
  return id === null ? null : (held ?? null);
}
