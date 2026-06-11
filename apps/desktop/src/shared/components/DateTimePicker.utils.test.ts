import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  formatTriggerLabel,
  parseCustomDurationStr,
  parseCustomTimeStr,
} from "./DateTimePicker.utils";

// `formatTriggerLabel` produces the chip's visible text (and aria-label suffix).
// These cases guard the branches that caused the multi-day regression — the
// function used to emit "May 2 · 9d" for all-day spans; we now want the
// explicit range "May 2 – 10".

describe("formatTriggerLabel", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("all-day multi-day span: explicit 'May 2 – 10'", () => {
    const r = formatTriggerLabel("2026-05-02", "2026-05-10", false);
    expect(r.label).toBe("May 2 – 10");
  });

  it("all-day multi-day span (cross-month): 'May 30 – Jun 3'", () => {
    const r = formatTriggerLabel("2026-05-30", "2026-06-03", false);
    expect(r.label).toBe("May 30 – Jun 3");
  });

  it("all-day single-day today: 'Today' (no suffix)", () => {
    const r = formatTriggerLabel("2026-04-21", null, false);
    expect(r.label).toBe("Today");
  });

  it("all-day single-day tomorrow: 'Tomorrow'", () => {
    const r = formatTriggerLabel("2026-04-22", null, false);
    expect(r.label).toBe("Tomorrow");
  });

  it("all-day single-day absolute: 'May 15'", () => {
    const r = formatTriggerLabel("2026-05-15", null, false);
    expect(r.label).toBe("May 15");
  });

  it("timed today with duration: 'Today 3:00pm · 1h'", () => {
    const r = formatTriggerLabel("2026-04-21T15:00:00", "2026-04-21T16:00:00", false);
    expect(r.label).toBe("Today 3:00pm · 1h");
  });

  it("timed future date without end: 'May 15 3:00pm'", () => {
    const r = formatTriggerLabel("2026-05-15T15:00:00", null, false);
    expect(r.label).toBe("May 15 3:00pm");
  });

  it("end equal to start (no span): falls back to single-day label", () => {
    const r = formatTriggerLabel("2026-05-02", "2026-05-02", false);
    expect(r.label).toBe("May 2");
  });

  it("all-day past date: marked past", () => {
    const r = formatTriggerLabel("2026-04-10", null, false);
    expect(r.isPast).toBe(true);
  });

  it("all-day multi-day that ends in the future: not past", () => {
    const r = formatTriggerLabel("2026-04-22", "2026-04-30", false);
    expect(r.isPast).toBe(false);
  });
});

describe("parseCustomDurationStr", () => {
  it("plain numbers are minutes", () => {
    expect(parseCustomDurationStr("10")).toBe(10);
    expect(parseCustomDurationStr("60")).toBe(60);
    expect(parseCustomDurationStr("600")).toBe(600);
  });

  it("hour units: h/hr/hrs/hour/hours", () => {
    for (const s of ["1h", "1hr", "1hrs", "1hour", "1hours", "1 hr", "1 hour"]) {
      expect(parseCustomDurationStr(s)).toBe(60);
    }
    expect(parseCustomDurationStr("1.5h")).toBe(90);
  });

  it("minute units: m/min/mins/minute/minutes", () => {
    for (const s of ["20m", "20min", "20mins", "20minute", "20minutes", "20 min"]) {
      expect(parseCustomDurationStr(s)).toBe(20);
    }
  });

  it("combined hours + minutes, any spacing", () => {
    for (const s of ["1h20m", "1h 20m", "1hr20min", "1hr 20min", "1 hour 20 mins"]) {
      expect(parseCustomDurationStr(s)).toBe(80);
    }
  });

  it("rejects junk and non-positive", () => {
    expect(parseCustomDurationStr("")).toBeNull();
    expect(parseCustomDurationStr("abc")).toBeNull();
    expect(parseCustomDurationStr("1h20")).toBeNull();
    expect(parseCustomDurationStr("0")).toBeNull();
    expect(parseCustomDurationStr("0h0m")).toBeNull();
  });
});

describe("parseCustomTimeStr", () => {
  it("24-hour and bare-hour inputs", () => {
    expect(parseCustomTimeStr("15:30")).toEqual({ hour24: 15, minute: 30 });
    expect(parseCustomTimeStr("9")).toEqual({ hour24: 9, minute: 0 });
    expect(parseCustomTimeStr("0:00")).toEqual({ hour24: 0, minute: 0 });
  });

  it("12-hour am/pm with optional space", () => {
    expect(parseCustomTimeStr("3pm")).toEqual({ hour24: 15, minute: 0 });
    expect(parseCustomTimeStr("3:15 PM")).toEqual({ hour24: 15, minute: 15 });
    expect(parseCustomTimeStr("12am")).toEqual({ hour24: 0, minute: 0 });
    expect(parseCustomTimeStr("12pm")).toEqual({ hour24: 12, minute: 0 });
  });

  it("rejects out-of-range and junk", () => {
    expect(parseCustomTimeStr("25:00")).toBeNull();
    expect(parseCustomTimeStr("9:99")).toBeNull();
    expect(parseCustomTimeStr("13pm")).toBeNull();
    expect(parseCustomTimeStr("abc")).toBeNull();
  });
});
