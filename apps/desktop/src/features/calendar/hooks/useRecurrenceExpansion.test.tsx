// useRecurrenceExpansion — verifies the calendar's hook for merging virtual
// rrule occurrences into the rendered page list. Covers head-deduplication,
// override exclusion, multi-rule expansion, the empty-rules short-circuit, and
// both engine paths (Rust-via-IPC default + the rrule.js kill-switch).

import type {
  PageRecurrenceRule,
  PageSchedule,
  PageSummary,
  RawRuleExpansion,
  VirtualOccurrence,
} from "@pikos/core";
import { parseLocalISO, rawExpandRule } from "@pikos/core";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRecurrenceExpansion } from "./useRecurrenceExpansion";

// Stand-in for the batched Rust command: delegates to the same `rawExpandRule`
// the backend mirrors (raw per-rule occurrences, rule EXDATEs only). The page
// only satisfies the helper's signature — the raw fields are rule-derived.
const DUMMY_PAGE = makePage();
const EXPAND = (
  rules: PageRecurrenceRule[],
  startStr: string,
  endStr: string
): Promise<RawRuleExpansion[]> =>
  Promise.resolve(
    rules.map((rule) => ({
      occurrences: rawExpandRule(rule, DUMMY_PAGE, parseLocalISO(startStr), parseLocalISO(endStr)),
      ruleId: rule.id,
    }))
  );

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "page-1",
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    scheduleLocked: false,
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
        expandRecurrenceRange: EXPAND,
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
        expandRecurrenceRange: EXPAND,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [rule],
      })
    );

    // No async fetches needed since listSchedulesRange returns []
    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
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
        expandRecurrenceRange: EXPAND,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages: [head],
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      // No virtual for Mar 9 — that slot is the real head block.
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
      // Real head still present.
      expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeDefined();
    });
  });

  it("suppresses only the head's own-date virtual — a pre-head open gap still renders", async () => {
    // Daily anchor at Mar 2. Head has advanced to Mar 11: Mar 9 was completed
    // (its clone renders instead), but Mar 10 is an open gap — neither completed
    // nor skipped (an "advance, gap stays open" outcome). Visible week Mar 9–15.
    // Only Mar 11 (the head's own date) is filtered here; Mar 9 drops via the
    // completed exclusion union, and Mar 10 must survive — the gap stays visible.
    // (The old "<= headDate" filter wrongly hid Mar 10.)
    const head = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      scheduledStart: "2026-03-11T09:00:00",
    });
    const rule = makeRule({
      rrule: "FREQ=DAILY",
      scheduledEnd: "2026-03-02T10:00:00",
      scheduledStart: "2026-03-02T09:00:00",
    });
    const days = weekDays(new Date(2026, 2, 9)); // Mar 9–15

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        expandRecurrenceRange: EXPAND,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages: [head],
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      // Mar 9 — completed, dropped by the exclusion union (not this filter).
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
      // Mar 10 — open gap before the head; must render under own-date-only.
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-10"))).toBeDefined();
      // Mar 11 — the head's own date; suppressed so the real head isn't doubled.
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-11"))).toBeUndefined();
      // Mar 12+ still appear.
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-12"))).toBeDefined();
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
        expandRecurrenceRange: EXPAND,
        listSchedulesRange,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      // No virtual on Mar 9 — there's a materialised override row for it.
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
  });

  it("suppresses a synced series' head when its base occurrence is completed", async () => {
    // A synced series pins its head at the base (Mar 9). Completing that
    // occurrence records it in completedOccurrences — the head block must drop
    // out (its done clone renders instead), while later virtuals keep showing.
    const head = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      scheduledStart: "2026-03-09T09:00:00",
      scheduleLocked: true,
    });
    const clone = makePage({
      id: "clone-1",
      scheduledStart: "2026-03-09T09:00:00",
      status: "done",
      title: "Standup (done)",
    });
    const rule = makeRule({ scheduledStart: "2026-03-09T09:00:00" });
    const days = weekDays(new Date(2026, 2, 9));

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        expandRecurrenceRange: EXPAND,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages: [head, clone],
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      // The head (real page at the completed base date) is gone.
      expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeUndefined();
      expect(result.current.find((p) => p.id === "clone-1")).toBeDefined();
      // No virtual resurrects the completed base date either.
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
  });

  it("suppresses a native head on a completed base too (out-of-envelope rule) while its clone renders", async () => {
    // An engine-rejected (out-of-envelope) rule never advances its head, so a
    // native page (scheduleLocked: false) can sit on a completed base just like
    // a synced one. The un-gated headCompleted must drop it — proving the
    // dropped scheduleLocked gate — while its done clone (a separate page) stays.
    const head = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      scheduledStart: "2026-03-09T09:00:00",
      scheduleLocked: false,
    });
    const clone = makePage({
      id: "clone-1",
      scheduledStart: "2026-03-09T09:00:00",
      status: "done",
      title: "Standup (done)",
    });
    const rule = makeRule({ scheduledStart: "2026-03-09T09:00:00" });
    const days = weekDays(new Date(2026, 2, 9));

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        expandRecurrenceRange: EXPAND,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages: [head, clone],
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      // The head (real recurring page on the completed base) is gone.
      expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeUndefined();
      expect(result.current.find((p) => p.id === "clone-1")).toBeDefined();
      // No virtual resurrects the completed base date.
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
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
        expandRecurrenceRange: EXPAND,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages: [pageA, pageB],
        recurrenceRules: [ruleA, ruleB],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual).toHaveLength(2);
      expect(virtual.find((v) => v.ruleId === "rule-A")?.scheduledStart).toBe(
        "2026-03-09T09:00:00"
      );
      expect(virtual.find((v) => v.ruleId === "rule-B")?.scheduledStart).toBe(
        "2026-03-11T15:00:00"
      );
    });
  });

  it("falls back to rrule.js for a rule the Rust engine omitted (out-of-envelope)", async () => {
    // The IPC batch omits any rule its stricter engine can't parse. Here the
    // expander returns an empty batch (the rule is absent), so the hook must fall
    // back to the in-process rrule.js expansion — the occurrence still renders.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const rule = makeRule();
    const omitAll = (): Promise<RawRuleExpansion[]> => Promise.resolve([]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: omitAll,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual).toHaveLength(1);
      expect(virtual[0]?.scheduledStart).toBe("2026-03-09T09:00:00");
    });
  });

  it("kill-switch (useRustEngine: false) expands via rrule.js, never touching IPC", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const rule = makeRule();
    const expandSpy = vi.fn(() => Promise.reject(new Error("IPC must not be called")));

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: expandSpy,
        listSchedulesRange: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [rule],
        useRustEngine: false,
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual).toHaveLength(1);
      expect(virtual[0]?.scheduledStart).toBe("2026-03-09T09:00:00");
    });
    expect(expandSpy).not.toHaveBeenCalled();
  });
});
