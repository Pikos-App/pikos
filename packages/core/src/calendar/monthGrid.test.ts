import { describe, expect, it } from "vitest";

import type { PageSummary } from "../types";
import {
  buildMonthGrid,
  MONTH_CELL_MAX_EVENTS,
  monthGridDays,
  placeMonthCellEvents,
} from "./monthGrid";

function page(over: Partial<PageSummary> & { id: string }): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    isRecurring: false,
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    syncState: null,
    tags: [],
    title: over.id,
    updatedAt: "2026-01-01T00:00:00",
    ...over,
  };
}

/** 'YYYY-MM-DD' keys of a grid, row by row — the readable shape for assertions. */
function keys(weeks: ReturnType<typeof buildMonthGrid>): string[][] {
  return weeks.map((w) => w.map((c) => c.key));
}

describe("buildMonthGrid — padding and shape", () => {
  it("pads the visible month back to Monday and forward to Sunday", () => {
    // March 2026 starts on a Sunday and ends on a Tuesday.
    const weeks = buildMonthGrid(new Date(2026, 2, 15), 1, new Date(2026, 2, 15));
    expect(keys(weeks)[0]?.[0]).toBe("2026-02-23");
    expect(weeks[weeks.length - 1]?.[6]?.key).toBe("2026-04-05");
    for (const week of weeks) expect(week).toHaveLength(7);
  });

  it("anchors the grid on Sunday when weekStartsOn is 0", () => {
    const weeks = buildMonthGrid(new Date(2026, 2, 15), 0, new Date(2026, 2, 15));
    expect(weeks[0]?.[0]?.key).toBe("2026-03-01");
    expect(weeks[0]?.[0]?.date.getDay()).toBe(0);
    expect(weeks[weeks.length - 1]?.[6]?.key).toBe("2026-04-04");
  });

  it("emits whole weeks only — never a partial trailing row", () => {
    // Sweep a year of months under both week-start conventions.
    for (const weekStartsOn of [0, 1] as const) {
      for (let month = 0; month < 12; month++) {
        const weeks = buildMonthGrid(new Date(2026, month, 1), weekStartsOn, new Date(2026, 0, 1));
        expect(weeks.length).toBeGreaterThanOrEqual(4);
        expect(weeks.length).toBeLessThanOrEqual(6);
        for (const week of weeks) expect(week).toHaveLength(7);
      }
    }
  });

  it("covers every day of the month between the padding", () => {
    const weeks = buildMonthGrid(new Date(2026, 6, 10), 1, new Date(2026, 6, 10));
    const inMonth = weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]?.key).toBe("2026-07-01");
    expect(inMonth[inMonth.length - 1]?.key).toBe("2026-07-31");
  });

  it("flags padding cells from the neighbouring months as out-of-month", () => {
    const weeks = buildMonthGrid(new Date(2026, 2, 15), 1, new Date(2026, 2, 15));
    const first = weeks[0]?.[0];
    expect(first?.key).toBe("2026-02-23");
    expect(first?.inMonth).toBe(false);
    const last = weeks[weeks.length - 1]?.[6];
    expect(last?.inMonth).toBe(false);
  });

  it("does not treat the same day-of-month in another year as in-month", () => {
    // December 2025's grid pads into January 2026 — same month index arithmetic
    // would wrongly mark a January cell in-month without the year check.
    const weeks = buildMonthGrid(new Date(2025, 11, 10), 1, new Date(2025, 11, 10));
    const january = weeks.flat().filter((c) => c.key.startsWith("2026-01"));
    expect(january.length).toBeGreaterThan(0);
    for (const cell of january) expect(cell.inMonth).toBe(false);
  });
});

describe("buildMonthGrid — today and calendar edge cases", () => {
  it("marks exactly one cell as today when today is inside the grid", () => {
    const weeks = buildMonthGrid(new Date(2026, 4, 12), 1, new Date(2026, 4, 12, 14, 30));
    const todays = weeks.flat().filter((c) => c.isToday);
    expect(todays).toHaveLength(1);
    expect(todays[0]?.key).toBe("2026-05-12");
  });

  it("marks a padding cell as today when today falls in the padding", () => {
    // March 2026 starts on a Sunday, so its Monday-anchored grid opens on
    // Feb 23 — a date in February still renders inside the March grid.
    const weeks = buildMonthGrid(new Date(2026, 2, 15), 1, new Date(2026, 1, 25, 9, 0));
    const todays = weeks.flat().filter((c) => c.isToday);
    expect(todays).toHaveLength(1);
    expect(todays[0]?.key).toBe("2026-02-25");
    expect(todays[0]?.inMonth).toBe(false);
  });

  it("marks no cell as today when today is outside the grid", () => {
    const weeks = buildMonthGrid(new Date(2026, 0, 15), 1, new Date(2026, 8, 1));
    expect(weeks.flat().some((c) => c.isToday)).toBe(false);
  });

  it("includes Feb 29 in a leap year and stops at Feb 28 otherwise", () => {
    const leap = buildMonthGrid(new Date(2028, 1, 10), 1, new Date(2028, 1, 10));
    const leapDays = leap.flat().filter((c) => c.inMonth);
    expect(leapDays).toHaveLength(29);
    expect(leapDays[leapDays.length - 1]?.key).toBe("2028-02-29");

    const common = buildMonthGrid(new Date(2026, 1, 10), 1, new Date(2026, 1, 10));
    const commonDays = common.flat().filter((c) => c.inMonth);
    expect(commonDays).toHaveLength(28);
    expect(commonDays[commonDays.length - 1]?.key).toBe("2026-02-28");
  });

  it("renders 7 distinct cells across a DST-transition week", () => {
    // US DST starts 2026-03-08 and ends 2026-11-01; EU shifts 2026-03-29 and
    // 2026-10-25. Under any of those the row must still be 7 calendar days.
    for (const [year, month] of [
      [2026, 2],
      [2026, 9],
      [2026, 10],
    ] as const) {
      const weeks = buildMonthGrid(new Date(year, month, 15), 1, new Date(year, month, 15));
      for (const week of weeks) {
        expect(new Set(week.map((c) => c.key)).size).toBe(7);
        for (const cell of week) {
          expect(cell.date.getHours()).toBe(0);
        }
      }
    }
  });

  it("keeps consecutive cells exactly one calendar day apart", () => {
    const flat = monthGridDays(buildMonthGrid(new Date(2026, 2, 1), 1, new Date(2026, 2, 1)));
    for (let i = 1; i < flat.length; i++) {
      const prev = flat[i - 1]!;
      const next = flat[i]!;
      expect(next.getTime()).toBeGreaterThan(prev.getTime());
      const days = Math.round((next.getTime() - prev.getTime()) / 86_400_000);
      // A DST day is 23 or 25 hours, so the rounded delta is still 1.
      expect(days).toBe(1);
    }
  });
});

describe("monthGridDays", () => {
  it("flattens the grid in row-major order so expansion covers the whole range", () => {
    const weeks = buildMonthGrid(new Date(2026, 2, 15), 1, new Date(2026, 2, 15));
    const days = monthGridDays(weeks);
    expect(days).toHaveLength(weeks.length * 7);
    expect(days[0]).toEqual(weeks[0]?.[0]?.date);
    expect(days[days.length - 1]).toEqual(weeks[weeks.length - 1]?.[6]?.date);
  });
});

describe("placeMonthCellEvents — membership", () => {
  const day = new Date(2026, 2, 10);

  it("ignores unscheduled pages", () => {
    const placement = placeMonthCellEvents([page({ id: "a" })], day);
    expect(placement.visible).toHaveLength(0);
    expect(placement.overflowCount).toBe(0);
  });

  it("ignores events on other days", () => {
    const placement = placeMonthCellEvents(
      [page({ id: "a", scheduledStart: "2026-03-11T09:00:00" })],
      day
    );
    expect(placement.visible).toHaveLength(0);
  });

  it("places a multi-day event in every covered cell with continuation flags", () => {
    const span = page({ id: "trip", scheduledEnd: "2026-03-12", scheduledStart: "2026-03-09" });
    const first = placeMonthCellEvents([span], new Date(2026, 2, 9)).visible[0];
    const middle = placeMonthCellEvents([span], new Date(2026, 2, 10)).visible[0];
    const last = placeMonthCellEvents([span], new Date(2026, 2, 12)).visible[0];
    const after = placeMonthCellEvents([span], new Date(2026, 2, 13)).visible;

    expect(first?.continuesBefore).toBe(false);
    expect(first?.continuesAfter).toBe(true);
    expect(middle?.continuesBefore).toBe(true);
    expect(middle?.continuesAfter).toBe(true);
    expect(last?.continuesBefore).toBe(true);
    expect(last?.continuesAfter).toBe(false);
    expect(first?.spanDays).toBe(4);
    expect(after).toHaveLength(0);
  });

  it("spans a multi-day TIMED event across its covered days", () => {
    const conf = page({
      id: "conf",
      scheduledEnd: "2026-03-11T17:00:00",
      scheduledStart: "2026-03-10T09:00:00",
    });
    expect(placeMonthCellEvents([conf], new Date(2026, 2, 10)).visible[0]?.spanDays).toBe(2);
    expect(placeMonthCellEvents([conf], new Date(2026, 2, 11)).visible[0]?.continuesBefore).toBe(
      true
    );
  });

  it("keeps a timed event ending exactly at midnight on its start day", () => {
    const late = page({
      id: "late",
      scheduledEnd: "2026-03-11T00:00:00",
      scheduledStart: "2026-03-10T23:00:00",
    });
    expect(placeMonthCellEvents([late], new Date(2026, 2, 10)).visible[0]?.spanDays).toBe(1);
    expect(placeMonthCellEvents([late], new Date(2026, 2, 11)).visible).toHaveLength(0);
  });

  it("tolerates an end before the start by collapsing to the start day", () => {
    const broken = page({ id: "b", scheduledEnd: "2026-03-08", scheduledStart: "2026-03-10" });
    const placement = placeMonthCellEvents([broken], day);
    expect(placement.visible[0]?.spanDays).toBe(1);
    expect(placement.visible[0]?.continuesAfter).toBe(false);
  });

  it("collapses a same-day midnight end back onto the start day", () => {
    const odd = page({
      id: "odd",
      scheduledEnd: "2026-03-10T00:00:00",
      scheduledStart: "2026-03-10T00:00:00",
    });
    expect(placeMonthCellEvents([odd], day).visible[0]?.spanDays).toBe(1);
  });

  it("spans a multi-day event across a month boundary", () => {
    const span = page({ id: "s", scheduledEnd: "2026-04-02", scheduledStart: "2026-03-30" });
    expect(placeMonthCellEvents([span], new Date(2026, 3, 1)).visible[0]?.continuesBefore).toBe(
      true
    );
    expect(placeMonthCellEvents([span], new Date(2026, 3, 2)).visible[0]?.spanDays).toBe(4);
  });

  it("gives each occurrence sharing a page id a distinct key", () => {
    const head = page({ id: "rec", scheduledStart: "2026-03-10T09:00:00" });
    const moved = page({ id: "rec", scheduledStart: "2026-03-10T15:00:00" });
    const placement = placeMonthCellEvents([head, moved], day);
    expect(new Set(placement.visible.map((e) => e.key)).size).toBe(2);
  });
});

describe("placeMonthCellEvents — ordering", () => {
  const day = new Date(2026, 2, 10);

  it("puts all-day and multi-day events before single-day timed events", () => {
    const timed = page({ id: "timed", scheduledStart: "2026-03-10T08:00:00" });
    const allDay = page({ id: "allday", scheduledStart: "2026-03-10" });
    const span = page({ id: "span", scheduledEnd: "2026-03-13", scheduledStart: "2026-03-08" });
    const placement = placeMonthCellEvents([timed, allDay, span], day, 10);
    expect(placement.visible.map((e) => e.page.id)).toEqual(["span", "allday", "timed"]);
  });

  it("orders longer spans first inside the banner group", () => {
    const short = page({ id: "short", scheduledEnd: "2026-03-11", scheduledStart: "2026-03-10" });
    const long = page({ id: "long", scheduledEnd: "2026-03-14", scheduledStart: "2026-03-09" });
    const placement = placeMonthCellEvents([short, long], day, 10);
    expect(placement.visible.map((e) => e.page.id)).toEqual(["long", "short"]);
  });

  it("orders timed events by start time", () => {
    const late = page({ id: "late", scheduledStart: "2026-03-10T16:00:00" });
    const early = page({ id: "early", scheduledStart: "2026-03-10T07:30:00" });
    const noon = page({ id: "noon", scheduledStart: "2026-03-10T12:00:00" });
    const placement = placeMonthCellEvents([late, early, noon], day, 10);
    expect(placement.visible.map((e) => e.page.id)).toEqual(["early", "noon", "late"]);
  });

  it("breaks ties on createdAt then page id", () => {
    const a = page({ createdAt: "2026-01-02T00:00:00", id: "zzz", scheduledStart: "2026-03-10" });
    const b = page({ createdAt: "2026-01-01T00:00:00", id: "aaa", scheduledStart: "2026-03-10" });
    const c = page({ createdAt: "2026-01-01T00:00:00", id: "bbb", scheduledStart: "2026-03-10" });
    const placement = placeMonthCellEvents([a, b, c], day, 10);
    expect(placement.visible.map((e) => e.page.id)).toEqual(["aaa", "bbb", "zzz"]);
  });
});

describe("placeMonthCellEvents — overflow capping", () => {
  const day = new Date(2026, 2, 10);
  const many = Array.from({ length: 6 }, (_, i) =>
    page({ id: `p${i}`, scheduledStart: `2026-03-10T0${i + 1}:00:00` })
  );

  it("caps the visible list and reports the hidden count", () => {
    const placement = placeMonthCellEvents(many, day, 3);
    expect(placement.visible.map((e) => e.page.id)).toEqual(["p0", "p1", "p2"]);
    expect(placement.overflowCount).toBe(3);
    expect(placement.overflow.map((e) => e.page.id)).toEqual(["p3", "p4", "p5"]);
  });

  it("reports no overflow when everything fits", () => {
    const placement = placeMonthCellEvents(many.slice(0, 2), day, 3);
    expect(placement.visible).toHaveLength(2);
    expect(placement.overflowCount).toBe(0);
    expect(placement.overflow).toEqual([]);
  });

  it("defaults the cap to MONTH_CELL_MAX_EVENTS", () => {
    const placement = placeMonthCellEvents(many, day);
    expect(placement.visible).toHaveLength(MONTH_CELL_MAX_EVENTS);
    expect(placement.overflowCount).toBe(6 - MONTH_CELL_MAX_EVENTS);
  });

  it("collapses everything when the cap is zero or negative", () => {
    expect(placeMonthCellEvents(many, day, 0).overflowCount).toBe(6);
    expect(placeMonthCellEvents(many, day, -2).visible).toEqual([]);
  });
});
