import type { PageSummary } from "@pikos/core";
import { describe, expect, it, vi } from "vitest";

import {
  getCompletedTodayPages,
  getCompletedViewPages,
  getVisiblePages,
  groupTodayPages,
  sortPages,
} from "./pageFilters";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── sortPages ───────────────────────────────────────────────────────────────

describe("sortPages", () => {
  it("manual mode — sorted by sortOrder ascending", () => {
    const pages = [
      makePage({ sortOrder: 3, title: "C" }),
      makePage({ sortOrder: 1, title: "A" }),
      makePage({ sortOrder: 2, title: "B" }),
    ];
    const sorted = sortPages(pages, "manual");
    expect(sorted.map((p) => p.title)).toEqual(["A", "B", "C"]);
  });

  it("date mode — scheduled first, unscheduled sink to bottom", () => {
    const pages = [
      makePage({ scheduledStart: null, title: "No date" }),
      makePage({ scheduledStart: "2026-03-15T10:00:00", title: "Has date" }),
    ];
    const sorted = sortPages(pages, "date");
    expect(sorted.map((p) => p.title)).toEqual(["Has date", "No date"]);
  });

  it("date mode — all-day today sorts at 'now'", () => {
    const today = "2026-03-27";
    vi.useFakeTimers();
    // Set "now" to 2026-03-27T12:00:00 local
    vi.setSystemTime(new Date(2026, 2, 27, 12, 0, 0));

    const pages = [
      makePage({ scheduledStart: "2026-03-27T08:00:00", title: "Overdue timed" }),
      makePage({ scheduledStart: today, title: "All-day today" }),
      makePage({ scheduledStart: "2026-03-27T15:00:00", title: "Future timed" }),
    ];
    const sorted = sortPages(pages, "date");
    // Overdue (8 AM) < all-day today (at "now" = noon) < future (3 PM)
    expect(sorted.map((p) => p.title)).toEqual(["Overdue timed", "All-day today", "Future timed"]);

    vi.useRealTimers();
  });

  it("title mode — alphabetical", () => {
    const pages = [
      makePage({ title: "Banana" }),
      makePage({ title: "Apple" }),
      makePage({ title: "Cherry" }),
    ];
    const sorted = sortPages(pages, "title");
    expect(sorted.map((p) => p.title)).toEqual(["Apple", "Banana", "Cherry"]);
  });

  it("priority mode — urgent(1) before high(2), none(0) last", () => {
    const pages = [
      makePage({ priority: 0, title: "None" }),
      makePage({ priority: 2, title: "High" }),
      makePage({ priority: 1, title: "Urgent" }),
      makePage({ priority: 4, title: "Low" }),
    ];
    const sorted = sortPages(pages, "priority");
    expect(sorted.map((p) => p.title)).toEqual(["Urgent", "High", "Low", "None"]);
  });

  it("priority mode — same tier sub-sorted by date ascending", () => {
    const pages = [
      makePage({ priority: 2, scheduledStart: "2026-03-20T14:00:00", title: "Later" }),
      makePage({ priority: 2, scheduledStart: "2026-03-15T09:00:00", title: "Earlier" }),
      makePage({ priority: 2, scheduledStart: null, title: "No date" }),
    ];
    const sorted = sortPages(pages, "priority");
    expect(sorted.map((p) => p.title)).toEqual(["Earlier", "Later", "No date"]);
  });

  it("returns a new array, does not mutate input", () => {
    const pages = [makePage({ sortOrder: 2 }), makePage({ sortOrder: 1 })];
    const sorted = sortPages(pages, "manual");
    expect(sorted).not.toBe(pages);
  });
});

// ─── getVisiblePages ─────────────────────────────────────────────────────────

describe("getVisiblePages", () => {
  it("today — scheduled <= today, excludes done", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 27, 12, 0, 0));

    const pages = [
      makePage({ scheduledStart: "2026-03-27", status: "not_started", title: "Today" }),
      makePage({ scheduledStart: "2026-03-28", status: "not_started", title: "Tomorrow" }),
      makePage({ scheduledStart: "2026-03-27", status: "done", title: "Done today" }),
    ];
    const visible = getVisiblePages(pages, "today");
    expect(visible.map((p) => p.title)).toEqual(["Today"]);

    vi.useRealTimers();
  });

  it("today — includes overdue from yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 27, 12, 0, 0));

    const pages = [
      makePage({ scheduledStart: "2026-03-26", status: "not_started", title: "Yesterday" }),
    ];
    const visible = getVisiblePages(pages, "today");
    expect(visible.map((p) => p.title)).toEqual(["Yesterday"]);

    vi.useRealTimers();
  });

  it("inbox — folderId null, excludes done", () => {
    const pages = [
      makePage({ folderId: null, status: "not_started", title: "Inbox item" }),
      makePage({ folderId: "folder-1", status: "not_started", title: "In folder" }),
      makePage({ folderId: null, status: "done", title: "Done inbox" }),
    ];
    const visible = getVisiblePages(pages, "inbox");
    expect(visible.map((p) => p.title)).toEqual(["Inbox item"]);
  });

  it("folder ID — matches folderId, excludes done", () => {
    const pages = [
      makePage({ folderId: "f1", status: "not_started", title: "Match" }),
      makePage({ folderId: "f2", status: "not_started", title: "Wrong folder" }),
      makePage({ folderId: "f1", status: "done", title: "Done" }),
    ];
    const visible = getVisiblePages(pages, "f1");
    expect(visible.map((p) => p.title)).toEqual(["Match"]);
  });
});

// ─── groupTodayPages ─────────────────────────────────────────────────────────

describe("groupTodayPages", () => {
  it("all-day item today — in 'today' group (not overdue)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 27, 14, 0, 0));

    const pages = [makePage({ scheduledStart: "2026-03-27", title: "All-day" })];
    const { overdue, today } = groupTodayPages(pages);
    expect(today.map((p) => p.title)).toEqual(["All-day"]);
    expect(overdue).toHaveLength(0);

    vi.useRealTimers();
  });

  it("all-day item yesterday — in 'overdue' group", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 27, 14, 0, 0));

    const pages = [makePage({ scheduledStart: "2026-03-26", title: "Yesterday" })];
    const { overdue, today } = groupTodayPages(pages);
    expect(overdue.map((p) => p.title)).toEqual(["Yesterday"]);
    expect(today).toHaveLength(0);

    vi.useRealTimers();
  });

  it("timed item 2 hours ago — in 'overdue' group", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 27, 14, 0, 0));

    const pages = [makePage({ scheduledStart: "2026-03-27T12:00:00", title: "Past timed" })];
    const { overdue, today } = groupTodayPages(pages);
    expect(overdue.map((p) => p.title)).toEqual(["Past timed"]);
    expect(today).toHaveLength(0);

    vi.useRealTimers();
  });

  it("timed item 2 hours from now — in 'today' group", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 27, 14, 0, 0));

    const pages = [makePage({ scheduledStart: "2026-03-27T16:00:00", title: "Future timed" })];
    const { overdue, today } = groupTodayPages(pages);
    expect(today.map((p) => p.title)).toEqual(["Future timed"]);
    expect(overdue).toHaveLength(0);

    vi.useRealTimers();
  });
});

// ─── getCompletedTodayPages ──────────────────────────────────────────────────

describe("getCompletedTodayPages", () => {
  it("only status=done with completedAt today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 27, 12, 0, 0));

    const pages = [
      makePage({
        completedAt: "2026-03-27T10:00:00",
        status: "done",
        title: "Done today",
      }),
      makePage({
        completedAt: "2026-03-26T10:00:00",
        status: "done",
        title: "Done yesterday",
      }),
      makePage({ status: "not_started", title: "Not done" }),
    ];
    const result = getCompletedTodayPages(pages);
    expect(result.map((p) => p.title)).toEqual(["Done today"]);

    vi.useRealTimers();
  });
});

// ─── getCompletedViewPages ───────────────────────────────────────────────────

describe("getCompletedViewPages", () => {
  it("inbox — done + folderId null", () => {
    const pages = [
      makePage({
        completedAt: "2026-03-27T10:00:00",
        folderId: null,
        status: "done",
        title: "Done inbox",
      }),
      makePage({
        completedAt: "2026-03-27T10:00:00",
        folderId: "f1",
        status: "done",
        title: "Done folder",
      }),
      makePage({ folderId: null, status: "not_started", title: "Active inbox" }),
    ];
    const result = getCompletedViewPages(pages, "inbox");
    expect(result.map((p) => p.title)).toEqual(["Done inbox"]);
  });

  it("folder — done + matching folderId", () => {
    const pages = [
      makePage({
        completedAt: "2026-03-27T10:00:00",
        folderId: "f1",
        status: "done",
        title: "Done f1",
      }),
      makePage({
        completedAt: "2026-03-27T10:00:00",
        folderId: "f2",
        status: "done",
        title: "Done f2",
      }),
    ];
    const result = getCompletedViewPages(pages, "f1");
    expect(result.map((p) => p.title)).toEqual(["Done f1"]);
  });
});
