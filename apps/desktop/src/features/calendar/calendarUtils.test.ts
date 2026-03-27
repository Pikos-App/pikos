import type { PageSummary } from "@pikos/core";
import { describe, expect, it } from "vitest";

import {
  buildAllDayItems,
  buildDayBlocks,
  COMPACT_BLOCK_HEIGHT,
  formatTimeRange,
  GRID_HEIGHT,
  GRID_START_HOUR,
  hexToRgba,
  HOUR_HEIGHT,
  isAllDayPage,
  snapY,
  timeToY,
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
