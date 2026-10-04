import { describe, expect, it } from "vitest";

import { makePage } from "../calendar/calendar.testHelpers";
import type { ViewCursor, ViewKey, ViewWindow } from "../types";
import { PageStore } from "./pageStore";
import { ViewCache, viewName } from "./viewCache";

const inbox: ViewKey = { dates: null, scope: { kind: "inbox" }, sort: "manual", zone: "UTC" };
const folder: ViewKey = { ...inbox, scope: { folderId: "f1", kind: "folder" } };

function cursor(id: string): ViewCursor {
  return { createdAt: "2026-06-01", id, key: null, section: 0, sortOrder: 0 };
}

function window(ids: string[], next: string | null, total: number | null): ViewWindow {
  return {
    next: next === null ? null : cursor(next),
    rows: ids.map((id) => makePage({ id, rowSeq: 1 })),
    total,
  };
}

describe("ViewCache", () => {
  it("loads the first window, then appends the next without duplicates", () => {
    const cache = new ViewCache({ windowSize: 2 });
    const store = new PageStore();
    expect(cache.receive(cache.begin(inbox, null, 0), window(["a", "b"], "b", 4), store)).toBe(
      true
    );
    cache.receive(cache.begin(inbox, cursor("b"), 0), window(["b", "c", "d"], null, null), store);
    expect(cache.entry(inbox)).toMatchObject({
      ids: ["a", "b", "c", "d"],
      next: null,
      status: "ready",
      total: 4,
    });
    expect(store.ids().sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores a window that was in flight when the view was invalidated, but keeps its rows", () => {
    const cache = new ViewCache({ windowSize: 2 });
    const store = new PageStore();
    cache.receive(cache.begin(inbox, null, 0), window(["a"], null, 1), store);

    const late = cache.begin(inbox, null, 0);
    cache.invalidate();
    expect(cache.receive(late, window(["z"], null, 1), store)).toBe(false);
    expect(cache.entry(inbox)).toMatchObject({ ids: ["a"], stale: true });
    expect(store.has("z")).toBe(true);

    expect(cache.receive(cache.begin(inbox, null, 1), window(["a", "z"], null, 2), store)).toBe(
      true
    );
    expect(cache.entry(inbox)).toMatchObject({ ids: ["a", "z"], stale: false, total: 2 });
  });

  it("invalidates only the views a change can reach", () => {
    const cache = new ViewCache({ windowSize: 2 });
    const store = new PageStore();
    cache.receive(cache.begin(inbox, null, 0), window(["a"], null, 1), store);
    cache.receive(cache.begin(folder, null, 0), window(["b"], null, 1), store);
    cache.invalidate((key) => key.scope.kind === "folder");
    expect(cache.entry(inbox)?.stale).toBe(false);
    expect(cache.entry(folder)?.stale).toBe(true);
  });

  it("names a view the same whatever order its key was written in", () => {
    const reordered = JSON.parse(
      '{"zone":"UTC","sort":"manual","scope":{"kind":"inbox"},"dates":null}'
    ) as ViewKey;
    expect(viewName(reordered)).toBe(viewName(inbox));
    expect(viewName(folder)).not.toBe(viewName(inbox));
  });

  it("records an error only when a first window fails with nothing to show", () => {
    const cache = new ViewCache({ windowSize: 2 });
    const store = new PageStore();
    cache.fail(cache.begin(inbox, null, 0));
    expect(cache.entry(inbox)?.status).toBe("error");
    cache.receive(cache.begin(inbox, null, 0), window(["a"], "a", 3), store);
    cache.fail(cache.begin(inbox, cursor("a"), 0));
    expect(cache.entry(inbox)?.status).toBe("ready");
  });
});

describe("ViewCache ids without rows", () => {
  it("completes the list with ids alone, and drops them after an invalidation", () => {
    const cache = new ViewCache({ windowSize: 2 });
    const store = new PageStore();
    cache.receive(cache.begin(inbox, null, 0), window(["a", "b"], "b", 4), store);
    expect(cache.extendIds(cache.begin(inbox, cursor("b"), 0), ["b", "c", "d"])).toBe(true);
    expect(cache.entry(inbox)).toMatchObject({ ids: ["a", "b", "c", "d"], next: null });
    expect(store.has("c")).toBe(false);

    const late = cache.begin(inbox, cursor("b"), 0);
    cache.invalidate();
    expect(cache.extendIds(late, ["z"])).toBe(false);
  });
});

describe("ViewCache.place", () => {
  it("moves ids between their neighbours, to the top, and to the bottom", () => {
    const cache = new ViewCache({ windowSize: 5 });
    const store = new PageStore();
    cache.receive(cache.begin(inbox, null, 0), window(["a", "b", "c", "d"], null, 4), store);
    cache.place(inbox, ["d"], "a", "b");
    expect(cache.entry(inbox)?.ids).toEqual(["a", "d", "b", "c"]);
    cache.place(inbox, ["c", "b"], null, "a");
    expect(cache.entry(inbox)?.ids).toEqual(["c", "b", "a", "d"]);
    cache.place(inbox, ["c"], "d", null);
    expect(cache.entry(inbox)?.ids).toEqual(["b", "a", "d", "c"]);
  });

  it("leaves the list alone when the neighbour isn't in it", () => {
    const cache = new ViewCache({ windowSize: 5 });
    const store = new PageStore();
    cache.receive(cache.begin(inbox, null, 0), window(["a", "b"], null, 2), store);
    cache.place(inbox, ["b"], "zzz", null);
    expect(cache.entry(inbox)?.ids).toEqual(["a", "b"]);
  });
});
