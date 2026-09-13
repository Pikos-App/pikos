import { describe, expect, it } from "vitest";

import type { PageSummary } from "../types";
import type { VirtualOccurrence } from "../utils/recurrence";
import { withTodayOccurrences } from "./todayOccurrences";

const TODAY = "2026-03-25";

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

/** A synced series head, lapsed since the day the calendar was connected. */
function lapsedSyncedHead(overrides: Partial<PageSummary> = {}): PageSummary {
  return makePage({
    id: "standup",
    isRecurring: true,
    scheduledStart: "2026-03-04T09:00:00",
    syncState: "active",
    title: "Standup",
    ...overrides,
  });
}

function occurrence(page: PageSummary, originalDate: string, start: string): VirtualOccurrence {
  return { ...page, isVirtual: true, originalDate, ruleId: "r1", scheduledStart: start };
}

describe("withTodayOccurrences", () => {
  it("lists a lapsed synced series at today's occurrence, not its stale head", () => {
    const head = lapsedSyncedHead();
    const rows = withTodayOccurrences(
      [head],
      [occurrence(head, TODAY, `${TODAY}T09:00:00`)],
      TODAY
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scheduledStart).toBe(`${TODAY}T09:00:00`);
    expect(rows[0]!.id).toBe(head.id);
  });

  it("leaves a native series on its head — a native tick funnels there", () => {
    const head = lapsedSyncedHead({ syncState: null });
    const rows = withTodayOccurrences(
      [head],
      [occurrence(head, TODAY, `${TODAY}T09:00:00`)],
      TODAY
    );
    expect(rows[0]!.scheduledStart).toBe(head.scheduledStart);
  });

  it("leaves a head that is already today or later alone", () => {
    const head = lapsedSyncedHead({ scheduledStart: `${TODAY}T09:00:00` });
    const rows = withTodayOccurrences(
      [head],
      [occurrence(head, TODAY, `${TODAY}T11:00:00`)],
      TODAY
    );
    expect(rows[0]!.scheduledStart).toBe(`${TODAY}T09:00:00`);
  });

  it("leaves the head alone when the series doesn't recur today", () => {
    const head = lapsedSyncedHead();
    const tomorrow = occurrence(head, "2026-03-26", "2026-03-26T09:00:00");
    const rows = withTodayOccurrences([head], [tomorrow], TODAY);
    expect(rows[0]!.scheduledStart).toBe(head.scheduledStart);
  });

  it("places a moved instance by the day it moved to, still naming its own date", () => {
    const head = lapsedSyncedHead();
    const moved = { ...head, originalDate: "2026-03-24", scheduledStart: `${TODAY}T15:00:00` };
    const rows = withTodayOccurrences([head], [moved], TODAY);
    expect(rows[0]!.scheduledStart).toBe(`${TODAY}T15:00:00`);
    expect(rows[0]).toHaveProperty("originalDate", "2026-03-24");
  });

  it("ignores the plain pages the expansion returns alongside its occurrences", () => {
    const head = lapsedSyncedHead();
    const other = makePage({ id: "other", scheduledStart: `${TODAY}T08:00:00` });
    const rows = withTodayOccurrences([head, other], [head, other], TODAY);
    expect(rows.map((p) => p.scheduledStart)).toEqual([head.scheduledStart, `${TODAY}T08:00:00`]);
  });
});
