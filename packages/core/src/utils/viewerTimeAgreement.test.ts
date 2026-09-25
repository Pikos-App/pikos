// Every surface that shows a time asks one of three functions whether that time is
// absolute. They are separate implementations — the grid needs a `Date` for pixel
// maths, the label needs a formatted string, the lists need an ISO — so nothing but
// this file stops them drifting apart. They did drift: `viewerStart` read a
// populated `timezone` as "synced", which authoring puts on every native page, so a
// list showed a page at one time and the grid showed it at another.
//
// A native page carrying a source zone is the fixture that tells them apart, and it
// is the ordinary case rather than a contrived one.

import { describe, expect, it } from "vitest";

import { makePage } from "../calendar/calendar.testHelpers";
import { buildDayBlocks } from "../calendar/calendarLayout";
import { syncedScheduleLabel } from "../format/syncedScheduleLabel";
import { viewerStart } from "./syncedTime";

const DAY = new Date("2026-03-15T00:00:00Z");

/** 15:00 Los_Angeles is 22:00 UTC in March, and the test runner is UTC. */
const SOURCE_WALL_CLOCK = "2026-03-15T15:00:00";
const CONVERTED_HOUR = 22;

const native = makePage({
  id: "native",
  scheduledStart: SOURCE_WALL_CLOCK,
  timezone: "America/Los_Angeles",
  title: "Take medication",
});

const synced = makePage({
  id: "synced",
  scheduledStart: SOURCE_WALL_CLOCK,
  scheduleLocked: true,
  timezone: "America/Los_Angeles",
  title: "Design review",
});

function gridHour(page: typeof native): number {
  const block = buildDayBlocks([page], DAY).find((b) => b.page.id === page.id);
  if (!block) throw new Error(`${page.id} rendered no block`);
  return block.startDate.getUTCHours();
}

describe("the three conversion paths agree", () => {
  it("floats a native page on every surface, though it carries a source zone", () => {
    expect(viewerStart(native)).toBe(SOURCE_WALL_CLOCK);
    expect(gridHour(native)).toBe(15);
    expect(syncedScheduleLabel(native)).toContain("3:00");
  });

  it("re-expresses a synced page in the viewer's zone on every surface", () => {
    expect(viewerStart(synced)).toBe("2026-03-15T22:00:00");
    expect(gridHour(synced)).toBe(CONVERTED_HOUR);
    expect(syncedScheduleLabel(synced)).toContain("10:00");
  });

  it("puts a native and a synced page at different times from the same stored string", () => {
    expect(viewerStart(native)).not.toBe(viewerStart(synced));
    expect(gridHour(native)).not.toBe(gridHour(synced));
    expect(syncedScheduleLabel(native)).not.toBe(syncedScheduleLabel(synced));
  });
});
