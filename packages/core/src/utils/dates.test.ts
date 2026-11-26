import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatDateOnly,
  formatLocalISO,
  isAllDayIso,
  isTimedIso,
  localToday,
  nowLocalISO,
  parseLocalISO,
} from "./dates";

describe("isAllDayIso", () => {
  it("returns true for date-only strings", () => {
    expect(isAllDayIso("2026-03-15")).toBe(true);
  });

  it("returns false for datetime strings", () => {
    expect(isAllDayIso("2026-03-15T09:00:00")).toBe(false);
  });
});

describe("isTimedIso", () => {
  it("returns false for date-only strings", () => {
    expect(isTimedIso("2026-03-15")).toBe(false);
  });

  it("returns true for datetime strings", () => {
    expect(isTimedIso("2026-03-15T09:00:00")).toBe(true);
  });
});

describe("parseLocalISO", () => {
  it("date-only string → local midnight (not UTC)", () => {
    const date = parseLocalISO("2026-03-15");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  it("datetime string → correct local time", () => {
    const date = parseLocalISO("2026-03-15T14:30:00");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(14);
    expect(date.getMinutes()).toBe(30);
  });

  it("date-only does not shift date for any local timezone", () => {
    // `new Date('2026-03-15')` would parse as UTC midnight and show March 14 in UTC-8.
    const date = parseLocalISO("2026-01-01");
    expect(date.getDate()).toBe(1);
    expect(date.getMonth()).toBe(0);
  });
});

describe("formatLocalISO", () => {
  it("formats a Date as YYYY-MM-DDTHH:MM:SS", () => {
    const d = new Date(2026, 2, 15, 9, 5, 3);
    expect(formatLocalISO(d)).toBe("2026-03-15T09:05:03");
  });

  it("zero-pads single-digit values", () => {
    const d = new Date(2026, 0, 5, 3, 7, 2);
    expect(formatLocalISO(d)).toBe("2026-01-05T03:07:02");
  });

  it("handles midnight", () => {
    const d = new Date(2026, 11, 31, 0, 0, 0);
    expect(formatLocalISO(d)).toBe("2026-12-31T00:00:00");
  });

  it("handles end of day", () => {
    const d = new Date(2026, 5, 15, 23, 59, 59);
    expect(formatLocalISO(d)).toBe("2026-06-15T23:59:59");
  });

  it("round-trips with parseLocalISO for datetime strings", () => {
    const iso = "2026-07-04T16:45:00";
    const date = parseLocalISO(iso);
    expect(formatLocalISO(date)).toBe(iso);
  });
});

describe("formatDateOnly", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    const d = new Date(2026, 2, 15, 14, 30, 0);
    expect(formatDateOnly(d)).toBe("2026-03-15");
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 0, 5);
    expect(formatDateOnly(d)).toBe("2026-01-05");
  });

  it("round-trips with parseLocalISO for date-only strings", () => {
    const iso = "2026-07-04";
    const date = parseLocalISO(iso);
    expect(formatDateOnly(date)).toBe(iso);
  });
});

describe("localToday", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns YYYY-MM-DD for the local date", () => {
    vi.setSystemTime(new Date(2026, 2, 15, 14, 0, 0));
    expect(localToday()).toBe("2026-03-15");
  });

  it("returns local date, not UTC (late evening)", () => {
    vi.setSystemTime(new Date(2026, 2, 27, 23, 30, 0));
    expect(localToday()).toBe("2026-03-27");
  });

  it("zero-pads month and day", () => {
    vi.setSystemTime(new Date(2026, 0, 5, 8, 0, 0));
    expect(localToday()).toBe("2026-01-05");
  });
});

describe("nowLocalISO", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns local ISO format YYYY-MM-DDTHH:MM:SS", () => {
    vi.setSystemTime(new Date(2026, 2, 15, 9, 5, 3));
    expect(nowLocalISO()).toBe("2026-03-15T09:05:03");
  });

  it("zero-pads single-digit months, days, hours, minutes, seconds", () => {
    vi.setSystemTime(new Date(2026, 0, 5, 3, 7, 2));
    expect(nowLocalISO()).toBe("2026-01-05T03:07:02");
  });

  it("handles midnight", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 0, 0, 0));
    expect(nowLocalISO()).toBe("2026-12-31T00:00:00");
  });

  it("handles end of day", () => {
    vi.setSystemTime(new Date(2026, 5, 15, 23, 59, 59));
    expect(nowLocalISO()).toBe("2026-06-15T23:59:59");
  });

  it("equals formatLocalISO(new Date())", () => {
    vi.setSystemTime(new Date(2026, 6, 4, 16, 45, 0));
    expect(nowLocalISO()).toBe(formatLocalISO(new Date()));
  });
});
