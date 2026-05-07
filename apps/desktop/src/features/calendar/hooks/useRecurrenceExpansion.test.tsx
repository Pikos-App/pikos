// useRecurrenceExpansion — verifies the calendar's hook for merging virtual
// rrule occurrences into the rendered page list. Covers head-deduplication,
// override exclusion, multi-rule expansion, and the empty-rules short-circuit.

import type {
  PageRecurrenceRule,
  PageSchedule,
  PageSummary,
  VirtualOccurrence,
} from "@pikos/core";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRecurrenceExpansion } from "./useRecurrenceExpansion";

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "page-1",
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Standup",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

function makeRule(overrides: Partial<PageRecurrenceRule> = {}): PageRecurrenceRule {
  return {
    createdAt: "2026-01-01T00:00:00",
    id: "rule-1",
    pageId: "page-1",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    rruleExdates: [],
    scheduledEnd: "2026-03-02T10:00:00",
    scheduledStart: "2026-03-02T09:00:00",
    timezone: "America/New_York",
    ...overrides,
  };
}

function weekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

const NOOP_LIST_SCHEDULES = (): Promise<PageSchedule[]> => Promise.resolve([]);

describe("useRecurrenceExpansion", () => {
  it("returns pages unchanged when there are no recurrence rules", () => {
    const pages = [makePage()];
    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 2)),
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [],
      })
    );

    expect(result.current).toBe(pages);
  });

  it("expands a weekly rule into virtual occurrences for the visible week", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const rule = makeRule();
    const days = weekDays(new Date(2026, 2, 9)); // week of March 9 (next Monday)
    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [rule],
      })
    );

    // No async fetches needed since listSchedulesRange returns []
    await waitFor(() => {
      const virtual = result.current.filter(
        (p): p is VirtualOccurrence => "isVirtual" in p
      );
      expect(virtual).toHaveLength(1);
      expect(virtual[0]?.scheduledStart).toBe("2026-03-09T09:00:00");
    });
  });

  it("excludes the head's current date from virtual expansion (head renders as a real block)", async () => {
    // Head is on Mar 9 — the first Monday of the visible week. The hook must
    // not emit a virtual for Mar 9 on top of the real head, otherwise the
    // calendar would render two stacked blocks for the same occurrence.
    const head = makePage({ scheduledStart: "2026-03-09T09:00:00" });
    const rule = makeRule();
    const days = weekDays(new Date(2026, 2, 9));

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages: [head],
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter(
        (p): p is VirtualOccurrence => "isVirtual" in p
      );
      // No virtual for Mar 9 — that slot is the real head block.
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
      // Real head still present.
      expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeDefined();
    });
  });

  it("excludes dates with materialised override schedules", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const rule = makeRule();
    const days = weekDays(new Date(2026, 2, 9));
    const overrideSchedule: PageSchedule = {
      createdAt: "2026-01-01T00:00:00",
      id: "sched-override-1",
      originalDate: "2026-03-09",
      pageId: "page-1",
      ruleId: "rule-1",
      scheduledEnd: "2026-03-09T11:00:00",
      scheduledStart: "2026-03-09T10:00:00",
      status: "not_started",
      timezone: "America/New_York",
    };

    const listSchedulesRange = vi.fn().mockResolvedValue([overrideSchedule]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        listSchedulesRange,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter(
        (p): p is VirtualOccurrence => "isVirtual" in p
      );
      // No virtual on Mar 9 — there's a materialised override row for it.
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
  });

  it("expands multiple rules independently in the same week", async () => {
    const pageA = makePage({ id: "page-A", scheduledStart: "2026-03-02T09:00:00" });
    const pageB = makePage({
      id: "page-B",
      scheduledStart: "2026-03-04T15:00:00",
      title: "Wednesday Sync",
    });
    const ruleA = makeRule({ id: "rule-A", pageId: "page-A" });
    const ruleB = makeRule({
      id: "rule-B",
      pageId: "page-B",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      scheduledEnd: "2026-03-04T16:00:00",
      scheduledStart: "2026-03-04T15:00:00",
    });
    const days = weekDays(new Date(2026, 2, 9));

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages: [pageA, pageB],
        recurrenceRules: [ruleA, ruleB],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter(
        (p): p is VirtualOccurrence => "isVirtual" in p
      );
      expect(virtual).toHaveLength(2);
      expect(virtual.find((v) => v.ruleId === "rule-A")?.scheduledStart).toBe(
        "2026-03-09T09:00:00"
      );
      expect(virtual.find((v) => v.ruleId === "rule-B")?.scheduledStart).toBe(
        "2026-03-11T15:00:00"
      );
    });
  });
});
