import { describe, expect, it } from "vitest";

import { COLLAPSED_BAND_HEIGHT, GRID_HEIGHT, HOUR_HEIGHT } from "./calendarConstants";
import {
  buildCalendarDays,
  buildCollapseGeometry,
  clampBottomHour,
  clampTopHour,
  collapsedBandInnerOffset,
  collapsedBandPillHeight,
  mapHourToY,
  mapYToDate,
  mapYToHour,
  snapY,
  timeToY,
  weekDays,
  weekEnd,
  weekStart,
  yToDate,
} from "./calendarGeometry";

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

// ─── collapsedBandPillHeight / collapsedBandInnerOffset ──────────────────────

describe("collapsedBandPillHeight", () => {
  it("returns the default band's pill height inside the [14, 20] envelope", () => {
    const h = collapsedBandPillHeight(COLLAPSED_BAND_HEIGHT);
    expect(h).toBeGreaterThanOrEqual(14);
    expect(h).toBeLessThanOrEqual(20);
  });

  it("clamps to a 14px floor for very narrow bands", () => {
    expect(collapsedBandPillHeight(10)).toBe(14);
    expect(collapsedBandPillHeight(0)).toBe(14);
  });

  it("clamps to a 20px ceiling for tall bands", () => {
    expect(collapsedBandPillHeight(60)).toBe(20);
    expect(collapsedBandPillHeight(200)).toBe(20);
  });
});

describe("collapsedBandInnerOffset", () => {
  it("equals the symmetric padding on each side of the centered pill", () => {
    const bandHeight = COLLAPSED_BAND_HEIGHT;
    const pillHeight = collapsedBandPillHeight(bandHeight);
    expect(collapsedBandInnerOffset(bandHeight)).toBe((bandHeight - pillHeight) / 2);
  });

  it("never goes negative — pill height is clamped against the band height", () => {
    expect(collapsedBandInnerOffset(14)).toBeGreaterThanOrEqual(0);
    expect(collapsedBandInnerOffset(40)).toBeGreaterThanOrEqual(0);
  });
});
