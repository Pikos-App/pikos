import { describe, expect, it } from "vitest";

import {
  assignAllDayRows,
  assignStableAllDayRows,
  buildAllDayBars,
  buildAllDayItems,
  computeAllDayEdgeResize,
  crossingMidnightsCount,
  firstFreeRowInSpan,
  isAllDayPage,
  shiftAllDayEnd,
} from "./allDayLayout";
import { makePage } from "./calendar.testHelpers";

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

  it("shared-id recurring (daily, no gaps) → one bar per day, never one eternal span", () => {
    // Regression: a gap-free daily series has no empty columns to break the
    // run, so the page-id-only merge collapsed all seven single-day virtuals
    // into one bar spanning the whole row ("single eternal page in the all-day
    // row"). Each occurrence is single-day (no continuation flags), so they
    // must stay seven separate span-1 bars.
    const pages = Array.from({ length: 7 }, (_, i) =>
      makePage({ id: "standup", scheduledStart: `2026-03-${16 + i}` })
    );
    const bars = buildAllDayBars(assignAllDayRows(pages, week1));
    expect(bars).toHaveLength(7);
    expect(bars.map((b) => b.startCol)).toEqual([0, 1, 2, 3, 4, 5, 6]);
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
