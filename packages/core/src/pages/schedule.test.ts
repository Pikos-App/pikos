import { describe, expect, it } from "vitest";

import { computeScheduleTransition, normalizeEndInput } from "./schedule";

const ALL_DAY = "2026-05-23";
const TIMED = "2026-05-23T10:00:00";

describe("computeScheduleTransition", () => {
  it("all-day → timed: collapses to a single occurrence", () => {
    expect(
      computeScheduleTransition({ end: "2026-05-25", start: ALL_DAY }, "2026-05-24T09:00:00")
    ).toEqual({
      end: undefined,
      start: "2026-05-24T09:00:00",
    });
  });

  it("timed → all-day: strips time from a timed end that stays after the new start", () => {
    expect(
      computeScheduleTransition({ end: "2026-05-25T11:00:00", start: TIMED }, "2026-05-23")
    ).toEqual({ end: "2026-05-25", start: "2026-05-23" });
  });

  it("timed → all-day: drops a timed end that is no longer after the new start", () => {
    expect(
      computeScheduleTransition({ end: "2026-05-22T11:00:00", start: TIMED }, "2026-05-24")
    ).toEqual({ end: undefined, start: "2026-05-24" });
  });

  it("timed → all-day: keeps a date-only end after the new start", () => {
    expect(computeScheduleTransition({ end: "2026-05-26", start: TIMED }, "2026-05-23")).toEqual({
      end: "2026-05-26",
      start: "2026-05-23",
    });
  });

  it("timed → all-day: drops a date-only end that is before the new start", () => {
    expect(computeScheduleTransition({ end: "2026-05-20", start: TIMED }, "2026-05-24")).toEqual({
      end: undefined,
      start: "2026-05-24",
    });
  });

  it("timed → timed: preserves the duration", () => {
    expect(
      computeScheduleTransition(
        { end: "2026-05-23T11:30:00", start: "2026-05-23T10:00:00" },
        "2026-05-24T14:00:00"
      )
    ).toEqual({ end: "2026-05-24T15:30:00", start: "2026-05-24T14:00:00" });
  });

  it("timed → timed: keeps the original end when duration is non-positive", () => {
    expect(
      computeScheduleTransition(
        { end: "2026-05-23T11:00:00", start: "2026-05-23T11:00:00" },
        "2026-05-24T14:00:00"
      )
    ).toEqual({ end: "2026-05-23T11:00:00", start: "2026-05-24T14:00:00" });
  });

  it("all-day → all-day: preserves an end on/after the new start", () => {
    expect(computeScheduleTransition({ end: "2026-05-25", start: ALL_DAY }, "2026-05-24")).toEqual({
      end: "2026-05-25",
      start: "2026-05-24",
    });
  });

  it("all-day → all-day: drops an end before the new start", () => {
    expect(computeScheduleTransition({ end: "2026-05-23", start: ALL_DAY }, "2026-05-25")).toEqual({
      end: undefined,
      start: "2026-05-25",
    });
  });

  it("handles a null current start (no prior schedule)", () => {
    expect(computeScheduleTransition({ end: null, start: null }, TIMED)).toEqual({
      end: undefined,
      start: TIMED,
    });
  });

  // ─── Cases migrated from the calendar aggregate suite ──────────────────────
  it("all-day → timed: collapses to single day (end undefined)", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-18", start: "2026-03-15" },
      "2026-03-15T09:00:00"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-15T09:00:00" });
  });

  it("all-day → timed (single-day): end stays undefined", () => {
    const result = computeScheduleTransition(
      { end: undefined, start: "2026-03-15" },
      "2026-03-15T14:30:00"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-15T14:30:00" });
  });

  it("timed → all-day: preserves date extent (strips time from end)", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-16T17:00:00", start: "2026-03-15T09:00:00" },
      "2026-03-15"
    );
    expect(result).toEqual({ end: "2026-03-16", start: "2026-03-15" });
  });

  it("timed → all-day where end date equals start date: end undefined (single day)", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-15T17:00:00", start: "2026-03-15T09:00:00" },
      "2026-03-15"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-15" });
  });

  it("timed → timed: preserves duration", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-15T10:30:00", start: "2026-03-15T09:00:00" },
      "2026-03-15T14:00:00"
    );
    // 90-min duration preserved.
    expect(result).toEqual({ end: "2026-03-15T15:30:00", start: "2026-03-15T14:00:00" });
  });

  it("all-day → all-day: preserves end when still >= new start", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-18", start: "2026-03-15" },
      "2026-03-16"
    );
    expect(result).toEqual({ end: "2026-03-18", start: "2026-03-16" });
  });

  it("all-day → all-day: drops end when new start crosses past it", () => {
    const result = computeScheduleTransition(
      { end: "2026-03-18", start: "2026-03-15" },
      "2026-03-20"
    );
    expect(result).toEqual({ end: undefined, start: "2026-03-20" });
  });

  it("no previous schedule (start null) → all-day only, no end", () => {
    const result = computeScheduleTransition({ end: null, start: null }, "2026-03-15");
    expect(result).toEqual({ end: undefined, start: "2026-03-15" });
  });
});

describe("normalizeEndInput", () => {
  it("returns undefined when the picker cleared the end", () => {
    expect(normalizeEndInput(ALL_DAY, null)).toBeUndefined();
  });

  it("strips time from a timed end when the start is all-day", () => {
    expect(normalizeEndInput(ALL_DAY, "2026-05-25T10:00:00")).toBe("2026-05-25");
  });

  it("returns undefined when the resulting end is not after the start", () => {
    expect(normalizeEndInput("2026-05-25", "2026-05-23")).toBeUndefined();
  });

  it("keeps a timed end after a timed start", () => {
    expect(normalizeEndInput("2026-05-23T10:00:00", "2026-05-23T11:00:00")).toBe(
      "2026-05-23T11:00:00"
    );
  });

  // ─── Cases migrated from the calendar aggregate suite ──────────────────────
  it("null end → undefined (end cleared)", () => {
    expect(normalizeEndInput("2026-03-15", null)).toBeUndefined();
  });

  it("end > start (all-day) → passed through", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-18")).toBe("2026-03-18");
  });

  it("end == start → undefined (single day)", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-15")).toBeUndefined();
  });

  it("end < start → undefined (clamped)", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-10")).toBeUndefined();
  });

  it("all-day start with datetime end → strips time to date-only", () => {
    expect(normalizeEndInput("2026-03-15", "2026-03-18T09:00:00")).toBe("2026-03-18");
  });

  it("timed start with datetime end → passed through unchanged", () => {
    expect(normalizeEndInput("2026-03-15T09:00:00", "2026-03-15T10:30:00")).toBe(
      "2026-03-15T10:30:00"
    );
  });
});
