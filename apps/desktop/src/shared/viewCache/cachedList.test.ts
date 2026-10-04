import type { PageSummary, ViewKey } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { buildCachedList } from "./cachedList";
import type { CachedView } from "./useCachedView";

const TODAY = "2026-06-15";

function page(id: string, day: string): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    detachIsReversible: false,
    folderId: null,
    id,
    isRecurring: false,
    priority: 0,
    scheduledEnd: null,
    scheduledStart: day,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: id,
    updatedAt: "2026-01-01T00:00:00",
  };
}

function dayList(day: string, pages: PageSummary[] | null): CachedView {
  const key: ViewKey = {
    dates: { from: day, until: day },
    scope: { kind: "everywhere" },
    sort: "date",
    zone: "UTC",
  };
  const held = pages ?? [];
  return {
    allIds: () => Promise.resolve(held.map((p) => p.id)),
    ensure: () => undefined,
    ids: held.map((p) => p.id),
    key,
    loading: pages === null,
    pages: held,
    place: () => undefined,
    rows: () => Promise.resolve([]),
    slots: held,
    tail: 0,
    total: held.length,
  };
}

function upcoming(views: CachedView[]) {
  return buildCachedList({
    hiddenIds: new Set(),
    occurrences: [],
    pages: [],
    today: TODAY,
    viewId: "upcoming",
    views,
  });
}

describe("buildCachedList", () => {
  it("draws a view of several lists only once every list has its first rows", () => {
    const first = [page("a", "2026-06-15")];
    const second = [page("b", "2026-06-16")];

    const partial = upcoming([dayList("2026-06-15", first), dayList("2026-06-16", null)]);
    expect(partial.loading).toBe(true);
    expect(partial.pages).toEqual([]);
    expect(partial.sections.every((s) => s.slots.length === 0 && s.header === null)).toBe(true);

    const whole = upcoming([dayList("2026-06-15", first), dayList("2026-06-16", second)]);
    expect(whole.loading).toBe(false);
    expect(whole.pages.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
