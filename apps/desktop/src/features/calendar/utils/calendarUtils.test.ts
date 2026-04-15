import type { PageSummary } from "@pikos/core";
import { describe, expect, it } from "vitest";

import {
  buildAllDayItems,
  buildCalendarDays,
  buildDayBlocks,
  chipFolderStyle,
  COMPACT_BLOCK_HEIGHT,
  formatTimeRange,
  GRID_HEIGHT,
  GRID_START_HOUR,
  hexToRgba,
  HOUR_HEIGHT,
  isAllDayPage,
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
  it("returns --event-color CSS property and borderColor", () => {
    const style = chipFolderStyle("#ff0000");
    expect(style.borderColor).toBe("#ff0000");
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
    expect(result.map((p) => p.title)).toEqual(["All-day match"]);
  });
});

// ─── buildDayBlocks ──────────────────────────────────────────────────────────

describe("buildDayBlocks", () => {
  const day = new Date(2026, 2, 15); // March 15

  it("single timed event → correct top/height/column", () => {
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
    expect(b.top).toBe((9 - GRID_START_HOUR) * HOUR_HEIGHT); // 3 * 64 = 192
    expect(b.height).toBe(HOUR_HEIGHT); // 1 hour = 64px
    expect(b.column).toBe(0);
    expect(b.totalColumns).toBe(1);
    expect(b.isCompact).toBe(false);
  });

  it("two overlapping events → 2 columns", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        scheduledEnd: "2026-03-15T10:30:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "B",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    // They should be in separate columns
    const columns = blocks.map((b) => b.column);
    expect(new Set(columns).size).toBe(2);
    // Both should see totalColumns = 2
    expect(blocks[0]!.totalColumns).toBe(2);
    expect(blocks[1]!.totalColumns).toBe(2);
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

  it("empty input → []", () => {
    expect(buildDayBlocks([], day)).toEqual([]);
  });

  it("three overlapping events → 3 columns", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:15:00",
        title: "B",
      }),
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:30:00",
        title: "C",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(3);
    const columns = new Set(blocks.map((b) => b.column));
    expect(columns.size).toBe(3);
    blocks.forEach((b) => expect(b.totalColumns).toBe(3));
  });

  it("non-overlapping events → each gets its own column 0", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-15T10:00:00",
        scheduledStart: "2026-03-15T09:00:00",
        title: "A",
      }),
      makePage({
        scheduledEnd: "2026-03-15T12:00:00",
        scheduledStart: "2026-03-15T11:00:00",
        title: "B",
      }),
    ];
    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(2);
    blocks.forEach((b) => {
      expect(b.column).toBe(0);
      expect(b.totalColumns).toBe(1);
    });
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

    // March 15: shows from 10 PM to grid end, with isContinuationAfter
    const blocksDay1 = buildDayBlocks(pages, day);
    expect(blocksDay1).toHaveLength(1);
    const b1 = blocksDay1[0]!;
    expect(b1.top).toBe((22 - GRID_START_HOUR) * HOUR_HEIGHT); // 10 PM
    expect(b1.height).toBe(GRID_HEIGHT - b1.top); // extends to grid bottom
    expect(b1.isContinuationAfter).toBe(true);
    expect(b1.isContinuationBefore).toBeUndefined();

    // March 16: shows from grid start to 2 AM, with isContinuationBefore
    const nextDay = new Date(2026, 2, 16);
    const blocksDay2 = buildDayBlocks(pages, nextDay);
    expect(blocksDay2).toHaveLength(1);
    const b2 = blocksDay2[0]!;
    expect(b2.top).toBe(0); // grid start (6 AM clamped)
    expect(b2.isContinuationBefore).toBe(true);
    expect(b2.isContinuationAfter).toBeUndefined();
  });

  it("event ending exactly at midnight clamps to grid end", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T00:00:00", // exactly midnight
        scheduledStart: "2026-03-15T16:30:00",
        title: "Evening block",
      }),
    ];

    const blocks = buildDayBlocks(pages, day);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.isContinuationAfter).toBe(true);
    expect(b.top).toBe((16.5 - GRID_START_HOUR) * HOUR_HEIGHT);
    expect(b.height).toBe(GRID_HEIGHT - b.top); // extends to grid bottom, not 0
  });

  it("multi-day event shows on all spanned days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-17T14:00:00",
        scheduledStart: "2026-03-15T20:00:00",
        title: "Conference",
      }),
    ];

    // Day 1 (Mar 15): starts at 8 PM, continues after
    const blocks1 = buildDayBlocks(pages, day);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0]!.isContinuationAfter).toBe(true);
    expect(blocks1[0]!.isContinuationBefore).toBeUndefined();

    // Day 2 (Mar 16): full-day continuation
    const blocks2 = buildDayBlocks(pages, new Date(2026, 2, 16));
    expect(blocks2).toHaveLength(1);
    expect(blocks2[0]!.isContinuationBefore).toBe(true);
    expect(blocks2[0]!.isContinuationAfter).toBe(true);
    expect(blocks2[0]!.top).toBe(0);
    expect(blocks2[0]!.height).toBe(GRID_HEIGHT);

    // Day 3 (Mar 17): ends at 2 PM
    const blocks3 = buildDayBlocks(pages, new Date(2026, 2, 17));
    expect(blocks3).toHaveLength(1);
    expect(blocks3[0]!.isContinuationBefore).toBe(true);
    expect(blocks3[0]!.isContinuationAfter).toBeUndefined();
  });

  it("cross-day event does not appear on unrelated days", () => {
    const pages = [
      makePage({
        scheduledEnd: "2026-03-16T02:00:00",
        scheduledStart: "2026-03-15T22:00:00",
        title: "Late night",
      }),
    ];
    // March 17: should not appear
    expect(buildDayBlocks(pages, new Date(2026, 2, 17))).toHaveLength(0);
  });

  it("cross-day event overlaps correctly with same-day events", () => {
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
    // March 16: both events should appear and overlap
    const nextDay = new Date(2026, 2, 16);
    const blocks = buildDayBlocks(pages, nextDay);
    expect(blocks).toHaveLength(2);
    // They overlap (overnight continues from grid start, morning is at 8 AM)
    expect(blocks.some((b) => b.totalColumns === 2)).toBe(true);
  });
});

// ─── timeToY ─────────────────────────────────────────────────────────────────

describe("timeToY", () => {
  it("6:00 AM → 0 (grid start)", () => {
    expect(timeToY(new Date(2026, 2, 15, 6, 0))).toBe(0);
  });

  it("5:00 AM → 0 (clamped)", () => {
    expect(timeToY(new Date(2026, 2, 15, 5, 0))).toBe(0);
  });

  it("11:00 PM → GRID_HEIGHT (clamped)", () => {
    expect(timeToY(new Date(2026, 2, 15, 23, 0))).toBe(GRID_HEIGHT);
  });

  it("9:30 AM → (3.5 * HOUR_HEIGHT)", () => {
    expect(timeToY(new Date(2026, 2, 15, 9, 30))).toBe(3.5 * HOUR_HEIGHT);
  });
});

// ─── yToDate ─────────────────────────────────────────────────────────────────

describe("yToDate", () => {
  const day = new Date(2026, 2, 15);

  it("0px → 6:00 AM on given day", () => {
    const result = yToDate(0, day);
    expect(result.getHours()).toBe(6);
    expect(result.getMinutes()).toBe(0);
  });

  it("snaps to 15-min boundaries", () => {
    // A y-value that corresponds to ~6:07 should snap to 6:00
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
  it("same period → shares AM/PM", () => {
    const start = new Date(2026, 2, 15, 9, 0);
    const end = new Date(2026, 2, 15, 10, 30);
    expect(formatTimeRange(start, end)).toBe("9 – 10:30 AM");
  });

  it("cross period → both AM/PM shown", () => {
    const start = new Date(2026, 2, 15, 11, 30);
    const end = new Date(2026, 2, 15, 13, 0);
    expect(formatTimeRange(start, end)).toBe("11:30 AM – 1 PM");
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
