import { describe, expect, it } from "vitest";

import { formatMultiDayTimeRange, formatTimeRange } from "./calendarTimeFormat";

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
