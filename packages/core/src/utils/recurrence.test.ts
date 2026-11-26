import { describe, expect, it } from "vitest";

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "../types";
import {
  alignWeeklyRuleToAnchor,
  buildRrule,
  computeNextEnd,
  expandRecurrenceForRange,
  nextOccurrenceAfter,
  optionsForFreq,
  optionsWithEnd,
  parseRrule,
  rruleEditWouldDegrade,
  rruleToLabel,
  rruleToShortLabel,
  snapAnchorToRule,
} from "./recurrence";

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    detachIsReversible: false,
    folderId: null,
    id: "page-1",
    isRecurring: true,
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

describe("expandRecurrenceForRange", () => {
  it("expands weekly recurrence for a one-week range", () => {
    const page = makePage();
    const rule = makeRule();

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 9);

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

  it("excludes a synced timed exdate stored as full wall-clock (day-keyed)", () => {
    // A synced cancelled instance stores its exdate as full wall clock; without day-keying Mar 9 ghosts.
    const page = makePage();
    const rule = makeRule({ rruleExdates: ["2026-03-09T09:00:00"] });

    const occurrences = expandRecurrenceForRange(
      rule,
      page,
      new Date(2026, 2, 2),
      new Date(2026, 2, 23)
    );

    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-16"]);
  });

  it("excludes dates completed on a recurring series (completedOccurrences)", () => {
    const page = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      detachIsReversible: false,
      scheduleLocked: true,
    });
    const rule = makeRule();

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 23);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-16"]);
  });

  it("excludes an exdate AND a completed occurrence in the same expansion", () => {
    const page = makePage({
      completedOccurrences: { "2026-03-16": "clone-1" },
      detachIsReversible: false,
      scheduleLocked: true,
    });
    const rule = makeRule({ rruleExdates: ["2026-03-09"] });

    const occurrences = expandRecurrenceForRange(
      rule,
      page,
      new Date(2026, 2, 2),
      new Date(2026, 2, 30)
    );

    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-23"]);
  });

  it("excludes completedOccurrences on a native/detached series too", () => {
    const page = makePage({
      completedOccurrences: { "2026-03-09": "clone-1" },
      detachIsReversible: false,
      scheduleLocked: false,
    });
    const rule = makeRule();

    const occurrences = expandRecurrenceForRange(
      rule,
      page,
      new Date(2026, 2, 2),
      new Date(2026, 2, 23)
    );

    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-16"]);
  });

  it("excludes skippedOccurrences from expansion", () => {
    const page = makePage({ scheduleLocked: false, skippedOccurrences: ["2026-03-09"] });
    const rule = makeRule();

    const occurrences = expandRecurrenceForRange(
      rule,
      page,
      new Date(2026, 2, 2),
      new Date(2026, 2, 23)
    );

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

  it("excludes a synced override whose original_date is full wall-clock (day-keyed)", () => {
    // A synced moved instance stores original_date as full wall clock; day-keying excludes the original slot.
    const page = makePage();
    const rule = makeRule();
    const overrideSchedule: PageSchedule = {
      createdAt: "2026-01-01T00:00:00",
      id: "sched-override-timed",
      originalDate: "2026-03-09T09:00:00",
      pageId: "page-1",
      ruleId: "rule-1",
      scheduledEnd: "2026-03-16T12:00:00",
      scheduledStart: "2026-03-16T11:00:00",
      status: "not_started",
      timezone: "America/New_York",
    };

    const occurrences = expandRecurrenceForRange(
      rule,
      page,
      new Date(2026, 2, 2),
      new Date(2026, 2, 23),
      [overrideSchedule]
    );

    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-16"]);
  });

  it("handles all-day recurrence", () => {
    const page = makePage();
    const { scheduledEnd: _removed, ...base } = makeRule();
    const rule: PageRecurrenceRule = {
      ...base,
      scheduledStart: "2026-03-02",
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
    for (const occ of occurrences) {
      expect(occ.scheduledStart).toMatch(/T09:00:00$/);
      expect(occ.scheduledEnd).toMatch(/T09:30:00$/);
    }
  });

  it("returns empty array when no occurrences in range", () => {
    const page = makePage();
    const rule = makeRule();

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

  it("biweekly INTERVAL=2 skips alternate weeks", () => {
    const page = makePage();
    const rule = makeRule({ rrule: "FREQ=WEEKLY;BYDAY=MO;INTERVAL=2" });

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 3, 13);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);

    expect(occurrences.map((o) => o.originalDate)).toEqual([
      "2026-03-02",
      "2026-03-16",
      "2026-03-30",
    ]);
  });

  it("returns empty when range is entirely after UNTIL", () => {
    const page = makePage();
    const rule = makeRule({
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260309T235959Z",
    });

    const rangeStart = new Date(2026, 2, 16);
    const rangeEnd = new Date(2026, 2, 30);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);
    expect(occurrences).toHaveLength(0);
  });

  it("expansion is bounded by COUNT — no occurrences past the Nth", () => {
    const page = makePage();
    const rule = makeRule({ rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=2" });

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 30);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);
    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-09"]);
  });

  it("does not generate occurrences before the rule's scheduledStart", () => {
    const page = makePage();
    const rule = makeRule();

    const rangeStart = new Date(2026, 1, 23);
    const rangeEnd = new Date(2026, 2, 9);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);
    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02"]);
  });
});

describe("nextOccurrenceAfter", () => {
  it("returns next Monday after a given date", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2)
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-09");
    expect(result!.scheduledStart).toContain("09:00");
  });

  it("skips missed occurrences — returns next future from afterDate", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 18)
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-23");
    expect(result!.scheduledStart).toContain("09:00");
  });

  it("handles all-day recurrence", () => {
    const result = nextOccurrenceAfter("FREQ=WEEKLY;BYDAY=FR", "2026-03-06", new Date(2026, 2, 6));

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toBe("2026-03-13");
    expect(result!.scheduledEnd).toBeNull();
  });

  it("handles daily recurrence", () => {
    const result = nextOccurrenceAfter("FREQ=DAILY", "2026-03-02T08:00:00", new Date(2026, 2, 5));

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-06");
    expect(result!.scheduledStart).toContain("08:00");
  });

  it("returns null when UNTIL has passed", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260310T000000Z",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 15)
    );

    expect(result).toBeNull();
  });

  it("returns null when COUNT has been exhausted (weekly BYDAY)", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO;COUNT=2",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 9, 23, 59)
    );

    expect(result).toBeNull();
  });

  it("returns null when COUNT is exhausted (daily, single occurrence)", () => {
    const result = nextOccurrenceAfter(
      "FREQ=DAILY;COUNT=1",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2)
    );

    expect(result).toBeNull();
  });

  it("returns next within COUNT bound when not yet exhausted", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 5)
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-09");
  });

  it("returns the final occurrence when COUNT > 1 and we ask after the second-to-last", () => {
    const result = nextOccurrenceAfter(
      "FREQ=DAILY;COUNT=3",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 3)
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-04");
  });

  // Advance must skip exdates, or the head lands on a date that already has its own page and the
  // day shows two chips.

  it("skips a single exdate when advancing", () => {
    const result = nextOccurrenceAfter("FREQ=DAILY", "2026-03-02T09:00:00", new Date(2026, 2, 2), [
      "2026-03-03",
    ]);

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-04");
  });

  it("skips multiple consecutive exdates", () => {
    const result = nextOccurrenceAfter("FREQ=DAILY", "2026-03-02T09:00:00", new Date(2026, 2, 2), [
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-06");
  });

  it("ignores exdates that don't match a rule-generated date", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2),
      ["2026-03-05"]
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-09");
  });

  it("preserves wall-clock time after skipping an exdate", () => {
    const result = nextOccurrenceAfter("FREQ=DAILY", "2026-03-02T09:00:00", new Date(2026, 2, 2), [
      "2026-03-03",
    ]);

    expect(result!.scheduledStart).toContain("09:00");
  });

  it("returns null when every remaining occurrence within COUNT is excluded", () => {
    const result = nextOccurrenceAfter(
      "FREQ=DAILY;COUNT=3",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2),
      ["2026-03-03", "2026-03-04"]
    );

    expect(result).toBeNull();
  });

  it("completing same day returns next week, not same day", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2, 8, 0)
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-09");
  });
});

describe("snapAnchorToRule", () => {
  it("moves a Sunday anchor onto the first allowed weekday for an M/W/F rule", () => {
    expect(snapAnchorToRule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-06-07")).toBe("2026-06-08");
  });

  it("leaves an anchor untouched when it already satisfies the rule", () => {
    expect(snapAnchorToRule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-06-08")).toBe("2026-06-08");
  });

  it("snaps a weekend anchor onto Monday for an every-weekday rule", () => {
    expect(snapAnchorToRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-06-07")).toBe("2026-06-08");
  });

  it("preserves the wall-clock time when snapping a timed anchor", () => {
    expect(snapAnchorToRule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-06-07T09:30:00")).toBe(
      "2026-06-08T09:30:00"
    );
  });

  it("leaves a daily rule's anchor untouched (every day is permitted)", () => {
    expect(snapAnchorToRule("FREQ=DAILY", "2026-06-07")).toBe("2026-06-07");
  });

  it("leaves a monthly rule's anchor untouched", () => {
    expect(snapAnchorToRule("FREQ=MONTHLY", "2026-06-07")).toBe("2026-06-07");
  });

  it("returns the anchor unchanged when the rule yields no occurrence on/after it", () => {
    expect(snapAnchorToRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260610T235959Z", "2026-06-09")).toBe(
      "2026-06-09"
    );
  });

  it("returns the anchor unchanged for an unparseable rrule", () => {
    expect(snapAnchorToRule("not-a-rule", "2026-06-07")).toBe("2026-06-07");
  });
});

describe("alignWeeklyRuleToAnchor", () => {
  it("rewrites a single-BYDAY weekly rule to the moved weekday", () => {
    expect(alignWeeklyRuleToAnchor("FREQ=WEEKLY;BYDAY=MO", "2099-01-07")).toBe(
      "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE"
    );
  });

  it("preserves the wall-clock anchor's weekday for timed anchors", () => {
    expect(alignWeeklyRuleToAnchor("FREQ=WEEKLY;BYDAY=MO", "2099-01-07T09:00:00")).toBe(
      "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE"
    );
  });

  it("returns the rule unchanged when the anchor is already on the BYDAY weekday", () => {
    expect(alignWeeklyRuleToAnchor("FREQ=WEEKLY;BYDAY=MO", "2099-01-05T14:00:00")).toBe(
      "FREQ=WEEKLY;BYDAY=MO"
    );
  });

  it("preserves interval and end conditions when realigning", () => {
    expect(alignWeeklyRuleToAnchor("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=10", "2099-01-07")).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=10"
    );
  });

  it("leaves multi-day weekly rules untouched (ambiguous to realign)", () => {
    expect(alignWeeklyRuleToAnchor("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2099-01-06")).toBe(
      "FREQ=WEEKLY;BYDAY=MO,WE,FR"
    );
  });

  it("leaves non-weekly rules untouched", () => {
    expect(alignWeeklyRuleToAnchor("FREQ=DAILY", "2099-01-07")).toBe("FREQ=DAILY");
    expect(alignWeeklyRuleToAnchor("FREQ=MONTHLY", "2099-01-07")).toBe("FREQ=MONTHLY");
  });

  it("leaves a weekly rule with no BYDAY untouched (already anchor-driven)", () => {
    expect(alignWeeklyRuleToAnchor("FREQ=WEEKLY", "2099-01-07")).toBe("FREQ=WEEKLY");
  });
});

describe("computeNextEnd", () => {
  it("preserves end time on new date", () => {
    const result = computeNextEnd("2026-03-02T10:00:00", "2026-03-09T09:00:00");
    expect(result).toBe("2026-03-09T10:00:00");
  });

  it("returns null for all-day events", () => {
    const result = computeNextEnd("2026-03-02", "2026-03-09");
    expect(result).toBeNull();
  });

  it("handles end time earlier than start time (wraps to next day)", () => {
    const result = computeNextEnd("2026-03-03T01:00:00", "2026-03-09T22:00:00");
    expect(result).toBe("2026-03-10T01:00:00");
  });
});

describe("rruleToLabel", () => {
  it("converts FREQ=WEEKLY;BYDAY=MO to human-readable", () => {
    expect(rruleToLabel("FREQ=WEEKLY;BYDAY=MO")).toBe("every week on Monday");
  });

  it("falls back to raw string on invalid input", () => {
    expect(rruleToLabel("INVALID_RRULE")).toBe("INVALID_RRULE");
  });

  it("restores the position rrule.js drops from BYSETPOS", () => {
    expect(rruleToLabel("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3")).toBe("every month on the 3rd Friday");
  });

  it("reads a negative BYSETPOS as 'last'", () => {
    expect(rruleToLabel("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1")).toBe(
      "every month on the last Friday"
    );
  });

  it("collapses a weekday set to 'last weekday'", () => {
    expect(rruleToLabel("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")).toBe(
      "every month on the last weekday"
    );
  });

  it("collapses an all-days set to 'day'", () => {
    expect(rruleToLabel("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYSETPOS=1")).toBe(
      "every month on the 1st day"
    );
  });

  it("joins an arbitrary day set with 'or'", () => {
    expect(rruleToLabel("FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1")).toBe(
      "every month on the 1st Saturday or Sunday"
    );
  });

  it("joins multiple positions", () => {
    expect(rruleToLabel("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=1,3")).toBe(
      "every month on the 1st or 3rd Friday"
    );
  });

  it("keeps rrule's interval and end-condition wording", () => {
    expect(rruleToLabel("FREQ=MONTHLY;INTERVAL=2;BYDAY=FR;BYSETPOS=3;COUNT=10")).toBe(
      "every 2 months on the 3rd Friday for 10 times"
    );
    expect(rruleToLabel("FREQ=YEARLY;BYMONTH=3;BYDAY=SU;BYSETPOS=-1")).toBe(
      "every March on the last Sunday"
    );
  });

  it("leaves a rule without BYSETPOS untouched", () => {
    expect(rruleToLabel("FREQ=MONTHLY;BYDAY=3FR")).toBe("every month on the 3rd Friday");
    expect(rruleToLabel("FREQ=MONTHLY;BYMONTHDAY=15")).toBe("every month on the 15th");
  });
});

describe("rruleEditWouldDegrade", () => {
  it.each([
    ["BYWEEKNO", "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO"],
    ["BYYEARDAY", "FREQ=YEARLY;BYYEARDAY=100"],
    ["a sub-daily BY* term", "FREQ=DAILY;BYHOUR=9"],
    ["an unparseable rule", "FREQ=NONSENSE"],
    ["a BYMONTH outside 1–12, which the carrier normalises away", "FREQ=YEARLY;BYMONTH=13"],
    ["a UTC UNTIL mid-day", "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T090000Z"],
    [
      "a wall-clock UNTIL mid-day, as the reconciler rewrites it",
      "FREQ=DAILY;UNTIL=20261231T060000",
    ],
    [
      "COUNT beside UNTIL, of which only COUNT is rebuilt",
      "FREQ=DAILY;COUNT=90;UNTIL=20260304T235959",
    ],
  ])("locks %s", (_term, rrule) => {
    expect(rruleEditWouldDegrade(rrule)).toBe(true);
  });

  it.each([
    ["a plain weekly rule", "FREQ=WEEKLY;BYDAY=MO,WE,FR"],
    ["BYMONTHDAY", "FREQ=MONTHLY;BYMONTHDAY=15"],
    ["a positional BYDAY ordinal (3rd Tuesday)", "FREQ=MONTHLY;BYDAY=3TU"],
    ["a from-end BYDAY ordinal (last Friday)", "FREQ=MONTHLY;BYDAY=-1FR"],
    ["an ordinal on one weekday of a BYDAY set", "FREQ=MONTHLY;BYDAY=MO,2WE"],
    ["BYMONTH (15 March, annually)", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15"],
    ["BYMONTH beside a weekly BYDAY", "FREQ=WEEKLY;BYDAY=MO;BYMONTH=6,7"],
    ["BYSETPOS", "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3"],
    ["a from-end BYSETPOS over a weekday set", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"],
    ["WKST", "FREQ=WEEKLY;BYDAY=SA,SU;WKST=SU"],
    ["an explicit + on BYMONTHDAY", "FREQ=MONTHLY;BYMONTHDAY=+15"],
    ["an explicit + on a BYDAY ordinal", "FREQ=MONTHLY;BYDAY=+1MO"],
    ["an explicit + on BYSETPOS", "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=+3"],
    [
      "a date-only UNTIL, which ends an all-day series at the same occurrence",
      "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260315",
    ],
    [
      "a floating end-of-day UNTIL, the form the editor writes",
      "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959",
    ],
    [
      "an end-of-day UNTIL still carrying the legacy Z",
      "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z",
    ],
    ["an explicit INTERVAL=1", "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"],
    ["a reordered BYDAY set", "FREQ=WEEKLY;BYDAY=FR,MO,WE"],
  ])("leaves %s editable", (_term, rrule) => {
    expect(rruleEditWouldDegrade(rrule)).toBe(false);
  });
});

describe("optionsWithEnd", () => {
  it("keeps bymonthday when setting a count", () => {
    const options = parseRrule("FREQ=MONTHLY;BYMONTHDAY=15")!;
    expect(optionsWithEnd(options, { count: 10 })).toEqual({
      bymonthday: [15],
      count: 10,
      freq: "MONTHLY",
      interval: 1,
    });
  });

  it("keeps bysetpos and wkst when setting an until", () => {
    const options = parseRrule("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3;WKST=SU")!;
    expect(optionsWithEnd(options, { until: "2026-12-31" })).toEqual({
      bysetpos: [3],
      byweekday: [4],
      freq: "MONTHLY",
      interval: 1,
      until: "2026-12-31",
      wkst: 6,
    });
  });

  it("swaps until for count rather than carrying both", () => {
    const options = parseRrule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z")!;
    const next = optionsWithEnd(options, { count: 4 });
    expect(next.count).toBe(4);
    expect(next.until).toBeUndefined();
  });

  it("clears both on a null end", () => {
    const options = parseRrule("FREQ=WEEKLY;BYDAY=MO;COUNT=5")!;
    const next = optionsWithEnd(options, null);
    expect(next.count).toBeUndefined();
    expect(next.until).toBeUndefined();
    expect(buildRrule(next)).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO");
  });
});

describe("rruleToShortLabel", () => {
  it("FREQ=DAILY → Daily", () => {
    expect(rruleToShortLabel("FREQ=DAILY")).toBe("Daily");
  });

  it("FREQ=WEEKLY → Weekly (drops BYDAY)", () => {
    expect(rruleToShortLabel("FREQ=WEEKLY;BYDAY=MO")).toBe("Weekly");
  });

  it("FREQ=MONTHLY → Monthly", () => {
    expect(rruleToShortLabel("FREQ=MONTHLY")).toBe("Monthly");
  });

  it("FREQ=YEARLY → Yearly", () => {
    expect(rruleToShortLabel("FREQ=YEARLY")).toBe("Yearly");
  });

  it("interval > 1 → Every N <unit>", () => {
    expect(rruleToShortLabel("FREQ=WEEKLY;INTERVAL=2")).toBe("Every 2 weeks");
    expect(rruleToShortLabel("FREQ=DAILY;INTERVAL=3")).toBe("Every 3 days");
    expect(rruleToShortLabel("FREQ=MONTHLY;INTERVAL=6")).toBe("Every 6 months");
  });

  it("COUNT → appends × N", () => {
    expect(rruleToShortLabel("FREQ=WEEKLY;BYDAY=MO;COUNT=10")).toBe("Weekly × 10");
    expect(rruleToShortLabel("FREQ=DAILY;COUNT=5")).toBe("Daily × 5");
  });

  it("UNTIL → appends thru <MMM d>", () => {
    expect(rruleToShortLabel("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260628T235959Z")).toBe(
      "Weekly thru Jun 28"
    );
    expect(rruleToShortLabel("FREQ=DAILY;UNTIL=20260105T235959Z")).toBe("Daily thru Jan 5");
  });

  it("interval > 1 with COUNT", () => {
    expect(rruleToShortLabel("FREQ=WEEKLY;INTERVAL=2;COUNT=4")).toBe("Every 2 weeks × 4");
  });

  it("falls back to raw string on invalid input", () => {
    expect(rruleToShortLabel("INVALID_RRULE")).toBe("INVALID_RRULE");
  });
});

describe("parseRrule", () => {
  it("parses FREQ and defaults interval to 1", () => {
    expect(parseRrule("FREQ=DAILY")).toEqual({ freq: "DAILY", interval: 1 });
    expect(parseRrule("FREQ=WEEKLY")).toEqual({ freq: "WEEKLY", interval: 1 });
    expect(parseRrule("FREQ=MONTHLY")).toEqual({ freq: "MONTHLY", interval: 1 });
    expect(parseRrule("FREQ=YEARLY")).toEqual({ freq: "YEARLY", interval: 1 });
  });

  it("parses explicit interval", () => {
    expect(parseRrule("FREQ=WEEKLY;INTERVAL=3")).toEqual({ freq: "WEEKLY", interval: 3 });
  });

  it("parses BYDAY using rrule.js 0=Monday indexing", () => {
    const result = parseRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(result?.byweekday).toEqual([0, 2, 4]);
  });

  it("parses COUNT end condition", () => {
    const result = parseRrule("FREQ=DAILY;COUNT=10");
    expect(result).toEqual({ count: 10, freq: "DAILY", interval: 1 });
    expect(result?.until).toBeUndefined();
  });

  it("parses UNTIL end condition as YYYY-MM-DD", () => {
    const result = parseRrule("FREQ=WEEKLY;UNTIL=20260615T235959Z");
    expect(result?.until).toBe("2026-06-15");
    expect(result?.count).toBeUndefined();
  });

  it("returns null for unparseable input", () => {
    expect(parseRrule("NOT_A_RULE")).toBeNull();
  });

  it("returns null when FREQ is missing", () => {
    expect(parseRrule("INTERVAL=2")).toBeNull();
  });
});

describe("buildRrule", () => {
  it("builds a weekly rule with FREQ", () => {
    expect(buildRrule({ freq: "WEEKLY", interval: 1 })).toContain("FREQ=WEEKLY");
  });

  it("never prepends RRULE:", () => {
    const result = buildRrule({ freq: "DAILY", interval: 1 });
    expect(result.startsWith("RRULE:")).toBe(false);
  });

  it("emits the chosen interval", () => {
    expect(buildRrule({ freq: "DAILY", interval: 2 })).toContain("INTERVAL=2");
    expect(buildRrule({ freq: "DAILY", interval: 5 })).toContain("INTERVAL=5");
  });

  it("floors fractional intervals and clamps minimum to 1", () => {
    expect(buildRrule({ freq: "DAILY", interval: 2.9 })).toContain("INTERVAL=2");
    expect(buildRrule({ freq: "DAILY", interval: 0 })).toContain("INTERVAL=1");
    expect(buildRrule({ freq: "DAILY", interval: -5 })).toContain("INTERVAL=1");
  });

  it("emits BYDAY for weekly with weekday indices", () => {
    const result = buildRrule({ byweekday: [0, 2, 4], freq: "WEEKLY", interval: 1 });
    expect(result).toContain("BYDAY=MO,WE,FR");
  });

  it("omits BYDAY when byweekday is empty", () => {
    expect(buildRrule({ byweekday: [], freq: "WEEKLY", interval: 1 })).not.toContain("BYDAY");
  });

  it("emits COUNT end condition", () => {
    expect(buildRrule({ count: 5, freq: "DAILY", interval: 1 })).toContain("COUNT=5");
  });

  it("emits UNTIL end condition as floating end-of-day", () => {
    const result = buildRrule({ freq: "WEEKLY", interval: 1, until: "2026-06-15" });
    expect(result).toContain("UNTIL=20260615T235959");
    expect(result).not.toContain("Z");
  });

  it("roundtrips through parseRrule → buildRrule", () => {
    const cases = [
      "FREQ=DAILY",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
      "FREQ=MONTHLY;COUNT=12",
      "FREQ=YEARLY;UNTIL=20301231T235959Z",
      "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
      "FREQ=WEEKLY;BYDAY=SA,SU;WKST=SU",
      "FREQ=MONTHLY;BYMONTHDAY=15",
      "FREQ=MONTHLY;BYMONTHDAY=-1",
    ];
    for (const original of cases) {
      const parsed = parseRrule(original);
      expect(parsed).not.toBeNull();
      const rebuilt = buildRrule(parsed!);
      expect(parseRrule(rebuilt)).toEqual(parsed);
    }
  });
});

describe("optionsForFreq", () => {
  it("drops BYMONTHDAY when an imported monthly rule switches to weekly", () => {
    const imported = parseRrule("FREQ=MONTHLY;BYMONTHDAY=15")!;
    const next = optionsForFreq(imported, "WEEKLY");
    expect(next).toEqual({ freq: "WEEKLY", interval: 1 });
  });

  it("drops BY* terms a non-weekly freq can't carry", () => {
    const imported = parseRrule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")!;
    expect(optionsForFreq(imported, "DAILY")).toEqual({ freq: "DAILY", interval: 1 });
    expect(optionsForFreq(imported, "WEEKLY").bysetpos).toBeUndefined();
    expect(optionsForFreq(imported, "YEARLY")).toEqual({ freq: "YEARLY", interval: 1 });
  });

  it("keeps byweekday + wkst only for weekly", () => {
    const imported = parseRrule("FREQ=WEEKLY;BYDAY=SA,SU;WKST=SU")!;
    const weekly = optionsForFreq(imported, "WEEKLY");
    expect(weekly.byweekday).toEqual(imported.byweekday);
    expect(weekly.wkst).toBe(imported.wkst);
    const monthly = optionsForFreq(imported, "MONTHLY");
    expect(monthly.byweekday).toBeUndefined();
    expect(monthly.wkst).toBeUndefined();
  });

  it("keeps bymonthday when staying monthly", () => {
    const imported = parseRrule("FREQ=MONTHLY;BYMONTHDAY=15")!;
    expect(optionsForFreq(imported, "MONTHLY").bymonthday).toEqual([15]);
  });

  it("drops a BYDAY ordinal, which no frequency the editor offers can carry", () => {
    const imported = parseRrule("FREQ=MONTHLY;BYDAY=1MO")!;
    expect(optionsForFreq(imported, "WEEKLY")).toEqual({
      byweekday: [0],
      freq: "WEEKLY",
      interval: 1,
    });
  });

  it("drops BYMONTH rather than narrow the new frequency to those months", () => {
    const imported = parseRrule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15")!;
    expect(optionsForFreq(imported, "MONTHLY")).toEqual({
      bymonthday: [15],
      freq: "MONTHLY",
      interval: 1,
    });
  });

  it("preserves the end condition across a freq change", () => {
    expect(optionsForFreq({ count: 5, freq: "MONTHLY", interval: 2 }, "WEEKLY")).toEqual({
      count: 5,
      freq: "WEEKLY",
      interval: 2,
    });
    expect(optionsForFreq({ freq: "MONTHLY", interval: 1, until: "2026-12-31" }, "DAILY")).toEqual({
      freq: "DAILY",
      interval: 1,
      until: "2026-12-31",
    });
  });
});

const TZ_MATRIX = ["UTC", "America/Los_Angeles", "Asia/Kolkata", "America/Phoenix"] as const;

function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env["TZ"];
  process.env["TZ"] = tz;
  try {
    return fn();
  } finally {
    process.env["TZ"] = prev;
  }
}

const MATRIX_CASES: { name: string; run: () => unknown }[] = [
  {
    name: "weekly timed Sunday 09:00 spanning the spring-forward day",
    run: () =>
      expandRecurrenceForRange(
        makeRule({
          rrule: "FREQ=WEEKLY;BYDAY=SU",
          scheduledEnd: "2026-03-01T10:00:00",
          scheduledStart: "2026-03-01T09:00:00",
        }),
        makePage(),
        new Date(2026, 2, 1),
        new Date(2026, 2, 22)
      ).map((o) => [o.originalDate, o.scheduledStart, o.scheduledEnd]),
  },
  {
    name: "daily timed 09:00 spanning the fall-back day",
    run: () =>
      expandRecurrenceForRange(
        makeRule({
          rrule: "FREQ=DAILY",
          scheduledEnd: "2026-10-30T09:45:00",
          scheduledStart: "2026-10-30T09:00:00",
        }),
        makePage(),
        new Date(2026, 9, 30),
        new Date(2026, 10, 4)
      ).map((o) => [o.originalDate, o.scheduledStart, o.scheduledEnd]),
  },
  {
    name: "daily timed 00:30 (half-hour-offset stress for Kolkata)",
    run: () =>
      expandRecurrenceForRange(
        makeRule({
          rrule: "FREQ=DAILY",
          scheduledEnd: "2026-03-06T01:15:00",
          scheduledStart: "2026-03-06T00:30:00",
        }),
        makePage(),
        new Date(2026, 2, 6),
        new Date(2026, 2, 11)
      ).map((o) => [o.originalDate, o.scheduledStart, o.scheduledEnd]),
  },
  {
    name: "daily timed 23:30 (near-midnight, end wraps next day)",
    run: () =>
      expandRecurrenceForRange(
        makeRule({
          rrule: "FREQ=DAILY",
          scheduledEnd: "2026-03-07T00:30:00",
          scheduledStart: "2026-03-06T23:30:00",
        }),
        makePage(),
        new Date(2026, 2, 6),
        new Date(2026, 2, 10)
      ).map((o) => [o.originalDate, o.scheduledStart, o.scheduledEnd]),
  },
  {
    name: "all-day weekly Sunday spanning the spring-forward day",
    run: () => {
      const { scheduledEnd: _drop, ...base } = makeRule({
        rrule: "FREQ=WEEKLY;BYDAY=SU",
        scheduledStart: "2026-03-01",
      });
      return expandRecurrenceForRange(
        base as PageRecurrenceRule,
        makePage(),
        new Date(2026, 2, 1),
        new Date(2026, 2, 22)
      ).map((o) => [o.originalDate, o.scheduledStart, o.scheduledEnd]);
    },
  },
  {
    name: "biweekly timed across a DST boundary",
    run: () =>
      expandRecurrenceForRange(
        makeRule({
          rrule: "FREQ=WEEKLY;BYDAY=SU;INTERVAL=2",
          scheduledEnd: "2026-03-01T15:00:00",
          scheduledStart: "2026-03-01T14:00:00",
        }),
        makePage(),
        new Date(2026, 2, 1),
        new Date(2026, 3, 13)
      ).map((o) => [o.originalDate, o.scheduledStart, o.scheduledEnd]),
  },
  {
    name: "nextOccurrenceAfter: weekly timed across spring-forward",
    run: () =>
      nextOccurrenceAfter("FREQ=WEEKLY;BYDAY=SU", "2026-03-01T09:00:00", new Date(2026, 2, 1)),
  },
  {
    name: "nextOccurrenceAfter: all-day weekly across spring-forward",
    run: () => nextOccurrenceAfter("FREQ=WEEKLY;BYDAY=SU", "2026-03-01", new Date(2026, 2, 1)),
  },
];

describe("timezone-independence matrix", () => {
  for (const c of MATRIX_CASES) {
    it(`${c.name} — byte-identical wall-clock across all zones`, () => {
      const baseline = withTz("UTC", c.run);
      expect(baseline).not.toEqual([]);
      expect(baseline).not.toBeNull();
      for (const tz of TZ_MATRIX) {
        expect(withTz(tz, c.run), `zone ${tz} must match the UTC baseline`).toEqual(baseline);
      }
    });
  }
});
