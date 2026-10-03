import type { ViewKey } from "@pikos/core";
import { watchWrites } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { afterEach, describe, expect, it } from "vitest";

import { ViewCacheController } from "./controller";

const inbox: ViewKey = { dates: null, scope: { kind: "inbox" }, sort: "manual", zone: "UTC" };

function newPage(title: string): Parameters<MockStorageAdapter["createPage"]>[0] {
  return { content: "", folderId: null, priority: 0, status: "not_started", tags: [], title };
}

async function setup(pages: number, windowSize = 2) {
  const raw = new MockStorageAdapter();
  for (let i = 0; i < pages; i++) await raw.createPage(newPage(`Page ${i}`));
  const ref: { controller: ViewCacheController | null } = { controller: null };
  const adapter = watchWrites(raw, {
    settled: (method, args) => ref.controller?.writeSettled(method, args),
    started: () => ref.controller?.writeStarted(),
  });
  const controller = new ViewCacheController(adapter, {
    budgetBytes: Number.MAX_SAFE_INTEGER,
    shadow: true,
    windowSize,
  });
  ref.controller = controller;
  return { adapter, controller, raw };
}

/** Wait for every fetch the controller started to land. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  window.__PIKOS_SHADOW_MISMATCHES__ = [];
});

describe("ViewCacheController", () => {
  it("keeps loading until the rows on screen are held, a window at a time", async () => {
    const { controller } = await setup(7);
    controller.show([inbox], []);
    controller.want(inbox, 0, 6);
    await settle();
    const entry = controller.cache.entry(inbox);
    expect(entry?.ids).toHaveLength(7);
    expect(entry?.ids.every((id) => controller.store.has(id))).toBe(true);
  });

  it("jumps far past what's loaded by fetching the ids, then only the rows on screen", async () => {
    const { controller } = await setup(20);
    controller.show([inbox], []);
    await settle();
    controller.want(inbox, 17, 19);
    await settle();
    const ids = controller.cache.entry(inbox)?.ids ?? [];
    expect(ids).toHaveLength(20);
    expect(ids.slice(17).every((id) => controller.store.has(id))).toBe(true);
    expect(controller.store.has(ids[10]!)).toBe(false);
  });

  it("refreshes the list on screen after a write", async () => {
    const { adapter, controller } = await setup(1);
    controller.show([inbox], []);
    await settle();
    const created = await adapter.createPage(newPage("Added"));
    await settle();
    expect(controller.cache.entry(inbox)?.ids).toContain(created.id);
  });

  it("records a cached list that differs from the database, and nothing when it matches", async () => {
    const { controller, raw } = await setup(2);
    controller.show([inbox], []);
    await settle();
    controller.show([inbox], []);
    await settle();
    expect(window.__PIKOS_SHADOW_MISMATCHES__ ?? []).toEqual([]);

    // A write the controller doesn't hear about, as from another process before the doorbell.
    await raw.createPage(newPage("Behind its back"));
    controller.show([inbox], []);
    await settle();
    expect(window.__PIKOS_SHADOW_MISMATCHES__).toHaveLength(1);
  });

  it("skips the check while a write is in flight", async () => {
    const { controller, raw } = await setup(2);
    controller.show([inbox], []);
    await settle();
    await raw.createPage(newPage("Committed, not yet settled"));
    controller.writeStarted();
    controller.show([inbox], []);
    await settle();
    expect(window.__PIKOS_SHADOW_MISMATCHES__ ?? []).toEqual([]);
  });
});

describe("ViewCacheController shown twice before its first window lands", () => {
  it("doesn't check a list that is still loading", async () => {
    const { controller } = await setup(2);
    controller.show([inbox], []);
    controller.show([inbox], []);
    await settle();
    expect(window.__PIKOS_SHADOW_MISMATCHES__ ?? []).toEqual([]);
  });
});

describe("ViewCacheController calendar ranges", () => {
  const start = "2026-06-01T00:00:00Z";
  const end = "2026-06-08T00:00:00Z";

  it("holds a range's pages, done ones too, and every series head", async () => {
    const { adapter, controller } = await setup(0);
    const open = await adapter.createPage({
      ...newPage("Dentist"),
      scheduledStart: "2026-06-03T09:00:00",
    });
    const done = await adapter.createPage({
      ...newPage("Filed taxes"),
      scheduledStart: "2026-06-04T09:00:00",
      status: "done",
    });
    await adapter.createPage({ ...newPage("Next month"), scheduledStart: "2026-07-03T09:00:00" });
    await settle();
    controller.showRange(start, end);
    await settle();
    const ids = controller.rangePages(start, end).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([open.id, done.id]));
    expect(ids).toHaveLength(2);
  });

  it("refetches the range on screen after a write, and drops every range when hidden", async () => {
    const { adapter, controller } = await setup(0);
    controller.showRange(start, end);
    await settle();
    const added = await adapter.createPage({
      ...newPage("Added"),
      scheduledStart: "2026-06-05T10:00:00",
    });
    await settle();
    expect(controller.rangePages(start, end).map((p) => p.id)).toContain(added.id);
    controller.hideRanges();
    expect(controller.rangePages(start, end)).toEqual([]);
  });
});

describe("ViewCacheController series heads", () => {
  it("gives a range every series head, even one dated outside it", async () => {
    const { adapter, controller } = await setup(0);
    const head = await adapter.createPage({
      ...newPage("Standup"),
      scheduledStart: "2026-05-04T09:00:00",
    });
    await adapter.createRecurrenceRule({
      pageId: head.id,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      scheduledStart: "2026-05-04T09:00:00",
      timezone: "UTC",
    });
    await settle();
    controller.showRange("2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z");
    await settle();
    const ids = controller
      .rangePages("2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z")
      .map((p) => p.id);
    expect(ids).toContain(head.id);
  });
});

describe("ViewCacheController range races", () => {
  it("keeps a range's newer load when an older one lands after it", async () => {
    const { adapter, controller, raw } = await setup(0);
    const start = "2026-06-01T00:00:00Z";
    const end = "2026-06-08T00:00:00Z";
    const real = raw.listRange.bind(raw);
    const held: Array<() => void> = [];
    raw.listRange = (...args) =>
      new Promise((resolve) => {
        const answer = real(...args);
        held.push(() => void answer.then(resolve));
      });

    controller.showRange(start, end);
    await settle();
    const added = await adapter.createPage({
      ...newPage("Added"),
      scheduledStart: "2026-06-03T09:00:00",
    });
    await settle();
    // The first load read before the write; the refresh's load reads after it.
    raw.listRange = real;
    const [older, newer] = held;
    newer?.();
    await settle();
    older?.();
    await settle();
    expect(controller.rangePages(start, end).map((p) => p.id)).toContain(added.id);
  });
});

describe("ViewCacheController after its own writes", () => {
  it("refetches only the row when a write touches its body alone, as an autosave does", async () => {
    const { adapter, controller } = await setup(3);
    controller.show([inbox], []);
    await settle();
    const id = controller.cache.entry(inbox)?.ids[0] ?? "";
    const before = controller.store.get(id)?.rowSeq;
    const fetches = controller.listFetches;

    await adapter.updatePage(id, { content: '{"type":"doc"}', contentText: "typed" });
    await settle();
    expect(controller.listFetches).toBe(fetches);
    expect(controller.store.get(id)?.rowSeq).not.toBe(before);
  });

  it("refreshes nothing after a write that changed nothing", async () => {
    const { adapter, controller } = await setup(3);
    controller.show([inbox], []);
    await settle();
    await adapter.recomputeRecurringSchedules();
    await settle();
    const fetches = controller.listFetches;
    await adapter.recomputeRecurringSchedules();
    await settle();
    expect(controller.listFetches).toBe(fetches);
  });

  it("refreshes on the doorbell only when another writer moved the counter", async () => {
    const { controller, raw } = await setup(2);
    controller.show([inbox], []);
    await settle();
    controller.doorbell();
    await settle();
    const fetches = controller.listFetches;

    controller.doorbell();
    await settle();
    expect(controller.listFetches).toBe(fetches);

    const outside = await raw.createPage(newPage("From the CLI"));
    controller.doorbell();
    await settle();
    expect(controller.cache.entry(inbox)?.total).toBe(3);
    expect(await controller.allIds(inbox)).toContain(outside.id);
  });
});
