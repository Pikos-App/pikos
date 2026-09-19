import { describe, expect, it } from "vitest";

import type { PageRecurrenceRule } from "../types";
import { anchorMoveUpdate, applyAnchorMove, resolveAnchorMove } from "./scheduleAnchor";

function makeRule(overrides: Partial<PageRecurrenceRule> = {}): PageRecurrenceRule {
  return {
    createdAt: "2026-01-01T00:00:00",
    id: "rule-1",
    pageId: "page-1",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    rruleExdates: [],
    scheduledStart: "2026-01-05T09:00:00",
    timezone: "UTC",
    ...overrides,
  };
}

describe("resolveAnchorMove", () => {
  it("passes a non-recurring move through untouched", () => {
    const move = resolveAnchorMove(undefined, "2026-01-07T09:00:00", "2026-01-07T10:00:00");
    expect(move).toEqual({
      end: "2026-01-07T10:00:00",
      rrule: undefined,
      start: "2026-01-07T09:00:00",
    });
  });

  it("realigns a single-BYDAY weekly rule to the moved weekday", () => {
    // 2026-01-05 is a Monday, 2026-01-07 a Wednesday.
    const move = resolveAnchorMove(makeRule(), "2026-01-07T09:00:00");
    expect(move.rrule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=WE");
    // Realigned, so the snap has nothing left to correct.
    expect(move.start).toBe("2026-01-07T09:00:00");
  });

  it("leaves a daily rule's weekdays alone and keeps the drop point", () => {
    const move = resolveAnchorMove(makeRule({ rrule: "FREQ=DAILY" }), "2026-01-07T09:00:00");
    expect(move.rrule).not.toContain("BYDAY");
    expect(move.start).toBe("2026-01-07T09:00:00");
  });

  it("snaps an off-pattern drop onto a day a multi-day weekly rule yields", () => {
    // M/W/F dropped on a Tuesday (2026-01-06) snaps to the nearest rule day.
    const move = resolveAnchorMove(
      makeRule({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }),
      "2026-01-06T09:00:00"
    );
    expect(move.start.slice(0, 10)).not.toBe("2026-01-06");
    expect(["2026-01-05", "2026-01-07"]).toContain(move.start.slice(0, 10));
  });

  it("carries the end across the snap so the block keeps its span", () => {
    const move = resolveAnchorMove(
      makeRule({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }),
      "2026-01-06T09:00:00",
      "2026-01-06T10:00:00"
    );
    expect(move.end?.slice(0, 10)).toBe(move.start.slice(0, 10));
    expect(move.end?.slice(11)).toBe("10:00:00");
  });

  it("does not realign a rule the editor is locked out of", () => {
    // A term the round-trip cannot rebuild makes the whole edit degrading, so
    // the realign is skipped rather than silently dropping it.
    const rule = makeRule({ rrule: "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO" });
    const move = resolveAnchorMove(rule, "2026-01-07T09:00:00");
    expect(move.rrule).toBeUndefined();
  });
});

describe("applyAnchorMove", () => {
  it("mirrors the moved anchor and the realigned rrule onto the rule", () => {
    const rule = makeRule({ scheduledEnd: "2026-01-05T10:00:00" });
    const next = applyAnchorMove(rule, {
      end: "2026-01-07T10:00:00",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      start: "2026-01-07T09:00:00",
    });
    expect(next.rrule).toBe("FREQ=WEEKLY;BYDAY=WE");
    expect(next.scheduledStart).toBe("2026-01-07T09:00:00");
    expect(next.scheduledEnd).toBe("2026-01-07T10:00:00");
  });

  it("keeps the existing rrule when the move did not realign one", () => {
    const next = applyAnchorMove(makeRule(), {
      end: undefined,
      rrule: undefined,
      start: "2026-01-12T09:00:00",
    });
    expect(next.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("CLEARS a dropped end rather than leaving it behind the new start", () => {
    const rule = makeRule({ scheduledEnd: "2026-01-05T10:00:00" });
    const next = applyAnchorMove(rule, {
      end: undefined,
      rrule: undefined,
      start: "2026-01-12T09:00:00",
    });
    expect("scheduledEnd" in next).toBe(false);
  });

  it("does not mutate the rule it is given", () => {
    const rule = makeRule({ scheduledEnd: "2026-01-05T10:00:00" });
    applyAnchorMove(rule, { end: undefined, rrule: "FREQ=DAILY", start: "2026-01-12T09:00:00" });
    expect(rule.scheduledEnd).toBe("2026-01-05T10:00:00");
    expect(rule.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });
});

describe("anchorMoveUpdate", () => {
  it("sends the rrule only when the realign actually changed it", () => {
    const rule = makeRule();
    expect(
      anchorMoveUpdate(rule, { end: undefined, rrule: "FREQ=WEEKLY;BYDAY=WE", start: "x" })
    ).toHaveProperty("rrule", "FREQ=WEEKLY;BYDAY=WE");
    expect(
      anchorMoveUpdate(rule, { end: undefined, rrule: rule.rrule, start: "x" })
    ).not.toHaveProperty("rrule");
    expect(
      anchorMoveUpdate(rule, { end: undefined, rrule: undefined, start: "x" })
    ).not.toHaveProperty("rrule");
  });

  it("persists a dropped end as an explicit null, in lockstep with the head denorm", () => {
    const update = anchorMoveUpdate(makeRule(), {
      end: undefined,
      rrule: undefined,
      start: "2026-01-12T09:00:00",
    });
    expect(update.scheduledEnd).toBeNull();
    expect(update.scheduledStart).toBe("2026-01-12T09:00:00");
  });
});
