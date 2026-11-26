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

describe("isAllDayPage", () => {
  it("date-only string → true", () => {
    expect(isAllDayPage("2026-03-15")).toBe(true);
  });

  it("datetime string → false", () => {
    expect(isAllDayPage("2026-03-15T14:00:00")).toBe(false);
  });
});

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

describe("buildAllDayItems", () => {
  it("returns only all-day pages matching the given day", () => {
    const day = new Date(2026, 2, 15);
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
    expect(day15[0]?.isContinuationBefore).toBe(false);
    expect(day15[0]?.isContinuationAfter).toBe(true);
    expect(day16[0]?.isContinuationBefore).toBe(true);
    expect(day16[0]?.isContinuationAfter).toBe(true);
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
    expect(slots[1]?.[0]?.page.id).toBe("trip");
    expect(slots[1]?.[1]?.page.id).toBe("lunch");
    expect(slots[2]?.[0]?.page.id).toBe("trip");
    expect(slots[2]?.[1]).toBe(null);
  });

  it("places a solo middle-day event at row 0 when siblings occupy row 0 on other days", () => {
    const pages = [
      makePage({ id: "left", scheduledStart: "2026-03-15" }),
      makePage({ id: "mid", scheduledStart: "2026-03-16" }),
      makePage({ id: "right", scheduledStart: "2026-03-17" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(slots[0]?.[0]?.page.id).toBe("left");
    expect(slots[1]?.[0]?.page.id).toBe("mid");
    expect(slots[2]?.[0]?.page.id).toBe("right");
    expect(slots[1]).toHaveLength(1);
  });

  it("places multi-day spans above same-start single-day events", () => {
    const pages = [
      makePage({ id: "single", scheduledStart: "2026-03-15" }),
      makePage({ id: "span", scheduledEnd: "2026-03-17", scheduledStart: "2026-03-15" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(slots[0]?.[0]?.page.id).toBe("span");
    expect(slots[0]?.[1]?.page.id).toBe("single");
  });

  it("breaks ties with createdAt, not pageId, when events share a start day", () => {
    const pages = [
      makePage({ createdAt: "2026-02-02T00:00:00", id: "zzz", scheduledStart: "2026-03-15" }),
      makePage({ createdAt: "2026-02-01T00:00:00", id: "aaa", scheduledStart: "2026-03-15" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(slots[0]?.[0]?.page.id).toBe("aaa");
    expect(slots[0]?.[1]?.page.id).toBe("zzz");
  });

  it("does not claim row on gap days for non-contiguous virtual occurrences sharing an id", () => {
    // Recurring occurrences share the head page's id, so they must not claim row 0 on every day
    // between the first and last; a single-day event on a gap day would be pushed to row 1.
    const pages = [
      makePage({ id: "run", scheduledStart: "2026-03-15" }),
      makePage({ id: "run", scheduledStart: "2026-03-17" }),
      makePage({ id: "run", scheduledStart: "2026-03-19" }),
      makePage({ id: "meeting", scheduledStart: "2026-03-18" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(slots[3]?.[0]?.page.id).toBe("meeting");
  });
});

describe("assignStableAllDayRows", () => {
  const week1 = Array.from({ length: 7 }, (_, i) => new Date(2026, 2, 16 + i));
  const week2 = Array.from({ length: 7 }, (_, i) => new Date(2026, 2, 23 + i));

  it("keeps a cross-week event on the same row in the week it continues into", () => {
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

    expect(w1[5]?.[0]?.page.id).toBe("a");
    expect(w1[5]?.[1]?.page.id).toBe("b");
    expect(w1[5]?.[2]?.page.id).toBe("c");
    expect(w1[5]?.[3]?.page.id).toBe("d");

    expect(w2[0]?.[0]?.page.id).toBe("a");
    expect(w2[0]?.[1]?.page.id).toBe("b");
    expect(w2[0]?.[2]?.page.id).toBe("c");
  });

  it("trims trailing empty rows when the stable layout would leave unused slots below", () => {
    const pages = [makePage({ id: "d", scheduledEnd: "2026-03-23", scheduledStart: "2026-03-21" })];
    const w2 = assignStableAllDayRows(pages, week2);
    expect(w2[0]).toHaveLength(1);
    expect(w2[0]?.[0]?.page.id).toBe("d");
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
    expect(w2[0]?.[0]?.page.id).toBe("d");
  });

  it("recurring virtual occurrences sharing an id keep their non-contiguous rows in the stable view", () => {
    const pages = [
      makePage({ id: "run", scheduledStart: "2026-03-16" }),
      makePage({ id: "run", scheduledStart: "2026-03-18" }),
      makePage({ id: "run", scheduledStart: "2026-03-20" }),
      makePage({ id: "tue-meeting", scheduledStart: "2026-03-17" }),
    ];
    const w1 = assignStableAllDayRows(pages, week1);
    expect(w1[1]?.[0]?.page.id).toBe("tue-meeting");
  });
});

describe("firstFreeRowInSpan", () => {
  const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 2, 16 + i));

  it("returns 0 when every column in the span is empty", () => {
    const slots = assignAllDayRows([], days);
    expect(firstFreeRowInSpan(slots, 0, 4)).toBe(0);
  });

  it("returns the lowest row that is empty across every spanned column", () => {
    const pages = [
      makePage({ createdAt: "2026-01-01", id: "a", scheduledStart: "2026-03-18" }),
      makePage({ createdAt: "2026-01-02", id: "b", scheduledStart: "2026-03-18" }),
    ];
    const slots = assignAllDayRows(pages, days);
    expect(firstFreeRowInSpan(slots, 1, 3)).toBe(2);
  });

  it("uses only the spanned columns — events outside the span don't push the row down", () => {
    const pages = [makePage({ id: "outside", scheduledStart: "2026-03-20" })];
    const slots = assignAllDayRows(pages, days);
    expect(firstFreeRowInSpan(slots, 0, 2)).toBe(0);
  });

  it("treats a single-column span (lo === hi) as a one-cell free check", () => {
    const pages = [makePage({ id: "x", scheduledStart: "2026-03-17" })];
    const slots = assignAllDayRows(pages, days);
    expect(firstFreeRowInSpan(slots, 1, 1)).toBe(1);
    expect(firstFreeRowInSpan(slots, 0, 0)).toBe(0);
  });
});

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
    const pages = [
      makePage({ id: "conf", scheduledEnd: "2026-03-24", scheduledStart: "2026-03-21" }),
    ];
    const bars = buildAllDayBars(assignStableAllDayRows(pages, week2));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      continuesLeft: true,
      continuesRight: false,
      span: 2,
      startCol: 0,
    });
  });

  it("multi-week event extending after the view → continuesRight", () => {
    const pages = [
      makePage({ id: "conf", scheduledEnd: "2026-03-23", scheduledStart: "2026-03-21" }),
    ];
    const bars = buildAllDayBars(assignStableAllDayRows(pages, week1));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      continuesLeft: false,
      continuesRight: true,
      span: 2,
      startCol: 5,
    });
  });

  it("event spanning the entire view both continues left and right", () => {
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
    const pages = [
      makePage({ id: "run", scheduledStart: "2026-03-16" }),
      makePage({ id: "run", scheduledStart: "2026-03-18" }),
      makePage({ id: "run", scheduledStart: "2026-03-20" }),
    ];
    const bars = buildAllDayBars(assignAllDayRows(pages, week1));
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.startCol)).toEqual([0, 2, 4]);
    expect(bars.every((b) => b.span === 1)).toBe(true);
    expect(bars.every((b) => !b.continuesLeft && !b.continuesRight)).toBe(true);
  });

  it("shared-id recurring (daily, no gaps) → one bar per day, never one eternal span", () => {
    // No empty columns break a gap-free daily series, so merging on page id alone would make one
    // bar of seven single-day occurrences.
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

describe("shiftAllDayEnd", () => {
  it("shifts the end date by the same number of days as the move", () => {
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
    const r1 = shiftAllDayEnd("2026-03-15T09:00:00", "2026-03-15T10:00:00", new Date(2026, 2, 22));
    expect(r1).toBeUndefined();
    const r2 = shiftAllDayEnd("2026-03-15", "2026-03-18T10:00:00", new Date(2026, 2, 22));
    expect(r2).toBeUndefined();
  });

  it("returns undefined when start is missing entirely", () => {
    expect(shiftAllDayEnd(null, "2026-03-18", new Date(2026, 2, 22))).toBeUndefined();
  });
});

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
    const result = computeAllDayEdgeResize("2026-03-18", "2026-03-20");
    expect(result).toEqual({ end: "2026-03-20", start: "2026-03-18" });
  });

  it("grabbed equals anchor → zero-length range (single day) with both set to same date", () => {
    const result = computeAllDayEdgeResize("2026-03-15", "2026-03-15");
    expect(result).toEqual({ end: "2026-03-15", start: "2026-03-15" });
  });
});
