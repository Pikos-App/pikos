// Shared fixture for the calendar suites. `allDayLayout.test.ts` and
// `calendarLayout.test.ts` both build `PageSummary` rows by the hundred and
// only ever vary a handful of scheduling fields, so the full-shape default
// lives here once instead of being copied into each file when the aggregate
// suite was split apart.

import type { PageSummary } from "../types";

export function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: overrides.id ?? crypto.randomUUID(),
    isRecurring: false,
    priority: 0,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Untitled",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}
