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

import {
  ExpansionHold,
  usePreloadRecurrenceExpansion,
  useRecurrenceExpansion,
} from "./useRecurrenceExpansion";

// Stand-in for the batched Rust command, delegating to the `rawExpandRule` the backend mirrors.
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
    detachIsReversible: false,
    folderId: null,
    id: "page-1",
    isRecurring: false,
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

/** The real, completable block a moved synced override renders, distinct from a recurring virtual. */
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

/** `scheduleLocked` is `sync_state = 'active'` alone, so the two move together; a detached page
 * keeps its `page_sync` row and loses the lock. */
const SYNCED = { scheduleLocked: true, syncState: "active" as const };
const DETACHED = { scheduleLocked: false, syncState: "detached" as const };

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
    const days = weekDays(new Date(2026, 2, 9));
    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days,
        expandRecurrenceRange: EXPAND,
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

  it("excludes the head's current date from virtual expansion (head renders as a real block)", async () => {
    // A virtual on top of the real head would render two stacked blocks for one occurrence.
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
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
      expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeDefined();
    });
  });

  it("suppresses only the head's own-date virtual — a pre-head open gap still renders", async () => {
    // Mar 10 is an open gap (neither completed nor skipped) and must survive: only the head's own
    // date is filtered.
    const head = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      scheduledStart: "2026-03-11T09:00:00",
    });
    const rule = makeRule({
      rrule: "FREQ=DAILY",
      scheduledEnd: "2026-03-02T10:00:00",
      scheduledStart: "2026-03-02T09:00:00",
    });
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
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-10"))).toBeDefined();
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-11"))).toBeUndefined();
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
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
  });

  it("excludes a synced override stored as full wall-clock (day-keyed)", async () => {
    // A synced timed override stores original_date as '...THH:MM:SS' but the occurrence key is
    // day-only, so the exclusion set must day-key it or Mar 9 ghosts beside the moved instance.
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
    // The override's moved scheduledStart lands weeks away, so only the by-rule fetch still
    // excludes the original slot.
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
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00", ...SYNCED })];
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
        days: weekDays(new Date(2026, 2, 9)),
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
      expect(moved?.scheduleLocked).toBe(true);
      expect((moved as { originalDate?: string }).originalDate).toBe("2026-03-09");
    });
    const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
    expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
  });

  it("renders a moved all-day synced override at its new date", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02", ...SYNCED })];
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
    // Mar 12 → Mar 13 (open) is the positive anchor: once it renders the whole batch was applied, so
    // the done Mar 10 override's absence is real and not an unresolved fetch.
    const pages = [
      makePage({
        completedOccurrences: { "2026-03-10": "clone-1" },
        scheduledStart: "2026-03-02T09:00:00",
        ...SYNCED,
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
        ...SYNCED,
        skippedOccurrences: ["2026-03-10"],
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

  it("does not render an override block for a native (never-synced) series", async () => {
    // Guards toOverrideBlocks' sync-origin gate: a page with no page_sync row gets no block. The
    // Mar 9 virtual dropping out signals the fetch applied.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
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

  it("refetches overrides when overridesVersion changes and renders the moved-in-place row's new time", async () => {
    // An in-place move leaves range, rule set and row id identical, so the version counter is the
    // only refetch trigger and the guard must compare schedule fields or the block snaps back.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00", ...DETACHED })];
    const rule = makeRule();
    const before = {
      ...makeOverride("2026-03-09T09:00:00", "2026-03-11T11:00:00", "2026-03-11T12:00:00"),
      id: "sched-in-place",
    };
    const after = {
      ...before,
      scheduledEnd: "2026-03-12T15:00:00",
      scheduledStart: "2026-03-12T14:00:00",
    };
    const listOverridesForRules = vi
      .fn()
      .mockResolvedValueOnce([before])
      .mockResolvedValue([after]);

    const { rerender, result } = renderHook(
      ({ version }: { version: number }) =>
        useRecurrenceExpansion({
          days: weekDays(new Date(2026, 2, 9)),
          expandRecurrenceRange: EXPAND,
          listOverridesForRules,
          overridesVersion: version,
          pages,
          recurrenceRules: [rule],
        }),
      { initialProps: { version: 0 } }
    );

    await waitFor(() => expect(movedBlock(result.current, "2026-03-11T11:00:00")).toBeDefined());
    rerender({ version: 0 });
    expect(listOverridesForRules).toHaveBeenCalledTimes(1);

    rerender({ version: 1 });
    await waitFor(() => expect(movedBlock(result.current, "2026-03-12T14:00:00")).toBeDefined());
    expect(movedBlock(result.current, "2026-03-11T11:00:00")).toBeUndefined();
    expect(listOverridesForRules).toHaveBeenCalledTimes(2);
  });

  it("still renders a detached series' override — unlocked, original slot suppressed", async () => {
    // Detaching drops scheduleLocked while toVirtuals still suppresses the original slot, so gating
    // on the lock would erase the occurrence entirely. The row is the user's now: unlocked.
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00", ...DETACHED })];
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
      const moved = movedBlock(result.current, "2026-03-11T11:00:00");
      expect(moved).toBeDefined();
      expect(moved?.scheduleLocked).toBe(false);
      expect((moved as { originalDate?: string }).originalDate).toBe("2026-03-09");
    });
    const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
    expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    expect(
      result.current.filter((p) => (p as { originalDate?: string }).originalDate === "2026-03-09")
    ).toHaveLength(1);
  });

  it("suppresses a synced series' head when its base occurrence is completed", async () => {
    const head = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      scheduledStart: "2026-03-09T09:00:00",
      ...SYNCED,
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
      expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeUndefined();
      expect(result.current.find((p) => p.id === "clone-1")).toBeDefined();
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
  });

  it("suppresses a native head on a completed base too (out-of-envelope rule) while its clone renders", async () => {
    // An engine-rejected rule never advances its head, so a native page can sit on a completed
    // base too: the un-gated headCompleted must drop it while its done clone stays.
    const head = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      detachIsReversible: false,
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
      expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeUndefined();
      expect(result.current.find((p) => p.id === "clone-1")).toBeDefined();
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual.find((v) => v.scheduledStart?.startsWith("2026-03-09"))).toBeUndefined();
    });
  });

  it("draws no head on a date the person skipped, however its key is written", async () => {
    const head = makePage({
      scheduledStart: "2026-03-13T09:00:00",
      skippedOccurrences: ["2026-03-13T09:00:00"],
      status: "done",
      ...SYNCED,
    });
    const rule = makeRule({ scheduledStart: "2026-03-09T09:00:00" });

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules: NOOP_LIST_SCHEDULES,
        pages: [head],
        recurrenceRules: [rule],
      })
    );

    await waitFor(() => {
      expect(result.current.some((p) => "isVirtual" in p)).toBe(true);
    });
    expect(result.current.find((p) => p.id === head.id && !("isVirtual" in p))).toBeUndefined();
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

  it("pairs each rule with its own overrides and the first row carrying its head's id", async () => {
    const pageA = makePage({
      id: "page-A",
      scheduledStart: "2026-03-02T09:00:00",
      title: "Monday Standup",
    });
    const pageB = makePage({ id: "page-B", scheduledStart: "2026-03-04T15:00:00" });
    const ruleA = makeRule({ id: "rule-A", pageId: "page-A" });
    const ruleB = makeRule({
      id: "rule-B",
      pageId: "page-B",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      scheduledEnd: "2026-03-04T16:00:00",
      scheduledStart: "2026-03-04T15:00:00",
    });
    const movedB = {
      ...makeOverride("2026-03-11", "2026-03-12T15:00:00"),
      pageId: "page-B",
      ruleId: "rule-B",
    };
    const pages = [
      makePage({ id: "other-1", title: "Unrelated" }),
      pageA,
      pageB,
      makePage({ id: "page-A", title: "A later row with the head's id" }),
    ];

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: EXPAND,
        listOverridesForRules: () => Promise.resolve([movedB]),
        pages,
        recurrenceRules: [ruleB, ruleA],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual).toHaveLength(1);
      expect(virtual[0]).toMatchObject({
        ruleId: "rule-A",
        scheduledStart: "2026-03-09T09:00:00",
        title: "Monday Standup",
      });
    });
  });

  it("renders no virtuals for a rule the engine omitted (out-of-envelope)", async () => {
    // The engine omits a rejected rule and there is no second engine to fall back to, so the series
    // contributes nothing while other rules still render.
    const pages = [
      makePage({ id: "page-A", scheduledStart: "2026-03-02T09:00:00" }),
      makePage({ id: "page-B", scheduledStart: "2026-03-04T15:00:00" }),
    ];
    const ruleA = makeRule({ id: "rule-A", pageId: "page-A" });
    const ruleB = makeRule({
      id: "rule-B",
      pageId: "page-B",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      scheduledEnd: "2026-03-04T16:00:00",
      scheduledStart: "2026-03-04T15:00:00",
    });
    const omitA = (
      rules: PageRecurrenceRule[],
      startStr: string,
      endStr: string
    ): Promise<RawRuleExpansion[]> =>
      EXPAND(
        rules.filter((r) => r.id !== "rule-A"),
        startStr,
        endStr
      );

    const { result } = renderHook(() =>
      useRecurrenceExpansion({
        days: weekDays(new Date(2026, 2, 9)),
        expandRecurrenceRange: omitA,
        listOverridesForRules: NOOP_LIST_SCHEDULES,
        pages,
        recurrenceRules: [ruleA, ruleB],
      })
    );

    await waitFor(() => {
      const virtual = result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
      expect(virtual).toHaveLength(1);
      expect(virtual[0]?.ruleId).toBe("rule-B");
    });
  });
});

// The IPC path is stale-while-revalidate with token-guarded out-of-order arrivals. The default
// EXPAND resolves synchronously, so these hold the promise open by hand.
describe("useRecurrenceExpansion — async in-flight", () => {
  const isVirtual = (p: PageSummary | VirtualOccurrence): p is VirtualOccurrence =>
    "isVirtual" in p;

  const flush = async (settle: () => void): Promise<void> => {
    await act(async () => {
      settle();
      await Promise.resolve();
    });
  };

  /** An expander that never resolves on its own; each call is captured for the test to settle. */
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
    await waitFor(() => expect(calls).toHaveLength(1));

    rerender({ days: weekDays(new Date(2026, 2, 9)) });
    await waitFor(() => expect(calls).toHaveLength(2));

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

    // rawExpansion is NOT reset to null, so the retained map keeps rendering virtuals while the new
    // batch is in flight.
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

    // The virtual must drop synchronously with zero new expand round-trips: pages isn't in the
    // effect's dep set.
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
  // A synced series' rule base is the provider's original DTSTART, so range-only expansion would
  // paint it into every past week, from a period whose cancellations were never fetched.
  // `syncedSince` bounds it at the same anchor.
  describe("synced render floor", () => {
    const virtualsFor = async (over: Partial<PageSummary>) => {
      const { result } = renderHook(() =>
        useRecurrenceExpansion({
          days: weekDays(new Date(2026, 2, 9)),
          expandRecurrenceRange: EXPAND,
          listOverridesForRules: NOOP_LIST_SCHEDULES,
          pages: [makePage({ scheduledStart: "2026-03-02T09:00:00", ...over })],
          recurrenceRules: [makeRule()],
        })
      );
      await waitFor(() => expect(result.current).toBeDefined());
      return () => result.current.filter((p): p is VirtualOccurrence => "isVirtual" in p);
    };

    it("drops an occurrence before the day the page first synced", async () => {
      const virtuals = await virtualsFor({ ...SYNCED, syncedSince: "2026-03-16" });
      await waitFor(() => expect(virtuals()).toHaveLength(0));
    });

    it("keeps an occurrence on that day — the floor is inclusive", async () => {
      const virtuals = await virtualsFor({ ...SYNCED, syncedSince: "2026-03-09" });
      await waitFor(() => {
        expect(virtuals()).toHaveLength(1);
        expect(virtuals()[0]?.scheduledStart).toBe("2026-03-09T09:00:00");
      });
    });

    it("leaves a native series alone — it carries no floor", async () => {
      const virtuals = await virtualsFor({});
      await waitFor(() => expect(virtuals()).toHaveLength(1));
    });
  });

  it("with a margin, a step to the next week shows its occurrences without a fetch", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00" })];
    const expand = vi.fn(EXPAND);
    const { rerender, result } = renderHook(
      ({ days }: { days: Date[] }) =>
        useRecurrenceExpansion({
          days,
          expandRecurrenceRange: expand,
          listOverridesForRules: NOOP_LIST_SCHEDULES,
          margin: 7,
          pages,
          recurrenceRules: [makeRule()],
        }),
      { initialProps: { days: weekDays(new Date(2026, 2, 9)) } }
    );
    const starts = () =>
      result.current
        .filter((p): p is VirtualOccurrence => "isVirtual" in p)
        .map((p) => p.scheduledStart);
    await waitFor(() => expect(starts()).toEqual(["2026-03-09T09:00:00"]));
    expect(expand).toHaveBeenLastCalledWith(expect.anything(), "2026-03-02", "2026-03-23");

    rerender({ days: weekDays(new Date(2026, 2, 16)) });
    expect(starts()).toEqual(["2026-03-16T09:00:00"]);
    await waitFor(() => expect(expand).toHaveBeenCalledTimes(2));
    expect(expand).toHaveBeenLastCalledWith(expect.anything(), "2026-03-09", "2026-03-30");
  });

  it("a remount sharing a hold draws its occurrences and moved rows in the first frame", async () => {
    const pages = [makePage({ scheduledStart: "2026-03-02T09:00:00", ...SYNCED })];
    const hold = new ExpansionHold();
    const expand = vi.fn(EXPAND);
    const listOverrides = vi.fn(() =>
      Promise.resolve([makeOverride("2026-03-16", "2026-03-17T14:00:00")])
    );
    const renders: (PageSummary | VirtualOccurrence)[][] = [];
    const mount = () =>
      renderHook(() => {
        const out = useRecurrenceExpansion({
          days: weekDays(new Date(2026, 2, 16)),
          expandRecurrenceRange: expand,
          hold,
          listOverridesForRules: listOverrides,
          margin: 7,
          pages,
          recurrenceRules: [makeRule()],
        });
        renders.push(out);
        return out;
      });
    const first = mount();
    await waitFor(() =>
      expect(movedBlock(first.result.current, "2026-03-17T14:00:00")).toBeDefined()
    );
    const settled = first.result.current;
    first.unmount();
    renders.length = 0;

    mount();

    expect(renders[0]).toEqual(settled);
    await waitFor(() => expect(listOverrides).toHaveBeenCalledTimes(2));
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("a hold preloaded while the surface was hidden draws its occurrences in the first frame", async () => {
    const hold = new ExpansionHold();
    const expand = vi.fn(EXPAND);
    const loads = {
      days: weekDays(new Date(2026, 2, 16)),
      expandRecurrenceRange: expand,
      hold,
      listOverridesForRules: NOOP_LIST_SCHEDULES,
      margin: 7,
      recurrenceRules: [makeRule()],
    };
    renderHook(() => usePreloadRecurrenceExpansion(loads));
    await waitFor(() => expect(hold.window()).not.toBeNull());
    const renders: (PageSummary | VirtualOccurrence)[][] = [];

    renderHook(() => {
      const out = useRecurrenceExpansion({
        ...loads,
        pages: [makePage({ scheduledStart: "2026-03-02T09:00:00" })],
      });
      renders.push(out);
      return out;
    });

    expect(renders[0]!.some((p) => "isVirtual" in p)).toBe(true);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("a preload beside the surface it fills fetches once", async () => {
    const hold = new ExpansionHold();
    const expand = vi.fn(EXPAND);
    const listOverrides = vi.fn(NOOP_LIST_SCHEDULES);
    const loads = {
      days: weekDays(new Date(2026, 2, 16)),
      expandRecurrenceRange: expand,
      hold,
      listOverridesForRules: listOverrides,
      margin: 7,
      recurrenceRules: [makeRule()],
    };

    const { result } = renderHook(() => {
      usePreloadRecurrenceExpansion(loads);
      return useRecurrenceExpansion({
        ...loads,
        pages: [makePage({ scheduledStart: "2026-03-02T09:00:00" })],
      });
    });

    await waitFor(() => expect(result.current.some((p) => "isVirtual" in p)).toBe(true));
    expect(expand).toHaveBeenCalledTimes(1);
    expect(listOverrides).toHaveBeenCalledTimes(1);
  });

  it("keeps an occurrence's object while its series is unchanged, and builds a new one when it changes", async () => {
    const head = makePage({ scheduledStart: "2026-03-02T09:00:00" });
    const days = weekDays(new Date(2026, 2, 9));
    const { rerender, result } = renderHook(
      ({ pages }: { pages: PageSummary[] }) =>
        useRecurrenceExpansion({
          days,
          expandRecurrenceRange: EXPAND,
          listOverridesForRules: NOOP_LIST_SCHEDULES,
          pages,
          recurrenceRules: [makeRule()],
        }),
      { initialProps: { pages: [head] } }
    );
    const occurrence = () => result.current.find((p): p is VirtualOccurrence => "isVirtual" in p);
    await waitFor(() => expect(occurrence()).toBeDefined());
    const first = occurrence();

    rerender({ pages: [head] });
    expect(occurrence()).toBe(first);

    rerender({ pages: [{ ...head, title: "Standup, renamed" }] });
    expect(occurrence()).not.toBe(first);
    expect(occurrence()?.title).toBe("Standup, renamed");
  });
});
