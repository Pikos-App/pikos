import type { PageSummary } from "@pikos/core";
import { PageStore } from "@pikos/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ViewCacheController } from "@/shared/viewCache/controller";

import { usePageSummary } from "./usePageSummary";

const mocks = vi.hoisted(() => ({
  controller: null as unknown,
  pages: [] as PageSummary[],
}));

vi.mock("@/shared/context/PagesContext", () => ({ usePages: () => ({ pages: mocks.pages }) }));
vi.mock("@/shared/context/WorkspaceContext", () => ({
  useViewCacheController: () => mocks.controller,
}));

function makeSummary(id: string, title: string): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    detachIsReversible: false,
    folderId: null,
    id,
    isRecurring: false,
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title,
    updatedAt: "2026-01-01T00:00:00",
  };
}

function cacheOf(store: PageStore): ViewCacheController {
  return {
    getVersion: () => store.getVersion(),
    store,
    subscribe: (listener: () => void) => store.subscribe(listener),
  } as unknown as ViewCacheController;
}

beforeEach(() => {
  mocks.controller = null;
  mocks.pages = [];
});

describe("usePageSummary", () => {
  it("finds the page in the page list when the view cache is off", () => {
    mocks.pages = [makeSummary("a", "A"), makeSummary("b", "B")];
    const { result } = renderHook(() => usePageSummary("b"));
    expect(result.current?.title).toBe("B");
  });

  it("reads the row from the view cache, not the page list, when it's on", () => {
    const store = new PageStore();
    store.confirm([makeSummary("a", "Held")]);
    mocks.controller = cacheOf(store);
    mocks.pages = [makeSummary("a", "Stale list copy")];

    const { result } = renderHook(() => usePageSummary("a"));

    expect(result.current?.title).toBe("Held");
  });

  it("follows an unsaved edit and a removal in the view cache", () => {
    const store = new PageStore();
    store.confirm([makeSummary("a", "Before")]);
    mocks.controller = cacheOf(store);
    const { result } = renderHook(() => usePageSummary("a"));

    act(() => {
      store.write("a", { title: "After" });
    });
    expect(result.current?.title).toBe("After");

    act(() => {
      store.write("a", {}, true);
    });
    expect(result.current).toBeNull();
  });

  it("returns null for no id or an id nothing holds", () => {
    mocks.controller = cacheOf(new PageStore());
    expect(renderHook(() => usePageSummary(null)).result.current).toBeNull();
    expect(renderHook(() => usePageSummary("missing")).result.current).toBeNull();
  });
});
