import { describe, expect, it } from "vitest";

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "../types";
import { expandRecurrenceForRange } from "./recurrence";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    scheduledEnd: "2026-03-02T10:00:00", // Monday 10am
    scheduledStart: "2026-03-02T09:00:00", // Monday 9am
    timezone: "America/New_York",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("expandRecurrenceForRange", () => {
  it("expands weekly recurrence for a one-week range", () => {
    const page = makePage();
    const rule = makeRule();

    // Range: Mon Mar 2 – Sun Mar 8
    const rangeStart = new Date(2026, 2, 2); // March 2
    const rangeEnd = new Date(2026, 2, 9); // March 9 (exclusive)

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.scheduledStart).toBe("2026-03-02T09:00:00");
    expect(occurrences[0]!.scheduledEnd).toBe("2026-03-02T10:00:00");
    expect(occurrences[0]!.isVirtual).toBe(true);
    expect(occurrences[0]!.ruleId).toBe("rule-1");
    expect(occurrences[0]!.originalDate).toBe("2026-03-02");
    expect(occurrences[0]!.title).toBe("Standup");
  });

  it("expands multiple weeks", () => {
    const page = makePage();
    const rule = makeRule();

    // Range: 3 weeks
    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 23);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((o) => o.originalDate)).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
    ]);
  });

  it("excludes dates in rruleExdates", () => {
    const page = makePage();
    const rule = makeRule({ rruleExdates: ["2026-03-09"] });

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 23);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-16"]);
  });

  it("excludes dates with materialised override schedules", () => {
    const page = makePage();
    const rule = makeRule();

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

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 23);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd, [
      overrideSchedule,
    ]);

    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-16"]);
  });

  it("handles all-day recurrence", () => {
    const page = makePage();
    const { scheduledEnd: _removed, ...base } = makeRule();
    const rule: PageRecurrenceRule = {
      ...base,
      scheduledStart: "2026-03-02", // date-only = all-day
    };

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 9);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.scheduledStart).toBe("2026-03-02");
    expect(occurrences[0]!.scheduledEnd).toBeNull();
  });

  it("handles daily recurrence", () => {
    const page = makePage();
    const rule = makeRule({
      rrule: "FREQ=DAILY",
      scheduledEnd: "2026-03-02T09:30:00",
      scheduledStart: "2026-03-02T09:00:00",
    });

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 5);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences).toHaveLength(3);
    // Each occurrence preserves 30-min duration
    for (const occ of occurrences) {
      expect(occ.scheduledStart).toMatch(/T09:00:00$/);
      expect(occ.scheduledEnd).toMatch(/T09:30:00$/);
    }
  });

  it("returns empty array when no occurrences in range", () => {
    const page = makePage();
    const rule = makeRule(); // Monday only

    // Range: Tue–Thu only
    const rangeStart = new Date(2026, 2, 3);
    const rangeEnd = new Date(2026, 2, 6);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences).toHaveLength(0);
  });

  it("preserves page metadata on virtual occurrences", () => {
    const page = makePage({
      folderId: "folder-x",
      id: "pg-42",
      priority: 2,
      tags: ["work", "review"],
      title: "Weekly Review",
    });
    const rule = makeRule({ pageId: "pg-42" });

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 9);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences[0]!.id).toBe("pg-42");
    expect(occurrences[0]!.folderId).toBe("folder-x");
    expect(occurrences[0]!.priority).toBe(2);
    expect(occurrences[0]!.tags).toEqual(["work", "review"]);
  });
});
