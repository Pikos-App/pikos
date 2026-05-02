import type { PageSummary } from "@pikos/core";
import { describe, expect, it } from "vitest";

import {
  assignAllDayRows,
  assignStableAllDayRows,
  buildAllDayBars,
  buildAllDayItems,
  buildCalendarDays,
  buildCollapseGeometry,
  buildDayBlocks,
  CASCADE_OFFSET_PCT,
  chipFolderStyle,
  clampBottomHour,
  clampDayCount,
  clampTopHour,
  collapseUnderWidth,
  COMPACT_BLOCK_HEIGHT,
  computeAllDayEdgeResize,
  computeScheduleTransition,
  crossingMidnightsCount,
  dayCountColumns,
  dayCountNavStep,
  firstFreeRowInSpan,
  formatMultiDayTimeRange,
  formatTimeRange,
  GRID_HEIGHT,
  GRID_START_HOUR,
  hexToRgba,
  HOUR_HEIGHT,
  isAllDayPage,
  mapHourToY,
  mapYToDate,
  mapYToHour,
  normalizeEndInput,
  OVERFLOW_MIN_WIDTH_PX,
  remapBlocksForCollapse,
  shiftAllDayEnd,
  snapY,
  timeToY,
  weekDays,
  weekEnd,
  weekStart,
  yToDate,
} from "./calendarUtils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: overrides.id ?? crypto.randomUUID(),
    priority: 0,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Untitled",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

// ─── weekStart / weekDays / weekEnd ──────────────────────────────────────────

describe("weekStart", () => {
  it("returns Monday for a Wednesday (default)", () => {
    const wed = new Date(2026, 2, 18); // Wednesday March 18
    const monday = weekStart(wed);
    expect(monday.getDay()).toBe(1); // Monday
    expect(monday.getDate()).toBe(16);
  });

  it("returns same day when given a Monday", () => {
    const mon = new Date(2026, 2, 16); // Monday March 16
    expect(weekStart(mon).getDate()).toBe(16);
  });

  it("returns previous Monday for a Sunday", () => {
    const sun = new Date(2026, 2, 22); // Sunday March 22
    const monday = weekStart(sun);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(16);
  });

  it("returns Sunday when weekStartsOn=0", () => {
    const wed = new Date(2026, 2, 18); // Wednesday March 18
    const sunday = weekStart(wed, 0);
    expect(sunday.getDay()).toBe(0); // Sunday
    expect(sunday.getDate()).toBe(15);
  });

  it("returns same day when given a Sunday with weekStartsOn=0", () => {
    const sun = new Date(2026, 2, 15); // Sunday March 15
    expect(weekStart(sun, 0).getDate()).toBe(15);
  });
});

describe("weekDays", () => {
  it("returns 7 days starting from Monday (default)", () => {
    const wed = new Date(2026, 2, 18);
    const days = weekDays(wed);
    expect(days).toHaveLength(7);
    expect(days[0]!.getDay()).toBe(1); // Monday
    expect(days[6]!.getDay()).toBe(0); // Sunday
  });

  it("all days are consecutive", () => {
    const days = weekDays(new Date(2026, 2, 18));
    for (let i = 1; i < days.length; i++) {
      const diff = days[i]!.getDate() - days[i - 1]!.getDate();
      expect(diff).toBe(1);
    }
  });

  it("returns 7 days starting from Sunday with weekStartsOn=0", () => {
    const wed = new Date(2026, 2, 18);
    const days = weekDays(wed, 0);
    expect(days).toHaveLength(7);
    expect(days[0]!.getDay()).toBe(0); // Sunday
    expect(days[6]!.getDay()).toBe(6); // Saturday
  });
});

describe("buildCalendarDays", () => {
  it("returns 7 days anchored at the week start when dayCount=7", () => {
    const wed = new Date(2026, 2, 18); // Wednesday
    const days = buildCalendarDays(wed, 7);
    expect(days).toHaveLength(7);
    expect(days[0]!.getDay()).toBe(1); // Monday
  });

  it("returns dayCount days anchored at refDate when dayCount<7", () => {
    const wed = new Date(2026, 2, 18);
    const days = buildCalendarDays(wed, 3);
    expect(days).toHaveLength(3);
    expect(days[0]!.getDate()).toBe(18); // starts on ref date itself
    expect(days[1]!.getDate()).toBe(19);
    expect(days[2]!.getDate()).toBe(20);
  });

  it("returns 5 consecutive days when dayCount=5", () => {
    const fri = new Date(2026, 2, 20);
    const days = buildCalendarDays(fri, 5);
    expect(days).toHaveLength(5);
    expect(days[0]!.getDate()).toBe(20);
    expect(days[4]!.getDate()).toBe(24);
  });

  it("respects weekStartsOn=0 for dayCount=7", () => {
    const wed = new Date(2026, 2, 18);
    const days = buildCalendarDays(wed, 7, 0);
    expect(days[0]!.getDay()).toBe(0); // Sunday
  });

  it("days are always consecutive", () => {
    const days = buildCalendarDays(new Date(2026, 2, 18), 5);
    for (let i = 1; i < days.length; i++) {
      const diff = days[i]!.getDate() - days[i - 1]!.getDate();
      expect(diff).toBe(1);
    }
  });

  it("returns Mon-Fri anchored to Monday when dayCount='mf'", () => {
    const wed = new Date(2026, 2, 18); // Wednesday March 18
    const days = buildCalendarDays(wed, "mf");
    expect(days).toHaveLength(5);
    expect(days[0]!.getDay()).toBe(1); // Monday
    expect(days[0]!.getDate()).toBe(16);
    expect(days[4]!.getDay()).toBe(5); // Friday
    expect(days[4]!.getDate()).toBe(20);
  });

  it("'mf' anchors to Monday even when weekStartsOn=0 (Sunday)", () => {
    // M-F means Mon-Fri by name — the Sunday-start preference shouldn't push it
    // to Sun-Thu, otherwise the label becomes a lie.
    const wed = new Date(2026, 2, 18);
    const days = buildCalendarDays(wed, "mf", 0);
    expect(days[0]!.getDay()).toBe(1); // still Monday
  });

  it("'mf' on a Sunday returns the upcoming Mon-Fri", () => {
    // startOfWeek with weekStartsOn=1 on Sun returns the previous Monday — a
    // Sunday refDate should land in the *previous* week's Mon-Fri block.
    const sun = new Date(2026, 2, 22); // Sunday March 22
    const days = buildCalendarDays(sun, "mf");
    expect(days[0]!.getDate()).toBe(16); // previous Monday
    expect(days[4]!.getDate()).toBe(20); // previous Friday
  });
});

describe("dayCountColumns", () => {
  it("numeric values pass through", () => {
    expect(dayCountColumns(1)).toBe(1);
    expect(dayCountColumns(3)).toBe(3);
    expect(dayCountColumns(5)).toBe(5);
    expect(dayCountColumns(7)).toBe(7);
  });

  it("'mf' renders 5 columns", () => {
    expect(dayCountColumns("mf")).toBe(5);
  });
});

describe("dayCountNavStep", () => {
  it("numeric values step by their count", () => {
    expect(dayCountNavStep(1)).toBe(1);
    expect(dayCountNavStep(5)).toBe(5);
    expect(dayCountNavStep(7)).toBe(7);
  });

  it("'mf' steps by 7 so next page lands on the following Monday", () => {
    expect(dayCountNavStep("mf")).toBe(7);
  });
});

describe("clampDayCount", () => {
  it("returns preferred when it fits", () => {
    expect(clampDayCount(7, 7)).toBe(7);
    expect(clampDayCount("mf", 7)).toBe("mf");
    expect(clampDayCount(3, 5)).toBe(3);
  });

  it("demotes 7 to the largest numeric value the breakpoint allows", () => {
    expect(clampDayCount(7, 5)).toBe(5);
    expect(clampDayCount(7, 3)).toBe(3);
    expect(clampDayCount(7, 1)).toBe(1);
  });

  it("demotes 'mf' to 3 when only 3 columns fit (no work-week subset exists)", () => {
    expect(clampDayCount("mf", 3)).toBe(3);
    expect(clampDayCount("mf", 1)).toBe(1);
  });
});

describe("weekEnd", () => {
  it("returns Sunday for a Wednesday (default)", () => {
    const wed = new Date(2026, 2, 18);
    const sunday = weekEnd(wed);
    expect(sunday.getDay()).toBe(0); // Sunday
    expect(sunday.getDate()).toBe(22);
  });

  it("returns Saturday for a Wednesday with weekStartsOn=0", () => {
    const wed = new Date(2026, 2, 18);
    const saturday = weekEnd(wed, 0);
    expect(saturday.getDay()).toBe(6); // Saturday
    expect(saturday.getDate()).toBe(21);
  });
});

// ─── chipFolderStyle ────────────────────────────────────────────────────────

describe("chipFolderStyle", () => {
  it("returns --event-color CSS property", () => {
    const style = chipFolderStyle("#ff0000") as Record<string, string>;
    expect(style["--event-color"]).toBe("#ff0000");
  });
});

// ─── isAllDayPage ────────────────────────────────────────────────────────────

describe("isAllDayPage", () => {
  it("date-only string → true", () => {
    expect(isAllDayPage("2026-03-15")).toBe(true);
  });

  it("datetime string → false", () => {
    expect(isAllDayPage("2026-03-15T14:00:00")).toBe(false);
  });
});

// ─── crossingMidnightsCount ──────────────────────────────────────────────────

describe("crossingMidnightsCount", () => {
  it("same-day event → 0", () => {
    const start = new Date(2026, 2, 15, 10);
    const end = new Date(2026, 2, 15, 14);
    expect(crossingMidnightsCount(start, end)).toBe(0);
  });

  it("ends exactly at midnight → 0 (touches, doesn't cross)", () => {
    const start = new Date(2026, 2, 15, 23);
    const end = new Date(2026, 2, 16, 0);
    expect(crossingMidnightsCount(start, end)).toBe(0);
  });

  it("crosses one midnight (Mon 6pm → Tue 2am) → 1", () => {
    const start = new Date(2026, 2, 16, 18);
    const end = new Date(2026, 2, 17, 2);
    expect(crossingMidnightsCount(start, end)).toBe(1);
  });

  it("24-hour event (1 midnight) → 1", () => {
    const start = new Date(2026, 2, 15, 23);
    const end = new Date(2026, 2, 16, 23);
    expect(crossingMidnightsCount(start, end)).toBe(1);
  });

  it("crosses two midnights (Mon 11pm → Wed 1am) → 2", () => {
    const start = new Date(2026, 2, 16, 23);
    const end = new Date(2026, 2, 18, 1);
    expect(crossingMidnightsCount(start, end)).toBe(2);
  });

  it("Tue 10am → Thu 10am → 2", () => {
    const start = new Date(2026, 2, 17, 10);
    const end = new Date(2026, 2, 19, 10);
    expect(crossingMidnightsCount(start, end)).toBe(2);
  });

  it("end before start → 0", () => {
    const start = new Date(2026, 2, 18, 10);
    const end = new Date(2026, 2, 17, 10);
    expect(crossingMidnightsCount(start, end)).toBe(0);
  });
});

// ─── buildAllDayItems ────────────────────────────────────────────────────────

describe("buildAllDayItems", () => {
  it("returns only all-day pages matching the given day", () => {
    const day = new Date(2026, 2, 15); // March 15
    const pages = [
      makePage({ scheduledStart: "2026-03-15", title: "All-day match" }),
      makePage({ scheduledStart: "2026-03-16", title: "All-day wrong day" }),
      makePage({ scheduledStart: "2026-03-15T14:00:00", title: "Timed same day" }),
      makePage({ scheduledStart: null, title: "No schedule" }),
    ];
    const result = buildAllDayItems(pages, day);
    expect(result.map((r) => r.page.title)).toEqual(["All-day match"]);
    expect(result[0]?.isContinuationBefore).toBe(false);
  });

  it("includes a multi-day all-day event on every day in range", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-18",
        scheduledStart: "2026-03-15",
        title: "Trip",
      }),
    ];
    const day15 = buildAllDayItems(pages, new Date(2026, 2, 15));
    const day16 = buildAllDayItems(pages, new Date(2026, 2, 16));
    const day18 = buildAllDayItems(pages, new Date(2026, 2, 18));
    const day19 = buildAllDayItems(pages, new Date(2026, 2, 19));

    expect(day15).toHaveLength(1);
    // First day: not a continuation before, IS a continuation after (span is ≥2 days).
    expect(day15[0]?.isContinuationBefore).toBe(false);
    expect(day15[0]?.isContinuationAfter).toBe(true);
    // Middle day: continuation on both sides.
    expect(day16[0]?.isContinuationBefore).toBe(true);
    expect(day16[0]?.isContinuationAfter).toBe(true);
    // Last day: continuation before, NOT continuation after.
    expect(day18[0]?.isContinuationBefore).toBe(true);
    expect(day18[0]?.isContinuationAfter).toBe(false);
    expect(day19).toHaveLength(0);
  });

  it("single-day all-day event has no continuation flags", () => {
    const pages = [makePage({ scheduledStart: "2026-03-15", title: "One day" })];
    const result = buildAllDayItems(pages, new Date(2026, 2, 15));
    expect(result[0]?.isContinuationBefore).toBe(false);
    expect(result[0]?.isContinuationAfter).toBe(false);
  });

  it("ignores timed events entirely — even multi-day ones (they go to the timed grid)", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-19T10:00:00",
        scheduledStart: "2026-03-17T10:00:00",
        title: "Multi-day workshop",
      }),
      makePage({
        scheduledEnd: "2026-03-17T02:00:00",
        scheduledStart: "2026-03-16T18:00:00",
        title: "Late evening",
      }),
    ];
    expect(buildAllDayItems(pages, new Date(2026, 2, 17))).toHaveLength(0);
    expect(buildAllDayItems(pages, new Date(2026, 2, 18))).toHaveLength(0);
    expect(buildAllDayItems(pages, new Date(2026, 2, 19))).toHaveLength(0);
  });
});

// ─── assignAllDayRows ────────────────────────────────────────────────────────

describe("assignAllDayRows", () => {
  const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 2, 15 + i));

  it("places a multi-day event on the same row across every day it covers", () => {
    const pages = [
      makePage({
        id: "trip",
        scheduledEnd: "2026-03-18",
        scheduledStart: "2026-03-15",
      }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(slots).toHaveLength(5);
    // Row 0 occupied on days 0..3, empty on day 4
    expect(slots[0]?.[0]?.page.id).toBe("trip");
    expect(slots[1]?.[0]?.page.id).toBe("trip");
    expect(slots[3]?.[0]?.page.id).toBe("trip");
    expect(slots[4]?.[0]).toBe(null);
  });

  it("stacks a single-day event below a concurrent multi-day event", () => {
    const pages = [
      makePage({
        id: "trip",
        scheduledEnd: "2026-03-18",
        scheduledStart: "2026-03-15",
      }),
      makePage({ id: "lunch", scheduledStart: "2026-03-16" }),
    ];
    const slots = assignAllDayRows(pages, days);
    // Day index 1 = March 16 — trip on row 0, lunch on row 1
    expect(slots[1]?.[0]?.page.id).toBe("trip");
    expect(slots[1]?.[1]?.page.id).toBe("lunch");
    // Day index 2 = March 17 — only trip, but row 1 exists as an empty slot
    expect(slots[2]?.[0]?.page.id).toBe("trip");
    expect(slots[2]?.[1]).toBe(null);
  });

  it("places a solo middle-day event at row 0 when siblings occupy row 0 on other days", () => {
    // Reproduces the "gap above the middle chip" reported visually: three
    // non-overlapping single-day events on days 0, 1, 2. Each should land at
    // row 0 — there's no reason to push the middle one down. Regression guard.
    const pages = [
      makePage({ id: "left", scheduledStart: "2026-03-15" }),
      makePage({ id: "mid", scheduledStart: "2026-03-16" }),
      makePage({ id: "right", scheduledStart: "2026-03-17" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(slots[0]?.[0]?.page.id).toBe("left");
    expect(slots[1]?.[0]?.page.id).toBe("mid");
    expect(slots[2]?.[0]?.page.id).toBe("right");
    // No extra empty rows above any of them.
    expect(slots[1]).toHaveLength(1);
  });

  it("places multi-day spans above same-start single-day events", () => {
    // When a multi-day span and a single-day event start on the same day, the
    // span should anchor row 0 so the single-day stack stays contiguous below.
    const pages = [
      makePage({ id: "single", scheduledStart: "2026-03-15" }),
      makePage({ id: "span", scheduledEnd: "2026-03-17", scheduledStart: "2026-03-15" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(slots[0]?.[0]?.page.id).toBe("span");
    expect(slots[0]?.[1]?.page.id).toBe("single");
  });

  it("breaks ties with createdAt, not pageId, when events share a start day", () => {
    // Same start, same span length → the earlier-created page should sit on the
    // lower row index regardless of its UUID.
    const pages = [
      makePage({ createdAt: "2026-02-02T00:00:00", id: "zzz", scheduledStart: "2026-03-15" }),
      makePage({ createdAt: "2026-02-01T00:00:00", id: "aaa", scheduledStart: "2026-03-15" }),
    ];
    const slots = assignAllDayRows(pages, days);
    // "aaa" has later pageId letters but earlier createdAt — it should win row 0.
    expect(slots[0]?.[0]?.page.id).toBe("aaa");
    expect(slots[0]?.[1]?.page.id).toBe("zzz");
  });

  it("does not claim row on gap days for non-contiguous virtual occurrences sharing an id", () => {
    // Recurring virtual occurrences currently share the head page's id (see
    // expandRecurrenceForRange — spreads `...page` including id). In the
    // assignment algorithm they should NOT be treated as a single contiguous
    // span claiming row 0 on every day between the first and last occurrence.
    // Otherwise a regular single-day event on a gap day gets pushed to row 1.
    //
    // Scenario: virtuals of "run" on days 0, 2, 4 (skipping days 1, 3). A
    // regular "meeting" event on day 3 should still land at row 0.
    const pages = [
      makePage({ id: "run", scheduledStart: "2026-03-15" }), // day 0
      makePage({ id: "run", scheduledStart: "2026-03-17" }), // day 2 (shared id — simulates virtual)
      makePage({ id: "run", scheduledStart: "2026-03-19" }), // day 4 (shared id — simulates virtual)
      makePage({ id: "meeting", scheduledStart: "2026-03-18" }), // day 3
    ];
    const slots = assignAllDayRows(pages, days);
    // Meeting should be at row 0 on day 3 — no span covers day 3.
    expect(slots[3]?.[0]?.page.id).toBe("meeting");
  });
});

// ─── assignStableAllDayRows ──────────────────────────────────────────────────

describe("assignStableAllDayRows", () => {
  // Mon Mar 16 – Sun Mar 22 (week 1) and Mon Mar 23 – Sun Mar 29 (week 2).
  const week1 = Array.from({ length: 7 }, (_, i) => new Date(2026, 2, 16 + i));
  const week2 = Array.from({ length: 7 }, (_, i) => new Date(2026, 2, 23 + i));

  it("keeps a cross-week event on the same row in the week it continues into", () => {
    // Three same-start multi-week events (Sat Mar 21 → Mon Mar 23) plus one
    // shorter single-week event on Sat/Sun. The long spans stack at rows 0-2
    // (sort by createdAt tiebreak); the shorter one drops to row 3.
    const pages = [
      makePage({
        createdAt: "2026-01-01",
        id: "a",
        scheduledEnd: "2026-03-23",
        scheduledStart: "2026-03-21",
      }),
      makePage({
        createdAt: "2026-01-02",
        id: "b",
        scheduledEnd: "2026-03-23",
        scheduledStart: "2026-03-21",
      }),
      makePage({
        createdAt: "2026-01-03",
        id: "c",
        scheduledEnd: "2026-03-23",
        scheduledStart: "2026-03-21",
      }),
      makePage({
        createdAt: "2026-01-04",
        id: "d",
        scheduledEnd: "2026-03-22",
        scheduledStart: "2026-03-21",
      }),
    ];

    const w1 = assignStableAllDayRows(pages, week1);
    const w2 = assignStableAllDayRows(pages, week2);

    // Week 1, Sat Mar 21 (index 5) — a, b, c, d stack on rows 0-3.
    expect(w1[5]?.[0]?.page.id).toBe("a");
    expect(w1[5]?.[1]?.page.id).toBe("b");
    expect(w1[5]?.[2]?.page.id).toBe("c");
    expect(w1[5]?.[3]?.page.id).toBe("d");

    // Week 2, Mon Mar 23 (index 0) — a, b, c continue at rows 0, 1, 2.
    expect(w2[0]?.[0]?.page.id).toBe("a");
    expect(w2[0]?.[1]?.page.id).toBe("b");
    expect(w2[0]?.[2]?.page.id).toBe("c");
  });

  it("trims trailing empty rows when the stable layout would leave unused slots below", () => {
    // Single cross-week event with nothing else in week 2 → the visible week 2
    // has one row (D), not the totalRows count that week 1's context implies.
    const pages = [makePage({ id: "d", scheduledEnd: "2026-03-23", scheduledStart: "2026-03-21" })];
    const w2 = assignStableAllDayRows(pages, week2);
    // Mon Mar 23 — D is the only visible event, on row 0, no trailing spacers.
    expect(w2[0]).toHaveLength(1);
    expect(w2[0]?.[0]?.page.id).toBe("d");
    // Days without D collapse to the same row count (row 0 is just empty).
    expect(w2[1]).toHaveLength(1);
    expect(w2[1]?.[0]).toBe(null);
  });

  it("falls back to local assignment when nothing extends past the visible range", () => {
    const pages = [
      makePage({ id: "x", scheduledEnd: "2026-03-18", scheduledStart: "2026-03-16" }),
      makePage({ id: "y", scheduledStart: "2026-03-17" }),
    ];
    const stable = assignStableAllDayRows(pages, week1);
    const local = assignAllDayRows(pages, week1);
    expect(stable).toEqual(local);
  });

  it("reverse expansion: a span starting in a prior week sees its anchor's context", () => {
    // Two same-start spans in week 1 (push D to row 2). D continues from week 1
    // Sat into week 2 Mon. Viewing week 2 should still show D on row 2.
    const pages = [
      makePage({
        createdAt: "2026-01-01",
        id: "anchor-a",
        scheduledEnd: "2026-03-22",
        scheduledStart: "2026-03-21",
      }),
      makePage({
        createdAt: "2026-01-02",
        id: "anchor-b",
        scheduledEnd: "2026-03-22",
        scheduledStart: "2026-03-21",
      }),
      makePage({
        createdAt: "2026-01-03",
        id: "d",
        scheduledEnd: "2026-03-23",
        scheduledStart: "2026-03-21",
      }),
    ];
    const w2 = assignStableAllDayRows(pages, week2);
    // D is the longest span (length 3) so multi-day-first sort puts it on row 0
    // even though anchor-a/b push the row count up — the assertion is that the
    // expansion ran and considered both anchors. Mon Mar 23 has D at row 0.
    expect(w2[0]?.[0]?.page.id).toBe("d");
  });

  it("recurring virtual occurrences sharing an id keep their non-contiguous rows in the stable view", () => {
    // Recurring "run" occurrences on M/W/F via shared pageId — assignAllDayRows
    // already handles the non-contiguous span gap (no row claim on Tue/Thu).
    // The stable variant must inherit that behavior, not collapse the gaps.
    const pages = [
      makePage({ id: "run", scheduledStart: "2026-03-16" }), // Mon (week 1, day 0)
      makePage({ id: "run", scheduledStart: "2026-03-18" }), // Wed (day 2)
      makePage({ id: "run", scheduledStart: "2026-03-20" }), // Fri (day 4)
      makePage({ id: "tue-meeting", scheduledStart: "2026-03-17" }), // Tue (day 1)
    ];
    const w1 = assignStableAllDayRows(pages, week1);
    // Tue meeting should land on row 0 because run doesn't claim the gap day.
    expect(w1[1]?.[0]?.page.id).toBe("tue-meeting");
  });
});

// ─── firstFreeRowInSpan ──────────────────────────────────────────────────────

describe("firstFreeRowInSpan", () => {
  const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 2, 16 + i));

  it("returns 0 when every column in the span is empty", () => {
    const slots = assignAllDayRows([], days);
    expect(firstFreeRowInSpan(slots, 0, 4)).toBe(0);
  });

  it("returns the lowest row that is empty across every spanned column", () => {
    // Stack rows 0,1 on day 2 only — span [1..3] needs row 0 in days 1, 3 but
    // row 0 is filled in day 2 → first free across all three is row 2.
    const pages = [
      makePage({ createdAt: "2026-01-01", id: "a", scheduledStart: "2026-03-18" }),
      makePage({ createdAt: "2026-01-02", id: "b", scheduledStart: "2026-03-18" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(firstFreeRowInSpan(slots, 1, 3)).toBe(2);
  });

  it("uses only the spanned columns — events outside the span don't push the row down", () => {
    const pages = [
      makePage({ id: "outside", scheduledStart: "2026-03-20" }), // day 4 — outside span [0,2]
    ];
    const slots = assignAllDayRows(pages, days);
    expect(firstFreeRowInSpan(slots, 0, 2)).toBe(0);
  });

  it("treats a single-column span (lo === hi) as a one-cell free check", () => {
    const pages = [makePage({ id: "x", scheduledStart: "2026-03-17" })]; // day 1
    const slots = assignAllDayRows(pages, days);
    expect(firstFreeRowInSpan(slots, 1, 1)).toBe(1); // row 0 of day 1 is taken
    expect(firstFreeRowInSpan(slots, 0, 0)).toBe(0); // day 0 is empty
  });
});

// ─── buildAllDayBars ─────────────────────────────────────────────────────────

describe("buildAllDayBars", () => {
  const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 2, 16 + i));
  const week1 = Array.from({ length: 7 }, (_, i) => new Date(2026, 2, 16 + i));
  const week2 = Array.from({ length: 7 }, (_, i) => new Date(2026, 2, 23 + i));

  it("empty input → no bars", () => {
    expect(buildAllDayBars(assignAllDayRows([], days))).toEqual([]);
  });

  it("single-day event → one bar, span 1, no continuations", () => {
    const pages = [makePage({ id: "x", scheduledStart: "2026-03-17" })];
    const bars = buildAllDayBars(assignAllDayRows(pages, days));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      continuesLeft: false,
      continuesRight: false,
      row: 0,
      span: 1,
      startCol: 1,
    });
  });

  it("multi-day event fully inside the view → one bar spanning every day", () => {
    const pages = [
      makePage({ id: "trip", scheduledEnd: "2026-03-19", scheduledStart: "2026-03-17" }),
    ];
    const bars = buildAllDayBars(assignAllDayRows(pages, days));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      continuesLeft: false,
      continuesRight: false,
      row: 0,
      span: 3,
      startCol: 1,
    });
  });

  it("multi-week event extending before the view → continuesLeft, startCol 0", () => {
    // Event runs Mar 21 (week 1 Sat) → Mar 24 (week 2 Tue). Viewing week 2,
    // the bar starts at col 0 and carries continuesLeft from the slot's flags.
    const pages = [
      makePage({ id: "conf", scheduledEnd: "2026-03-24", scheduledStart: "2026-03-21" }),
    ];
    const bars = buildAllDayBars(assignStableAllDayRows(pages, week2));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      continuesLeft: true,
      continuesRight: false,
      span: 2, // Mon Mar 23, Tue Mar 24
      startCol: 0,
    });
  });

  it("multi-week event extending after the view → continuesRight", () => {
    // Event runs Sat Mar 21 → Mon Mar 23. Viewing week 1, the bar starts Sat
    // (col 5), covers only Sat + Sun (the visible portion), and flags continues.
    const pages = [
      makePage({ id: "conf", scheduledEnd: "2026-03-23", scheduledStart: "2026-03-21" }),
    ];
    const bars = buildAllDayBars(assignStableAllDayRows(pages, week1));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      continuesLeft: false,
      continuesRight: true,
      span: 2, // Sat Mar 21, Sun Mar 22
      startCol: 5,
    });
  });

  it("event spanning the entire view both continues left and right", () => {
    // Start Mar 10 (prior week), end Apr 3 (next week). Week 1 sees a full-
    // width bar with both continuation flags.
    const pages = [
      makePage({ id: "sprint", scheduledEnd: "2026-04-03", scheduledStart: "2026-03-10" }),
    ];
    const bars = buildAllDayBars(assignStableAllDayRows(pages, week1));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      continuesLeft: true,
      continuesRight: true,
      span: 7,
      startCol: 0,
    });
  });

  it("shared-id recurring (MWF) → three separate bars with gaps, none continuing", () => {
    // Recurring virtuals share the head page id. They shouldn't coalesce into
    // one bar — the gap columns (Tue/Thu) break the run naturally.
    const pages = [
      makePage({ id: "run", scheduledStart: "2026-03-16" }), // Mon
      makePage({ id: "run", scheduledStart: "2026-03-18" }), // Wed
      makePage({ id: "run", scheduledStart: "2026-03-20" }), // Fri
    ];
    const bars = buildAllDayBars(assignAllDayRows(pages, week1));
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.startCol)).toEqual([0, 2, 4]);
    expect(bars.every((b) => b.span === 1)).toBe(true);
    expect(bars.every((b) => !b.continuesLeft && !b.continuesRight)).toBe(true);
  });

  it("row stability: bar on row N in week 1 stays on row N in week 2", () => {
    // D is the only multi-week event but sits behind two same-start anchors
    // (via createdAt tiebreak) → D lands on row 2. Week 2's continuation must
    // preserve row 2.
    const pages = [
      makePage({
        createdAt: "2026-01-01",
        id: "anchor-a",
        scheduledEnd: "2026-03-22",
        scheduledStart: "2026-03-21",
      }),
      makePage({
        createdAt: "2026-01-02",
        id: "anchor-b",
        scheduledEnd: "2026-03-22",
        scheduledStart: "2026-03-21",
      }),
      makePage({
        createdAt: "2026-01-03",
        id: "d",
        scheduledEnd: "2026-03-23",
        scheduledStart: "2026-03-21",
      }),
    ];
    const w1 = buildAllDayBars(assignStableAllDayRows(pages, week1));
    const w2 = buildAllDayBars(assignStableAllDayRows(pages, week2));
    const dRowWeek1 = w1.find((b) => b.page.id === "d")?.row;
    const dRowWeek2 = w2.find((b) => b.page.id === "d")?.row;
    expect(dRowWeek1).toBe(dRowWeek2);
  });

  it("produces unique keys for every bar in a view", () => {
    const pages = [
      makePage({ id: "a", scheduledStart: "2026-03-16" }),
      makePage({ id: "b", scheduledEnd: "2026-03-19", scheduledStart: "2026-03-17" }),
      makePage({ id: "run", scheduledStart: "2026-03-16" }),
      makePage({ id: "run", scheduledStart: "2026-03-20" }),
    ];
    const bars = buildAllDayBars(assignAllDayRows(pages, week1));
    const keys = bars.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("overlapping events on different rows render as separate bars", () => {
    const pages = [
      makePage({
        id: "trip",
        scheduledEnd: "2026-03-18",
        scheduledStart: "2026-03-16",
      }),
      makePage({ id: "lunch", scheduledStart: "2026-03-17" }),
    ];
    const bars = buildAllDayBars(assignAllDayRows(pages, days));
    expect(bars).toHaveLength(2);
    const trip = bars.find((b) => b.page.id === "trip");
    const lunch = bars.find((b) => b.page.id === "lunch");
    expect(trip).toMatchObject({ row: 0, span: 3, startCol: 0 });
    expect(lunch?.row).toBe(1);
    expect(lunch?.startCol).toBe(1);
  });
});

// ─── shiftAllDayEnd ──────────────────────────────────────────────────────────

describe("shiftAllDayEnd", () => {
  it("shifts the end date by the same number of days as the move", () => {
    // 4-day event Mar 15-18 dragged to start Mar 22 → end Mar 25 (still 4 days).
    const result = shiftAllDayEnd("2026-03-15", "2026-03-18", new Date(2026, 2, 22));
    expect(result).toBe("2026-03-25");
  });

  it("returns undefined for a single-day event (start === end)", () => {
    const result = shiftAllDayEnd("2026-03-15", "2026-03-15", new Date(2026, 2, 22));
    expect(result).toBeUndefined();
  });

  it("returns undefined when the original end is missing", () => {
    expect(shiftAllDayEnd("2026-03-15", null, new Date(2026, 2, 22))).toBeUndefined();
    expect(shiftAllDayEnd("2026-03-15", undefined, new Date(2026, 2, 22))).toBeUndefined();
  });

  it("returns undefined when either bound is timed (not all-day)", () => {
    // Mixed cases shouldn't happen in practice but the guard keeps callers safe
    // from accidentally producing a date-only end on a timed event.
    const r1 = shiftAllDayEnd("2026-03-15T09:00:00", "2026-03-15T10:00:00", new Date(2026, 2, 22));
    expect(r1).toBeUndefined();
    const r2 = shiftAllDayEnd("2026-03-15", "2026-03-18T10:00:00", new Date(2026, 2, 22));
    expect(r2).toBeUndefined();
  });

  it("returns undefined when start is missing entirely", () => {
    expect(shiftAllDayEnd(null, "2026-03-18", new Date(2026, 2, 22))).toBeUndefined();
  });
});

// ─── collapseUnderWidth ──────────────────────────────────────────────────────

describe("collapseUnderWidth", () => {
  function makeBlock(
    pageId: string,
    leftPct: number,
    widthPct: number,
    top = 0,
    height = 60
  ): import("./calendarUtils").CalendarBlock {
    return {
      endDate: new Date(),
      height,
      isCompact: false,
      leftPct,
      page: makePage({ id: pageId }),
      startDate: new Date(),
      top,
      widthPct,
    };
  }

  it("no measurement (columnWidth=0) → unchanged, no pill", () => {
    const blocks = [makeBlock("a", 0, 50), makeBlock("b", 50, 50)];
    const { pill, visible } = collapseUnderWidth(blocks, 0);
    expect(visible).toBe(blocks);
    expect(pill).toBe(null);
  });

  it("all blocks above threshold → no pill", () => {
    // Column width 200, two blocks at 50% each = 100px each (above threshold).
    const blocks = [makeBlock("a", 0, 50), makeBlock("b", 50, 50)];
    const result = collapseUnderWidth(blocks, 200);
    expect(result.visible).toHaveLength(2);
    expect(result.pill).toBe(null);
  });

  it("pill anchors at rightmost collapsed slot, expanded to PILL_MIN_WIDTH_PX", () => {
    // Column 200 → min pill = (64/200)*100 = 32%. Slot is at 86/14 (only
    // 28px wide), expand left so the pill has a readable 32% width and
    // stays right-anchored.
    const blocks = [
      makeBlock("wide", 0, 60),
      makeBlock("n1", 60, 13, 100),
      makeBlock("n2", 73, 13, 200),
      makeBlock("n3", 86, 14, 150),
    ];
    const { pill, visible } = collapseUnderWidth(blocks, 200);
    expect(visible.map((b) => b.page.id)).toEqual(["wide"]);
    expect(pill?.pageIds).toEqual(["n1", "n2", "n3"]);
    expect(pill?.widthPct).toBe(32);
    expect(pill?.leftPct).toBe(68);
    expect(pill?.top).toBe(150);
  });

  it("pill widthPct caps at 50% on extremely narrow columns", () => {
    // Column 80px → uncapped floor would be 80%. Cap kicks in at 50%.
    const blocks = [makeBlock("a", 0, 30), makeBlock("b", 30, 30), makeBlock("c", 60, 40)];
    const { pill } = collapseUnderWidth(blocks, 80);
    // All three are under the 60px collapse threshold (24, 24, 32 px).
    expect(pill?.widthPct).toBe(50);
    expect(pill?.leftPct).toBe(50);
  });

  it("pill height is COMPACT_BLOCK_HEIGHT (chip-sized)", () => {
    const blocks = [makeBlock("n1", 50, 20, 100, 40), makeBlock("n2", 70, 20, 200, 60)];
    const { pill } = collapseUnderWidth(blocks, 100);
    expect(pill?.height).toBe(COMPACT_BLOCK_HEIGHT);
  });

  it("pill top tracks the rightmost-cascaded slot's top", () => {
    const blocks = [
      makeBlock("n1", 50, 20, 100, 40),
      makeBlock("n2", 70, 20, 200, 60), // rightmost (highest leftPct)
    ];
    const { pill } = collapseUnderWidth(blocks, 100);
    expect(pill?.top).toBe(200);
  });

  it("uses OVERFLOW_MIN_WIDTH_PX as the threshold", () => {
    // Block at exactly threshold passes; one pixel under collapses.
    const ok = makeBlock("ok", 0, OVERFLOW_MIN_WIDTH_PX);
    const bad = makeBlock("bad", 50, OVERFLOW_MIN_WIDTH_PX - 1);
    const { pill, visible } = collapseUnderWidth([ok, bad], 100);
    expect(visible.map((b) => b.page.id)).toEqual(["ok"]);
    expect(pill?.pageIds).toEqual(["bad"]);
  });

  it("conservation: every input block ends up either visible or in the pill", () => {
    // Mixed cluster — wide host, narrow chips of various widthPct/leftPct.
    const blocks = [
      makeBlock("a", 0, 60), // wide → visible
      makeBlock("b", 60, 12, 100), // narrow → collapsed
      makeBlock("c", 72, 14, 200), // narrow → collapsed
      makeBlock("d", 86, 14, 300), // narrow → collapsed
    ];
    const { pill, visible } = collapseUnderWidth(blocks, 200);
    const seen = new Set<string>([...visible.map((b) => b.page.id), ...(pill?.pageIds ?? [])]);
    expect(seen.size).toBe(blocks.length);
    for (const b of blocks) expect(seen.has(b.page.id)).toBe(true);
  });
});

// ─── buildDayBlocks ──────────────────────────────────────────────────────────

describe("buildDayBlocks", () => {
  const day = new Date(2026, 2, 15); // March 15

  it("single timed event → full-width, left 0", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Meeting",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.top).toBe((9 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(b.height).toBe(HOUR_HEIGHT);
    expect(b.leftPct).toBe(0);
    expect(b.widthPct).toBe(100);
    expect(b.isCompact).toBe(false);
  });

  it("two overlapping events with far tops → cascade (host full width, guest indented)", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T11:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T11:30:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "B",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    const a = blocks.find((b) => b.page.id === "a")!;
    const b = blocks.find((b) => b.page.id === "b")!;
    expect(a.leftPct).toBe(0);
    expect(a.widthPct).toBe(100);
    expect(b.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(b.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
  });

  it("two overlapping events with close tops → split 50/50 (would collide cascading)", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T10:30:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "B",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    blocks.forEach((b) => expect(b.widthPct).toBe(50));
    const lefts = blocks.map((b) => b.leftPct).sort((x, y) => x - y);
    expect(lefts).toEqual([0, 50]);
  });

  it("three close-top events → host 50%, second guest 50%, third cascades inside right half", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:15:00",
        title: "B",
      }),
      makePage({
        id: "c",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "C",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    const byId = Object.fromEntries(blocks.map((b) => [b.page.id, b]));
    expect(byId["a"]!.leftPct).toBe(0);
    expect(byId["a"]!.widthPct).toBe(50);
    expect(byId["b"]!.leftPct).toBe(50);
    expect(byId["b"]!.widthPct).toBe(50);
    // c is at cascade depth 1 inside the right 50%: relativeOffset =
    // CASCADE_OFFSET_PCT, leftPct = 50 + CASCADE_OFFSET_PCT/2.
    expect(byId["c"]!.leftPct).toBe(50 + CASCADE_OFFSET_PCT / 2);
    expect(byId["c"]!.widthPct).toBe(50 - CASCADE_OFFSET_PCT / 2);
  });

  it("three overlapping events with spread-out tops → cascade depth 0/1/2", () => {
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T10:15:00",
        title: "B",
      }),
      makePage({
        id: "c",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T11:30:00",
        title: "C",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    const a = blocks.find((x) => x.page.id === "a")!;
    const b = blocks.find((x) => x.page.id === "b")!;
    const c = blocks.find((x) => x.page.id === "c")!;
    expect(a.leftPct).toBe(0);
    expect(a.widthPct).toBe(100);
    expect(b.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(b.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
    expect(c.leftPct).toBe(2 * CASCADE_OFFSET_PCT);
    expect(c.widthPct).toBe(100 - 2 * CASCADE_OFFSET_PCT);
  });

  it("very deep pile of close-top events → host 50%, rest cascade inside right half", () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      makePage({
        id: `p${i}`,
        scheduledEnd: "2026-03-15T11:00:00",
        scheduledStart: `2026-03-15T09:${String(i * 5).padStart(2, "0")}:00`,
        title: `P${i}`,
      })
    );
    const blocks = buildDayBlocks(pages, day);
    const byId = Object.fromEntries(blocks.map((b) => [b.page.id, b]));
    // p0 = host on the left half.
    expect(byId["p0"]!.leftPct).toBe(0);
    expect(byId["p0"]!.widthPct).toBe(50);
    // p1..p5 cascade inside the right 50% with half-scaled offset.
    for (let i = 1; i < 6; i++) {
      const cascadeDepth = i - 1;
      const relativeOffset = Math.min(cascadeDepth * CASCADE_OFFSET_PCT, 60);
      const expectedLeft = 50 + relativeOffset / 2;
      expect(byId[`p${i}`]!.leftPct).toBe(expectedLeft);
      expect(byId[`p${i}`]!.widthPct).toBe(100 - expectedLeft);
    }
  });

  it("cascade is capped (depth ≥ 4 events all sit at CASCADE_MAX_LEFT_PCT)", () => {
    // Five events with tops 1h apart. Depths 0..3 cascade; depth 4 lands at
    // the cap — leftPct stops growing so the deepest still has width.
    const pages = Array.from({ length: 5 }, (_, i) =>
      makePage({
        id: `p${i}`,
        scheduledEnd: "2026-03-15T20:00:00",
        scheduledStart: `2026-03-15T${String(9 + i).padStart(2, "0")}:00:00`,
        title: `P${i}`,
      })
    );
    const blocks = buildDayBlocks(pages, day);
    const byId = Object.fromEntries(blocks.map((b) => [b.page.id, b]));
    expect(byId["p0"]!.leftPct).toBe(0);
    expect(byId["p1"]!.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(byId["p2"]!.leftPct).toBe(2 * CASCADE_OFFSET_PCT);
    expect(byId["p3"]!.leftPct).toBe(3 * CASCADE_OFFSET_PCT);
    // p4 is depth 4 — leftPct caps; widthPct stays at 100 - cap.
    expect(byId["p4"]!.leftPct).toBeLessThanOrEqual(60);
    expect(byId["p4"]!.widthPct).toBeGreaterThanOrEqual(40);
  });

  it("mixed cluster: close-top pair splits, unrelated events still cascade", () => {
    const pages = [
      makePage({
        id: "e0",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "E0",
      }),
      makePage({
        id: "e1",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T09:15:00",
        title: "E1",
      }),
      makePage({
        id: "e2",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "E2",
      }),
      makePage({
        id: "e3",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T12:30:00",
        title: "E3",
      }),
      makePage({
        id: "e4",
        scheduledEnd: "2026-03-15T15:00:00",
        scheduledStart: "2026-03-15T14:00:00",
        title: "E4",
      }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((b) => [b.page.id, b]));
    // e0/e1 collide on top → split 50/50.
    expect(byId["e0"]!.widthPct).toBe(50);
    expect(byId["e1"]!.widthPct).toBe(50);
    expect(new Set([byId["e0"]!.leftPct, byId["e1"]!.leftPct])).toEqual(new Set([0, 50]));
    // e2-e4 are spread out → cascade. None should be as narrow as a 5-way split.
    for (const id of ["e2", "e3", "e4"]) {
      expect(byId[id]!.widthPct).toBeGreaterThanOrEqual(100 - 60);
    }
  });

  it("containment (host fully contains guest) → guest cascades on top of host", () => {
    const pages = [
      makePage({
        id: "host",
        scheduledEnd: "2026-03-15T11:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Host",
      }),
      makePage({
        id: "guest",
        scheduledEnd: "2026-03-15T10:30:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "Guest",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    const host = blocks.find((b) => b.page.id === "host")!;
    const guest = blocks.find((b) => b.page.id === "guest")!;
    expect(host.leftPct).toBe(0);
    expect(host.widthPct).toBe(100);
    expect(guest.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(guest.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
    // Both keep their own time-accurate top/height.
    expect(host.top).toBe(9 * HOUR_HEIGHT);
    expect(host.height).toBe(2 * HOUR_HEIGHT);
    expect(guest.top).toBe(10 * HOUR_HEIGHT);
    expect(guest.height).toBe(0.5 * HOUR_HEIGHT);
    // DOM order: host (depth 0) before guest (depth 1) so guest paints on top.
    expect(blocks.indexOf(host)).toBeLessThan(blocks.indexOf(guest));
  });

  it("identical range → split (same tops always collide), stable ordering by id", () => {
    const pagesA = [
      makePage({
        id: "aaa",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        id: "bbb",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "B",
      }),
    ];
    const first = buildDayBlocks(pagesA, day);
    const second = buildDayBlocks([...pagesA].reverse(), day);
    const pickIds = (blocks: ReturnType<typeof buildDayBlocks>) =>
      blocks.slice().map((b) => b.page.id);
    expect(pickIds(first)).toEqual(["aaa", "bbb"]);
    expect(pickIds(second)).toEqual(["aaa", "bbb"]);
    first.forEach((b) => expect(b.widthPct).toBe(50));
  });

  it("long host + chips: header-overlapping chip splits 50/50, body chips cascade", () => {
    // Sunday meal prep (12-2 PM) with three reminder chips. The first chip
    // (12:30) lands inside the host's title/time area (32px below host top
    // < CASCADE_MIN_TOP_GAP_PX) so it splits 50/50 with the host. Later chips
    // (1pm, 1:30pm) are well below the header and cascade like normal nested
    // events at sweep-line depth 1.
    const pages = [
      makePage({
        id: "host",
        scheduledEnd: "2026-03-15T14:00:00",
        scheduledStart: "2026-03-15T12:00:00",
        title: "Sunday meal prep",
      }),
      makePage({ id: "c1", scheduledStart: "2026-03-15T12:30:00", title: "Start rice" }),
      makePage({ id: "c2", scheduledStart: "2026-03-15T13:00:00", title: "Preheat oven" }),
      makePage({ id: "c3", scheduledStart: "2026-03-15T13:30:00", title: "Pack lunch" }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((b) => [b.page.id, b]));
    // Host + first chip collide (chip in host's header) → 50/50 split.
    expect(byId["host"]!.leftPct).toBe(0);
    expect(byId["host"]!.widthPct).toBe(50);
    expect(byId["c1"]!.leftPct).toBe(50);
    expect(byId["c1"]!.widthPct).toBe(50);
    // Other chips don't collide (chip-vs-chip threshold is much tighter, and
    // their gap to the host > CASCADE_MIN_TOP_GAP_PX) → cascade depth 1.
    for (const id of ["c2", "c3"]) {
      expect(byId[id]!.leftPct).toBe(CASCADE_OFFSET_PCT);
      expect(byId[id]!.widthPct).toBe(100 - CASCADE_OFFSET_PCT);
      expect(byId[id]!.isCompact).toBe(true);
    }
  });

  it("non-overlapping earlier event stays full width regardless of later pile", () => {
    const pages = [
      makePage({
        id: "solo",
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Solo",
      }),
      makePage({
        id: "p1",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "P1",
      }),
      makePage({
        id: "p2",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:15:00",
        title: "P2",
      }),
      makePage({
        id: "p3",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:30:00",
        title: "P3",
      }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((b) => [b.page.id, b]));
    // Solo is its own cluster — full width, independent of the later pile.
    expect(byId["solo"]!.leftPct).toBe(0);
    expect(byId["solo"]!.widthPct).toBe(100);
    // The pile has close tops → host 50%, second guest 50%, third cascades.
    expect(byId["p1"]!.leftPct).toBe(0);
    expect(byId["p1"]!.widthPct).toBe(50);
    expect(byId["p2"]!.leftPct).toBe(50);
    expect(byId["p2"]!.widthPct).toBe(50);
    expect(byId["p3"]!.leftPct).toBe(50 + CASCADE_OFFSET_PCT / 2);
    expect(byId["p3"]!.widthPct).toBe(50 - CASCADE_OFFSET_PCT / 2);
  });

  it("third event doesn't fall back to col 0 when col 1 is still alive (cascade visibility)", () => {
    // A 8:30–10:30, B 9:30–12:30, C 11:00–12:00. A ends before C starts so
    // col 0 is technically free, BUT col 1 (B) is still alive at 11:00. C
    // must NOT reuse col 0 — otherwise it'd render at leftPct=0/widthPct=100
    // and B's cascade would cover it (the bug). Force C to a fresh col 2.
    const pages = [
      makePage({
        id: "a",
        scheduledEnd: "2026-03-15T10:30:00",
        scheduledStart: "2026-03-15T08:30:00",
        title: "A",
      }),
      makePage({
        id: "b",
        scheduledEnd: "2026-03-15T12:30:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "B",
      }),
      makePage({
        id: "c",
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "C",
      }),
    ];
    const byId = Object.fromEntries(buildDayBlocks(pages, day).map((bb) => [bb.page.id, bb]));
    expect(byId["a"]!.leftPct).toBe(0);
    expect(byId["b"]!.leftPct).toBe(CASCADE_OFFSET_PCT);
    expect(byId["c"]!.leftPct).toBe(2 * CASCADE_OFFSET_PCT);
  });

  it("no-end event → isCompact=true, height=COMPACT_BLOCK_HEIGHT", () => {
    const pages = [makePage({ scheduledStart: "2026-03-15T10:00:00", title: "Quick" })];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.isCompact).toBe(true);
    expect(blocks[0]!.height).toBe(COMPACT_BLOCK_HEIGHT);
  });

  it("sub-15-min event → isCompact=true", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:10:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "Brief",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks[0]!.isCompact).toBe(true);
    expect(blocks[0]!.height).toBe(COMPACT_BLOCK_HEIGHT);
  });

  it("20-min event rounds up to 30-min visual height", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:20:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "20m",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks[0]!.height).toBe((30 / 60) * HOUR_HEIGHT);
  });

  it("40-min event rounds up to 45-min visual height", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:40:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "40m",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks[0]!.height).toBe((45 / 60) * HOUR_HEIGHT);
  });

  it("excludes all-day events", () => {
    const pages = [
      makePage({ scheduledStart: "2026-03-15", title: "All-day" }),
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Timed",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.page.title).toBe("Timed");
  });

  it("multi-day timed event renders as one segment per day (Mon → Thu = 4 segments)", () => {
    // 9 AM Sun → 5 PM Wed: present on Sun, Mon, Tue, Wed columns. Sun gets
    // segment from 9am to grid bottom (continuation after). Mon/Tue are
    // full-grid continuations both ways. Wed runs from grid top to 5pm.
    const pages = [
      makePage({
        id: "trip",
        scheduledEnd: "2026-03-18T17:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Conference",
      }),
    ];
    const sun = buildDayBlocks(pages, new Date(2026, 2, 15));
    expect(sun).toHaveLength(1);
    expect(sun[0]!.top).toBe(9 * HOUR_HEIGHT);
    expect(sun[0]!.isContinuationAfter).toBe(true);
    expect(sun[0]!.isContinuationBefore).toBeUndefined();

    const mon = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(mon).toHaveLength(1);
    expect(mon[0]!.top).toBe(0);
    expect(mon[0]!.isContinuationBefore).toBe(true);
    expect(mon[0]!.isContinuationAfter).toBe(true);

    const tue = buildDayBlocks(pages, new Date(2026, 2, 17));
    expect(tue).toHaveLength(1);
    expect(tue[0]!.top).toBe(0);
    expect(tue[0]!.isContinuationBefore).toBe(true);
    expect(tue[0]!.isContinuationAfter).toBe(true);

    const wed = buildDayBlocks(pages, new Date(2026, 2, 18));
    expect(wed).toHaveLength(1);
    expect(wed[0]!.top).toBe(0);
    expect(wed[0]!.height).toBe(17 * HOUR_HEIGHT);
    expect(wed[0]!.isContinuationBefore).toBe(true);
    expect(wed[0]!.isContinuationAfter).toBeUndefined();
  });

  it("multi-day timed event: present on every spanned day, absent on adjacent days", () => {
    // Sun 9 AM → Wed 5 PM. Should appear on Sun/Mon/Tue/Wed, NOT on the
    // day before (Sat) or after (Thu).
    const pages = [
      makePage({
        id: "trip",
        scheduledEnd: "2026-03-18T17:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Trip",
      }),
    ];
    const sat = buildDayBlocks(pages, new Date(2026, 2, 14));
    const sun = buildDayBlocks(pages, new Date(2026, 2, 15));
    const mon = buildDayBlocks(pages, new Date(2026, 2, 16));
    const tue = buildDayBlocks(pages, new Date(2026, 2, 17));
    const wed = buildDayBlocks(pages, new Date(2026, 2, 18));
    const thu = buildDayBlocks(pages, new Date(2026, 2, 19));
    expect(sat).toHaveLength(0);
    expect(sun).toHaveLength(1);
    expect(mon).toHaveLength(1);
    expect(tue).toHaveLength(1);
    expect(wed).toHaveLength(1);
    expect(thu).toHaveLength(0);
  });

  it("empty input → empty array", () => {
    expect(buildDayBlocks([], day)).toEqual([]);
  });

  it("ignores pages from other days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T10:00:00",
        scheduledStart: "2026-03-16T09:00:00",
        title: "Wrong day",
      }),
    ];
    expect(buildDayBlocks(pages, day)).toHaveLength(0);
  });

  it("ignores pages with no scheduledStart", () => {
    const pages = [makePage({ scheduledStart: null, title: "No schedule" })];
    expect(buildDayBlocks(pages, day)).toHaveLength(0);
  });

  // ── Cross-day events ──────────────────────────────────────────────────────

  it("event spanning midnight shows on both days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T02:00:00",
        scheduledStart: "2026-03-15T22:00:00",
        title: "Late night",
      }),
    ];

    const blocksDay1 = buildDayBlocks(pages, day);
    expect(blocksDay1).toHaveLength(1);
    const b1 = blocksDay1[0]!;
    expect(b1.top).toBe((22 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(b1.height).toBe(GRID_HEIGHT - b1.top);
    expect(b1.isContinuationAfter).toBe(true);
    expect(b1.isContinuationBefore).toBeUndefined();

    const nextDay = new Date(2026, 2, 16);
    const blocksDay2 = buildDayBlocks(pages, nextDay);
    expect(blocksDay2).toHaveLength(1);
    const b2 = blocksDay2[0]!;
    expect(b2.top).toBe(0);
    expect(b2.isContinuationBefore).toBe(true);
    expect(b2.isContinuationAfter).toBeUndefined();
  });

  it("event ending exactly at midnight clamps to grid end", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T00:00:00",
        scheduledStart: "2026-03-15T16:30:00",
        title: "Evening block",
      }),
    ];

    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.isContinuationAfter).toBe(true);
    expect(b.top).toBe((16.5 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(b.height).toBe(GRID_HEIGHT - b.top);
  });

  it("one-midnight event renders as split segments on both spanned days", () => {
    // Single midnight crossed → segment A on day 1 runs to bottom of grid;
    // segment B on day 2 runs from top of grid to event end.
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T02:45:00",
        scheduledStart: "2026-03-15T18:15:00",
        title: "Late evening",
      }),
    ];

    // Day 1 (segment A): start = 18:15, end = bottom of grid.
    const day1 = buildDayBlocks(pages, day);
    expect(day1).toHaveLength(1);
    expect(day1[0]!.isContinuationAfter).toBe(true);
    expect(day1[0]!.isContinuationBefore).toBeUndefined();

    // Day 2 (segment B): start = top, end = 02:45.
    const day2 = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(day2).toHaveLength(1);
    expect(day2[0]!.isContinuationBefore).toBe(true);
    expect(day2[0]!.isContinuationAfter).toBeUndefined();
    expect(day2[0]!.top).toBe(0);
    expect(day2[0]!.height).toBe(2.75 * HOUR_HEIGHT);
  });

  it("no-end event at the end of a day is never a continuation", () => {
    const pages = [
      makePage({
        scheduledStart: "2026-03-15T23:45:00",
        title: "Point in time",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.isContinuationAfter).toBeUndefined();
    expect(blocks[0]!.isCompact).toBe(true);
  });

  it("cross-day event does not appear on unrelated days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T02:00:00",
        scheduledStart: "2026-03-15T22:00:00",
        title: "Late night",
      }),
    ];
    expect(buildDayBlocks(pages, new Date(2026, 2, 17))).toHaveLength(0);
  });

  it("cross-midnight 11pm→1am: split into 1h on day 1, 1h on day 2", () => {
    const pages = [
      makePage({
        id: "late",
        scheduledEnd: "2026-03-16T01:00:00",
        scheduledStart: "2026-03-15T23:00:00",
        title: "Late",
      }),
    ];
    const a = buildDayBlocks(pages, day);
    expect(a).toHaveLength(1);
    expect(a[0]!.isContinuationAfter).toBe(true);
    expect(a[0]!.isContinuationBefore).toBeUndefined();
    expect(a[0]!.top).toBe(23 * HOUR_HEIGHT);
    expect(a[0]!.height).toBe(HOUR_HEIGHT);

    const b = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(b).toHaveLength(1);
    expect(b[0]!.isContinuationBefore).toBe(true);
    expect(b[0]!.isContinuationAfter).toBeUndefined();
    expect(b[0]!.top).toBe(0);
    expect(b[0]!.height).toBe(HOUR_HEIGHT);
  });

  it("cross-midnight 6pm→6am: 6h on day 1, 6h on day 2", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T06:00:00",
        scheduledStart: "2026-03-15T18:00:00",
        title: "Long night",
      }),
    ];
    const a = buildDayBlocks(pages, day);
    expect(a[0]!.top).toBe(18 * HOUR_HEIGHT);
    expect(a[0]!.height).toBe(6 * HOUR_HEIGHT);
    expect(a[0]!.isContinuationAfter).toBe(true);

    const b = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(b[0]!.top).toBe(0);
    expect(b[0]!.height).toBe(6 * HOUR_HEIGHT);
    expect(b[0]!.isContinuationBefore).toBe(true);
  });

  it("24-hour event (1 midnight): split as 1h on day 1 + 23h on day 2", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T23:00:00", // Mon 11pm
        scheduledStart: "2026-03-15T23:00:00", // Sun 11pm
        title: "Day-long",
      }),
    ];
    // Sunday — segment A: 11pm to bottom (1h before midnight).
    const sun = buildDayBlocks(pages, day);
    expect(sun).toHaveLength(1);
    expect(sun[0]!.isContinuationAfter).toBe(true);
    expect(sun[0]!.top).toBe(23 * HOUR_HEIGHT);
    // Monday — segment B: top to 11pm.
    const mon = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(mon).toHaveLength(1);
    expect(mon[0]!.isContinuationBefore).toBe(true);
    expect(mon[0]!.top).toBe(0);
    expect(mon[0]!.height).toBe(23 * HOUR_HEIGHT);
  });

  it("cross-day event with same-day overlap cascades when tops are far apart", () => {
    // Overnight visually starts at midnight (top=0), Morning at 8am.
    // Top gap >> CASCADE_MIN_TOP_GAP_PX → cascade.
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T10:00:00",
        scheduledStart: "2026-03-15T22:00:00",
        title: "Overnight",
      }),
      makePage({
        scheduledEnd: "2026-03-16T09:00:00",
        scheduledStart: "2026-03-16T08:00:00",
        title: "Morning",
      }),
    ];
    const nextDay = new Date(2026, 2, 16);
    const blocks = buildDayBlocks(pages, nextDay);
    expect(blocks).toHaveLength(2);
    const overnight = blocks.find((b) => b.page.title === "Overnight")!;
    const morning = blocks.find((b) => b.page.title === "Morning")!;
    expect(overnight.leftPct).toBe(0);
    expect(morning.leftPct).toBe(CASCADE_OFFSET_PCT);
  });

  it("clipping invariant: every block stays inside its column (leftPct + widthPct ≤ 100)", () => {
    // A pathological mix: deep cascade, close-top split, point clusters,
    // and a containment guest. None of these should produce a block whose
    // rendered width extends past the day-column right edge.
    const pages = [
      makePage({
        id: "host",
        scheduledEnd: "2026-03-15T18:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "Host",
      }),
      makePage({
        id: "g1",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T10:00:00",
        title: "G1",
      }),
      makePage({
        id: "g2",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "G2",
      }),
      makePage({
        id: "g3",
        scheduledEnd: "2026-03-15T13:00:00",
        scheduledStart: "2026-03-15T12:00:00",
        title: "G3",
      }),
      makePage({ id: "p1", scheduledStart: "2026-03-15T14:00:00", title: "P1" }),
      makePage({ id: "p2", scheduledStart: "2026-03-15T14:00:00", title: "P2" }),
      makePage({ id: "p3", scheduledStart: "2026-03-15T14:00:00", title: "P3" }),
    ];
    const blocks = buildDayBlocks(pages, day);
    for (const b of blocks) {
      expect(b.leftPct).toBeGreaterThanOrEqual(0);
      expect(b.widthPct).toBeGreaterThanOrEqual(0);
      expect(b.leftPct + b.widthPct).toBeLessThanOrEqual(100);
    }
  });
});

// ─── timeToY ─────────────────────────────────────────────────────────────────

describe("timeToY", () => {
  it("midnight → 0 (grid start)", () => {
    expect(timeToY(new Date(2026, 2, 15, 0, 0))).toBe(0);
  });

  it("6:00 AM → 6 * HOUR_HEIGHT", () => {
    expect(timeToY(new Date(2026, 2, 15, 6, 0))).toBe(6 * HOUR_HEIGHT);
  });

  it("11:00 PM → 23 * HOUR_HEIGHT (not clamped, full 24h grid)", () => {
    expect(timeToY(new Date(2026, 2, 15, 23, 0))).toBe(23 * HOUR_HEIGHT);
    expect(timeToY(new Date(2026, 2, 15, 23, 0))).toBeLessThan(GRID_HEIGHT);
  });

  it("9:30 AM → 9.5 * HOUR_HEIGHT", () => {
    expect(timeToY(new Date(2026, 2, 15, 9, 30))).toBe(9.5 * HOUR_HEIGHT);
  });
});

// ─── yToDate ─────────────────────────────────────────────────────────────────

describe("yToDate", () => {
  const day = new Date(2026, 2, 15);

  it("0px → midnight on given day", () => {
    const result = yToDate(0, day);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it("snaps to 15-min boundaries", () => {
    // A y-value that corresponds to ~0:07 should snap to 0:00
    const sevenMinY = (7 / 60) * HOUR_HEIGHT;
    const result = yToDate(sevenMinY, day);
    expect(result.getMinutes() % 15).toBe(0);
  });
});

// ─── snapY ───────────────────────────────────────────────────────────────────

describe("snapY", () => {
  it("rounds to nearest 15-min grid line", () => {
    // 15 min = HOUR_HEIGHT / 4
    const fifteenMinY = HOUR_HEIGHT / 4;
    expect(snapY(fifteenMinY)).toBe(fifteenMinY);
    // Halfway between 0 and 15 min → snaps to 15 min
    expect(snapY(fifteenMinY / 2 + 1)).toBe(fifteenMinY);
  });

  it("0 → 0", () => {
    expect(snapY(0)).toBe(0);
  });
});

// ─── formatTimeRange ─────────────────────────────────────────────────────────

describe("formatTimeRange", () => {
  it("same period → shares AM/PM, unspaced dash", () => {
    const start = new Date(2026, 2, 15, 9, 0);
    const end = new Date(2026, 2, 15, 10, 30);
    expect(formatTimeRange(start, end)).toBe("9–10:30 AM");
  });

  it("cross period → both AM/PM shown, unspaced dash", () => {
    const start = new Date(2026, 2, 15, 11, 30);
    const end = new Date(2026, 2, 15, 13, 0);
    expect(formatTimeRange(start, end)).toBe("11:30 AM–1 PM");
  });
});

// ─── formatMultiDayTimeRange ────────────────────────────────────────────────

describe("formatMultiDayTimeRange", () => {
  it("includes day-of-week on each side", () => {
    // 2026-03-17 is a Tuesday, 2026-03-19 is a Thursday.
    const start = new Date(2026, 2, 17, 10);
    const end = new Date(2026, 2, 19, 17);
    expect(formatMultiDayTimeRange(start, end)).toBe("10 AM Tue – 5 PM Thu");
  });

  it("preserves minutes when non-zero", () => {
    const start = new Date(2026, 2, 16, 9, 30);
    const end = new Date(2026, 2, 18, 14, 15);
    expect(formatMultiDayTimeRange(start, end)).toBe("9:30 AM Mon – 2:15 PM Wed");
  });
});

// ─── computeAllDayEdgeResize ─────────────────────────────────────────────────

describe("computeAllDayEdgeResize", () => {
  it("right edge dragged later than anchor → anchor is start, grabbed is end", () => {
    const result = computeAllDayEdgeResize("2026-03-15", "2026-03-18");
    expect(result).toEqual({ end: "2026-03-18", start: "2026-03-15" });
  });

  it("left edge dragged earlier than anchor → grabbed is start, anchor is end", () => {
    const result = computeAllDayEdgeResize("2026-03-18", "2026-03-15");
    expect(result).toEqual({ end: "2026-03-18", start: "2026-03-15" });
  });

  it("grabbed edge crosses anchor → range flips so grabbed becomes opposite edge", () => {
    // User grabs start edge at day 15 (anchor end = day 18), drags past 18 to day 20.
    // Expected: range becomes [18, 20] — the grabbed edge is now the end.
    const result = computeAllDayEdgeResize("2026-03-18", "2026-03-20");
    expect(result).toEqual({ end: "2026-03-20", start: "2026-03-18" });
  });

  it("grabbed equals anchor → zero-length range (single day) with both set to same date", () => {
    const result = computeAllDayEdgeResize("2026-03-15", "2026-03-15");
    expect(result).toEqual({ end: "2026-03-15", start: "2026-03-15" });
  });
});

// ─── computeScheduleTransition ───────────────────────────────────────────────

describe("computeScheduleTransition", () => {
  it("all-day → timed: collapses to single day (end undefined)", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-18", start: "2026-03-15" },
      "2026-03-15T09:00:00"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-15T09:00:00" });
  });

  it("all-day → timed (single-day): end stays undefined", () => {
    const result = computeScheduleTransition(
      { end: undefined, start: "2026-03-15" },
      "2026-03-15T14:30:00"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-15T14:30:00" });
  });

  it("timed → all-day: preserves date extent (strips time from end)", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-16T17:00:00", start: "2026-03-15T09:00:00" },
      "2026-03-15"
    );
    expect(result).toEqual({ end: "2026-03-16", start: "2026-03-15" });
  });

  it("timed → all-day where end date equals start date: end undefined (single day)", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-15T17:00:00", start: "2026-03-15T09:00:00" },
      "2026-03-15"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-15" });
  });

  it("timed → timed: preserves duration", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-15T10:30:00", start: "2026-03-15T09:00:00" },
      "2026-03-15T14:00:00"
    );
    // 90-min duration preserved.
    expect(result).toEqual({ end: "2026-03-15T15:30:00", start: "2026-03-15T14:00:00" });
  });

  it("all-day → all-day: preserves end when still >= new start", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-18", start: "2026-03-15" },
      "2026-03-16"
    );
    expect(result).toEqual({ end: "2026-03-18", start: "2026-03-16" });
  });

  it("all-day → all-day: drops end when new start crosses past it", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-18", start: "2026-03-15" },
      "2026-03-20"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-20" });
  });

  it("no previous schedule (start null) → all-day only, no end", () => {
    const result = computeScheduleTransition({ end: null, start: null }, "2026-03-15");
    expect(result).toEqual({ end: undefined, start: "2026-03-15" });
  });
});

// ─── normalizeEndInput ───────────────────────────────────────────────────────

describe("normalizeEndInput", () => {
  it("null end → undefined (end cleared)", () => {
    expect(normalizeEndInput("2026-03-15", null)).toBeUndefined();
  });

  it("end > start (all-day) → passed through", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-18")).toBe("2026-03-18");
  });

  it("end == start → undefined (single day)", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-15")).toBeUndefined();
  });

  it("end < start → undefined (clamped)", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-10")).toBeUndefined();
  });

  it("all-day start with datetime end → strips time to date-only", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-18T09:00:00")).toBe("2026-03-18");
  });

  it("timed start with datetime end → passed through unchanged", () => {
    expect(normalizeEndInput("2026-03-15T09:00:00", "2026-03-15T10:30:00")).toBe(
      "2026-03-15T10:30:00"
    );
  });
});

// ─── hexToRgba ───────────────────────────────────────────────────────────────

describe("hexToRgba", () => {
  it("valid hex → correct rgba string", () => {
    expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
  });

  it("valid hex without # → correct rgba string", () => {
    expect(hexToRgba("00ff00", 0.25)).toBe("rgba(0,255,0,0.25)");
  });

  it("invalid hex → fallback indigo", () => {
    expect(hexToRgba("zzz", 0.5)).toBe("rgba(99,102,241,0.5)");
  });
});

// ─── Collapse geometry ───────────────────────────────────────────────────────

describe("buildCollapseGeometry", () => {
  it("both bands collapsed → 40 + middle + 40", () => {
    const g = buildCollapseGeometry(
      { bottomCollapsed: true, bottomHour: 22, topCollapsed: true, topHour: 6 },
      64
    );
    expect(g.topBandHeight).toBe(40);
    expect(g.middleHeight).toBe(16 * 64);
    expect(g.bottomBandHeight).toBe(40);
    expect(g.totalHeight).toBe(40 + 16 * 64 + 40);
  });

  it("both bands expanded → full 24 * hourHeight", () => {
    const g = buildCollapseGeometry(
      { bottomCollapsed: false, bottomHour: 22, topCollapsed: false, topHour: 6 },
      64
    );
    expect(g.totalHeight).toBe(24 * 64);
  });
});

describe("mapHourToY / mapYToHour", () => {
  const config = { bottomCollapsed: true, bottomHour: 22, topCollapsed: true, topHour: 6 };
  const g = buildCollapseGeometry(config, 64);

  it("hour 0 → y 0", () => {
    expect(mapHourToY(0, g)).toBe(0);
  });

  it("hour topHour → start of middle region", () => {
    expect(mapHourToY(6, g)).toBe(g.middleStart);
  });

  it("hour bottomHour → end of middle region", () => {
    expect(mapHourToY(22, g)).toBe(g.middleEnd);
  });

  it("hour 24 → totalHeight", () => {
    expect(mapHourToY(24, g)).toBe(g.totalHeight);
  });

  it("middle hour follows 1:1 hourHeight scaling", () => {
    expect(mapHourToY(10, g)).toBe(g.middleStart + 4 * 64);
  });

  it("inverse: y 0 → hour 0, y middleStart → topHour, y middleEnd → bottomHour", () => {
    expect(mapYToHour(0, g)).toBe(0);
    expect(mapYToHour(g.middleStart, g)).toBe(6);
    expect(mapYToHour(g.middleEnd, g)).toBe(22);
    expect(mapYToHour(g.totalHeight, g)).toBe(24);
  });

  it("round-trip in middle region preserves hour value", () => {
    for (const h of [7, 9.5, 12, 18, 21]) {
      expect(mapYToHour(mapHourToY(h, g), g)).toBeCloseTo(h, 5);
    }
  });
});

describe("mapYToDate", () => {
  const config = { bottomCollapsed: true, bottomHour: 22, topCollapsed: true, topHour: 6 };
  const g = buildCollapseGeometry(config, 64);
  const day = new Date(2026, 4, 1);

  it("y inside top collapsed band clamps to topHour boundary", () => {
    const r = mapYToDate(20, day, g);
    expect(r.getHours()).toBe(6);
    expect(r.getMinutes()).toBe(0);
  });

  it("y inside bottom collapsed band clamps to bottomHour boundary", () => {
    const r = mapYToDate(g.middleEnd + 20, day, g);
    expect(r.getHours()).toBe(22);
    expect(r.getMinutes()).toBe(0);
  });

  it("y in middle region snaps to nearest 15 min", () => {
    const r = mapYToDate(g.middleStart + 64 * 3 + 64 * 0.1, day, g);
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes() % 15).toBe(0);
  });
});

describe("clampTopHour / clampBottomHour", () => {
  it("topHour stays at least 1 below bottomHour", () => {
    expect(clampTopHour(20, 22)).toBe(12);
    expect(clampTopHour(8, 22)).toBe(8);
  });

  it("bottomHour stays at least 1 above topHour", () => {
    expect(clampBottomHour(2, 6)).toBe(12);
    expect(clampBottomHour(20, 6)).toBe(20);
  });

  it("hard caps respect 0..24", () => {
    expect(clampTopHour(-5, 22)).toBe(0);
    expect(clampBottomHour(99, 6)).toBe(24);
  });
});

describe("remapBlocksForCollapse", () => {
  const config = { bottomCollapsed: true, bottomHour: 22, topCollapsed: true, topHour: 6 };
  const g = buildCollapseGeometry(config, 64);

  function block(top: number, height: number, id: string) {
    return {
      endDate: new Date(),
      height,
      isCompact: true,
      leftPct: 0,
      page: makePage({ id }),
      startDate: new Date(),
      top,
      widthPct: 100,
    };
  }

  it("blocks fully in top collapsed range → topCollapsedPageIds", () => {
    const r = remapBlocksForCollapse([block(0, 64, "a"), block(64 * 4, 64, "b")], g);
    expect(r.topCollapsedPageIds).toEqual(["a", "b"]);
    expect(r.visible).toHaveLength(0);
  });

  it("blocks fully in bottom collapsed range → bottomCollapsedPageIds", () => {
    const r = remapBlocksForCollapse([block(64 * 22, 64, "x"), block(64 * 23, 64, "y")], g);
    expect(r.bottomCollapsedPageIds).toEqual(["x", "y"]);
    expect(r.visible).toHaveLength(0);
  });

  it("blocks in middle range → remapped via geometry, stay visible", () => {
    const r = remapBlocksForCollapse([block(64 * 9, 64, "m")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.visible[0]!.top).toBe(g.middleStart + (9 - 6) * 64);
    expect(r.visible[0]!.height).toBe(64);
  });
});

describe("remapBlocksForCollapse — boundary cases", () => {
  const config = { bottomCollapsed: true, bottomHour: 22, topCollapsed: true, topHour: 6 };
  const g = buildCollapseGeometry(config, 64);

  function block(top: number, height: number, id: string) {
    return {
      endDate: new Date(),
      height,
      isCompact: true,
      leftPct: 0,
      page: makePage({ id }),
      startDate: new Date(),
      top,
      widthPct: 100,
    };
  }

  it("block straddling top boundary stays visible with rewritten top/height", () => {
    // event 5am-9am: starts in collapsed top band, ends in middle.
    const r = remapBlocksForCollapse([block(64 * 5, 64 * 4, "boundary")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.topCollapsedPageIds).toEqual([]);
    const v = r.visible[0]!;
    expect(v.top).toBeCloseTo((5 / 6) * 40, 5);
    expect(v.top + v.height).toBeCloseTo(g.middleStart + 3 * 64, 5);
  });

  it("block straddling bottom boundary stays visible", () => {
    const r = remapBlocksForCollapse([block(64 * 21, 64 * 2, "evening")], g);
    expect(r.visible).toHaveLength(1);
    expect(r.bottomCollapsedPageIds).toEqual([]);
    expect(r.visible[0]!.top).toBe(g.middleStart + 15 * 64);
  });

  it("block ending exactly at topHour boundary → top-collapsed", () => {
    const r = remapBlocksForCollapse([block(64 * 4, 64 * 2, "early")], g);
    expect(r.topCollapsedPageIds).toEqual(["early"]);
    expect(r.visible).toHaveLength(0);
  });

  it("block starting exactly at bottomHour → bottom-collapsed", () => {
    const r = remapBlocksForCollapse([block(64 * 22, 64 * 2, "late")], g);
    expect(r.bottomCollapsedPageIds).toEqual(["late"]);
    expect(r.visible).toHaveLength(0);
  });

  it("when no bands collapsed, every block stays visible", () => {
    const noCollapse = buildCollapseGeometry(
      { bottomCollapsed: false, bottomHour: 22, topCollapsed: false, topHour: 6 },
      64
    );
    const r = remapBlocksForCollapse(
      [block(64 * 2, 64, "early"), block(64 * 23, 64, "late")],
      noCollapse
    );
    expect(r.topCollapsedPageIds).toEqual([]);
    expect(r.bottomCollapsedPageIds).toEqual([]);
    expect(r.visible).toHaveLength(2);
  });

  it("multiple blocks in collapsed band aggregate in source order", () => {
    const r = remapBlocksForCollapse(
      [block(0, 32, "first"), block(32, 32, "second"), block(64, 32, "third")],
      g
    );
    expect(r.topCollapsedPageIds).toEqual(["first", "second", "third"]);
  });
});
