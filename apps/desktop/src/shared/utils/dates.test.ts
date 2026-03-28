import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nowLocalISO } from "./dates";

describe("nowLocalISO", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns local ISO format YYYY-MM-DDTHH:MM:SS", () => {
    vi.setSystemTime(new Date(2026, 2, 15, 9, 5, 3)); // March 15, 9:05:03
    expect(nowLocalISO()).toBe("2026-03-15T09:05:03");
  });

  it("zero-pads single-digit months, days, hours, minutes, seconds", () => {
    vi.setSystemTime(new Date(2026, 0, 5, 3, 7, 2)); // Jan 5, 3:07:02
    expect(nowLocalISO()).toBe("2026-01-05T03:07:02");
  });

  it("handles midnight", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 0, 0, 0)); // Dec 31, midnight
    expect(nowLocalISO()).toBe("2026-12-31T00:00:00");
  });

  it("handles end of day", () => {
    vi.setSystemTime(new Date(2026, 5, 15, 23, 59, 59));
    expect(nowLocalISO()).toBe("2026-06-15T23:59:59");
  });
});
