// Snapping a parsed schedule onto its rule, run against the table
// `snap_schedule_to_rule` also runs. Quick Add and `pikos add` snap the same
// parser output; the engine is shared but the end-shift is not, and an end that
// doesn't travel with its start lands before it.

import { describe, expect, it } from "vitest";

import { readFixture } from "../adapters/conformanceTable";
import { snapScheduleToRule } from "./recurrence";

interface Case {
  name: string;
  rrule: string;
  start: string;
  end: string | null;
  snappedStart: string;
  snappedEnd: string | null;
}

const KEYS = ["name", "rrule", "start", "end", "snappedStart", "snappedEnd"];

const { cases } = readFixture<{ cases: Case[] }>("schedule-snap.json");

describe("schedule snap conformance", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$name", (testCase) => {
    expect(Object.keys(testCase).sort()).toEqual([...KEYS].sort());
    const snapped = snapScheduleToRule(testCase.rrule, testCase.start, testCase.end ?? undefined);
    expect(snapped.start).toBe(testCase.snappedStart);
    expect(snapped.end ?? null).toBe(testCase.snappedEnd);
  });
});
