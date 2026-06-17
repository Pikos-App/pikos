import { describe, expect, it } from "vitest";

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "../types";
import {
  alignWeeklyRuleToAnchor,
  buildRrule,
  computeNextEnd,
  expandRecurrenceForRange,
  nextOccurrenceAfter,
  parseRrule,
  rruleToLabel,
  rruleToShortLabel,
  snapAnchorToRule,
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

  it("biweekly INTERVAL=2 skips alternate weeks", () => {
    // Anchor Mon Mar 2; INTERVAL=2 should yield Mar 2, Mar 16, Mar 30, …
    const page = makePage();
    const rule = makeRule({ rrule: "FREQ=WEEKLY;BYDAY=MO;INTERVAL=2" });

    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 3, 13); // through Apr 12 (5+ weeks)

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
      // UNTIL is 2026-03-09 end-of-day UTC: only Mar 2 and Mar 9 are valid.
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260309T235959Z",
    });

    // Range entirely past UNTIL.
    const rangeStart = new Date(2026, 2, 16);
    const rangeEnd = new Date(2026, 2, 30);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);
    expect(occurrences).toHaveLength(0);
  });

  it("expansion is bounded by COUNT — no occurrences past the Nth", () => {
    const page = makePage();
    const rule = makeRule({ rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=2" });

    // Range covers 4 Mondays — only the first 2 should expand.
    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 30);

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);
    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-09"]);
  });

  it("does not generate occurrences before the rule's scheduledStart", () => {
    const page = makePage();
    const rule = makeRule(); // anchored on Mon Mar 2

    // Range starts a week BEFORE the anchor. rrule.js shouldn't produce dates
    // before DTSTART.
    const rangeStart = new Date(2026, 1, 23); // Feb 23
    const rangeEnd = new Date(2026, 2, 9); // Mar 9 (exclusive)

    const occurrences = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);
    expect(occurrences.map((o) => o.originalDate)).toEqual(["2026-03-02"]);
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

  it("returns null when COUNT has been exhausted (weekly BYDAY)", () => {
    // COUNT=2: only Mar 2 and Mar 9 exist. afterDate = Mar 9 → no more.
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO;COUNT=2",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 9, 23, 59) // Monday Mar 9 end of day
    );

    expect(result).toBeNull();
  });

  it("returns null when COUNT is exhausted (daily, single occurrence)", () => {
    // FREQ=DAILY;COUNT=1 produces exactly one occurrence (the DTSTART itself).
    // After completing it, asking for the next one must return null so the
    // caller (completeRecurringPage) marks the head done instead of advancing.
    const result = nextOccurrenceAfter(
      "FREQ=DAILY;COUNT=1",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2) // same day as DTSTART
    );

    expect(result).toBeNull();
  });

  it("returns next within COUNT bound when not yet exhausted", () => {
    // COUNT=3: Mar 2, Mar 9, Mar 16. afterDate = Mar 5 → next is Mar 9.
    const result = nextOccurrenceAfter(
      "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 5)
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-09");
  });

  it("returns the final occurrence when COUNT > 1 and we ask after the second-to-last", () => {
    // FREQ=DAILY;COUNT=3 → Mar 2, 3, 4. afterDate = Mar 3 → expect Mar 4.
    const result = nextOccurrenceAfter(
      "FREQ=DAILY;COUNT=3",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 3)
    );

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-04");
  });

  // ─── exdate handling ──────────────────────────────────────────────────────
  //
  // exdates represent dates a user has already taken out of the series — they
  // were materialised into a real page via drag-reschedule, or explicitly
  // skipped via the popover. Advance must skip past them or the head lands
  // on a date that already has its own real page, producing two chips on the
  // same calendar day. Regression here was the original "head advance lands
  // on materialised date" bug fixed in the recurring-completion feature.

  it("skips a single exdate when advancing", () => {
    // Daily from Mar 2. afterDate = Mar 2. With Mar 3 excluded, expect Mar 4.
    const result = nextOccurrenceAfter("FREQ=DAILY", "2026-03-02T09:00:00", new Date(2026, 2, 2), [
      "2026-03-03",
    ]);

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-04");
  });

  it("skips multiple consecutive exdates", () => {
    // Daily from Mar 2. afterDate = Mar 2. Mar 3, 4, 5 excluded → Mar 6.
    const result = nextOccurrenceAfter("FREQ=DAILY", "2026-03-02T09:00:00", new Date(2026, 2, 2), [
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);

    expect(result).not.toBeNull();
    expect(result!.scheduledStart).toContain("2026-03-06");
  });

  it("ignores exdates that don't match a rule-generated date", () => {
    // Weekly Mondays. afterDate = Mar 2 (Mon). Exdate Mar 5 (Thu, not in rule).
    // Next Mon is Mar 9 — exdate has no effect.
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
    // Daily anchored 9am. Exdate skips Mar 3 → return Mar 4 at 9am, not midnight.
    const result = nextOccurrenceAfter("FREQ=DAILY", "2026-03-02T09:00:00", new Date(2026, 2, 2), [
      "2026-03-03",
    ]);

    expect(result!.scheduledStart).toContain("09:00");
  });

  it("returns null when every remaining occurrence within COUNT is excluded", () => {
    // FREQ=DAILY;COUNT=3 from Mar 2 → Mar 2, 3, 4. afterDate = Mar 2 means
    // the only candidates are Mar 3 + Mar 4. Excluding both leaves nothing.
    const result = nextOccurrenceAfter(
      "FREQ=DAILY;COUNT=3",
      "2026-03-02T09:00:00",
      new Date(2026, 2, 2),
      ["2026-03-03", "2026-03-04"]
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

// ─── snapAnchorToRule ─────────────────────────────────────────────────────

describe("snapAnchorToRule", () => {
  // 2026-06-07 is a Sunday; 06-08 Mon, 06-10 Wed, 06-12 Fri.
  it("moves a Sunday anchor onto the first allowed weekday for an M/W/F rule", () => {
    expect(snapAnchorToRule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-06-07")).toBe("2026-06-08");
  });

  it("leaves an anchor untouched when it already satisfies the rule", () => {
    // 06-08 is a Monday, which BYDAY=MO,WE,FR permits.
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
    // BYDAY=MO with UNTIL 06-10: the next Monday (06-15) is past UNTIL, so the
    // rule has no permitted occurrence on/after a Tuesday 06-09 anchor.
    expect(snapAnchorToRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260610T235959Z", "2026-06-09")).toBe(
      "2026-06-09"
    );
  });

  it("returns the anchor unchanged for an unparseable rrule", () => {
    expect(snapAnchorToRule("not-a-rule", "2026-06-07")).toBe("2026-06-07");
  });
});

// ─── alignWeeklyRuleToAnchor ──────────────────────────────────────────────

describe("alignWeeklyRuleToAnchor", () => {
  // 2099-01-05 is a Monday; 01-07 Wed; 01-06 Tue.
  it("rewrites a single-BYDAY weekly rule to the moved weekday", () => {
    // Monday rule, anchor moved to Wednesday → BYDAY follows.
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
    // Still a Monday — same-day time move shouldn't touch BYDAY.
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

// ─── rruleToShortLabel ────────────────────────────────────────────────────

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

// ─── Timezone-independence matrix ──────────────────────────────────────────
//
// The engine stores naive wall-clock and must expand identically regardless of
// the runner's timezone — sync feeds it zoned data, so any TZ-dependence is
// silent corruption. Default runner TZ is pinned to UTC; this re-runs expansion
// under four zones (one with DST, one half-hour offset, one DST-free) and
// asserts the wall-clock never shifts. Cases use times that exist in every
// zone; a non-existent spring-forward instant is out of scope.

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

// 2026-03-08 is the US spring-forward Sunday; 2026-11-01 is the fall-back Sunday.
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
      // Guard against a vacuous pass if expansion returns nothing.
      expect(baseline).not.toEqual([]);
      expect(baseline).not.toBeNull();
      for (const tz of TZ_MATRIX) {
        expect(withTz(tz, c.run), `zone ${tz} must match the UTC baseline`).toEqual(baseline);
      }
    });
  }
});
