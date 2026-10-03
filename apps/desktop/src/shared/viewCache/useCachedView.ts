import type { ListSlot, PageSummary, Placement, SortMode, ViewKey } from "@pikos/core";
import { getLocalTimezone, isSmartViewId, viewName } from "@pikos/core";
import { useEffect, useSyncExternalStore } from "react";

import { useViewCacheController } from "@/shared/context/WorkspaceContext";

import type { ViewCacheController } from "./controller";

export interface CachedView {
  key: ViewKey;
  /** The list in order: a page where its row is held, else a placeholder. */
  slots: ListSlot[];
  /** The loaded pages alone, in order. */
  pages: PageSummary[];
  /** Every id known so far, in order; may run past the loaded rows. */
  ids: string[];
  loading: boolean;
  /** Load what the rows from `first` through `last` need: more of the list, or rows for ids. */
  ensure: (first: number, last: number) => void;
  /** Every id in the list, loading the ones not yet known. */
  allIds: () => Promise<string[]>;
  /** Summaries for `ids`, fetching any not held. */
  rows: (ids: string[]) => Promise<PageSummary[]>;
  /** Show pages moved, ahead of the write that moves them. */
  place: (moving: string[], place: Placement) => void;
}

/** The view key for a list the cache serves: Inbox and folders, for now. */
export function cachedViewKey(viewId: string, sort: SortMode): ViewKey | null {
  if (isSmartViewId(viewId) && viewId !== "inbox") return null;
  return {
    dates: null,
    scope: viewId === "inbox" ? { kind: "inbox" } : { folderId: viewId, kind: "folder" },
    sort,
    zone: getLocalTimezone(),
  };
}

/**
 * The list as the controller holds it. `version` is unused here but must be an argument: the
 * controller is one object for the app's life, so the compiler would otherwise memoize this read
 * forever.
 */
function readView(controller: ViewCacheController, key: ViewKey, _version: number) {
  const entry = controller.cache.entry(key);
  const ids = entry?.ids ?? [];
  const total = Math.max(entry?.total ?? 0, ids.length);
  const slots: ListSlot[] = [];
  const pages: PageSummary[] = [];
  for (const id of ids) {
    const page = controller.store.get(id);
    if (page) pages.push(page);
    slots.push(page ?? { id, key: `slot-${id}`, placeholder: true });
  }
  for (let i = ids.length; i < total; i++) {
    slots.push({ id: null, key: `slot-${i}`, placeholder: true });
  }
  return { entry, ids, pages, slots };
}

const NO_SUBSCRIPTION = () => () => undefined;
const NO_VERSION = () => 0;

/**
 * Null when the view isn't served from the cache: the flag is off, or it's Today or Upcoming.
 * `pinnedPages` stay through the eviction that showing the view runs; null reads the list without
 * showing it, for a second reader of the list on screen.
 */
export function useCachedView(
  viewId: string,
  sort: SortMode,
  pinnedPages: string[] | null
): CachedView | null {
  const controller = useViewCacheController();
  const version = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller?.getVersion ?? NO_VERSION
  );
  const key = controller ? cachedViewKey(viewId, sort) : null;
  const name = key ? viewName(key) : null;

  // Shown once per view: a key object rebuilt every render would show it again each time.
  useEffect(() => {
    if (controller && key && pinnedPages) controller.show(key, pinnedPages);
  }, [name]);

  if (!controller || !key) return null;
  const { entry, ids, pages, slots } = readView(controller, key, version);

  function ensure(first: number, last: number) {
    if (controller && key) controller.want(key, first, last);
  }

  return {
    allIds: () => controller.allIds(key),
    ensure,
    ids,
    key,
    loading: !entry || (entry.status === "loading" && ids.length === 0),
    pages,
    place: (moving, place) => controller.place(key, moving, place),
    rows: (wanted) => controller.rows(wanted),
    slots,
  };
}
