import { describe, expect, it } from "vitest";

import { makePage } from "../calendar/calendar.testHelpers";
import type { ViewKey } from "../types";
import { evict } from "./eviction";
import { PageStore } from "./pageStore";
import { ViewCache, viewName } from "./viewCache";

function key(folderId: string): ViewKey {
  return { dates: null, scope: { folderId, kind: "folder" }, sort: "manual", zone: "UTC" };
}

/** Three folders of three pages each, shown f1 then f2 then f3. */
function loaded() {
  const cache = new ViewCache({ windowSize: 50 });
  const store = new PageStore();
  for (const f of ["f1", "f2", "f3"]) {
    const ids = [1, 2, 3].map((n) => `${f}-${n}`);
    const token = cache.begin(key(f), null, 0);
    cache.receive(
      token,
      { next: null, rows: ids.map((id) => makePage({ id, rowSeq: 1 })), total: 3 },
      store
    );
    cache.touch(key(f));
  }
  return { cache, store };
}

const nothing = { pages: new Set<string>(), views: new Set<string>() };

describe("evict", () => {
  it("does nothing under budget", () => {
    const { cache, store } = loaded();
    expect(evict(cache, store, Number.MAX_SAFE_INTEGER, nothing)).toEqual({ pages: [], views: [] });
  });

  it("drops the least recently shown views first, and their pages with them", () => {
    const { cache, store } = loaded();
    const oneView = cache.estimateBytes() / 3 + store.estimateBytes() / 3;
    const result = evict(cache, store, oneView * 1.5, nothing);
    expect(result.views).toEqual([viewName(key("f1")), viewName(key("f2"))]);
    expect(store.ids().sort()).toEqual(["f3-1", "f3-2", "f3-3"]);
  });

  it("keeps pinned views and pages, and pages another view still lists", () => {
    const { cache, store } = loaded();
    const pinned = { pages: new Set(["f2-1"]), views: new Set([viewName(key("f1"))]) };
    evict(cache, store, 0, pinned);
    expect(cache.entry(key("f1"))).toBeDefined();
    expect(store.has("f1-1")).toBe(true);
    expect(store.has("f2-1")).toBe(true);
    expect(store.has("f2-2")).toBe(false);
  });

  it("never drops a page with a write in flight", () => {
    const { cache, store } = loaded();
    store.write("f1-2", { title: "unsaved" });
    evict(cache, store, 0, nothing);
    expect(store.ids()).toEqual(["f1-2"]);
  });

  it("refetches a view after it was evicted and shown again", () => {
    const { cache, store } = loaded();
    evict(cache, store, 0, nothing);
    expect(cache.entry(key("f1"))).toBeUndefined();
    const token = cache.begin(key("f1"), null, 1);
    expect(cache.entry(key("f1"))?.status).toBe("loading");
    cache.receive(
      token,
      { next: null, rows: [makePage({ id: "f1-1", rowSeq: 2 })], total: 1 },
      store
    );
    expect(cache.entry(key("f1"))?.ids).toEqual(["f1-1"]);
  });
});
