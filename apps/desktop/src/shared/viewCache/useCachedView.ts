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

const sameSlot = (a: ListSlot, b: ListSlot) =>
  a === b || ("placeholder" in a && "placeholder" in b && a.id === b.id);

/** The last read of each list, by controller, so a read that finds nothing changed returns it. */
const lastViews = new WeakMap<ViewCacheController, Map<string, CachedView>>();

/** The list as the controller holds it; the same object while its rows and counts are, so a write
 *  to a page in another list re-renders nothing here. */
function readView(controller: ViewCacheController, key: ViewKey): CachedView {
  const entry = controller.cache.entry(key);
  const ids = entry?.ids ?? [];
  const total = Math.max(entry?.total ?? 0, ids.length);
  const loading = !entry || (entry.status === "loading" && ids.length === 0);
  const slots: ListSlot[] = [];
  const pages: PageSummary[] = [];
  for (const id of ids) {
    const page = controller.store.get(id);
    if (page) pages.push(page);
    slots.push(page ?? { id, key: `slot-${id}`, placeholder: true });
  }
  const held = lastViews.get(controller) ?? new Map<string, CachedView>();
  lastViews.set(controller, held);
  const name = viewName(key);
  const last = held.get(name);
  if (
    last &&
    last.loading === loading &&
    last.total === total &&
    last.slots.length === slots.length &&
    last.slots.every((slot, i) => sameSlot(slot, slots[i]!))
  )
    return last;
  const view: CachedView = {
    allIds: () => controller.allIds(key),
    ensure: (first, last) => controller.want(key, first, last),
    ids,
    key,
    loading,
    pages,
    place: (moving, place) => controller.place(key, moving, place),
    rows: (wanted) => controller.rows(wanted),
    slots,
    tail: total - ids.length,
    total,
  };
  held.set(name, view);
  return view;
}

/** The lists a view shows as last read, by controller and view, kept like `lastViews`. */
const lastLists = new WeakMap<ViewCacheController, Map<string, CachedLists>>();

interface CachedLists {
  /** The series heads are held, which Today needs to put each series' occurrence in its place. */
  headsReady: boolean;
  today: string;
  views: CachedView[];
}

function readLists(controller: ViewCacheController, viewId: string, sort: SortMode) {
  const today = localToday();
  const keys = cachedViewKeys(viewId, sort, today);
  if (!keys) return null;
  const views = keys.map((k) => readView(controller, k));
  const held = lastLists.get(controller) ?? new Map<string, CachedLists>();
  lastLists.set(controller, held);
  const name = `${viewId}|${sort}`;
  const last = held.get(name);
  const headsReady = controller.headsLoaded();
  if (
    last &&
    last.today === today &&
    last.headsReady === headsReady &&
    last.views.length === views.length &&
    last.views.every((v, i) => v === views[i])
  )
    return last;
  const lists = { headsReady, today, views };
  held.set(name, lists);
  return lists;
}

const NO_SUBSCRIPTION = () => () => undefined;
const NO_LISTS = () => null;

/**
 * The lists `viewId` shows, from the cache; null when the flag is off or the cache doesn't serve
 * the view. `pinnedPages` stay through the eviction that showing them runs; null reads the lists
 * without showing them, for a second reader of what's on screen.
 */
export function useCachedViews(
  viewId: string,
  sort: SortMode,
  pinnedPages: string[] | null
): CachedLists | null {
  const controller = useViewCacheController();
  const lists = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIPTION,
    controller ? () => readLists(controller, viewId, sort) : NO_LISTS
  );
  const keys = lists?.views.map((v) => v.key) ?? null;
  const names = keys?.map(viewName).join("\n") ?? null;

  // Shown once per set of lists: key objects rebuilt every render would show them each time.
  useEffect(() => {
    if (controller && keys && pinnedPages) controller.show(keys, pinnedPages);
  }, [names]);

  return lists;
}

/**
 * The one list an Inbox or folder view shows, read when an action needs it rather than subscribed
 * to: a drag needs the order only when it starts and ends, and a subscription re-rendered the
 * whole layout with every change to the store. Null when the cache doesn't serve the view.
 */
export function cachedListNow(
  controller: ViewCacheController | null,
  viewId: string,
  sort: SortMode
): { pages: PageSummary[]; place: (moving: string[], place: Placement) => void } | null {
  if (!controller || viewId === "today" || viewId === "upcoming") return null;
  const [key] = cachedViewKeys(viewId, sort, localToday()) ?? [];
  if (!key) return null;
  const ids = controller.cache.entry(key)?.ids ?? [];
  return {
    pages: ids.flatMap((id) => controller.store.get(id) ?? []),
    place: (moving, place) => controller.place(key, moving, place),
  };
}
