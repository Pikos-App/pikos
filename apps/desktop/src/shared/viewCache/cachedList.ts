// What the page list draws when the view cache serves it: the view's lists as sections, each row
// as the store shows it (unsaved edits included), without the rows an edit took out of their
// section.

import type { ListSection, ListSlot, PageSummary } from "@pikos/core";
import {
  belongsToView,
  compareByScheduledStart,
  dateKey,
  isOpen,
  upcomingDayLabel,
  viewerStart,
  withTodayOccurrences,
} from "@pikos/core";

import type { CachedView } from "./useCachedView";

export interface CachedList {
  sections: ListSection[];
  /** The loaded pages of every section, in the order shown. */
  pages: PageSummary[];
  /** Every id known so far, in the order shown; may run past the loaded rows. */
  ids: string[];
  loading: boolean;
  /** Rows `first` through `last` of `section` are on screen. */
  ensure: (section: string, first: number, last: number) => void;
  /** Every id in the view, loading the ones not yet known. */
  allIds: () => Promise<string[]>;
  /** Summaries for `ids`, fetching any not held. */
  rows: (ids: string[]) => Promise<PageSummary[]>;
  /** The one list of an Inbox or folder view, which a drag reorders; null for sections. */
  single: CachedView | null;
  /** Every page in one section, fetching the ones not loaded: Overdue, for moving it to today. */
  sectionPages: (section: string) => Promise<PageSummary[]>;
}

interface Section {
  key: string;
  header: ListSection["header"];
  /** Whether a page, as it now stands, belongs here. */
  holds: (page: PageSummary) => boolean;
}

function startDay(page: PageSummary): string | null {
  const start = viewerStart(page);
  return start ? dateKey(start) : null;
}

/** The sections `views` stand for, in order: see `cachedViewKeys`. */
function sectionsOf(viewId: string, views: CachedView[], today: string): Section[] {
  if (viewId === "today") {
    return [
      {
        header: { collapsible: true, label: "Overdue" },
        holds: (p) => isOpen(p) && (startDay(p) ?? today) < today,
        key: "overdue",
      },
      {
        // Headed only beside an Overdue section; see `buildCachedList`.
        header: { collapsible: false, label: "Today" },
        holds: (p) => isOpen(p) && startDay(p) === today,
        key: "today",
      },
    ];
  }
  if (viewId === "upcoming") {
    return views.map((view) => {
      const day = view.key.dates?.from ?? today;
      return {
        header: { collapsible: false, label: upcomingDayLabel(day, today) },
        holds: (p) => isOpen(p) && startDay(p) === day,
        key: day,
      };
    });
  }
  return [
    { header: null, holds: (p) => isOpen(p) && belongsToView(p, viewId, today), key: "list" },
  ];
}

/**
 * Synced series whose occurrence today stands in for a head on another day, by head id. The
 * occurrence moves the row into today's section, as `withTodayOccurrences` does for the full list.
 */
function todaySwaps(pages: PageSummary[], occurrences: PageSummary[], today: string) {
  const synced = pages.filter((p) => p.syncState != null);
  const swapped = withTodayOccurrences(synced, occurrences, today);
  const swaps = new Map<string, { head: PageSummary; occurrence: PageSummary }>();
  swapped.forEach((page, i) => {
    const head = synced[i];
    if (head && page !== head) swaps.set(head.id, { head, occurrence: page });
  });
  return swaps;
}

export function buildCachedList(input: {
  viewId: string;
  views: CachedView[];
  /** The in-memory list, for synced series heads. */
  pages: PageSummary[];
  hiddenIds: Set<string>;
  /** Today's recurring occurrences, for the Today view. */
  occurrences: PageSummary[];
  today: string;
}): CachedList {
  const { hiddenIds, occurrences, pages, today, viewId, views } = input;
  const swaps =
    viewId === "today" ? todaySwaps(pages, occurrences, today) : new Map<string, never>();
  const defs = sectionsOf(viewId, views, today);

  // Each shown slot's place in its list, so loading asks for what the list needs: rows left out
  // or added here would otherwise shift every place after them.
  const places = new Map<string, number[]>();
  const sections: ListSection[] = defs.map((def, i) => {
    const view = views[i];
    if (!view) return { count: 0, header: def.header, key: def.key, slots: [], tail: 0 };
    let count = view.total;
    const loaded: { page: PageSummary; place: number }[] = [];
    const rest: { slot: ListSlot; place: number }[] = [];
    view.slots.forEach((slot, place) => {
      if ("placeholder" in slot) {
        rest.push({ place, slot });
        return;
      }
      const page = slot;
      if (swaps.has(page.id) || hiddenIds.has(page.id) || !def.holds(page)) {
        count -= 1;
        return;
      }
      loaded.push({ page, place });
    });
    if (def.key === "today" && swaps.size > 0) {
      for (const { occurrence } of swaps.values()) loaded.push({ page: occurrence, place: 0 });
      count += swaps.size;
      loaded.sort((a, b) => compareByScheduledStart(a.page, b.page));
    }
    places.set(def.key, [...loaded.map((l) => l.place), ...rest.map((r) => r.place)]);
    return {
      count,
      header: def.header,
      key: def.key,
      slots: [...loaded.map((l) => l.page), ...rest.map((r) => r.slot)],
      tail: view.tail,
    };
  });

  const [overdue, todays] = sections;
  if (viewId === "today" && overdue && todays && overdue.count <= 0) todays.header = null;

  const viewOf = new Map(defs.map((def, i) => [def.key, views[i]]));
  const shownPages = sections.flatMap((s) =>
    s.slots.filter((x): x is PageSummary => !("placeholder" in x))
  );
  return {
    allIds: async () => (await Promise.all(views.map((v) => v.allIds()))).flat(),
    ensure: (section, first, last) => {
      const view = viewOf.get(section);
      if (!view) return;
      const placed = places.get(section) ?? [];
      // Past the shown slots is the tail, which follows the list's known ids in order.
      const placeOf = (at: number) => placed[at] ?? view.ids.length + (at - placed.length);
      const known = placed.slice(first, last + 1);
      view.ensure(Math.min(placeOf(first), ...known), Math.max(placeOf(last), ...known));
    },
    ids: views.flatMap((v) => v.ids),
    loading: views.some((v) => v.loading),
    pages: shownPages,
    rows: (ids) => views[0]?.rows(ids) ?? Promise.resolve([]),
    sectionPages: async (section) => {
      const view = viewOf.get(section);
      const def = defs.find((d) => d.key === section);
      if (!view || !def) return [];
      const fetched = await view.rows(await view.allIds());
      return fetched.filter(
        (page) => !swaps.has(page.id) && !hiddenIds.has(page.id) && def.holds(page)
      );
    },
    sections,
    single: viewId === "today" || viewId === "upcoming" ? null : (views[0] ?? null),
  };
}
