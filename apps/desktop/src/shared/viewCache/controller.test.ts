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
    settled: () => ref.controller?.writeSettled(),
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
