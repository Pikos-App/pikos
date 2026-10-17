import { format } from "date-fns";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePage } from "./calendar.testHelpers";
import { DEFAULT_COLLAPSE_CONFIG, HOUR_HEIGHT } from "./calendarConstants";
import {
  addClockMinutes,
  buildCollapseGeometry,
  clockMinutesBetween,
  mapYToDate,
  yToDate,
} from "./calendarGeometry";
import { buildDayBlocks } from "./calendarLayout";

// The suite pins TZ=UTC, which has no clock changes; these days need a zone that does.
const CLOCK_CHANGES = [
  { day: "2026-11-01", label: "a 25-hour day", zone: "America/Los_Angeles" },
  { day: "2026-03-08", label: "a 23-hour day", zone: "America/Los_Angeles" },
  { day: "2026-10-25", label: "a 25-hour day", zone: "Europe/London" },
] as const;

const geometry = buildCollapseGeometry(
  { ...DEFAULT_COLLAPSE_CONFIG, bottomCollapsed: false, topCollapsed: false },
  HOUR_HEIGHT
);
const clock = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");
const localDay = (iso: string) => new Date(`${iso}T00:00:00`);

for (const { day, label, zone } of CLOCK_CHANGES) {
  describe(`on ${day} in ${zone}, ${label}`, () => {
    let savedZone: string | undefined;
    beforeEach(() => {
      savedZone = process.env["TZ"];
      process.env["TZ"] = zone;
    });
    afterEach(() => {
      process.env["TZ"] = savedZone;
    });

    it("reads the 4 PM row as 4 PM", () => {
      expect(clock(mapYToDate(16 * HOUR_HEIGHT, localDay(day), geometry))).toBe(`${day}T16:00`);
      expect(clock(yToDate(16 * HOUR_HEIGHT, localDay(day)))).toBe(`${day}T16:00`);
    });

    it("reads the rows either side of the change as their own hours", () => {
      expect(clock(mapYToDate(0.5 * HOUR_HEIGHT, localDay(day), geometry))).toBe(`${day}T00:30`);
      expect(clock(mapYToDate(9 * HOUR_HEIGHT, localDay(day), geometry))).toBe(`${day}T09:00`);
    });

    it("reads the bottom of the grid as the next midnight", () => {
      const next = mapYToDate(24 * HOUR_HEIGHT, localDay(day), geometry);
      expect(format(next, "HH:mm")).toBe("00:00");
      expect(clock(next) > `${day}T23:59`).toBe(true);
    });

    it("moves a 3 PM block one row down to 4 PM", () => {
      const start = new Date(`${day}T15:00:00`);
      expect(clock(addClockMinutes(start, 60))).toBe(`${day}T16:00`);
    });

    it("measures a span across the change in clock minutes", () => {
      expect(clockMinutesBetween(localDay(day), new Date(`${day}T04:00:00`))).toBe(240);
    });

    it("draws a block across the change from its start row to its end row", () => {
      const page = makePage({
        id: "overnight",
        scheduledEnd: `${day}T04:00:00`,
        scheduledStart: `${day}T00:30:00`,
      });
      const [block] = buildDayBlocks([page], localDay(day));
      expect(block?.top).toBe(0.5 * HOUR_HEIGHT);
      expect(block?.height).toBe(3.5 * HOUR_HEIGHT);
    });
  });
}
