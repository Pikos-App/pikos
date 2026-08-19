import { describe, expect, it } from "vitest";

import type { PageSummary } from "../types";
import { belongsToView, UPCOMING_WINDOW_DAYS, upcomingWindowEnd } from "./pageFilters";
import { groupUpcomingPages } from "./upcoming";

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: overrides.id ?? crypto.randomUUID(),
    isRecurring: false,
    priority: 0,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Untitled",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

// Wednesday. Window runs 2026-03-25 … 2026-03-31 inclusive.
const TODAY = "2026-03-25";

// ─── Membership ──────────────────────────────────────────────────────────────

describe("belongsToView — upcoming", () => {
  it("spans today through today+6, seven days in total", () => {
    expect(UPCOMING_WINDOW_DAYS).toBe(7);
    expect(upcomingWindowEnd(TODAY)).toBe("2026-03-31");
  });

  it("includes today — the window is grounded at the day the user is on", () => {
    expect(belongsToView(makePage({ scheduledStart: TODAY }), "upcoming", TODAY)).toBe(true);
  });

  it("includes a timed page earlier today, even though it has already passed", () => {
    // Overdue-within-today is the Today view's split to make, not a reason to
    // drop the page out of the day group it is scheduled in.
    const page = makePage({ scheduledStart: "2026-03-25T01:00:00" });
    expect(belongsToView(page, "upcoming", TODAY)).toBe(true);
  });

  it("includes the last day of the window (today+6)", () => {
    expect(belongsToView(makePage({ scheduledStart: "2026-03-31" }), "upcoming", TODAY)).toBe(true);
    const timed = makePage({ scheduledStart: "2026-03-31T23:30:00" });
    expect(belongsToView(timed, "upcoming", TODAY)).toBe(true);
  });

  it("excludes today+7 — one day past the window", () => {
    expect(belongsToView(makePage({ scheduledStart: "2026-04-01" }), "upcoming", TODAY)).toBe(
      false
    );
    const timed = makePage({ scheduledStart: "2026-04-01T00:00:00" });
    expect(belongsToView(timed, "upcoming", TODAY)).toBe(false);
  });

  it("excludes overdue — that is the Today view's job", () => {
    expect(belongsToView(makePage({ scheduledStart: "2026-03-24" }), "upcoming", TODAY)).toBe(
      false
    );
    const timed = makePage({ scheduledStart: "2026-03-24T23:59:00" });
    expect(belongsToView(timed, "upcoming", TODAY)).toBe(false);
  });

  it("excludes unscheduled pages", () => {
    expect(belongsToView(makePage({ scheduledStart: null }), "upcoming", TODAY)).toBe(false);
    expect(belongsToView(makePage(), "upcoming", TODAY)).toBe(false);
  });

  it("is folder-blind — a page in any folder shows if it is scheduled in range", () => {
    const page = makePage({ folderId: "f1", scheduledStart: "2026-03-27" });
    expect(belongsToView(page, "upcoming", TODAY)).toBe(true);
  });

  it("keeps a synced mirror scheduled in range", () => {
    const page = makePage({
      scheduledStart: "2026-03-27T09:00:00",
      scheduleLocked: true,
      syncState: "active",
    });
    expect(belongsToView(page, "upcoming", TODAY)).toBe(true);
  });

  it("crosses a month boundary correctly", () => {
    // Window from 2026-03-30 runs to 2026-04-05.
    expect(upcomingWindowEnd("2026-03-30")).toBe("2026-04-05");
    const page = makePage({ scheduledStart: "2026-04-05" });
    expect(belongsToView(page, "upcoming", "2026-03-30")).toBe(true);
    expect(
      belongsToView(makePage({ scheduledStart: "2026-04-06" }), "upcoming", "2026-03-30")
    ).toBe(false);
  });
});

// ─── Grouping ────────────────────────────────────────────────────────────────

describe("groupUpcomingPages", () => {
  it("labels today, tomorrow, then weekday + date", () => {
    const sections = groupUpcomingPages(
      [
        makePage({ scheduledStart: TODAY, title: "a" }),
        makePage({ scheduledStart: "2026-03-26", title: "b" }),
        makePage({ scheduledStart: "2026-03-27", title: "c" }),
      ],
      TODAY
    );
    expect(sections.map((s) => s.label)).toEqual(["Today", "Tomorrow", "Fri, Mar 27"]);
    expect(sections.map((s) => s.date)).toEqual([TODAY, "2026-03-26", "2026-03-27"]);
  });

  it("orders days ascending regardless of input order", () => {
    const sections = groupUpcomingPages(
      [
        makePage({ scheduledStart: "2026-03-29" }),
        makePage({ scheduledStart: TODAY }),
        makePage({ scheduledStart: "2026-03-27" }),
      ],
      TODAY
    );
    expect(sections.map((s) => s.date)).toEqual([TODAY, "2026-03-27", "2026-03-29"]);
  });

  it("emits no section for a day with nothing on it", () => {
    const sections = groupUpcomingPages(
      [makePage({ scheduledStart: TODAY }), makePage({ scheduledStart: "2026-03-29" })],
      TODAY
    );
    expect(sections).toHaveLength(2);
  });

  it("sorts within a day by scheduled start, all-day first on a future day", () => {
    const sections = groupUpcomingPages(
      [
        makePage({ scheduledStart: "2026-03-27T15:00:00", title: "afternoon" }),
        makePage({ scheduledStart: "2026-03-27", title: "all-day" }),
        makePage({ scheduledStart: "2026-03-27T09:00:00", title: "morning" }),
      ],
      TODAY
    );
    expect(sections[0]?.pages.map((p) => p.title)).toEqual(["all-day", "morning", "afternoon"]);
  });

  it("buckets a timed page by its day, not its time", () => {
    const sections = groupUpcomingPages(
      [makePage({ scheduledStart: "2026-03-26T23:45:00", title: "late" })],
      TODAY
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.date).toBe("2026-03-26");
    expect(sections[0]?.label).toBe("Tomorrow");
  });

  it("drops unscheduled pages rather than inventing a day for them", () => {
    const sections = groupUpcomingPages(
      [makePage({ scheduledStart: null }), makePage({ scheduledStart: TODAY })],
      TODAY
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.pages).toHaveLength(1);
  });

  it("returns an empty list for no pages", () => {
    expect(groupUpcomingPages([], TODAY)).toEqual([]);
  });
});
