import type { DateBounds, ListSlot, PageSummary, Placement, SortMode, ViewKey } from "@pikos/core";
import {
  formatDateOnly,
  getLocalTimezone,
  isSmartViewId,
  localToday,
  parseLocalISO,
  UPCOMING_WINDOW_DAYS,
  viewName,
} from "@pikos/core";
import { addDays } from "date-fns";
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
  /** Every row in the list, loaded or not. */
  total: number;
  /** Rows after `slots` whose ids aren't known yet. */
  tail: number;
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

function dayAfter(day: string, days = 1): string {
  return formatDateOnly(addDays(parseLocalISO(day), days));
}

function key(scope: ViewKey["scope"], sort: SortMode, dates: DateBounds | null): ViewKey {
  return { dates, scope, sort, zone: getLocalTimezone() };
}

/**
 * The lists a view shows: Inbox and a folder are one list; Today is Overdue, then today; Upcoming
 * is a list per day, today first. Null for the trash, which the cache doesn't serve.
 */
export function cachedViewKeys(viewId: string, sort: SortMode, today: string): ViewKey[] | null {
  const everywhere = { kind: "everywhere" } as const;
  if (viewId === "today") {
    return [
      key(everywhere, "date", { from: null, until: today }),
      key(everywhere, "date", { from: today, until: dayAfter(today) }),
    ];
  }
  if (viewId === "upcoming") {
    return Array.from({ length: UPCOMING_WINDOW_DAYS }, (_, i) => {
      const day = dayAfter(today, i);
      return key(everywhere, "date", { from: day, until: dayAfter(day) });
    });
  }
  if (isSmartViewId(viewId) && viewId !== "inbox") return null;
  return [
    key(viewId === "inbox" ? { kind: "inbox" } : { folderId: viewId, kind: "folder" }, sort, null),
  ];
}

/**
 * The list as the controller holds it. `version` is unused here but must be an argument: the
 * controller is one object for the app's life, so the compiler would otherwise memoize this read
 * forever.
 */
function readView(controller: ViewCacheController, key: ViewKey, _version: number): CachedView {
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
  return {
    allIds: () => controller.allIds(key),
    ensure: (first, last) => controller.want(key, first, last),
    ids,
    key,
    loading: !entry || (entry.status === "loading" && ids.length === 0),
    pages,
    place: (moving, place) => controller.place(key, moving, place),
    rows: (wanted) => controller.rows(wanted),
    slots,
    tail: total - ids.length,
    total,
  };
}

/** Today's date, read again whenever the controller's version changes, which it does at midnight:
 *  with no argument the compiler would read it once and keep it. */
export function todayAt(_version: number): string {
  return localToday();
}

const NO_SUBSCRIPTION = () => () => undefined;
const NO_VERSION = () => 0;

/**
 * The lists `viewId` shows, from the cache; null when the flag is off or the cache doesn't serve
 * the view. `pinnedPages` stay through the eviction that showing them runs; null reads the lists
 * without showing them, for a second reader of what's on screen.
 */
export function useCachedViews(
  viewId: string,
  sort: SortMode,
  pinnedPages: string[] | null
): { views: CachedView[]; today: string } | null {
  const controller = useViewCacheController();
  const version = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller?.getVersion ?? NO_VERSION
  );
  const today = todayAt(version);
  const keys = controller ? cachedViewKeys(viewId, sort, today) : null;
  const names = keys?.map(viewName).join("\n") ?? null;

  // Shown once per set of lists: key objects rebuilt every render would show them each time.
  useEffect(() => {
    if (controller && keys && pinnedPages) controller.show(keys, pinnedPages);
  }, [names]);

  if (!controller || !keys) return null;
  return { today, views: keys.map((k) => readView(controller, k, version)) };
}

/** The one list an Inbox or folder view shows, from the cache; null otherwise. */
export function useCachedView(
  viewId: string,
  sort: SortMode,
  pinnedPages: string[] | null
): CachedView | null {
  const views = useCachedViews(viewId, sort, pinnedPages)?.views;
  return views?.length === 1 && viewId !== "today" ? (views[0] ?? null) : null;
}
