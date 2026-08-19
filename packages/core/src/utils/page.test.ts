import { describe, expect, it } from "vitest";

import type { Page, PageSummary } from "../types";
import { deriveTags, findRecurringOccurrenceClone, isDone, isOpen, toPageSummary } from "./page";

function makeSummary(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "page-1",
    isRecurring: false,
    priority: 0,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Page",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

describe("isOpen", () => {
  it("returns true for not_started", () => {
    expect(isOpen({ status: "not_started" })).toBe(true);
  });

  it("returns false for done", () => {
    expect(isOpen({ status: "done" })).toBe(false);
  });
});

describe("isDone", () => {
  it("returns true for done", () => {
    expect(isDone({ status: "done" })).toBe(true);
  });

  it("returns false for not_started", () => {
    expect(isDone({ status: "not_started" })).toBe(false);
  });
});

describe("toPageSummary", () => {
  it("drops content and contentText, keeping every other field", () => {
    const page: Page = {
      ...makeSummary({ tags: ["a"], title: "Full" }),
      content: '{"type":"doc"}',
      contentText: "body text",
    };
    const summary = toPageSummary(page);
    expect(summary).not.toHaveProperty("content");
    expect(summary).not.toHaveProperty("contentText");
    expect(summary.title).toBe("Full");
    expect(summary.tags).toEqual(["a"]);
  });
});

describe("deriveTags", () => {
  it("counts each tag and collects the pages carrying it", () => {
    const tags = deriveTags([
      makeSummary({ id: "a", tags: ["work", "urgent"] }),
      makeSummary({ id: "b", tags: ["work"] }),
    ]);
    expect(tags).toEqual([
      { name: "work", pageCount: 2, pageIds: ["a", "b"] },
      { name: "urgent", pageCount: 1, pageIds: ["a"] },
    ]);
  });

  it("returns nothing for pages with no tags", () => {
    expect(deriveTags([makeSummary(), makeSummary({ id: "b" })])).toEqual([]);
  });
});

describe("findRecurringOccurrenceClone", () => {
  const series = makeSummary({
    completedOccurrences: { "2026-01-05": "clone-1", "2026-01-06": "clone-2" },
    id: "series",
  });

  it("finds the series and date a done clone came from", () => {
    expect(findRecurringOccurrenceClone([makeSummary({ id: "other" }), series], "clone-2")).toEqual(
      {
        occurrenceDate: "2026-01-06",
        seriesId: "series",
      }
    );
  });

  it("returns null for a page that is not a recurring clone", () => {
    expect(findRecurringOccurrenceClone([series], "unrelated")).toBeNull();
  });

  it("skips pages with no completion map", () => {
    expect(
      findRecurringOccurrenceClone([makeSummary({ completedOccurrences: null })], "x")
    ).toBeNull();
  });
});
