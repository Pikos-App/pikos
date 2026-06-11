// Single-page predicates. Used by filters and view-membership logic across the
// app so a future PageStatus addition (e.g. "in_progress") has one place to
// update instead of every list/filter site.

import type { Page, PageSummary } from "../types";

type PageLike = Pick<Page | PageSummary, "status">;

export function isOpen(page: PageLike): boolean {
  return page.status !== "done";
}

export function isDone(page: PageLike): boolean {
  return page.status === "done";
}
