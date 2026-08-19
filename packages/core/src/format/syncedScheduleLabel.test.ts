import { describe, expect, it } from "vitest";

import type { PageSummary } from "../types";
import { syncedScheduleLabel } from "./syncedScheduleLabel";

function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "p1",
    isRecurring: false,
    priority: 0,
    scheduleLocked: true,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Standup",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

describe("syncedScheduleLabel", () => {
  it("returns null when the page has no schedule", () => {
    expect(syncedScheduleLabel(makePage())).toBeNull();
  });

  it("labels an all-day synced event without shifting it", () => {
    const label = syncedScheduleLabel(
      makePage({ scheduledEnd: "2099-03-17", scheduledStart: "2099-03-15" })
    );
    expect(label).toBe("Mar 15, 2099 – Mar 17, 2099");
  });

  it("resolves a timed synced event into the viewer's zone", () => {
    // TZ is pinned to UTC for the suite, so 09:00 in Europe/Berlin (UTC+1 in
    // March, before the DST switch) reads back as 08:00 local.
    const label = syncedScheduleLabel(
      makePage({
        scheduledEnd: "2099-03-15T10:00:00",
        scheduledStart: "2099-03-15T09:00:00",
        timezone: "Europe/Berlin",
      })
    );
    expect(label).toBe("Mar 15 8:00am · 1h");
  });

  it("falls back to the stored wall clock when no timezone is recorded", () => {
    const label = syncedScheduleLabel(makePage({ scheduledStart: "2099-03-15T09:00:00" }));
    expect(label).toBe("Mar 15 9:00am");
  });

  it("drops the past styling once a locked event is done", () => {
    const label = syncedScheduleLabel(
      makePage({ scheduledStart: "2020-01-02T09:00:00", status: "done" })
    );
    expect(label).toBe("Jan 2 9:00am");
  });
});
