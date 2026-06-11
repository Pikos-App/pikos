import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Page, PageSummary } from "../types";
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
    ...(overrides.contentText !== undefined && { contentText: overrides.contentText }),
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

  it("falls back to the earliest past schedule when no future schedule exists", async () => {
    // Regression: previously the mock stripped denorm to null when only past
    // schedules existed. That caused just-created past-date multi-day events
    // to appear momentarily and then "revert" — the debounced updatePage
    // write re-read the adapter's stripped record and overwrote React's
    // optimistic state. Rust adapter (schedules.rs:refresh_schedule_denorm)
    // falls back to the earliest past — this mock must match.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0));

    const page = await createTestPage();
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledEnd: "2026-03-12",
      scheduledStart: "2026-03-10",
    });

    const updated = await adapter.getPage(page.id);
    expect(updated?.scheduledStart).toBe("2026-03-10");
    expect(updated?.scheduledEnd).toBe("2026-03-12");

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
    await createTestPage({ contentText: "discuss the budget proposal", title: "notes" });

    const { results } = await adapter.searchPages("budget");
    expect(results).toHaveLength(1);
    expect(results[0]!.matchSource).toBe("content");
  });

  it("title matches rank above content matches", async () => {
    await createTestPage({ contentText: "review the design", title: "other" });
    await createTestPage({ title: "design doc" });

    const { results } = await adapter.searchPages("design");
    expect(results[0]!.title).toBe("design doc");
    expect(results[0]!.matchSource).toBe("title");
  });

  it("generates excerpt around content match", async () => {
    const longContent = "prefix ".repeat(20) + "findme" + " suffix".repeat(20);
    await createTestPage({ contentText: longContent, title: "other" });

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

  it("hasSchedule=true returns only pages with a scheduledStart", async () => {
    const scheduled = await createTestPage({ title: "scheduled" });
    await adapter.createPageSchedule({ pageId: scheduled.id, scheduledStart: "2026-03-15" });
    await createTestPage({ title: "no schedule" });

    const results = await adapter.listPages({ hasSchedule: true });
    expect(results.map((r) => r.title)).toEqual(["scheduled"]);
  });

  it("compound: status=done + hasSchedule=true returns completed scheduled pages only", async () => {
    // This is the calendar's use case — pulls done items that occupy a
    // time slot without also loading every unscheduled completed page.
    const doneSched = await createTestPage({ status: "done", title: "done+sched" });
    await adapter.createPageSchedule({ pageId: doneSched.id, scheduledStart: "2026-03-15" });
    await createTestPage({ status: "done", title: "done no sched" });
    const activeSched = await createTestPage({ status: "not_started", title: "active+sched" });
    await adapter.createPageSchedule({ pageId: activeSched.id, scheduledStart: "2026-03-15" });

    const results = await adapter.listPages({ hasSchedule: true, status: "done" });
    expect(results.map((r) => r.title)).toEqual(["done+sched"]);
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

// ─── completeRecurringPage ───────────────────────────────────────────────────

describe("completeRecurringPage", () => {
  it("clones head as done, advances head to next occurrence", async () => {
    const head = await createTestPage({
      content: '{"type":"doc","content":[]}',
      folderId: null,
      priority: 2,
      tags: ["work"],
      title: "Standup",
    });

    // Manually set scheduledStart on head (simulating what QuickAddDialog does)
    await adapter.updatePage(head.id, { scheduledStart: "2026-03-16T09:00:00" });

    await adapter.createRecurrenceRule({
      pageId: head.id,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      scheduledStart: "2026-03-16T09:00:00",
      timezone: "America/New_York",
    });

    const result = await adapter.completeRecurringPage({
      nextScheduledEnd: null,
      nextScheduledStart: "2026-03-23T09:00:00",
      pageId: head.id,
    });

    // Clone should be done with the completed occurrence date
    expect(result.clone.status).toBe("done");
    expect(result.clone.scheduledStart).toBe("2026-03-16T09:00:00");
    expect(result.clone.title).toBe("Standup");
    expect(result.clone.priority).toBe(2);
    expect(result.clone.tags).toEqual(["work"]);
    expect(result.clone.completedAt).toBeDefined();
    expect(result.clone.id).not.toBe(head.id);

    // Head should be advanced
    expect(result.head.id).toBe(head.id);
    expect(result.head.status).toBe("not_started");
    expect(result.head.scheduledStart).toBe("2026-03-23T09:00:00");
    expect(result.head.title).toBe("Standup");
  });

  it("marks head as done when no next occurrence (series finished)", async () => {
    const head = await createTestPage({ title: "Limited series" });
    await adapter.updatePage(head.id, { scheduledStart: "2026-03-16T09:00:00" });

    const result = await adapter.completeRecurringPage({
      nextScheduledEnd: null,
      nextScheduledStart: null, // no next occurrence
      pageId: head.id,
    });

    expect(result.head.status).toBe("done");
    expect(result.head.completedAt).toBeDefined();
  });

  it("preserves content in the clone", async () => {
    const content =
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Meeting notes"}]}]}';
    const head = await createTestPage({ content, title: "Weekly sync" });

    const result = await adapter.completeRecurringPage({
      nextScheduledEnd: null,
      nextScheduledStart: "2026-03-23",
      pageId: head.id,
    });

    // Clone should have the content snapshot
    const cloneFull = await adapter.getPage(result.clone.id);
    expect(cloneFull?.content).toBe(content);
  });

  it("head keeps stable ID across multiple completions", async () => {
    const head = await createTestPage({ title: "Recurring" });
    await adapter.updatePage(head.id, { scheduledStart: "2026-03-16" });
    const originalId = head.id;

    // Complete 3 times
    await adapter.completeRecurringPage({
      nextScheduledEnd: null,
      nextScheduledStart: "2026-03-23",
      pageId: originalId,
    });
    await adapter.completeRecurringPage({
      nextScheduledEnd: null,
      nextScheduledStart: "2026-03-30",
      pageId: originalId,
    });
    const result3 = await adapter.completeRecurringPage({
      nextScheduledEnd: null,
      nextScheduledStart: "2026-04-06",
      pageId: originalId,
    });

    // Head ID unchanged
    expect(result3.head.id).toBe(originalId);
    expect(result3.head.scheduledStart).toBe("2026-04-06");

    // 3 clones created (all done)
    const allPages = await adapter.listPages();
    const donePages = allPages.filter((p) => p.status === "done" && p.title === "Recurring");
    expect(donePages).toHaveLength(3);
  });

  it("throws when page not found", () => {
    expect(() =>
      adapter.completeRecurringPage({
        nextScheduledEnd: null,
        nextScheduledStart: "2026-03-23",
        pageId: "nonexistent",
      })
    ).toThrow("Page not found");
  });
});

// ─── skipOccurrence (exdates) ────────────────────────────────────────────────

describe("recurrence exdates (skip occurrence)", () => {
  // First test in this block cold-loads the rrule library via dynamic import,
  // which can exceed 5s on slow CI runners.
  it("adding a date to exdates excludes it from expansion", { timeout: 15_000 }, async () => {
    const { expandRecurrenceForRange } = await import("../utils/recurrence");

    const head = await createTestPage({ title: "Weekly" });
    const rule = await adapter.createRecurrenceRule({
      pageId: head.id,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      scheduledEnd: "2026-03-02T10:00:00",
      scheduledStart: "2026-03-02T09:00:00",
      timezone: "America/New_York",
    });

    // Expand 3 weeks: should get 3 occurrences
    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 23);
    const { content: _c, contentText: _ct, ...pageSummary } = head;
    const page: PageSummary = pageSummary;

    let occs = expandRecurrenceForRange(rule, page, rangeStart, rangeEnd);
    expect(occs).toHaveLength(3);

    // Skip March 9
    const updated = await adapter.updateRecurrenceRule(rule.id, {
      rruleExdates: ["2026-03-09"],
    });

    occs = expandRecurrenceForRange(updated, page, rangeStart, rangeEnd);
    expect(occs).toHaveLength(2);
    expect(occs.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-16"]);
  });

  it("removing a date from exdates restores it (undo)", { timeout: 15_000 }, async () => {
    const { expandRecurrenceForRange } = await import("../utils/recurrence");

    const head = await createTestPage({ title: "Weekly" });
    const rule = await adapter.createRecurrenceRule({
      pageId: head.id,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      scheduledEnd: "2026-03-02T10:00:00",
      scheduledStart: "2026-03-02T09:00:00",
      timezone: "America/New_York",
    });

    const { content: _c, contentText: _ct, ...pageSummary } = head;
    const page: PageSummary = pageSummary;
    const rangeStart = new Date(2026, 2, 2);
    const rangeEnd = new Date(2026, 2, 23);

    // Skip then undo
    await adapter.updateRecurrenceRule(rule.id, { rruleExdates: ["2026-03-09"] });
    const restored = await adapter.updateRecurrenceRule(rule.id, { rruleExdates: [] });

    const occs = expandRecurrenceForRange(restored, page, rangeStart, rangeEnd);
    expect(occs).toHaveLength(3);
  });
});

// ─── Page reminders ─────────────────────────────────────────────────────────

describe("page reminders", () => {
  it("creates and lists reminders sorted by minutesBefore", async () => {
    const page = await createTestPage({ title: "reminder test" });

    const r30 = await adapter.createPageReminder({ minutesBefore: 30, pageId: page.id });
    const r5 = await adapter.createPageReminder({ minutesBefore: 5, pageId: page.id });
    const r10 = await adapter.createPageReminder({ minutesBefore: 10, pageId: page.id });

    expect(r30.minutesBefore).toBe(30);
    expect(r5.minutesBefore).toBe(5);
    expect(r10.minutesBefore).toBe(10);

    const list = await adapter.listPageReminders(page.id);
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.minutesBefore)).toEqual([5, 10, 30]);
  });

  it("returns empty list for page with no reminders", async () => {
    const page = await createTestPage({ title: "no reminders" });
    const list = await adapter.listPageReminders(page.id);
    expect(list).toHaveLength(0);
  });

  it("deletes a single reminder by ID", async () => {
    const page = await createTestPage({ title: "delete one" });
    const r1 = await adapter.createPageReminder({ minutesBefore: 10, pageId: page.id });
    await adapter.createPageReminder({ minutesBefore: 30, pageId: page.id });

    await adapter.deletePageReminder(r1.id);

    const list = await adapter.listPageReminders(page.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.minutesBefore).toBe(30);
  });

  it("deletePageReminders removes all reminders for a page", async () => {
    const page = await createTestPage({ title: "delete all" });
    await adapter.createPageReminder({ minutesBefore: 5, pageId: page.id });
    await adapter.createPageReminder({ minutesBefore: 10, pageId: page.id });
    await adapter.createPageReminder({ minutesBefore: 30, pageId: page.id });

    await adapter.deletePageReminders(page.id);

    const list = await adapter.listPageReminders(page.id);
    expect(list).toHaveLength(0);
  });

  it("reminders are scoped to their page", async () => {
    const p1 = await createTestPage({ title: "page1" });
    const p2 = await createTestPage({ title: "page2" });

    await adapter.createPageReminder({ minutesBefore: 10, pageId: p1.id });
    await adapter.createPageReminder({ minutesBefore: 30, pageId: p2.id });

    const list1 = await adapter.listPageReminders(p1.id);
    const list2 = await adapter.listPageReminders(p2.id);

    expect(list1).toHaveLength(1);
    expect(list1[0]?.minutesBefore).toBe(10);
    expect(list2).toHaveLength(1);
    expect(list2[0]?.minutesBefore).toBe(30);
  });

  it("deletePageReminders for one page does not affect another", async () => {
    const p1 = await createTestPage({ title: "page1" });
    const p2 = await createTestPage({ title: "page2" });

    await adapter.createPageReminder({ minutesBefore: 10, pageId: p1.id });
    await adapter.createPageReminder({ minutesBefore: 15, pageId: p2.id });

    await adapter.deletePageReminders(p1.id);

    expect(await adapter.listPageReminders(p1.id)).toHaveLength(0);
    expect(await adapter.listPageReminders(p2.id)).toHaveLength(1);
  });

  it("created reminder has id, pageId, minutesBefore, and createdAt", async () => {
    const page = await createTestPage({ title: "fields test" });
    const r = await adapter.createPageReminder({ minutesBefore: 15, pageId: page.id });

    expect(r.id).toBeTruthy();
    expect(r.pageId).toBe(page.id);
    expect(r.minutesBefore).toBe(15);
    expect(r.createdAt).toBeTruthy();
  });

  it("supports minutesBefore = 0 (at time of event)", async () => {
    const page = await createTestPage({ title: "at-start" });
    const r = await adapter.createPageReminder({ minutesBefore: 0, pageId: page.id });

    expect(r.minutesBefore).toBe(0);
    const list = await adapter.listPageReminders(page.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.minutesBefore).toBe(0);
  });

  it("supports minutesBefore = -1 (none sentinel)", async () => {
    const page = await createTestPage({ title: "no-reminders" });
    const sentinel = await adapter.createPageReminder({ minutesBefore: -1, pageId: page.id });

    expect(sentinel.minutesBefore).toBe(-1);
    const list = await adapter.listPageReminders(page.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.minutesBefore).toBe(-1);
  });

  it("replacing none sentinel with real reminders", async () => {
    const page = await createTestPage({ title: "none-then-add" });

    // Set "None"
    await adapter.createPageReminder({ minutesBefore: -1, pageId: page.id });
    expect(await adapter.listPageReminders(page.id)).toHaveLength(1);

    // Switch to a real reminder — clear all then add
    await adapter.deletePageReminders(page.id);
    await adapter.createPageReminder({ minutesBefore: 10, pageId: page.id });

    const list = await adapter.listPageReminders(page.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.minutesBefore).toBe(10);
  });
});

// ─── SQLite parity guarantees ────────────────────────────────────────────────
// These tests pin behaviour the Rust adapter enforces via SQL — UNIQUE
// constraints, FTS surface, soft-delete cascade. Drift here causes mock-only
// passes that break in prod.

describe("parity: searchPages indexes contentText, not raw Tiptap JSON", () => {
  it("does not match structural tokens inside the content JSON", async () => {
    await createTestPage({
      content: JSON.stringify({
        content: [{ content: [{ text: "hello world", type: "text" }], type: "paragraph" }],
        type: "doc",
      }),
      title: "Untitled",
    });
    // Rust FTS would never match "paragraph" — that token lives in the structural
    // schema, not the indexed contentText.
    const { results } = await adapter.searchPages("paragraph");
    expect(results).toHaveLength(0);
  });

  it("matches body text extracted from the content JSON", async () => {
    await createTestPage({
      content: JSON.stringify({
        content: [{ content: [{ text: "the quick brown fox", type: "text" }], type: "paragraph" }],
        type: "doc",
      }),
      title: "Untitled",
    });
    const { results } = await adapter.searchPages("brown");
    expect(results).toHaveLength(1);
    expect(results[0]?.matchSource).toBe("content");
  });

  it("respects caller-provided contentText (no auto-overwrite)", async () => {
    const page = await adapter.createPage({
      content: '{"type":"doc","content":[]}',
      contentText: "explicit override",
      folderId: null,
      priority: 0,
      status: "not_started",
      tags: [],
      title: "Untitled",
    });
    expect(page.contentText).toBe("explicit override");
  });
});

describe("parity: createRecurrenceRule enforces UNIQUE(page_id)", () => {
  it("rejects a second rule for the same page", async () => {
    const page = await createTestPage({ title: "Daily standup" });
    await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    await expect(
      adapter.createRecurrenceRule({
        pageId: page.id,
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2026-01-01T09:00:00",
        timezone: "America/Los_Angeles",
      })
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("allows distinct pages to each have their own rule", async () => {
    const a = await createTestPage({ title: "A" });
    const b = await createTestPage({ title: "B" });
    await adapter.createRecurrenceRule({
      pageId: a.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });
    await expect(
      adapter.createRecurrenceRule({
        pageId: b.id,
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-01-01T09:00:00",
        timezone: "America/Los_Angeles",
      })
    ).resolves.toBeDefined();
  });
});

describe("parity: soft-delete cascades to schedules and rules", () => {
  it("listPageSchedulesRange excludes schedules of soft-deleted pages", async () => {
    const page = await createTestPage({ title: "Hidden" });
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledStart: "2026-03-15T10:00:00",
    });

    const before = await adapter.listPageSchedulesRange("2026-03-01", "2026-03-31");
    expect(before).toHaveLength(1);

    await adapter.softDeletePage(page.id);
    const after = await adapter.listPageSchedulesRange("2026-03-01", "2026-03-31");
    expect(after).toHaveLength(0);
  });

  it("listRecurrenceRules excludes rules whose page is soft-deleted", async () => {
    const page = await createTestPage({ title: "Recurring" });
    await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    expect(await adapter.listRecurrenceRules()).toHaveLength(1);
    await adapter.softDeletePage(page.id);
    expect(await adapter.listRecurrenceRules()).toHaveLength(0);
  });

  it("restorePage reinstates the cascade", async () => {
    const page = await createTestPage({ title: "Bouncy" });
    await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    await adapter.softDeletePage(page.id);
    expect(await adapter.listRecurrenceRules()).toHaveLength(0);
    await adapter.restorePage(page.id);
    expect(await adapter.listRecurrenceRules()).toHaveLength(1);
  });
});

// ─── Page CRUD ─────────────────────────────────────────────────────────────

describe("page CRUD", () => {
  it("clear() empties every store", async () => {
    const page = await createTestPage({ title: "A" });
    await adapter.createFolder({ name: "F", parentId: null });
    await adapter.createPageSchedule({ pageId: page.id, scheduledStart: "2026-03-15" });
    await adapter.createPageReminder({ minutesBefore: 10, pageId: page.id });

    adapter.clear();

    expect(await adapter.listPages()).toHaveLength(0);
    expect(await adapter.listFolders()).toHaveLength(0);
    expect(await adapter.listPageSchedules(page.id)).toHaveLength(0);
    expect(await adapter.listPageReminders(page.id)).toHaveLength(0);
  });

  it("deletePage hard-removes the page", async () => {
    const page = await createTestPage();
    await adapter.deletePage(page.id);
    expect(await adapter.getPage(page.id)).toBeNull();
  });

  it("updatePage rejects when the page does not exist", async () => {
    await expect(adapter.updatePage("missing", { title: "x" })).rejects.toThrow(
      "Page not found: missing"
    );
  });

  it("updatePage re-derives contentText from content unless the caller sets it", async () => {
    const page = await createTestPage();
    const content = JSON.stringify({
      content: [{ content: [{ text: "hello world", type: "text" }], type: "paragraph" }],
      type: "doc",
    });
    const updated = await adapter.updatePage(page.id, { content });
    expect(updated.contentText).toBe("hello world");
  });

  it("reorderPages assigns sortOrder by position", async () => {
    const a = await createTestPage({ title: "A" });
    const b = await createTestPage({ title: "B" });
    await adapter.reorderPages(null, [b.id, a.id]);
    const titles = (await adapter.listPages()).map((p) => p.title);
    expect(titles).toEqual(["B", "A"]);
  });

  it("setPagesStatus updates matching pages and skips missing/soft-deleted ones", async () => {
    const a = await createTestPage({ title: "A" });
    const b = await createTestPage({ title: "B" });
    await adapter.softDeletePage(b.id);

    const result = await adapter.setPagesStatus(
      [a.id, b.id, "missing"],
      "done",
      "2026-03-15T10:00:00"
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(a.id);
    expect((await adapter.getPage(a.id))?.status).toBe("done");
  });
});

// ─── Filter: schedule-window bounds ────────────────────────────────────────

describe("matchesFilter schedule bounds (via listPages)", () => {
  it("scheduledAfter excludes pages scheduled before the bound", async () => {
    const early = await createTestPage({ title: "early" });
    const late = await createTestPage({ title: "late" });
    await adapter.createPageSchedule({ pageId: early.id, scheduledStart: "2026-03-01" });
    await adapter.createPageSchedule({ pageId: late.id, scheduledStart: "2026-03-20" });

    const results = await adapter.listPages({ scheduledAfter: "2026-03-10" });
    expect(results.map((p) => p.title)).toEqual(["late"]);
  });

  it("scheduledBefore excludes pages scheduled after the bound", async () => {
    const early = await createTestPage({ title: "early" });
    const late = await createTestPage({ title: "late" });
    await adapter.createPageSchedule({ pageId: early.id, scheduledStart: "2026-03-01" });
    await adapter.createPageSchedule({ pageId: late.id, scheduledStart: "2026-03-20" });

    const results = await adapter.listPages({ scheduledBefore: "2026-03-10" });
    expect(results.map((p) => p.title)).toEqual(["early"]);
  });
});

// ─── Folder CRUD ───────────────────────────────────────────────────────────

describe("folder CRUD", () => {
  it("getFolder returns the folder or null", async () => {
    const folder = await adapter.createFolder({ name: "F", parentId: null });
    expect((await adapter.getFolder(folder.id))?.name).toBe("F");
    expect(await adapter.getFolder("missing")).toBeNull();
  });

  it("updateFolder renames and rejects when missing", async () => {
    const folder = await adapter.createFolder({ name: "F", parentId: null });
    const updated = await adapter.updateFolder(folder.id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    await expect(adapter.updateFolder("missing", { name: "x" })).rejects.toThrow(
      "Folder not found: missing"
    );
  });

  it("deleteFolder removes the folder and soft-deletes its pages", async () => {
    const folder = await adapter.createFolder({ name: "F", parentId: null });
    const page = await createTestPage({ folderId: folder.id });
    await adapter.deleteFolder(folder.id);

    expect(await adapter.getFolder(folder.id)).toBeNull();
    expect((await adapter.listPages()).map((p) => p.id)).not.toContain(page.id);
  });

  it("reorderFolders assigns sortOrder by position", async () => {
    const a = await adapter.createFolder({ name: "A", parentId: null });
    const b = await adapter.createFolder({ name: "B", parentId: null });
    await adapter.reorderFolders([b.id, a.id]);
    expect((await adapter.listFolders()).map((f) => f.name)).toEqual(["B", "A"]);
  });
});

// ─── Schedule + rule updates ───────────────────────────────────────────────

describe("schedule and rule updates", () => {
  it("updatePageSchedule changes start, clears end on null, and rejects when missing", async () => {
    const page = await createTestPage();
    const schedule = await adapter.createPageSchedule({
      pageId: page.id,
      scheduledEnd: "2026-03-15T11:00:00",
      scheduledStart: "2026-03-15T10:00:00",
    });

    const moved = await adapter.updatePageSchedule(schedule.id, {
      scheduledStart: "2026-03-16T10:00:00",
    });
    expect(moved.scheduledStart).toBe("2026-03-16T10:00:00");

    const cleared = await adapter.updatePageSchedule(schedule.id, { scheduledEnd: null });
    expect(cleared.scheduledEnd).toBeUndefined();

    await expect(adapter.updatePageSchedule("missing", {})).rejects.toThrow(
      "Schedule not found: missing"
    );
  });

  it("updateRecurrenceRule edits fields and rejects when missing", async () => {
    const page = await createTestPage();
    const rule = await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    const updated = await adapter.updateRecurrenceRule(rule.id, { rrule: "FREQ=WEEKLY" });
    expect(updated.rrule).toBe("FREQ=WEEKLY");

    await expect(adapter.updateRecurrenceRule("missing", {})).rejects.toThrow(
      "Recurrence rule not found: missing"
    );
  });

  it("getRecurrenceRule and deleteRecurrenceRule round-trip by page", async () => {
    const page = await createTestPage();
    const rule = await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    expect((await adapter.getRecurrenceRule(page.id))?.id).toBe(rule.id);
    await adapter.deleteRecurrenceRule(rule.id);
    expect(await adapter.getRecurrenceRule(page.id)).toBeNull();
  });

  it("completeRecurringPage merges added exdates into the rule's current row", async () => {
    const page = await createTestPage();
    const rule = await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    // An exdate written after the caller computed its completion input (e.g.
    // an interleaved skip) must survive the completion's merge.
    await adapter.addRuleExdates(rule.id, ["2026-01-05"]);

    const result = await adapter.completeRecurringPage({
      addExdates: ["2026-01-01"],
      nextScheduledEnd: null,
      nextScheduledStart: "2026-01-02T09:00:00",
      pageId: page.id,
      ruleId: rule.id,
    });

    expect(result.ruleExdates).toEqual(["2026-01-05", "2026-01-01"]);
    expect((await adapter.getRecurrenceRule(page.id))?.rruleExdates).toEqual([
      "2026-01-05",
      "2026-01-01",
    ]);
  });

  it("addRuleExdates dedups and removeRuleExdate removes only its date", async () => {
    const page = await createTestPage();
    const rule = await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    await adapter.addRuleExdates(rule.id, ["2026-01-02", "2026-01-02"]);
    await adapter.addRuleExdates(rule.id, ["2026-01-03"]);
    const removed = await adapter.removeRuleExdate(rule.id, "2026-01-02");
    expect(removed.rruleExdates).toEqual(["2026-01-03"]);
  });

  it("rescheduleVirtualOccurrence clones the head, schedules it, and exdates the original date", async () => {
    const page = await createTestPage();
    const rule = await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-01-01T09:00:00",
      timezone: "America/Los_Angeles",
    });

    const result = await adapter.rescheduleVirtualOccurrence({
      originalDate: "2026-01-03",
      ruleId: rule.id,
      scheduledEnd: "2026-01-04T15:00:00",
      scheduledStart: "2026-01-04T14:00:00",
      timezone: "America/Los_Angeles",
    });

    expect(result.clone.status).toBe("not_started");
    expect(result.clone.scheduledStart).toBe("2026-01-04T14:00:00");
    expect(result.ruleExdates).toEqual(["2026-01-03"]);
    const schedules = await adapter.listPageSchedules(result.clone.id);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.scheduledStart).toBe("2026-01-04T14:00:00");

    await expect(
      adapter.rescheduleVirtualOccurrence({
        originalDate: "2026-01-03",
        ruleId: "missing",
        scheduledStart: "2026-01-04T14:00:00",
        timezone: "America/Los_Angeles",
      })
    ).rejects.toThrow("Recurrence rule not found: missing");
  });
});
