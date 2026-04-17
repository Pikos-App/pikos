import { describe, expect, it } from "vitest";

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "../types";
import {
  buildRrule,
  computeNextEnd,
  expandRecurrenceForRange,
  nextOccurrenceAfter,
  parseRrule,
  rruleToLabel,
} from "./recurrence";

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

// ─── nextOccurrenceAfter ──────────────────────────────────────────────────

describe("nextOccurrenceAfter", () => {
  it("returns next Monday after a given date", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-03-02T09:00:00", // Monday 9am
      new Date(2026, 2, 2) // Monday March 2
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-09");
    expect(result!.scheduledStart).toContain("09:00");
  });

  it("skips missed occurrences — returns next future from afterDate", () => {
    // Rule: every Monday. afterDate = Wednesday March 18.
    // Should skip March 16 (past) and return March 23.
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 18) // Wednesday
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-23");
    expect(result!.scheduledStart).toContain("09:00");
  });

  it("handles all-day recurrence", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=FR",
      "2026-03-06", // date-only = all-day
      new Date(2026, 2, 6) // Friday March 6
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toBe("2026-03-13");
    expect(result!.scheduledEnd).toBeNull();
  });

  it("handles daily recurrence", () => {
    const result = nextOccurrenceAfter(
      "FREQ=DAILY",
      "2026-03-02T08:00:00",
      new Date(2026, 2, 5) // Thursday
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-06");
    expect(result!.scheduledStart).toContain("08:00");
  });

  it("returns null when UNTIL has passed", () => {
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260310T000000Z",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 15) // after UNTIL
    );

    expect(result).toBeNull();
  });

  it("completing same day returns next week, not same day", () => {
    // Rule: every Monday. Completing on Monday March 2 at 8am (before 9am event).
    // Should return March 9, not March 2 again.
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2, 8, 0) // Monday 8am
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-09");
  });
});

// ─── computeNextEnd ──────────────────────────────────────────────────────

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
    // Base end is 01:00 (after midnight), next start is 22:00
    // → next end should be 01:00 next day
    const result = computeNextEnd("2026-03-03T01:00:00", "2026-03-09T22:00:00");
    expect(result).toBe("2026-03-10T01:00:00");
  });
});

// ─── rruleToLabel ─────────────────────────────────────────────────────────

describe("rruleToLabel", () => {
  it("converts FREQ=WEEKLY;BYDAY=MO to human-readable", () => {
    expect(rruleToLabel("FREQ=WEEKLY;BYDAY=MO")).toBe("every week on Monday");
  });

  it("falls back to raw string on invalid input", () => {
    expect(rruleToLabel("INVALID_RRULE")).toBe("INVALID_RRULE");
  });
});

// ─── parseRrule ───────────────────────────────────────────────────────────────

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
    // rrule.js accepts INTERVAL-only strings but we require a FREQ.
    expect(parseRrule("INTERVAL=2")).toBeNull();
  });
});

// ─── buildRrule ───────────────────────────────────────────────────────────────

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

  it("emits UNTIL end condition as end-of-day UTC", () => {
    // UNTIL is set to 23:59:59 UTC so the final occurrence on that local date
    // is included.
    const result = buildRrule({ freq: "WEEKLY", interval: 1, until: "2026-06-15" });
    expect(result).toContain("UNTIL=20260615T235959Z");
  });

  it("roundtrips through parseRrule → buildRrule", () => {
    const cases = [
      "FREQ=DAILY",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
      "FREQ=MONTHLY;COUNT=12",
      "FREQ=YEARLY;UNTIL=20301231T235959Z",
    ];
    for (const original of cases) {
      const parsed = parseRrule(original);
      expect(parsed).not.toBeNull();
      const rebuilt = buildRrule(parsed!);
      // Re-parse rebuilt and compare options structurally — string order may
      // differ (rrule.js doesn't preserve field order).
      expect(parseRrule(rebuilt)).toEqual(parsed);
    }
  });
});
