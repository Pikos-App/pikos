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
import { act, renderHook, waitFor } from "@testing-library/react";
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

function makeOverride(
  originalDate: string,
  scheduledStart: string,
  scheduledEnd?: string
): PageSchedule {
  return {
    createdAt: "2026-01-01T00:00:00",
    id: `sched-${originalDate}-${scheduledStart}`,
    originalDate,
    pageId: "page-1",
    ruleId: "rule-1",
    scheduledStart,
    ...(scheduledEnd ? { scheduledEnd } : {}),
    status: "not_started",
    timezone: "America/New_York",
  };
}

/** The non-virtual (real, completable) block rendered at `scheduledStart` — a
 * moved synced override, distinct from a recurring virtual. */
function movedBlock(
  list: (PageSummary | VirtualOccurrence)[],
  scheduledStart: string
): PageSummary | VirtualOccurrence | undefined {
  return list.find((p) => !("isVirtual" in p) && p.scheduledStart === scheduledStart);
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [rule],
      })
    );

    // No async fetches needed since listOverridesForRules returns []
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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

    const listOverridesForRules = vi.fn().mockResolvedValue([overrideSchedule]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
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

  it("excludes a synced override stored as full wall-clock (day-keyed)", async () => {
    // A synced timed override stores its original_date as '...THH:MM:SS', but the
    // occurrence key is day-only — the exclusion set must day-key it to match,
    // else Mar 9 ghosts beside the moved instance.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const rule = makeRule();
    const overrideSchedule: PageSchedule = {
      createdAt: "2026-01-01T00:00:00",
      id: "sched-override-timed",
      originalDate: "2026-03-09T09:00:00",
      pageId: "page-1",
      ruleId: "rule-1",
      scheduledEnd: "2026-03-09T12:00:00",
      scheduledStart: "2026-03-09T11:00:00",
      status: "not_started",
      timezone: "America/New_York",
    };
    const listOverridesForRules = vi.fn().mockResolvedValue([overrideSchedule]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
  });

  it("excludes the original slot of an override moved out of the visible week (cross-week)", async () => {
    // The override's moved scheduledStart lands weeks away, so a range fetch keyed
    // on that position would never return it — but listOverridesForRules is keyed
    // by rule, so the original Mar 9 slot still excludes.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const rule = makeRule();
    const movedOverride: PageSchedule = {
      createdAt: "2026-01-01T00:00:00",
      id: "sched-override-moved",
      originalDate: "2026-03-09T09:00:00",
      pageId: "page-1",
      ruleId: "rule-1",
      scheduledEnd: "2026-05-01T12:00:00",
      scheduledStart: "2026-05-01T11:00:00",
      status: "not_started",
      timezone: "America/New_York",
    };
    const listOverridesForRules = vi.fn().mockResolvedValue([movedOverride]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
    expect(listOverridesForRules).toHaveBeenCalledWith(["rule-1"]);
  });

  it("renders a synced override at its moved slot as a locked, completable block (not a virtual)", async () => {
    // A synced weekly series whose Mar 9 occurrence was moved upstream to Mar 11
    // 11am. Mar 9's original slot is excluded from the virtuals; the moved instance
    // renders at Mar 11 as a plain (non-virtual) block that inherits the page's
    // synced lock and carries the original occurrence's day-key.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00", scheduleLocked: true })];
    const rule = makeRule();
    const movedOverride: PageSchedule = {
      createdAt: "2026-01-01T00:00:00",
      id: "sched-override-moved",
      originalDate: "2026-03-09T09:00:00",
      pageId: "page-1",
      ruleId: "rule-1",
      scheduledEnd: "2026-03-11T12:00:00",
      scheduledStart: "2026-03-11T11:00:00",
      status: "not_started",
      timezone: "America/New_York",
    };
    const listOverridesForRules = vi.fn().mockResolvedValue([movedOverride]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)), // Mar 9–15
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const moved = result.current.find(
        (p) => !("isVirtual" in p) && p.scheduledStart === "2026-03-11T11:00:00"
      );
      expect(moved).toBeDefined();
      expect(moved?.id).toBe("page-1");
      // Inherits the page's synced lock (drag/resize suppressed downstream).
      expect(moved?.scheduleLocked).toBe(true);
      // Keyed to the ORIGINAL occurrence day so completing it records that date.
      expect((moved as { originalDate?: string }).originalDate).toBe("2026-03-09");
    });
    // No virtual resurrects the original Mar 9 slot.
    const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
    expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
  });

  it("renders a moved all-day synced override at its new date", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02", scheduleLocked: true })];
    const rule = makeRule({ rrule: "FREQ=WEEKLY;BYDAY=MO", scheduledStart: "2026-03-02" });
    const movedOverride: PageSchedule = {
      createdAt: "2026-01-01T00:00:00",
      id: "sched-allday-moved",
      originalDate: "2026-03-09",
      pageId: "page-1",
      ruleId: "rule-1",
      scheduledStart: "2026-03-11",
      status: "not_started",
      timezone: "America/New_York",
    };
    const listOverridesForRules = vi.fn().mockResolvedValue([movedOverride]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const moved = result.current.find(
        (p) => !("isVirtual" in p) && p.scheduledStart === "2026-03-11"
      );
      expect(moved).toBeDefined();
      expect((moved as { originalDate?: string }).originalDate).toBe("2026-03-09");
    });
  });

  it("excludes a synced override whose original occurrence is completed", async () => {
    // Daily series. Mar 10 is done (its clone renders), so its moved override at
    // Mar 11 5pm must NOT render — else the completed occurrence shows twice. A
    // second override (Mar 12 → Mar 13 5pm, still open) is the positive anchor:
    // once it renders, the whole batch was applied, so the excluded slot's
    // absence is real and not just an unresolved fetch.
    const pages = [
      makePage({
        completedOccurrences: { "2026-03-10": "clone-1" },
        scheduledStart: "2026-03-02T09:00:00",
        scheduleLocked: true,
      }),
    ];
    const rule = makeRule({ rrule: "FREQ=DAILY" });
    const overrides: PageSchedule[] = [
      makeOverride("2026-03-10T09:00:00", "2026-03-11T17:00:00"),
      makeOverride("2026-03-12T09:00:00", "2026-03-13T17:00:00"),
    ];
    const listOverridesForRules = vi.fn().mockResolvedValue(overrides);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => expect(movedBlock(result.current, "2026-03-13T17:00:00")).toBeDefined());
    expect(movedBlock(result.current, "2026-03-11T17:00:00")).toBeUndefined();
  });

  it("excludes a synced override whose original occurrence is skipped", async () => {
    const pages = [
      makePage({
        scheduledStart: "2026-03-02T09:00:00",
        scheduleLocked: true,
        skippedOccurrences: ["2026-03-10"],
      }),
    ];
    const rule = makeRule({ rrule: "FREQ=DAILY" });
    const overrides: PageSchedule[] = [
      makeOverride("2026-03-10T09:00:00", "2026-03-11T17:00:00"), // skipped → excluded
      makeOverride("2026-03-12T09:00:00", "2026-03-13T17:00:00"), // anchor
    ];
    const listOverridesForRules = vi.fn().mockResolvedValue(overrides);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => expect(movedBlock(result.current, "2026-03-13T17:00:00")).toBeDefined());
    expect(movedBlock(result.current, "2026-03-11T17:00:00")).toBeUndefined();
  });

  it("does not render an override block for a non-synced (unlocked) series", async () => {
    // Guards toOverrideBlocks' scheduleLocked gate (override rows are synced-only).
    // Signal that the fetch applied via the Mar 9 virtual dropping out — the override
    // excludes its own slot locked or not — then assert no moved block rendered.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })]; // scheduleLocked: false
    const rule = makeRule();
    const listOverridesForRules = vi
      .fn()
      .mockResolvedValue([makeOverride("2026-03-09T09:00:00", "2026-03-11T11:00:00")]);

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules,
        pages,
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
    expect(movedBlock(result.current, "2026-03-11T11:00:00")).toBeUndefined();
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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
        listOverridesForRules: NOOP_LIST_SCHEDULES,
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

// The IPC path is stale-while-revalidate: every batch resolves asynchronously and
// out-of-order arrivals are token-guarded. The default EXPAND above resolves
// synchronously, so it can't exercise the in-flight machinery — these hold the
// promise open by hand and assert each intermediate frame.
describe("useRecurrenceExpansion — async in-flight", () => {
  const isVirtual = (p: PageSummary | VirtualOccurrence): p is VirtualOccurrence =>
    "isVirtual" in p;

  // Settle a captured promise and let the hook's `.then` state update land, all
  // inside act so React flushes before the assertions.
  const flush = async (settle: () => void): Promise<void> => {
    await act(async () => {
      settle();
      await Promise.resolve();
    });
  };

  /** An expander that never resolves on its own; each call is captured so the test
   * settles it explicitly. `resolveReal` mirrors the real batch for the call's range. */
  function controllableExpand() {
    const calls: {
      rules: PageRecurrenceRule[];
      start: string;
      end: string;
      settle: (r: RawRuleExpansion[]) => void;
    }[] = [];
    const fn = vi.fn(
      (rules: PageRecurrenceRule[], start: string, end: string): Promise<RawRuleExpansion[]> =>
        new Promise((settle) => calls.push({ end, rules, settle, start }))
    );
    const resolveReal = (i: number): void => {
      const c = calls[i]!;
      c.settle(
        c.rules.map((rule) => ({
          occurrences: rawExpandRule(
            rule,
            DUMMY_PAGE,
            parseLocalISO(c.start),
            parseLocalISO(c.end)
          ),
          ruleId: rule.id,
        }))
      );
    };
    return { calls, fn, resolveReal };
  }

  it("renders pages-only before the first batch resolves, then adds virtuals (cold mount)", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const { calls, fn, resolveReal } = controllableExpand();

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: fn,
        listOverridesForRules: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [makeRule()],
      })
    );

    // rawExpansion === null this frame → pages only, no virtuals yet.
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(result.current.filter(isVirtual)).toHaveLength(0);
    expect(result.current).toEqual(pages);

    await flush(() => resolveReal(0));
    expect(result.current.filter(isVirtual)).toHaveLength(1);
  });

  it("discards a superseded batch that resolves after the current one (token guard)", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const { calls, fn, resolveReal } = controllableExpand();

    const { rerender, result } = renderHook(
      (props: { days: Date[] }) =>
        useRecurrenceExpansion({
          days: props.days,
          expandRecurrenceRange: fn,
          listOverridesForRules: NOOP_LIST_SCHEDULES,
          pages,
          recurrenceRules: [makeRule()],
        }),
      { initialProps: { days: weekDays(new Date(2026, 2, 2)) } }
    );
    await waitFor(() => expect(calls).toHaveLength(1)); // stale batch (week of Mar 2)

    rerender({ days: weekDays(new Date(2026, 2, 9)) });
    await waitFor(() => expect(calls).toHaveLength(2)); // current batch (week of Mar 9)

    // Current resolves first, then the stale earlier-week batch lands late.
    await flush(() => resolveReal(1));
    await flush(() =>
      calls[0]!.settle([
        {
          occurrences: [
            {
              originalDate: "2020-01-06",
              scheduledEnd: null,
              scheduledStart: "2020-01-06T09:00:00",
            },
          ],
          ruleId: "rule-1",
        },
      ])
    );

    const virtual = result.current.filter(isVirtual);
    expect(virtual).toHaveLength(1);
    expect(virtual[0]?.scheduledStart).toBe("2026-03-09T09:00:00");
    expect(virtual.some((v) => v.scheduledStart?.startsWith("2020"))).toBe(false);
  });

  it("retains the prior batch's virtuals across a range change until the next resolves", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const { calls, fn, resolveReal } = controllableExpand();

    const { rerender, result } = renderHook(
      (props: { days: Date[] }) =>
        useRecurrenceExpansion({
          days: props.days,
          expandRecurrenceRange: fn,
          listOverridesForRules: NOOP_LIST_SCHEDULES,
          pages,
          recurrenceRules: [makeRule()],
        }),
      { initialProps: { days: weekDays(new Date(2026, 2, 9)) } }
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    await flush(() => resolveReal(0));
    expect(result.current.filter(isVirtual)).toHaveLength(1);

    // Day-step nav (Mar 10–16 overlaps Mar 9–15). rawExpansion is NOT reset to
    // null, so the retained map keeps rendering virtuals while the new batch is
    // in flight — no empty frame.
    rerender({ days: weekDays(new Date(2026, 2, 10)) });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(result.current.filter(isVirtual)).toHaveLength(1);

    await flush(() => resolveReal(1));
    expect(result.current.filter(isVirtual)).toHaveLength(1);
  });

  it("reflects an optimistic completion with no extra expand call (pages change, range/rules unchanged)", async () => {
    const rule = makeRule();
    const { calls, fn, resolveReal } = controllableExpand();
    const basePages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];

    const { rerender, result } = renderHook(
      (props: { pages: PageSummary[] }) =>
        useRecurrenceExpansion({
          days: weekDays(new Date(2026, 2, 9)),
          expandRecurrenceRange: fn,
          listOverridesForRules: NOOP_LIST_SCHEDULES,
          pages: props.pages,
          recurrenceRules: [rule],
        }),
      { initialProps: { pages: basePages } }
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    await flush(() => resolveReal(0));
    expect(result.current.filter(isVirtual)).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);

    // Optimistic completion of the Mar 9 virtual: the page gains a
    // completedOccurrences entry. The virtual must drop synchronously, with zero
    // new expand round-trips (pages isn't in the effect's dep set).
    rerender({
      pages: [
        makePage({
          completedOccurrences: { "2026-03-09": "clone-1" },
          scheduledStart: "2026-03-02T09:00:00",
        }),
      ],
    });

    expect(result.current.filter(isVirtual)).toHaveLength(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
