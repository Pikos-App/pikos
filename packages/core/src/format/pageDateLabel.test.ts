import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatCompactTime,
  formatLongDate,
  formatPageDate,
  formatPageRelativeTime,
  isDueSoon,
} from "./pageDateLabel";

// Vitest pins TZ=UTC, so local wall-clock equals the instants below.
const NOW = new Date("2026-06-15T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatCompactTime", () => {
  it("always shows minutes and a single-letter period", () => {
    expect(formatCompactTime(new Date("2026-06-15T14:00:00Z"))).toBe("2:00p");
    expect(formatCompactTime(new Date("2026-06-15T14:30:00Z"))).toBe("2:30p");
    expect(formatCompactTime(new Date("2026-06-15T10:00:00Z"))).toBe("10:00a");
    expect(formatCompactTime(new Date("2026-06-15T12:15:00Z"))).toBe("12:15p");
  });

  it("renders midnight as 12a", () => {
    expect(formatCompactTime(new Date("2026-06-15T00:05:00Z"))).toBe("12:05a");
  });
});

describe("formatLongDate", () => {
  it("spells out weekday and month", () => {
    expect(formatLongDate(new Date("2026-06-15T12:00:00Z"))).toBe("Monday, June 15, 2026");
  });
});

describe("isDueSoon", () => {
  it("covers the next three days but not the past or beyond", () => {
    expect(isDueSoon("2026-06-16")).toBe(true);
    expect(isDueSoon("2026-06-18")).toBe(true);
    expect(isDueSoon("2026-06-19")).toBe(false);
    expect(isDueSoon("2026-06-14")).toBe(false);
  });
});

describe("formatPageDate", () => {
  it("shows the time for a timed schedule today", () => {
    const { isPast, label } = formatPageDate("2026-06-15T14:00:00");
    expect(label).toBe("2:00p");
    expect(isPast).toBe(false);
  });

  it("marks an earlier time today as past", () => {
    expect(formatPageDate("2026-06-15T09:00:00").isPast).toBe(true);
  });

  it("shows a short date for a timed schedule on another day", () => {
    expect(formatPageDate("2026-06-18T14:00:00").label).toBe("Jun 18");
  });

  it("appends the year only outside the current one", () => {
    expect(formatPageDate("2027-01-04").label).toBe("Jan 4, 2027");
    expect(formatPageDate("2026-01-04").label).toBe("Jan 4");
  });

  it("treats today's all-day date as not past", () => {
    expect(formatPageDate("2026-06-15").isPast).toBe(false);
    expect(formatPageDate("2026-06-14").isPast).toBe(true);
  });

  it("tooltips an all-day date without a time and a timed one with it", () => {
    expect(formatPageDate("2026-06-15").tooltip).toBe("Monday, June 15, 2026");
    expect(formatPageDate("2026-06-15T14:00:00").tooltip).toBe("Monday, June 15, 2026 at 2:00 PM");
  });
});

describe("formatPageRelativeTime", () => {
  it("counts whole days for an all-day date", () => {
    expect(formatPageRelativeTime("2026-06-15").label).toBe("today");
    expect(formatPageRelativeTime("2026-06-18")).toMatchObject({ isPast: false, label: "3d" });
    expect(formatPageRelativeTime("2026-06-12")).toMatchObject({ isPast: true, label: "3d" });
  });

  it("counts minutes, then hours, then days for a timed schedule", () => {
    expect(formatPageRelativeTime("2026-06-15T12:00:00")).toMatchObject({
      isPast: false,
      label: "now",
    });
    expect(formatPageRelativeTime("2026-06-15T12:45:00").label).toBe("45m");
    expect(formatPageRelativeTime("2026-06-15T18:00:00").label).toBe("6hr");
    expect(formatPageRelativeTime("2026-06-13T12:00:00")).toMatchObject({
      isPast: true,
      label: "2d",
    });
  });
});
