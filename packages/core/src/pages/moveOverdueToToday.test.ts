import { describe, expect, it } from "vitest";

import type { PageSummary } from "../types";
import { moveOverdueToTodayLabel, planMoveOverdueToToday } from "./moveOverdueToToday";

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

const TODAY = "2026-03-25";

describe("planMoveOverdueToToday — timed pages", () => {
  it("keeps time of day and duration: last week's 9:00–10:00 becomes today's", () => {
    const page = makePage({
      id: "p",
      scheduledEnd: "2026-03-18T10:00:00",
      scheduledStart: "2026-03-18T09:00:00",
    });
    const { moves } = planMoveOverdueToToday([page], TODAY);
    expect(moves).toEqual([
      {
        end: "2026-03-25T10:00:00",
        pageId: "p",
        previousEnd: "2026-03-18T10:00:00",
        previousStart: "2026-03-18T09:00:00",
        start: "2026-03-25T09:00:00",
      },
    ]);
  });

  it("leaves end undefined when the page had no end", () => {
    const page = makePage({ id: "p", scheduledStart: "2026-03-20T14:30:00" });
    const [move] = planMoveOverdueToToday([page], TODAY).moves;
    expect(move?.start).toBe("2026-03-25T14:30:00");
    expect(move?.end).toBeUndefined();
    expect(move?.previousEnd).toBeUndefined();
  });

  it("keeps a schedule that runs past midnight the same length", () => {
    const page = makePage({
      scheduledEnd: "2026-03-19T01:00:00",
      scheduledStart: "2026-03-18T23:00:00",
    });
    const [move] = planMoveOverdueToToday([page], TODAY).moves;
    expect(move?.start).toBe("2026-03-25T23:00:00");
    expect(move?.end).toBe("2026-03-26T01:00:00");
  });
});

describe("planMoveOverdueToToday — all-day pages", () => {
  it("all-day stays all-day, landing on today", () => {
    const page = makePage({ id: "p", scheduledStart: "2026-03-22" });
    const [move] = planMoveOverdueToToday([page], TODAY).moves;
    expect(move?.start).toBe("2026-03-25");
    expect(move?.end).toBeUndefined();
  });

  it("a multi-day all-day span keeps its length", () => {
    const page = makePage({ scheduledEnd: "2026-03-23", scheduledStart: "2026-03-22" });
    const [move] = planMoveOverdueToToday([page], TODAY).moves;
    expect(move?.start).toBe("2026-03-25");
    expect(move?.end).toBe("2026-03-26");
  });
});

describe("planMoveOverdueToToday — exclusions", () => {
  it("leaves recurring occurrences in place and counts them", () => {
    const plan = planMoveOverdueToToday(
      [
        makePage({ id: "r", isRecurring: true, scheduledStart: "2026-03-20T09:00:00" }),
        makePage({ id: "p", scheduledStart: "2026-03-20T09:00:00" }),
      ],
      TODAY
    );
    expect(plan.moves.map((m) => m.pageId)).toEqual(["p"]);
    expect(plan.recurringKept).toBe(1);
    expect(plan.syncedKept).toBe(0);
  });

  it("leaves synced mirrors in place and counts them", () => {
    const plan = planMoveOverdueToToday(
      [
        makePage({
          id: "s",
          scheduledStart: "2026-03-20T09:00:00",
          scheduleLocked: true,
          syncState: "active",
        }),
        makePage({ id: "p", scheduledStart: "2026-03-20T09:00:00" }),
      ],
      TODAY
    );
    expect(plan.moves.map((m) => m.pageId)).toEqual(["p"]);
    expect(plan.syncedKept).toBe(1);
  });

  it("counts a recurring synced mirror once, as recurring", () => {
    const plan = planMoveOverdueToToday(
      [
        makePage({
          isRecurring: true,
          scheduledStart: "2026-03-20T09:00:00",
          scheduleLocked: true,
        }),
      ],
      TODAY
    );
    expect(plan.recurringKept).toBe(1);
    expect(plan.syncedKept).toBe(0);
  });

  it("skips a page already dated today without reporting it as left behind", () => {
    // A 9:00 read at 14:00 sits in the Overdue section but has nowhere to go.
    const plan = planMoveOverdueToToday(
      [makePage({ scheduledStart: "2026-03-25T09:00:00" })],
      TODAY
    );
    expect(plan).toEqual({ moves: [], recurringKept: 0, syncedKept: 0 });
  });

  it("skips unscheduled pages", () => {
    const plan = planMoveOverdueToToday([makePage({ scheduledStart: null })], TODAY);
    expect(plan.moves).toHaveLength(0);
  });

  it("never moves a page backwards", () => {
    const plan = planMoveOverdueToToday(
      [makePage({ scheduledStart: "2026-03-30T09:00:00" })],
      TODAY
    );
    expect(plan.moves).toHaveLength(0);
  });
});

describe("moveOverdueToTodayLabel", () => {
  const plan = (over: Partial<ReturnType<typeof planMoveOverdueToToday>>) => ({
    moves: [],
    recurringKept: 0,
    syncedKept: 0,
    ...over,
  });
  const moves = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      end: undefined,
      pageId: String(i),
      previousEnd: undefined,
      previousStart: "2026-03-20",
      start: TODAY,
    }));

  it("names the destination when nothing stayed behind", () => {
    expect(moveOverdueToTodayLabel(plan({ moves: moves(4) }))).toBe("Moved 4 to today");
    expect(moveOverdueToTodayLabel(plan({ moves: moves(1) }))).toBe("Moved 1 to today");
  });

  it("reports what stayed behind", () => {
    expect(moveOverdueToTodayLabel(plan({ moves: moves(4), recurringKept: 2 }))).toBe(
      "Moved 4 · 2 recurring left"
    );
    expect(moveOverdueToTodayLabel(plan({ moves: moves(4), syncedKept: 1 }))).toBe(
      "Moved 4 · 1 synced left"
    );
    expect(
      moveOverdueToTodayLabel(plan({ moves: moves(4), recurringKept: 2, syncedKept: 1 }))
    ).toBe("Moved 4 · 2 recurring, 1 synced left");
  });

  it("says so when everything stayed behind", () => {
    expect(moveOverdueToTodayLabel(plan({ recurringKept: 3 }))).toBe(
      "Nothing to move · 3 recurring left"
    );
  });

  it("never claims to have moved zero pages", () => {
    expect(moveOverdueToTodayLabel(plan({}))).toBe("Nothing to move");
  });
});
