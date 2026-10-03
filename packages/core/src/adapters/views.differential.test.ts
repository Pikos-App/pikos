// The mock half of the views differential suite: the workspace and writes the database side
// generated (`views_differential_tests.rs`), replayed into the mock, which must answer every list
// read exactly as the database did after every write.

import { describe, expect, it } from "vitest";

import type { Page, PageSummary, PageUpdate, ViewCursor, ViewKey, ViewScope } from "../index";
import { wallClockToUtc } from "../utils/zoned";
import { readFixture } from "./conformanceTable";
import { MockStorageAdapter } from "./MockStorageAdapter";
import { dayAfter } from "./mockViews";

interface SeedPage {
  id: string;
  title: string;
  folderId: string | null;
  priority: number;
  sortOrder: number;
  createdAt: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  syncedIn: string | null;
  status: "not_started" | "done";
  completedAt: string | null;
  tags: string[];
  lastOpenedAt: string | null;
}

type Write =
  | { op: "move"; ids: string[]; after: string | null; before: string | null }
  | { op: "update"; id: string; updates: PageUpdate }
  | { op: "trash"; id: string };

interface Step {
  write: Write | null;
  accepted: boolean;
  expect: Observed;
}

interface Observed {
  lists: Record<string, string[]>;
  completed: Record<string, string[]>;
  counts: Record<string, unknown>;
  ranges: Record<string, string[]>;
  tags: [string, number][];
  recents: string[];
}

interface Fixture {
  today: string;
  zones: string[];
  folders: string[];
  pages: SeedPage[];
  steps: Step[];
}

const fixture = readFixture<Fixture>("views-differential.json");

function page(seed: SeedPage): Page {
  return {
    completedAt: seed.completedAt,
    completedOccurrences: null,
    content: "{}",
    contentText: "",
    createdAt: seed.createdAt,
    detachIsReversible: false,
    folderId: seed.folderId,
    id: seed.id,
    isRecurring: false,
    lastOpenedAt: seed.lastOpenedAt,
    links: [],
    parentId: null,
    priority: seed.priority,
    scheduledEnd: seed.scheduledEnd,
    scheduledStart: seed.scheduledStart,
    scheduleLocked: false,
    skippedOccurrences: null,
    sortOrder: seed.sortOrder,
    status: seed.status,
    subtitle: null,
    tags: seed.tags,
    title: seed.title,
    updatedAt: seed.createdAt,
  } as Page;
}

function load(): MockStorageAdapter {
  const adapter = new MockStorageAdapter();
  adapter.seedExact(
    fixture.folders.map((id) => ({
      createdAt: "2026-06-01",
      id,
      isExternalCalendar: false,
      name: id,
      parentId: null,
      sortOrder: 0,
      updatedAt: "2026-06-01",
    })),
    fixture.pages.map(page)
  );
  for (const seed of fixture.pages) {
    if (seed.syncedIn) adapter.markPageSynced(seed.id, { timezone: seed.syncedIn });
  }
  return adapter;
}

/** The view keys the database side named, rebuilt from their names. */
function keyOf(name: string): ViewKey {
  const [scopeName, mode, ...zoneParts] = name.split("/");
  const zone = zoneParts.join("/");
  const today = fixture.today;
  if (scopeName === "everywhere") {
    const dates =
      mode === "overdue"
        ? { from: null, until: today }
        : mode === "today"
          ? { from: today, until: dayAfter(today) }
          : { from: today, until: dayAfter(today, 7) };
    return { dates, scope: { kind: "everywhere" }, sort: "date", zone };
  }
  const scope: ViewScope =
    scopeName === "inbox" ? { kind: "inbox" } : { folderId: scopeName!, kind: "folder" };
  return { dates: null, scope, sort: mode as ViewKey["sort"], zone };
}

async function paged(adapter: MockStorageAdapter, key: ViewKey): Promise<string[]> {
  const ids: string[] = [];
  let after: ViewCursor | null = null;
  for (;;) {
    const window = await adapter.listView(key, after, 3);
    ids.push(...window.rows.map((r: PageSummary) => r.id));
    if (!window.next) return ids;
    after = window.next;
  }
}

async function observe(adapter: MockStorageAdapter, names: string[]): Promise<Observed> {
  const lists: Record<string, string[]> = {};
  for (const name of names) lists[name] = await paged(adapter, keyOf(name));
  const completed: Record<string, string[]> = {};
  for (const [name, scope] of [
    ["inbox", { kind: "inbox" }],
    ["f1", { folderId: "f1", kind: "folder" }],
    ["everywhere", null],
  ] as const) {
    const window = await adapter.listCompletedWindow(scope, null, null, 50);
    completed[name] = window.rows.map((r) => r.id);
  }
  const counts: Record<string, unknown> = {};
  const ranges: Record<string, string[]> = {};
  for (const zone of fixture.zones) {
    counts[zone] = await adapter.countViews(zone, fixture.today);
    const start = wallClockToUtc(zone, `${fixture.today}T00:00:00`).toISOString();
    const end = wallClockToUtc(zone, `${dayAfter(fixture.today, 7)}T00:00:00`).toISOString();
    ranges[zone] = (await adapter.listRange(start, end, zone, false)).map((p) => p.id).sort();
  }
  const tags = (await adapter.listTags()).map((t): [string, number] => [t.name, t.pageCount]);
  const recents = (await adapter.listRecentPages(null, 10)).map((p) => p.id);
  return { completed, counts, lists, ranges, recents, tags };
}

async function apply(adapter: MockStorageAdapter, write: Write): Promise<boolean> {
  try {
    if (write.op === "move") {
      await adapter.movePages(write.ids, { after: write.after, before: write.before });
    } else if (write.op === "update") {
      await adapter.updatePage(write.id, write.updates);
    } else {
      await adapter.softDeletePage(write.id);
    }
    return true;
  } catch {
    return false;
  }
}

describe("the mock answers every list read as the database did", () => {
  it("after every write in the generated run", async () => {
    const adapter = load();
    const names = Object.keys(fixture.steps[0]!.expect.lists);
    for (const [i, step] of fixture.steps.entries()) {
      if (step.write) {
        expect(await apply(adapter, step.write), `step ${i} accepted`).toBe(step.accepted);
      }
      expect(
        await observe(adapter, names),
        `after step ${i}: ${JSON.stringify(step.write)}`
      ).toEqual(step.expect);
    }
  });
});
