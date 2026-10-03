import type { PageSummary } from "../types";

type SectionHeaderRow = {
  type: "section-header";
  key: string;
  label: string;
  count: number;
  collapsible: boolean;
  collapsed?: boolean;
};

type PageRow = {
  type: "page";
  key: string;
  page: PageSummary;
};

export type VirtualRow =
  | SectionHeaderRow
  | PageRow
  | { type: "empty-state"; key: string }
  | { type: "completed-toggle"; key: string }
  | { type: "load-more"; key: string }
  | { type: "empty-completed"; key: string }
  /** A row of the list not loaded yet: its id when known, else just its place. */
  | { type: "placeholder"; key: string; id: string | null };

/** A slot in a list loaded a window at a time: the page, or a row still to load. */
export type ListSlot = PageSummary | { placeholder: true; id: string | null; key: string };

/** One day's worth of the Upcoming view — see core `groupUpcomingPages`. */
export interface PageListDaySection {
  date: string;
  label: string;
  pages: PageSummary[];
}

export interface BuildPageListRowsInput {
  visiblePages: PageSummary[];
  isTodayView: boolean;
  overdue: PageSummary[];
  today: PageSummary[];
  overdueCollapsed: boolean;
  /**
   * Day sections for the Upcoming view; empty everywhere else. Unlike Today's
   * two fixed sections, these are open-ended and every one keeps its header even
   * when it is the only one — the day IS the information the view exists to give.
   */
  daySections?: PageListDaySection[];
  completedCollapsed: boolean;
  completedPages: PageSummary[];
  completedHasMore: boolean;
  /** A list loaded a window at a time, in place of `visiblePages` outside Today and Upcoming. */
  slots?: ListSlot[];
  /** The first window hasn't arrived, so an empty list isn't known to be empty yet. */
  loading?: boolean;
}

export interface BuildPageListRowsResult {
  rows: VirtualRow[];
  /** Maps page.id → row index (for scroll-to-index). */
  pageToRowIndex: Map<string, number>;
}

export function buildPageListRows(input: BuildPageListRowsInput): BuildPageListRowsResult {
  const {
    completedCollapsed,
    completedHasMore,
    completedPages,
    daySections = [],
    isTodayView,
    loading = false,
    overdue,
    overdueCollapsed,
    slots,
    today,
    visiblePages,
  } = input;

  const rows: VirtualRow[] = [];
  const pageToRowIndex = new Map<string, number>();

  if (slots) {
    if (slots.length === 0 && !loading) rows.push({ key: "empty-state", type: "empty-state" });
    for (const slot of slots) {
      if ("placeholder" in slot) {
        if (slot.id) pageToRowIndex.set(slot.id, rows.length);
        rows.push({ id: slot.id, key: slot.key, type: "placeholder" });
      } else {
        pageToRowIndex.set(slot.id, rows.length);
        rows.push({ key: slot.id, page: slot, type: "page" });
      }
    }
  } else if (visiblePages.length === 0) {
    rows.push({ key: "empty-state", type: "empty-state" });
  } else if (daySections.length > 0) {
    for (const section of daySections) {
      rows.push({
        collapsible: false,
        count: section.pages.length,
        key: `day-${section.date}`,
        label: section.label,
        type: "section-header",
      });
      for (const p of section.pages) {
        pageToRowIndex.set(p.id, rows.length);
        rows.push({ key: p.id, page: p, type: "page" });
      }
    }
  } else if (isTodayView) {
    if (overdue.length > 0) {
      rows.push({
        collapsed: overdueCollapsed,
        collapsible: true,
        count: overdue.length,
        key: "overdue-header",
        label: "Overdue",
        type: "section-header",
      });
      if (!overdueCollapsed) {
        for (const p of overdue) {
          pageToRowIndex.set(p.id, rows.length);
          rows.push({ key: p.id, page: p, type: "page" });
        }
      }
    }
    if (today.length > 0) {
      if (overdue.length > 0) {
        rows.push({
          collapsible: false,
          count: today.length,
          key: "today-header",
          label: "Today",
          type: "section-header",
        });
      }
      for (const p of today) {
        pageToRowIndex.set(p.id, rows.length);
        rows.push({ key: p.id, page: p, type: "page" });
      }
    }
  } else {
    for (const p of visiblePages) {
      pageToRowIndex.set(p.id, rows.length);
      rows.push({ key: p.id, page: p, type: "page" });
    }
  }

  rows.push({ key: "completed-toggle", type: "completed-toggle" });
  if (!completedCollapsed) {
    for (const p of completedPages) {
      pageToRowIndex.set(p.id, rows.length);
      rows.push({ key: `c-${p.id}`, page: p, type: "page" });
    }
    if (completedHasMore && completedPages.length > 0) {
      rows.push({ key: "load-more", type: "load-more" });
    }
    if (completedPages.length === 0 && !completedHasMore) {
      rows.push({ key: "empty-completed", type: "empty-completed" });
    }
  }

  return { pageToRowIndex, rows };
}
