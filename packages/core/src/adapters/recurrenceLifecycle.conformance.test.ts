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
  expectedOccurrenceDate?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  originalDate?: string;
  dates?: string[];
  date?: string;
}

interface Series {
  rrule: string;
  start: string;
  end: string;
  timezone: string;
}

interface Scenario {
  name: string;
  origin: "native" | "active" | "detached";
  /** Replaces the table-level series for this row — see the Rust runner's `Scenario`. */
  series?: Series;
  steps: Step[];
  expect: {
    head?: { scheduledStart?: string; scheduledEnd?: string; status?: string };
    completedDates?: string[];
    skippedDates?: string[];
    exdates?: string[];
    clones?: { scheduledStart: string; status: string }[];
    cloneCount?: number;
    overrideCount?: number;
  };
}

type Expect = Scenario["expect"];

interface World {
  adapter: MockStorageAdapter;
  headId: string;
}

/** The clones a scenario left behind, oldest first. Shared by the two checkers that
 *  read them, so the ordering they both assume has one definition. */
async function clonesOf(adapter: MockStorageAdapter, headId: string) {
  return (await adapter.listPages())
    .filter((p) => p.id !== headId)
    .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
}

/** One assertion per expectation key. `Record<keyof Expect, …>` is the point: a key
 *  added to `Expect` does not compile until it has a checker here, and
 *  `readConformanceTable` rejects a fixture key that is in neither. A declared list
 *  of key names could drift from the assertions; these are the assertions. */
const CHECKS: Record<keyof Expect, (want: Expect, world: World) => Promise<void>> = {
  cloneCount: async (want, { adapter, headId }) => {
    if (want.cloneCount === undefined) return;
    expect(await clonesOf(adapter, headId)).toHaveLength(want.cloneCount);
  },

  clones: async (want, { adapter, headId }) => {
    if (!want.clones) return;
    const clones = await clonesOf(adapter, headId);
    expect(clones).toHaveLength(want.clones.length);
    clones.forEach((got, i) => {
      expect(got.scheduledStart).toBe(want.clones![i]!.scheduledStart);
      expect(got.status).toBe(want.clones![i]!.status);
    });
  },

  completedDates: async (want, { adapter, headId }) => {
    if (!want.completedDates) return;
    const after = (await adapter.getPage(headId))!;
    expect(Object.keys(after.completedOccurrences ?? {}).sort()).toEqual(want.completedDates);
  },

  exdates: async (want, { adapter, headId }) => {
    if (!want.exdates) return;
    const stored = await adapter.getRecurrenceRule(headId);
    expect(stored?.rruleExdates ?? []).toEqual(want.exdates);
  },

  head: async (want, { adapter, headId }) => {
    if (!want.head) return;
    const after = (await adapter.getPage(headId))!;
    if (want.head.scheduledStart !== undefined) {
      expect(after.scheduledStart).toBe(want.head.scheduledStart);
    }
    if (want.head.scheduledEnd !== undefined) {
      expect(after.scheduledEnd).toBe(want.head.scheduledEnd);
    }
    if (want.head.status !== undefined) expect(after.status).toBe(want.head.status);
  },

  overrideCount: async (want, { adapter, headId }) => {
    if (want.overrideCount === undefined) return;
    const overrides = (await adapter.listPageSchedules(headId)).filter(
      (s) => s.originalDate != null
    );
    expect(overrides).toHaveLength(want.overrideCount);
  },

  skippedDates: async (want, { adapter, headId }) => {
    if (!want.skippedDates) return;
    const after = (await adapter.getPage(headId))!;
    expect([...(after.skippedOccurrences ?? [])].sort()).toEqual(want.skippedDates);
  },
};

const table = readConformanceTable<Scenario>("recurrence", Object.keys(CHECKS)) as {
  series: Series;
  scenarios: Scenario[];
};

async function apply(
  adapter: MockStorageAdapter,
  pageId: string,
  ruleId: string,
  series: Series,
  step: Step
): Promise<void> {
  switch (step.op) {
    case "complete":
      await adapter.completeRecurringPage({
        pageId,
        ...(step.occurrenceDate !== undefined && { occurrenceDate: step.occurrenceDate }),
        ...(step.expectedOccurrenceDate !== undefined && {
          expectedOccurrenceDate: step.expectedOccurrenceDate,
        }),
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
        timezone: series.timezone,
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
      const series = scenario.series ?? table.series;
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

      for (const step of scenario.steps) await apply(adapter, head.id, rule.id, series, step);

      const world: World = { adapter, headId: head.id };
      for (const check of Object.values(CHECKS)) await check(scenario.expect, world);
    });
  }
});
