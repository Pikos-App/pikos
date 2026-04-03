import type { PageSummary } from "@pikos/core";

// ── Row types ───────────────────────────────────────────────────────────────

export type SectionHeaderRow = {
  type: "section-header";
  key: string;
  label: string;
  count: number;
  collapsible: boolean;
  collapsed?: boolean;
};

export type PageRow = {
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
  | { type: "empty-completed"; key: string };

// ── Builder ─────────────────────────────────────────────────────────────────

export interface BuildPageListRowsInput {
  visiblePages: PageSummary[];
  isTodayView: boolean;
  overdue: PageSummary[];
  today: PageSummary[];
  overdueCollapsed: boolean;
  completedCollapsed: boolean;
  completedPages: PageSummary[];
  completedHasMore: boolean;
}

export interface BuildPageListRowsResult {
  rows: VirtualRow[];
  /** Maps page.id → row index (for scroll-to-index). */
  pageToRowIndex: Map<string, number>;
}

/**
 * Builds a flat array of virtual rows for the page list panel.
 * Pure function — no React dependencies.
 */
export function buildPageListRows(input: BuildPageListRowsInput): BuildPageListRowsResult {
  const {
    completedCollapsed,
    completedHasMore,
    completedPages,
    isTodayView,
    overdue,
    overdueCollapsed,
    today,
    visiblePages,
  } = input;

  const rows: VirtualRow[] = [];
  const pageToRowIndex = new Map<string, number>();

  // ── Active pages ──────────────────────────────────────────────────────────

  if (visiblePages.length === 0) {
    rows.push({ key: "empty-state", type: "empty-state" });
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

  // ── Completed section ─────────────────────────────────────────────────────

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
