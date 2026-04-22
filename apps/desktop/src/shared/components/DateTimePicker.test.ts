import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { formatTriggerLabel } from "./DateTimePicker";

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
