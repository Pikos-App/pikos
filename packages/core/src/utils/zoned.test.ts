import { describe, expect, it } from "vitest";

import {
  expandRecurrenceInZone,
  normalizeUntilToZone,
  utcToWallClock,
  wallClockToUtc,
} from "./zoned";

// US DST 2026: spring forward Mar 8 (2am → 3am), fall back Nov 1 (2am → 1am).
const NY = "America/New_York";
const LA = "America/Los_Angeles";

describe("wallClockToUtc / utcToWallClock", () => {
  it("round-trips standard-time and daylight-time wall clocks", () => {
    // Winter: NY is UTC-5.
    expect(wallClockToUtc(NY, "2026-01-15T09:00:00").toISOString()).toBe(
      "2026-01-15T14:00:00.000Z"
    );
    // Summer: NY is UTC-4.
    expect(wallClockToUtc(NY, "2026-07-15T09:00:00").toISOString()).toBe(
      "2026-07-15T13:00:00.000Z"
    );
    expect(utcToWallClock(NY, new Date("2026-07-15T13:00:00Z"))).toBe("2026-07-15T09:00:00");
  });

  it("treats date-only input as midnight", () => {
    expect(wallClockToUtc(NY, "2026-01-15").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("shifts nonexistent spring-forward times forward by the gap", () => {
    // 02:30 never happens on Mar 8 2026 in NY; pre-transition offset (EST,
    // UTC-5) interpretation → 07:30Z, which reads 03:30 EDT.
    const utc = wallClockToUtc(NY, "2026-03-08T02:30:00");
    expect(utc.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(utcToWallClock(NY, utc)).toBe("2026-03-08T03:30:00");
  });

  it("resolves ambiguous fall-back times to the earliest instant", () => {
    // 01:30 happens twice on Nov 1 2026 in NY (EDT 05:30Z, then EST 06:30Z).
    expect(wallClockToUtc(NY, "2026-11-01T01:30:00").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z"
    );
  });

  it("handles non-hour offsets (Kathmandu, UTC+5:45)", () => {
    expect(wallClockToUtc("Asia/Kathmandu", "2026-01-15T09:00:00").toISOString()).toBe(
      "2026-01-15T03:15:00.000Z"
    );
  });
});

describe("normalizeUntilToZone", () => {
  it("rewrites a UTC UNTIL into the event zone's wall clock", () => {
    // 2026-07-01T03:59:59Z is 2026-06-30T23:59:59 in NY (EDT).
    expect(normalizeUntilToZone("FREQ=DAILY;UNTIL=20260701T035959Z", NY)).toBe(
      "FREQ=DAILY;UNTIL=20260630T235959Z"
    );
  });

  it("leaves date-only UNTIL and UNTIL-less rules unchanged", () => {
    expect(normalizeUntilToZone("FREQ=DAILY;UNTIL=20260701", NY)).toBe("FREQ=DAILY;UNTIL=20260701");
    expect(normalizeUntilToZone("FREQ=DAILY;COUNT=3", NY)).toBe("FREQ=DAILY;COUNT=3");
  });
});

describe("expandRecurrenceInZone", () => {
  it("keeps the event's wall clock fixed and shifts the viewer's across DST", () => {
    // Weekly Wednesday 9am in NY, viewed from LA, across the Mar 8 2026
    // spring-forward. Both zones change together, so LA stays 6am — but the
    // UTC instant moves from 14:00Z to 13:00Z.
    const occ = expandRecurrenceInZone({
      eventZone: NY,
      exdates: [],
      rangeEndIso: "2026-03-20T00:00:00",
      rangeStartIso: "2026-02-25T00:00:00",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      scheduledEnd: "2026-02-25T10:00:00",
      scheduledStart: "2026-02-25T09:00:00",
      viewerZone: LA,
    });

    expect(occ.map((o) => o.scheduledStart)).toEqual([
      "2026-02-25T06:00:00",
      "2026-03-04T06:00:00",
      "2026-03-11T06:00:00",
      "2026-03-18T06:00:00",
    ]);
    expect(occ.map((o) => o.utcStart)).toEqual([
      "2026-02-25T14:00:00Z",
      "2026-03-04T14:00:00Z",
      "2026-03-11T13:00:00Z",
      "2026-03-18T13:00:00Z",
    ]);
    // Duration survives conversion.
    expect(occ[0]!.scheduledEnd).toBe("2026-02-25T07:00:00");
    // Identity stays in the event's zone.
    expect(occ[0]!.originalDate).toBe("2026-02-25");
  });

  it("converts into a zone that does not observe DST", () => {
    // Weekly 9am NY viewed from Phoenix (no DST, UTC-7 year-round): the
    // Phoenix wall clock shifts when NY changes offset.
    const occ = expandRecurrenceInZone({
      eventZone: NY,
      rangeEndIso: "2026-03-20T00:00:00",
      rangeStartIso: "2026-03-01T00:00:00",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      scheduledStart: "2026-02-25T09:00:00",
      viewerZone: "America/Phoenix",
    });
    expect(occ.map((o) => o.scheduledStart)).toEqual([
      "2026-03-04T07:00:00", // NY on EST (UTC-5): 14:00Z
      "2026-03-11T06:00:00", // NY on EDT (UTC-4): 13:00Z
      "2026-03-18T06:00:00",
    ]);
  });

  it("crosses the date line when the viewer is far ahead of the event zone", () => {
    // 9pm in NY is already the next calendar day in Tokyo.
    const occ = expandRecurrenceInZone({
      eventZone: NY,
      rangeEndIso: "2026-01-17T00:00:00",
      rangeStartIso: "2026-01-14T00:00:00",
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-05T21:00:00",
      viewerZone: "Asia/Tokyo",
    });
    // NY Jan 13 21:00 EST = Jan 14 02:00Z = Jan 14 11:00 Tokyo, etc.
    expect(occ.map((o) => o.scheduledStart)).toEqual([
      "2026-01-14T11:00:00",
      "2026-01-15T11:00:00",
      "2026-01-16T11:00:00",
    ]);
    // originalDate keeps the event-zone day (one behind Tokyo).
    expect(occ.map((o) => o.originalDate)).toEqual(["2026-01-13", "2026-01-14", "2026-01-15"]);
  });

  it("honors a UTC UNTIL at the zone boundary", () => {
    // Daily 23:00 NY. UNTIL=2026-01-16T04:30:00Z is 23:30 NY on Jan 15 —
    // so Jan 15's 23:00 occurrence is the last one.
    const occ = expandRecurrenceInZone({
      eventZone: NY,
      rangeEndIso: "2026-02-01T00:00:00",
      rangeStartIso: "2026-01-14T00:00:00",
      rrule: "FREQ=DAILY;UNTIL=20260116T043000Z",
      scheduledStart: "2026-01-10T23:00:00",
      viewerZone: NY,
    });
    expect(occ.map((o) => o.originalDate)).toEqual(["2026-01-14", "2026-01-15"]);
  });

  it("expands an occurrence landing in the viewer's spring-forward gap", () => {
    // Daily 7:30am London (GMT in early March → 07:30Z). On Mar 7 that reads
    // 02:30 EST in NY; on Mar 8, 02:30 falls inside NY's 2–3am spring-forward
    // gap, so the viewer-local rendering lands on the post-gap wall clock.
    const occ = expandRecurrenceInZone({
      eventZone: "Europe/London",
      rangeEndIso: "2026-03-09T00:00:00",
      rangeStartIso: "2026-03-07T00:00:00",
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-03-01T07:30:00",
      viewerZone: NY,
    });
    expect(occ.map((o) => o.scheduledStart)).toEqual([
      "2026-03-07T02:30:00", // 07:30Z, EST
      "2026-03-08T03:30:00", // 07:30Z falls in the 2–3am gap → EDT reading
    ]);
  });

  it("passes all-day rules through without conversion", () => {
    const occ = expandRecurrenceInZone({
      eventZone: NY,
      rangeEndIso: "2026-01-20T00:00:00",
      rangeStartIso: "2026-01-12T00:00:00",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      scheduledStart: "2026-01-05",
      viewerZone: "Asia/Tokyo",
    });
    expect(occ.map((o) => o.scheduledStart)).toEqual(["2026-01-12", "2026-01-19"]);
    expect(occ[0]!.scheduledEnd).toBeNull();
  });

  it("applies event-zone exdates", () => {
    const occ = expandRecurrenceInZone({
      eventZone: NY,
      exdates: ["2026-01-14"],
      rangeEndIso: "2026-01-17T00:00:00",
      rangeStartIso: "2026-01-13T00:00:00",
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-10T09:00:00",
      viewerZone: LA,
    });
    expect(occ.map((o) => o.originalDate)).toEqual(["2026-01-13", "2026-01-15", "2026-01-16"]);
  });
});
