import type { PageSummary } from "@pikos/core";
import { PageStore } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { WriteMirror } from "./writeMirror";

function makePage(fields: Partial<PageSummary> & { id: string }): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    detachIsReversible: false,
    folderId: null,
    isRecurring: false,
    priority: 0,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Untitled",
    updatedAt: "2026-01-01T00:00:00",
    ...fields,
  };
}

function setup(...pages: PageSummary[]) {
  const store = new PageStore();
  store.confirm(pages);
  const database = new Map(pages.map((p) => [p.id, p]));
  const mirror = new WriteMirror(store, (ids) =>
    Promise.resolve(ids.flatMap((id) => database.get(id) ?? []))
  );
  return { database, mirror, store };
}

describe("WriteMirror", () => {
  const plan = makePage({ id: "a", priority: 0, rowSeq: 1, title: "Plan" });

  it("records a write's optimistic edit as a pending write, and only inside the write", () => {
    const { mirror, store } = setup(plan);
    mirror.changed([plan], [{ ...plan, title: "Loaded" }]);
    expect(store.get("a")?.title).toBe("Plan");

    const writes = mirror.capture(() => mirror.changed([plan], [{ ...plan, priority: 2 }]));
    expect(writes).toHaveLength(1);
    expect(store.get("a")?.priority).toBe(2);
  });

  it("settles a landed write with the row the database now has", async () => {
    const { database, mirror, store } = setup(plan);
    const writes = mirror.capture(() => mirror.changed([plan], [{ ...plan, title: "Renamed" }]));
    database.set("a", { ...plan, rowSeq: 2, title: "Renamed" });
    await mirror.confirm(writes);
    expect(store.isPending("a")).toBe(false);
    expect(store.get("a")).toMatchObject({ rowSeq: 2, title: "Renamed" });
  });

  it("drops a failed write's edit, or holds typing on screen when asked", () => {
    const { mirror, store } = setup(plan);
    const failed = mirror.capture(() => mirror.changed([plan], [{ ...plan, title: "Lost" }]));
    mirror.fail(failed);
    expect(store.get("a")?.title).toBe("Plan");

    const typed = mirror.capture(() => mirror.changed([plan], [{ ...plan, title: "Typed" }]));
    mirror.fail(typed, true);
    expect(store.get("a")?.title).toBe("Typed");
  });

  it("hides a page a write takes out of the list, and holds one it adds", () => {
    const { mirror, store } = setup(plan);
    const added = makePage({ id: "b", rowSeq: 3, title: "New" });
    mirror.capture(() => mirror.changed([plan], [added]));
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.title).toBe("New");
  });
});
