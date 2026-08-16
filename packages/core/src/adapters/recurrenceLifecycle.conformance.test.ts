// Recurrence-lifecycle conformance — the mock half of the occurrence-set table.
// Why the table exists, and what an origin means: `recurrence_conformance_tests.rs`,
// beside the fixture.

import { beforeEach, describe, expect, it } from "vitest";

import { readConformanceTable, unhandledStep } from "./conformanceTable";
import { MockStorageAdapter } from "./MockStorageAdapter";

// Matches the Rust runner's `TEST_CONNECTED_LONG_AGO`: old enough that the synced
// head floor never binds, so these scenarios test the occurrence sets and nothing else.
const CONNECTED_LONG_AGO = "2000-01-01";

interface Step {
  op:
    | "complete"
    | "uncomplete"
    | "skip"
    | "undoSkip"
    | "addExdates"
    | "removeExdate"
    | "reschedule"
    | "staleHead"
    | "recompute";
  occurrenceDate?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  originalDate?: string;
  dates?: string[];
  date?: string;
}

interface Scenario {
  name: string;
  origin: "native" | "active" | "detached";
  steps: Step[];
  expect: {
    head?: { scheduledStart?: string; status?: string };
    completedDates?: string[];
    skippedDates?: string[];
    exdates?: string[];
    clones?: { scheduledStart: string; status: string }[];
    cloneCount?: number;
    overrideCount?: number;
  };
}

const EXPECT_KEYS = [
  "head",
  "completedDates",
  "skippedDates",
  "exdates",
  "clones",
  "cloneCount",
  "overrideCount",
] as const;

const table = readConformanceTable<Scenario>("recurrence", EXPECT_KEYS) as {
  series: { rrule: string; start: string; end: string; timezone: string };
  scenarios: Scenario[];
};

async function apply(
  adapter: MockStorageAdapter,
  pageId: string,
  ruleId: string,
  step: Step
): Promise<void> {
  switch (step.op) {
    case "complete":
      await adapter.completeRecurringPage({
        pageId,
        ...(step.occurrenceDate !== undefined && { occurrenceDate: step.occurrenceDate }),
        ...(step.scheduledStart !== undefined && { scheduledStart: step.scheduledStart }),
        ...(step.scheduledEnd !== undefined && { scheduledEnd: step.scheduledEnd }),
      });
      return;
    case "uncomplete":
      await adapter.uncompleteRecurringOccurrence({ occurrenceDate: step.occurrenceDate!, pageId });
      return;
    case "skip":
      await adapter.skipOccurrence({ occurrenceDate: step.occurrenceDate!, pageId });
      return;
    case "undoSkip":
      await adapter.undoSkipOccurrence({ occurrenceDate: step.occurrenceDate!, pageId });
      return;
    case "addExdates":
      await adapter.addRuleExdates(ruleId, step.dates!);
      return;
    case "removeExdate":
      await adapter.removeRuleExdate(ruleId, step.date!);
      return;
    case "reschedule":
      await adapter.rescheduleVirtualOccurrence({
        originalDate: step.originalDate!,
        ruleId,
        scheduledStart: step.scheduledStart!,
        timezone: table.series.timezone,
        ...(step.scheduledEnd !== undefined && { scheduledEnd: step.scheduledEnd }),
      });
      return;
    case "staleHead":
      adapter.setHeadScheduleForTest(pageId, step.scheduledStart!);
      return;
    case "recompute":
      await adapter.recomputeRecurringSchedules();
      return;
    default:
      return unhandledStep("recurrence", step.op);
  }
}

describe("recurrence lifecycle conformance", () => {
  let adapter: MockStorageAdapter;

  beforeEach(() => {
    adapter = new MockStorageAdapter();
    adapter.clear();
  });

  it("the table has scenarios", () => {
    expect(table.scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of table.scenarios) {
    it(scenario.name, async () => {
      const { series } = table;
      const head = await adapter.createPage({
        content: "",
        contentText: "",
        folderId: null,
        priority: 0,
        scheduledEnd: series.end,
        scheduledStart: series.start,
        status: "not_started",
        tags: [],
        title: "Standup",
      });
      const rule = await adapter.createRecurrenceRule({
        pageId: head.id,
        rrule: series.rrule,
        rruleExdates: [],
        scheduledEnd: series.end,
        scheduledStart: series.start,
        timezone: series.timezone,
      });
      if (scenario.origin !== "native") {
        adapter.markPageSynced(head.id, {
          state: scenario.origin,
          syncedSince: CONNECTED_LONG_AGO,
        });
      }

      for (const step of scenario.steps) await apply(adapter, head.id, rule.id, step);

      const { expect: want } = scenario;
      const after = (await adapter.getPage(head.id))!;

      if (want.head?.scheduledStart !== undefined) {
        expect(after.scheduledStart).toBe(want.head.scheduledStart);
      }
      if (want.head?.status !== undefined) {
        expect(after.status).toBe(want.head.status);
      }

      if (want.completedDates) {
        expect(Object.keys(after.completedOccurrences ?? {}).sort()).toEqual(want.completedDates);
      }
      if (want.skippedDates) {
        expect([...(after.skippedOccurrences ?? [])].sort()).toEqual(want.skippedDates);
      }
      if (want.exdates) {
        const stored = await adapter.getRecurrenceRule(head.id);
        expect(stored?.rruleExdates ?? []).toEqual(want.exdates);
      }

      const clones = (await adapter.listPages())
        .filter((p) => p.id !== head.id)
        .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));

      if (want.cloneCount !== undefined) {
        expect(clones).toHaveLength(want.cloneCount);
      }
      if (want.clones) {
        expect(clones).toHaveLength(want.clones.length);
        clones.forEach((got, i) => {
          expect(got.scheduledStart).toBe(want.clones![i]!.scheduledStart);
          expect(got.status).toBe(want.clones![i]!.status);
        });
      }

      if (want.overrideCount !== undefined) {
        const overrides = (await adapter.listPageSchedules(head.id)).filter(
          (s) => s.originalDate != null
        );
        expect(overrides).toHaveLength(want.overrideCount);
      }
    });
  }
});
