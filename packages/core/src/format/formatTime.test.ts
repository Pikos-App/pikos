import { describe, expect, it } from "vitest";

import { formatTriggerLabel, TIME_SLOTS } from "./dateTimePicker";
import { formatClockTime, formatTime12h, formatTime12hParts } from "./formatTime";
import { formatCompactTime } from "./pageDateLabel";

describe("formatTime12h", () => {
  it("formats AM hour without minutes", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 9, 0))).toBe("9 AM");
  });

  it("formats PM hour with minutes", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 14, 30))).toBe("2:30 PM");
  });

  it("renders midnight as 12 AM", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 0, 0))).toBe("12 AM");
  });

  it("renders noon as 12 PM", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 12, 0))).toBe("12 PM");
  });

  it("omits the period when period: false", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 9, 30), { period: false })).toBe("9:30");
  });
});

describe("formatTime12hParts", () => {
  it("pads single-digit minutes", () => {
    expect(formatTime12hParts(9, 5)).toBe("9:05 AM");
  });

  it("uses 12 for 0 and 12", () => {
    expect(formatTime12hParts(0, 0)).toBe("12 AM");
    expect(formatTime12hParts(12, 0)).toBe("12 PM");
  });
});

describe("formatClockTime", () => {
  it("keeps the minute and lowercases the period", () => {
    expect(formatClockTime(0, 0)).toBe("12:00am");
    expect(formatClockTime(9, 5)).toBe("9:05am");
    expect(formatClockTime(12, 30)).toBe("12:30pm");
    expect(formatClockTime(23, 15)).toBe("11:15pm");
  });

  // The page list chip, the editor trigger and the picker's own slot list each
  // had their own formatter. Nothing but this may write a clock time again.
  it("is the format every non-grid surface uses", () => {
    expect(formatCompactTime(new Date(2026, 5, 15, 14, 0))).toBe("2:00pm");
    expect(TIME_SLOTS[56]?.label).toBe("2:00pm");
    expect(formatTriggerLabel("2026-06-15T14:00:00", null, false).label).toContain("2:00pm");
  });
});
