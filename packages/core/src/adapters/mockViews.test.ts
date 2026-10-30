import { describe, expect, it } from "vitest";

import type { PageSummary, ViewKey } from "../types";
import { listViewOf } from "./mockViews";

function page(id: string, scheduledStart: string | null): PageSummary {
  return {
    createdAt: "2026-06-01T09:00:00",
    detachIsReversible: false,
    folderId: null,
    id,
    isRecurring: false,
    priority: 0,
    scheduledStart,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: id,
    updatedAt: "2026-06-01T09:00:00",
  };
}

const pages = [
  page("next-midnight", "2026-06-16T00:00:00"),
  page("all-day", "2026-06-15"),
  page("late", "2026-06-15T23:59:59"),
  page("midnight", "2026-06-15T00:00:00"),
  page("unscheduled", null),
];

function ids(key: ViewKey, limit = 50): string[] {
  return listViewOf(pages, key, null, limit).rows.map((p) => p.id);
}

describe("the mock's date order", () => {
  it("puts an all-day page after its day's timed pages and before the next day", () => {
    const inbox: ViewKey = { dates: null, scope: { kind: "inbox" }, sort: "date", zone: "UTC" };
    expect(ids(inbox)).toEqual(["midnight", "late", "all-day", "next-midnight", "unscheduled"]);
  });

  it("keeps an all-day page in its own day's section only", () => {
    const section = (from: string | null, until: string): ViewKey => ({
      dates: { from, until },
      scope: { kind: "everywhere" },
      sort: "date",
      zone: "UTC",
    });
    expect(ids(section(null, "2026-06-15"))).toEqual([]);
    expect(ids(section("2026-06-15", "2026-06-16"))).toEqual(["midnight", "late", "all-day"]);
    expect(ids(section("2026-06-16", "2026-06-17"))).toEqual(["next-midnight"]);
  });
});
