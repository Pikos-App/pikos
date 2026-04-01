import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Page } from "../types";
import { MockStorageAdapter } from "./MockStorageAdapter";

// ─── Setup ───────────────────────────────────────────────────────────────────

let adapter: MockStorageAdapter;

beforeEach(() => {
  adapter = new MockStorageAdapter();
});

/** Creates a page with sensible defaults and returns it. */
async function createTestPage(overrides: Partial<Page> = {}): Promise<Page> {
  return adapter.createPage({
    content: overrides.content ?? "",
    folderId: overrides.folderId ?? null,
    priority: overrides.priority ?? 0,
    status: overrides.status ?? "not_started",
    tags: overrides.tags ?? [],
    title: overrides.title ?? "Untitled",
  });
}

// ─── _refreshDenorm ──────────────────────────────────────────────────────────

describe("_refreshDenorm", () => {
  it("denormalises scheduledStart onto the page from the next future schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const page = await createTestPage({ title: "denorm test" });
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-20T10:00:00",
    });

    const updated = await adapter.getPage(page.id);
    expect(updated?.scheduledStart).toBe("2026-03-20T10:00:00");

    vi.useRealTimers();
  });

  it("picks the earliest future schedule when multiple exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const page = await createTestPage();
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-25T10:00:00",
    });
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-18T09:00:00",
    });

    const updated = await adapter.getPage(page.id);
    expect(updated?.scheduledStart).toBe("2026-03-18T09:00:00");

    vi.useRealTimers();
  });

  it("clears scheduledStart when no future schedules remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const page = await createTestPage();
    const schedule = await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-20T10:00:00",
    });

    await adapter.deletePageSchedule(schedule.id);
    const updated = await adapter.getPage(page.id);
    expect(updated?.scheduledStart).toBeUndefined();

    vi.useRealTimers();
  });

  it("copies scheduledEnd from the schedule to the page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const page = await createTestPage();
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledEnd: "2026-03-20T11:00:00",
      scheduledStart: "2026-03-20T10:00:00",
    });

    const updated = await adapter.getPage(page.id);
    expect(updated?.scheduledEnd).toBe("2026-03-20T11:00:00");

    vi.useRealTimers();
  });
});

// ─── listPagesToday ──────────────────────────────────────────────────────────

describe("listPagesToday", () => {
  it("returns pages with schedules <= today, excludes done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const todayPage = await createTestPage({ title: "today" });
    const futurePage = await createTestPage({ title: "future" });
    const donePage = await createTestPage({ status: "done", title: "done" });

    await adapter.createPageSchedule({
      pageId: todayPage.id,
      scheduledStart: "2026-03-15T10:00:00",
    });
    await adapter.createPageSchedule({
      pageId: futurePage.id,
      scheduledStart: "2026-03-20T10:00:00",
    });
    await adapter.createPageSchedule({
      pageId: donePage.id,
      scheduledStart: "2026-03-15T09:00:00",
    });

    const results = await adapter.listPagesToday();
    const titles = results.map((p) => p.title);
    expect(titles).toContain("today");
    expect(titles).not.toContain("future");
    expect(titles).not.toContain("done");

    vi.useRealTimers();
  });

  it("includes overdue pages from the past", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const overdue = await createTestPage({ title: "overdue" });
    await adapter.createPageSchedule({
      pageId: overdue.id,
      scheduledStart: "2026-03-10T10:00:00",
    });

    const results = await adapter.listPagesToday();
    expect(results.map((p) => p.title)).toContain("overdue");

    vi.useRealTimers();
  });

  it("excludes soft-deleted pages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const page = await createTestPage({ title: "soft-deleted" });
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-15T10:00:00",
    });
    await adapter.softDeletePage(page.id);

    const results = await adapter.listPagesToday();
    expect(results.map((p) => p.title)).not.toContain("soft-deleted");

    vi.useRealTimers();
  });
});

// ─── listPageSchedulesRange ──────────────────────────────────────────────────

describe("listPageSchedulesRange", () => {
  it("returns schedules within the date range", async () => {
    const page = await createTestPage();
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-15T10:00:00",
    });
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-20T10:00:00",
    });
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-04-01T10:00:00",
    });

    const results = await adapter.listPageSchedulesRange("2026-03-14", "2026-03-21");
    expect(results).toHaveLength(2);
  });

  it("excludes schedules outside the range", async () => {
    const page = await createTestPage();
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-04-01T10:00:00",
    });

    const results = await adapter.listPageSchedulesRange("2026-03-01", "2026-03-31");
    expect(results).toHaveLength(0);
  });

  it("includes multi-day events that overlap the range boundary", async () => {
    const page = await createTestPage();
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledEnd: "2026-03-17T12:00:00",
      scheduledStart: "2026-03-13T10:00:00",
    });

    // Range starts after scheduledStart but before scheduledEnd
    const results = await adapter.listPageSchedulesRange("2026-03-15", "2026-03-20");
    expect(results).toHaveLength(1);
  });
});

// ─── searchPages ─────────────────────────────────────────────────────────────

describe("searchPages", () => {
  it("returns empty results for empty query", async () => {
    await createTestPage({ title: "something" });
    const { results } = await adapter.searchPages("");
    expect(results).toHaveLength(0);
  });

  it("matches by title", async () => {
    await createTestPage({ title: "meeting notes" });
    await createTestPage({ title: "grocery list" });

    const { results } = await adapter.searchPages("meeting");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("meeting notes");
    expect(results[0]!.matchSource).toBe("title");
  });

  it("matches by content", async () => {
    await createTestPage({ content: "discuss the budget proposal", title: "notes" });

    const { results } = await adapter.searchPages("budget");
    expect(results).toHaveLength(1);
    expect(results[0]!.matchSource).toBe("content");
  });

  it("title matches rank above content matches", async () => {
    await createTestPage({ content: "review the design", title: "other" });
    await createTestPage({ title: "design doc" });

    const { results } = await adapter.searchPages("design");
    expect(results[0]!.title).toBe("design doc");
    expect(results[0]!.matchSource).toBe("title");
  });

  it("generates excerpt around content match", async () => {
    const longContent = "prefix ".repeat(20) + "findme" + " suffix".repeat(20);
    await createTestPage({ content: longContent, title: "other" });

    const { results } = await adapter.searchPages("findme");
    expect(results[0]!.excerpt).toContain("findme");
  });

  it("excludes completed pages by default, counts them", async () => {
    await createTestPage({ status: "done", title: "done task" });
    await createTestPage({ title: "active task" });

    const { completedCount, results } = await adapter.searchPages("task");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("active task");
    expect(completedCount).toBe(1);
  });

  it("includes completed pages when includeCompleted is true", async () => {
    await createTestPage({ status: "done", title: "done task" });

    const { results } = await adapter.searchPages("task", true);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("done task");
  });

  it("excludes soft-deleted pages", async () => {
    const page = await createTestPage({ title: "deleted task" });
    await adapter.softDeletePage(page.id);

    const { results } = await adapter.searchPages("deleted");
    expect(results).toHaveLength(0);
  });
});

// ─── matchesFilter (tested via listPages) ────────────────────────────────────

describe("matchesFilter (via listPages)", () => {
  it("filters by folderId", async () => {
    await createTestPage({ folderId: "f1", title: "in folder" });
    await createTestPage({ folderId: null, title: "inbox" });

    const results = await adapter.listPages({ folderId: "f1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("in folder");
  });

  it("filters by folderId: null (inbox)", async () => {
    await createTestPage({ folderId: "f1", title: "in folder" });
    await createTestPage({ folderId: null, title: "inbox" });

    const results = await adapter.listPages({ folderId: null });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("inbox");
  });

  it("filters by status", async () => {
    await createTestPage({ status: "done", title: "done" });
    await createTestPage({ status: "not_started", title: "active" });

    const results = await adapter.listPages({ status: "done" });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("done");
  });

  it("filters by priority", async () => {
    await createTestPage({ priority: 1, title: "urgent" });
    await createTestPage({ priority: 3, title: "medium" });

    const results = await adapter.listPages({ priority: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("urgent");
  });

  it("filters by tags (all must match)", async () => {
    await createTestPage({ tags: ["work", "design"], title: "both" });
    await createTestPage({ tags: ["work"], title: "only work" });

    const results = await adapter.listPages({ tags: ["work", "design"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("both");
  });

  it("filters by query (title + content search)", async () => {
    await createTestPage({ content: "lorem ipsum", title: "notes" });
    await createTestPage({ title: "unrelated" });

    const results = await adapter.listPages({ query: "ipsum" });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("notes");
  });

  it("compound filter: folderId + status + tags", async () => {
    await createTestPage({
      folderId: "f1",
      status: "not_started",
      tags: ["work"],
      title: "match",
    });
    await createTestPage({
      folderId: "f1",
      status: "done",
      tags: ["work"],
      title: "done",
    });
    await createTestPage({
      folderId: "f2",
      status: "not_started",
      tags: ["work"],
      title: "wrong folder",
    });

    const results = await adapter.listPages({
      folderId: "f1",
      status: "not_started",
      tags: ["work"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("match");
  });

  it("excludes soft-deleted pages from listPages", async () => {
    const page = await createTestPage({ title: "trashed" });
    await adapter.softDeletePage(page.id);

    const results = await adapter.listPages();
    expect(results.map((p) => p.title)).not.toContain("trashed");
  });
});

// ─── searchTags ──────────────────────────────────────────────────────────────

describe("searchTags", () => {
  it("returns tags matching the prefix", async () => {
    await createTestPage({ tags: ["work", "workout", "personal"] });

    const results = await adapter.searchTags("wor");
    expect(results).toEqual(["work", "workout"]);
  });

  it("returns deduplicated tags across pages", async () => {
    await createTestPage({ tags: ["design"] });
    await createTestPage({ tags: ["design", "ux"] });

    const results = await adapter.searchTags("des");
    expect(results).toEqual(["design"]);
  });

  it("limits to 20 results", async () => {
    const tags = Array.from({ length: 25 }, (_, i) => `tag${String(i).padStart(2, "0")}`);
    await createTestPage({ tags });

    const results = await adapter.searchTags("tag");
    expect(results).toHaveLength(20);
  });
});

// ─── listCompletedPages ─────────────────────────────────────────────────────

describe("listCompletedPages", () => {
  it("returns only completed pages, sorted by completedAt descending", async () => {
    await createTestPage({ title: "Active" });
    const done1 = await createTestPage({ status: "done", title: "Done 1" });
    await adapter.updatePage(done1.id, { completedAt: "2026-03-01T10:00:00" });
    const done2 = await createTestPage({ status: "done", title: "Done 2" });
    await adapter.updatePage(done2.id, { completedAt: "2026-03-02T10:00:00" });

    const result = await adapter.listCompletedPages({ limit: 20, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.pages.map((p) => p.title)).toEqual(["Done 2", "Done 1"]);
  });

  it("paginates with limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await createTestPage({ status: "done", title: `Done ${i}` });
      await adapter.updatePage(p.id, { completedAt: `2026-03-0${i + 1}T10:00:00` });
    }

    const page1 = await adapter.listCompletedPages({ limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.pages).toHaveLength(2);
    expect(page1.pages[0]!.title).toBe("Done 4"); // most recent first

    const page2 = await adapter.listCompletedPages({ limit: 2, offset: 2 });
    expect(page2.total).toBe(5);
    expect(page2.pages).toHaveLength(2);
    expect(page2.pages[0]!.title).toBe("Done 2");
  });

  it("filters by folderId", async () => {
    const folder = await adapter.createFolder({ name: "Work", parentId: null });
    const inFolder = await createTestPage({
      folderId: folder.id,
      status: "done",
      title: "In folder",
    });
    await adapter.updatePage(inFolder.id, { completedAt: "2026-03-01T10:00:00" });
    const inInbox = await createTestPage({ folderId: null, status: "done", title: "In inbox" });
    await adapter.updatePage(inInbox.id, { completedAt: "2026-03-01T10:00:00" });

    const folderResult = await adapter.listCompletedPages({
      folderId: folder.id,
      limit: 20,
      offset: 0,
    });
    expect(folderResult.pages.map((p) => p.title)).toEqual(["In folder"]);

    const inboxResult = await adapter.listCompletedPages({ folderId: null, limit: 20, offset: 0 });
    expect(inboxResult.pages.map((p) => p.title)).toEqual(["In inbox"]);
  });

  it("filters by completedSince", async () => {
    const old = await createTestPage({ status: "done", title: "Old" });
    await adapter.updatePage(old.id, { completedAt: "2026-02-15T10:00:00" });
    const recent = await createTestPage({ status: "done", title: "Recent" });
    await adapter.updatePage(recent.id, { completedAt: "2026-03-27T10:00:00" });

    const result = await adapter.listCompletedPages({
      completedSince: "2026-03-27",
      limit: 20,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.pages[0]!.title).toBe("Recent");
  });

  it("excludes soft-deleted pages", async () => {
    const done = await createTestPage({ status: "done", title: "Deleted done" });
    await adapter.updatePage(done.id, { completedAt: "2026-03-01T10:00:00" });
    await adapter.softDeletePage(done.id);

    const result = await adapter.listCompletedPages({ limit: 20, offset: 0 });
    expect(result.total).toBe(0);
    expect(result.pages).toHaveLength(0);
  });
});

// ─── softDelete / restore ────────────────────────────────────────────────────

describe("softDelete / restore", () => {
  it("soft-deleted page is hidden from listPages, restored page reappears", async () => {
    const page = await createTestPage({ title: "recoverable" });
    await adapter.softDeletePage(page.id);

    let results = await adapter.listPages();
    expect(results.map((p) => p.title)).not.toContain("recoverable");

    await adapter.restorePage(page.id);
    results = await adapter.listPages();
    expect(results.map((p) => p.title)).toContain("recoverable");
  });
});
