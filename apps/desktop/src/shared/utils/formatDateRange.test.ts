import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { formatDateRange } from "./formatDateRange";

describe("formatDateRange", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("same month, current year: 'May 2 – 10'", () => {
    expect(formatDateRange("2026-05-02", "2026-05-10")).toBe("May 2 – 10");
  });

  it("cross-month, current year: 'May 30 – Jun 3'", () => {
    expect(formatDateRange("2026-05-30", "2026-06-03")).toBe("May 30 – Jun 3");
  });

  it("cross-year: includes year on both sides", () => {
    expect(formatDateRange("2026-12-28", "2027-01-03")).toBe("Dec 28, 2026 – Jan 3, 2027");
  });

  it("start not in current year: show year on start-only label", () => {
    expect(formatDateRange("2025-05-02", null)).toBe("May 2, 2025");
  });

  it("missing end: falls back to start-only label", () => {
    expect(formatDateRange("2026-05-02", null)).toBe("May 2");
    expect(formatDateRange("2026-05-02", undefined)).toBe("May 2");
  });

  it("end equal to start: treated as single day", () => {
    expect(formatDateRange("2026-05-02", "2026-05-02")).toBe("May 2");
  });

  it("end earlier than start: treated as single day (defensive)", () => {
    expect(formatDateRange("2026-05-10", "2026-05-02")).toBe("May 10");
  });
});
