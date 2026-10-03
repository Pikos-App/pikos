import { describe, expect, it } from "vitest";

import { makePage } from "../calendar/calendar.testHelpers";
import { PageStore } from "./pageStore";

function store(...rows: Parameters<typeof makePage>[0][]) {
  const s = new PageStore();
  s.confirm(rows.map((r) => makePage(r)));
  return s;
}

describe("PageStore", () => {
  it("shows unsettled writes in order on top of the confirmed page", () => {
    const s = store({ id: "a", priority: 0, rowSeq: 1, title: "Plan" });
    s.write("a", { title: "Plan v2" });
    s.write("a", { priority: 1, title: "Plan v3" });
    expect(s.get("a")).toMatchObject({ priority: 1, title: "Plan v3" });
  });

  it("keeps a later write's fields when an earlier write to the page fails", () => {
    const s = store({ id: "a", priority: 0, rowSeq: 1, title: "Plan" });
    const first = s.write("a", { title: "Plan v2" });
    s.write("a", { priority: 2 });
    s.settle(first, { kind: "failed" });
    expect(s.get("a")).toMatchObject({ priority: 2, title: "Plan" });
    expect(s.hasError("a")).toBe(true);
  });

  it("removes only the settled write's entry, and takes the row it returned", () => {
    const s = store({ id: "a", rowSeq: 1, title: "Plan" });
    const first = s.write("a", { title: "Plan v2" });
    s.write("a", { title: "Plan v3" });
    s.settle(first, { kind: "confirmed", row: makePage({ id: "a", rowSeq: 2, title: "Plan v2" }) });
    expect(s.get("a")?.title).toBe("Plan v3");
    expect(s.isPending("a")).toBe(true);
  });

  it("ignores a row read before a write it would undo", () => {
    const s = store({ id: "a", rowSeq: 5, title: "Plan" });
    const w = s.write("a", { title: "Renamed" });
    s.settle(w, { kind: "confirmed", row: makePage({ id: "a", rowSeq: 9, title: "Renamed" }) });
    // A window that started before the rename lands after it.
    s.confirm([makePage({ id: "a", rowSeq: 7, title: "Plan" })]);
    expect(s.get("a")?.title).toBe("Renamed");
    s.confirm([makePage({ id: "a", rowSeq: 9, title: "Renamed by sync" })]);
    expect(s.get("a")?.title).toBe("Renamed by sync");
  });

  it("holds a failed content write on screen until a later write to the page is confirmed", () => {
    const s = store({ id: "a", rowSeq: 1, title: "Plan" });
    const failed = s.write("a", { title: "Typed but unsaved" });
    s.settle(failed, { keep: true, kind: "failed" });
    expect(s.get("a")?.title).toBe("Typed but unsaved");
    expect(s.forget(["a"])).toEqual([]);

    const retry = s.write("a", { title: "Typed and saved" });
    s.settle(retry, {
      kind: "confirmed",
      row: makePage({ id: "a", rowSeq: 2, title: "Typed and saved" }),
    });
    expect(s.isPending("a")).toBe(false);
    expect(s.hasError("a")).toBe(false);
    expect(s.get("a")?.title).toBe("Typed and saved");
  });

  it("forgets only pages with nothing in flight and no recorded error", () => {
    const s = store({ id: "a", rowSeq: 1 }, { id: "b", rowSeq: 1 }, { id: "c", rowSeq: 1 });
    s.write("b", { title: "in flight" });
    s.settle(s.write("c", { title: "failed" }), { kind: "failed" });
    expect(s.forget(["a", "b", "c"])).toEqual(["a"]);
    expect(s.ids().sort()).toEqual(["b", "c"]);
  });

  it("tells subscribers about every change", () => {
    const s = new PageStore();
    let calls = 0;
    const stop = s.subscribe(() => (calls += 1));
    s.confirm([makePage({ id: "a", rowSeq: 1 })]);
    s.write("a", { title: "x" });
    stop();
    s.write("a", { title: "y" });
    expect(calls).toBe(2);
  });

  it("hides a page while a write that removes it is in flight, and brings it back if it fails", () => {
    const s = store({ id: "a", rowSeq: 1, title: "Plan" });
    const removal = s.write("a", {}, true);
    expect(s.get("a")).toBeUndefined();
    s.settle(removal, { kind: "failed" });
    expect(s.get("a")?.title).toBe("Plan");

    const again = s.write("a", {}, true);
    s.settle(again, { kind: "confirmed" });
    expect(s.has("a")).toBe(false);
  });
});
