import { describe, expect, it } from "vitest";

import { EMPTY_PAGE_HISTORY, type PageHistory, stepPageHistory, visitPage } from "./pageHistory";

const allOpen = () => true;

function visitAll(ids: string[], browsed: string[] = []): PageHistory {
  return ids.reduce(
    (history, id) => visitPage(history, id, { browsed: browsed.includes(id) }),
    EMPTY_PAGE_HISTORY
  );
}

function landsOn(history: PageHistory): string | undefined {
  return history.entries[history.index]?.id;
}

describe("visitPage", () => {
  it("records each page opened, once", () => {
    const history = visitAll(["a", "b", "b"]);

    expect(history.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("drops the forward pages when a new page opens after going back", () => {
    const back = stepPageHistory(visitAll(["a", "b", "c"]), "c", -1, allOpen);
    const history = visitPage(back!.history, "d");

    expect(history.entries.map((e) => e.id)).toEqual(["a", "b", "d"]);
  });

  it("keeps a run of arrow steps as one entry after the page it started from", () => {
    const history = visitAll(["a", "b", "c", "d"], ["b", "c", "d"]);

    expect(history.entries.map((e) => e.id)).toEqual(["a", "d"]);
  });

  it("keeps the page a run of arrow steps ended on when a page opens from it", () => {
    const history = visitAll(["a", "b", "c", "d"], ["b", "c"]);

    expect(history.entries.map((e) => e.id)).toEqual(["a", "c", "d"]);
  });

  it("records the page on screen first when history doesn't hold it", () => {
    const history = visitPage(EMPTY_PAGE_HISTORY, "b", { showing: "a" });

    expect(history.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("forgets the oldest page past a hundred", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `p${i}`);
    const history = visitAll(ids);

    expect(history.entries).toHaveLength(100);
    expect(history.entries[0]?.id).toBe("p1");
    expect(landsOn(history)).toBe("p100");
  });
});

describe("stepPageHistory", () => {
  it("goes back and then forward again", () => {
    const back = stepPageHistory(visitAll(["a", "b"]), "b", -1, allOpen);
    const forward = stepPageHistory(back!.history, "a", 1, allOpen);

    expect(back?.id).toBe("a");
    expect(forward?.id).toBe("b");
  });

  it("has nowhere to go at either end", () => {
    const history = visitAll(["a"]);

    expect(stepPageHistory(history, "a", -1, allOpen)).toBeNull();
    expect(stepPageHistory(history, "a", 1, allOpen)).toBeNull();
  });

  it("passes over a page that has been deleted since", () => {
    const back = stepPageHistory(visitAll(["a", "b", "c"]), "c", -1, (id) => id !== "b");

    expect(back?.id).toBe("a");
  });

  it("returns to the page last open once it has been closed", () => {
    const back = stepPageHistory(visitAll(["a", "b"]), null, -1, allOpen);

    expect(back?.id).toBe("b");
  });
});
