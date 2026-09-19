// Core-lifecycle conformance — the mock half of the page/folder/reminder/search
// table. Why the table exists, and why search dominates it:
// `core_conformance_tests.rs`, beside the fixture.

import { beforeEach, describe, expect, it } from "vitest";

import type { PageStatus, SearchResult } from "../types";
import { readConformanceTable, unhandledStep } from "./conformanceTable";
import { MockStorageAdapter } from "./MockStorageAdapter";

interface Step {
  op:
    | "page"
    | "folder"
    | "softDeletePage"
    | "restorePage"
    | "softDeleteFolder"
    | "deletePage"
    | "reminder"
    | "setStatus";
  id?: string;
  title?: string;
  subtitle?: string;
  name?: string;
  contentText?: string;
  tags?: string[];
  folder?: string;
  page?: string;
  pages?: string[];
  status?: PageStatus;
  minutesBefore?: number;
}

interface Scenario {
  name: string;
  steps: Step[];
  expect: {
    search?: {
      query: string;
      includeCompleted?: boolean;
      matches: string[];
      /** Checked against every matched row — see the Rust runner's `SearchExpect`. */
      matchSource?: SearchResult["matchSource"];
      excerpt?: string;
      completedCount?: number;
    };
    listQuery?: { query: string; matches: string[] };
    visiblePages?: string[];
    reminderCount?: { page: string; count: number };
  };
}

type Expect = Scenario["expect"];

interface World {
  adapter: MockStorageAdapter;
  ids: Map<string, string>;
  /** The fixture's name for a real id, so a failure reads in the table's terms. */
  named: (real: string) => string;
}

/** One assertion per expectation key. `Record<keyof Expect, …>` is the point: a key
 *  added to `Expect` does not compile until it has a checker here, and
 *  `readConformanceTable` rejects a fixture key that is in neither. A declared list
 *  of key names could drift from the assertions; these are the assertions. */
const CHECKS: Record<keyof Expect, (want: Expect, world: World) => Promise<void>> = {
  listQuery: async (want, { adapter, named }) => {
    if (!want.listQuery) return;
    const listed = await adapter.listPages({ query: want.listQuery.query });
    expect(listed.map((p) => named(p.id)).sort()).toEqual([...want.listQuery.matches].sort());
  },

  reminderCount: async (want, { adapter, ids }) => {
    if (!want.reminderCount) return;
    const reminders = await adapter.listPageReminders(ids.get(want.reminderCount.page)!);
    expect(reminders).toHaveLength(want.reminderCount.count);
  },

  search: async (want, { adapter, named }) => {
    if (!want.search) return;
    const res = await adapter.searchPages(want.search.query, want.search.includeCompleted);
    expect(res.results.map((r) => named(r.id)).sort()).toEqual([...want.search.matches].sort());
    for (const row of res.results) {
      if (want.search.matchSource !== undefined) {
        expect(row.matchSource, `${named(row.id)}'s match source`).toBe(want.search.matchSource);
      }
      if (want.search.excerpt !== undefined) {
        expect(row.excerpt, `${named(row.id)}'s excerpt`).toBe(want.search.excerpt);
      }
    }
    if (want.search.completedCount !== undefined) {
      expect(res.completedCount).toBe(want.search.completedCount);
    }
  },

  visiblePages: async (want, { adapter, named }) => {
    if (!want.visiblePages) return;
    const listed = await adapter.listPages();
    expect(listed.map((p) => named(p.id)).sort()).toEqual([...want.visiblePages].sort());
  },
};

const table = readConformanceTable<Scenario>("core", Object.keys(CHECKS));

async function apply(
  adapter: MockStorageAdapter,
  ids: Map<string, string>,
  step: Step
): Promise<void> {
  switch (step.op) {
    case "page": {
      const page = await adapter.createPage({
        // Real editor markup, not an empty string: the words the user never typed
        // ("paragraph", "doc", "type") only exist here, and a filter that reaches
        // into this shape is what one of the rows below is looking for.
        content: JSON.stringify({
          content: [
            { content: [{ text: step.contentText ?? "", type: "text" }], type: "paragraph" },
          ],
          type: "doc",
        }),
        contentText: step.contentText ?? "",
        folderId: step.folder ? (ids.get(step.folder) ?? null) : null,
        priority: 0,
        status: "not_started",
        subtitle: step.subtitle ?? null,
        tags: step.tags ?? [],
        title: step.title!,
      });
      ids.set(step.id!, page.id);
      return;
    }
    case "folder": {
      const folder = await adapter.createFolder({ name: step.name!, parentId: null });
      ids.set(step.id!, folder.id);
      return;
    }
    case "softDeletePage":
      await adapter.softDeletePage(ids.get(step.page!)!);
      return;
    case "restorePage":
      await adapter.restorePage(ids.get(step.page!)!);
      return;
    case "softDeleteFolder":
      await adapter.softDeleteFolder(ids.get(step.folder!)!);
      return;
    case "deletePage":
      await adapter.deletePage(ids.get(step.page!)!);
      return;
    case "reminder":
      await adapter.createPageReminder({
        minutesBefore: step.minutesBefore!,
        pageId: ids.get(step.page!)!,
      });
      return;
    case "setStatus":
      await adapter.setPagesStatus(
        step.pages!.map((p) => ids.get(p)!),
        step.status!,
        new Date().toISOString()
      );
      return;
    default:
      return unhandledStep("core", step.op);
  }
}

describe("core lifecycle conformance", () => {
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
      const ids = new Map<string, string>();
      for (const step of scenario.steps) await apply(adapter, ids, step);

      const named = (real: string) => [...ids.entries()].find(([, v]) => v === real)?.[0] ?? real;
      const world: World = { adapter, ids, named };

      for (const check of Object.values(CHECKS)) await check(scenario.expect, world);
    });
  }
});
