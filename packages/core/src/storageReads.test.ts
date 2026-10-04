import { describe, expect, it } from "vitest";

import { MockStorageAdapter } from "./adapters/MockStorageAdapter";
import { STORAGE_READS, watchWrites } from "./storageReads";

describe("STORAGE_READS", () => {
  it("names only methods the adapter has", () => {
    const adapter = new MockStorageAdapter() as unknown as Record<string, unknown>;
    const missing = [...STORAGE_READS].filter((m) => typeof adapter[m] !== "function");
    expect(missing).toEqual([]);
  });

  it("holds every read a view refresh makes, so a refresh can't set off another", () => {
    for (const read of ["listView", "listViewIds", "getPages", "changeState", "countViews"]) {
      expect(STORAGE_READS.has(read as never)).toBe(true);
    }
  });
});

describe("watchWrites", () => {
  it("reports writes once they settle, and leaves reads alone", async () => {
    let writes = 0;
    const adapter = watchWrites(new MockStorageAdapter(), {
      settled: () => (writes += 1),
      started: () => undefined,
    });
    const page = await adapter.createPage({
      content: "",
      folderId: null,
      priority: 0,
      status: "not_started",
      tags: [],
      title: "Plan",
    });
    expect(writes).toBe(1);
    await adapter.getPage(page.id);
    await adapter.listView(
      { dates: null, scope: { kind: "inbox" }, sort: "manual", zone: "UTC" },
      null,
      10
    );
    expect(writes).toBe(1);
  });

  it("reports a failed write and still rejects to the caller", async () => {
    let writes = 0;
    const adapter = watchWrites(new MockStorageAdapter(), {
      settled: () => (writes += 1),
      started: () => undefined,
    });
    await expect(adapter.completeRecurringPage({ pageId: "missing" })).rejects.toBeDefined();
    expect(writes).toBe(1);
  });
});
