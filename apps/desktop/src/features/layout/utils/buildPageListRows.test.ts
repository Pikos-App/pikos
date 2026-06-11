import type { PageSummary } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { buildPageListRows } from "./buildPageListRows";
import type { BuildPageListRowsInput } from "./buildPageListRows";

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: overrides.id ?? crypto.randomUUID(),
    priority: 0,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Untitled",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

function defaults(overrides: Partial<BuildPageListRowsInput> = {}): BuildPageListRowsInput {
  return {
    completedCollapsed: true,
    completedHasMore: false,
    completedPages: [],
    isTodayView: false,
    overdue: [],
    overdueCollapsed: true,
    today: [],
    visiblePages: [],
    ...overrides,
  };
}

function rowTypes(input: BuildPageListRowsInput) {
  return buildPageListRows(input).rows.map((r) => r.type);
}

// ── Empty state ─────────────────────────────────────────────────────────────

describe("empty state", () => {
  it("shows empty-state row when no visible pages", () => {
    const types = rowTypes(defaults());
    expect(types).toEqual(["empty-state", "completed-toggle"]);
  });
});

// ── Folder / Inbox view ─────────────────────────────────────────────────────

describe("folder view", () => {
  it("creates a page row per visible page", () => {
    const pages = [makePage({ id: "a" }), makePage({ id: "b" }), makePage({ id: "c" })];
    const { pageToRowIndex, rows } = buildPageListRows(defaults({ visiblePages: pages }));
    const pageRows = rows.filter((r) => r.type === "page");
    expect(pageRows).toHaveLength(3);
    expect(pageToRowIndex.get("a")).toBe(0);
    expect(pageToRowIndex.get("b")).toBe(1);
    expect(pageToRowIndex.get("c")).toBe(2);
  });

  it("ends with completed-toggle", () => {
    const pages = [makePage()];
    const types = rowTypes(defaults({ visiblePages: pages }));
    expect(types[types.length - 1]).toBe("completed-toggle");
  });
});

// ── Today view ──────────────────────────────────────────────────────────────

describe("today view", () => {
  const overduePage = makePage({ id: "od1" });
  const todayPage = makePage({ id: "td1" });

  it("shows overdue header + today header when both sections present", () => {
    const types = rowTypes(
      defaults({
        isTodayView: true,
        overdue: [overduePage],
        overdueCollapsed: false,
        today: [todayPage],
        visiblePages: [overduePage, todayPage],
      })
    );
    expect(types).toEqual([
      "section-header", // overdue
      "page", // overdue page
      "section-header", // today
      "page", // today page
      "completed-toggle",
    ]);
  });

  it("hides overdue pages when collapsed", () => {
    const types = rowTypes(
      defaults({
        isTodayView: true,
        overdue: [overduePage],
        overdueCollapsed: true,
        today: [todayPage],
        visiblePages: [overduePage, todayPage],
      })
    );
    expect(types).toEqual([
      "section-header", // overdue (collapsed)
      "section-header", // today
      "page", // today page
      "completed-toggle",
    ]);
  });

  it("skips today header when no overdue items", () => {
    const types = rowTypes(
      defaults({
        isTodayView: true,
        overdue: [],
        today: [todayPage],
        visiblePages: [todayPage],
      })
    );
    // No overdue header, no today header — just the page
    expect(types).toEqual(["page", "completed-toggle"]);
  });

  it("overdue header is marked collapsible, today header is not", () => {
    const { rows } = buildPageListRows(
      defaults({
        isTodayView: true,
        overdue: [overduePage],
        overdueCollapsed: false,
        today: [todayPage],
        visiblePages: [overduePage, todayPage],
      })
    );
    const headers = rows.filter((r) => r.type === "section-header");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toMatchObject({ collapsible: true, label: "Overdue" });
    expect(headers[1]).toMatchObject({ collapsible: false, label: "Today" });
  });

  it("does not include collapsed overdue pages in pageToRowIndex", () => {
    const { pageToRowIndex } = buildPageListRows(
      defaults({
        isTodayView: true,
        overdue: [overduePage],
        overdueCollapsed: true,
        today: [todayPage],
        visiblePages: [overduePage, todayPage],
      })
    );
    expect(pageToRowIndex.has("od1")).toBe(false);
    expect(pageToRowIndex.has("td1")).toBe(true);
  });
});

// ── Completed section ───────────────────────────────────────────────────────

describe("completed section", () => {
  it("only shows toggle when collapsed", () => {
    const types = rowTypes(defaults({ completedCollapsed: true, completedPages: [makePage()] }));
    expect(types.filter((t) => t === "completed-toggle")).toHaveLength(1);
    expect(types).not.toContain("load-more");
    expect(types).not.toContain("empty-completed");
  });

  it("shows completed pages when expanded", () => {
    const completed = [makePage({ id: "c1" }), makePage({ id: "c2" })];
    const { rows } = buildPageListRows(
      defaults({ completedCollapsed: false, completedPages: completed })
    );
    const afterToggle = rows.slice(rows.findIndex((r) => r.type === "completed-toggle") + 1);
    expect(afterToggle.filter((r) => r.type === "page")).toHaveLength(2);
  });

  it("prefixes completed page keys with c- to avoid collisions", () => {
    const page = makePage({ id: "shared-id" });
    const { rows } = buildPageListRows(
      defaults({
        completedCollapsed: false,
        completedPages: [page],
        visiblePages: [makePage({ id: "shared-id" })],
      })
    );
    const keys = rows.filter((r) => r.type === "page").map((r) => r.key);
    expect(keys).toContain("shared-id"); // active page
    expect(keys).toContain("c-shared-id"); // completed page
  });

  it("shows load-more only when there are completed pages AND more available", () => {
    const types = rowTypes(
      defaults({
        completedCollapsed: false,
        completedHasMore: true,
        completedPages: [makePage()],
      })
    );
    expect(types).toContain("load-more");
    expect(types).not.toContain("empty-completed");
  });

  it("does not show load-more when completedPages is empty even if hasMore is true", () => {
    const types = rowTypes(
      defaults({
        completedCollapsed: false,
        completedHasMore: true,
        completedPages: [],
      })
    );
    expect(types).not.toContain("load-more");
    // hasMore is true but pages empty — neither load-more nor empty-completed
    expect(types).not.toContain("empty-completed");
  });

  it("shows empty-completed only when no pages and no more available", () => {
    const types = rowTypes(
      defaults({
        completedCollapsed: false,
        completedHasMore: false,
        completedPages: [],
      })
    );
    expect(types).toContain("empty-completed");
    expect(types).not.toContain("load-more");
  });

  it("maps completed page IDs in pageToRowIndex", () => {
    const completed = [makePage({ id: "done1" })];
    const { pageToRowIndex } = buildPageListRows(
      defaults({ completedCollapsed: false, completedPages: completed })
    );
    expect(pageToRowIndex.has("done1")).toBe(true);
  });
});
