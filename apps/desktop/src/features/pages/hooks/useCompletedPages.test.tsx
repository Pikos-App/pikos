// useCompletedPages — derivation + visibility invariants.
//
// Key contracts:
//   • Pages dropped into the WorkspaceContext `pages` array by something
//     other than this hook (e.g. CalendarView's range fetch, which completed
//     long before this session) stay out of the derived Completed list.
//   • A page completed during the current session (optimistic toggle) shows
//     up immediately, no "Load more" click required.
//   • Paginated fetches populate `loadedIds`, which surfaces historical
//     completions the session gate would otherwise exclude.
//   • State is keyed per view — completions in folder A don't bleed into
//     folder B's Completed section.

import type { Page, PageSummary } from "@pikos/core";
import { nowLocalISO } from "@pikos/core";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspace, WorkspaceProvider } from "@/shared/context/WorkspaceContext";

import { useCompletedPages } from "./useCompletedPages";

// Must be set before WorkspaceProvider mounts so useState(() => adapter) picks
// up MockStorageAdapter instead of TauriSQLiteAdapter.
vi.stubEnv("VITE_TEST_MODE", "true");

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

/** Render the combined workspace + completed-pages hook and initialise the
 * workspace. `viewId` can be changed mid-test via `hook.rerender({ viewId })`. */
async function setup(initialViewId = "inbox") {
  const hook = renderHook(
    ({ viewId }: { viewId: string }) => ({
      completed: useCompletedPages(viewId),
      workspace: useWorkspace(),
    }),
    { initialProps: { viewId: initialViewId }, wrapper }
  );
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
  return hook;
}

/** Minimal PageSummary used for mergePages fixtures. */
function fixtureDonePage(overrides: {
  id: string;
  folderId?: string | null;
  completedAt: string;
}): PageSummary {
  return {
    completedAt: overrides.completedAt,
    createdAt: overrides.completedAt,
    folderId: overrides.folderId ?? null,
    id: overrides.id,
    priority: 0,
    sortOrder: 0,
    status: "done",
    tags: [],
    title: `Fixture ${overrides.id}`,
    updatedAt: overrides.completedAt,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Calendar isolation ─────────────────────────────────────────────────────

describe("useCompletedPages — calendar isolation", () => {
  it("a page merged with an old completedAt stays hidden from the derived list", async () => {
    // Simulates CalendarView's range fetch: a completed page from months ago
    // gets placed into the workspace `pages` array via mergePages. The hook
    // must NOT surface it in the Inbox Completed section.
    const hook = await setup("inbox");

    act(() => {
      hook.result.current.workspace.mergePages([
        fixtureDonePage({
          completedAt: "2025-06-01T10:00:00",
          folderId: null,
          id: "calendar-loaded",
        }),
      ]);
    });

    expect(hook.result.current.completed.completedPages).toHaveLength(0);
  });
});

// ─── Session gate ───────────────────────────────────────────────────────────

describe("useCompletedPages — session gate", () => {
  it("an optimistic status toggle surfaces the page without calling onExpand", async () => {
    const hook = await setup("inbox");

    let page!: Page;
    await act(async () => {
      page = await hook.result.current.workspace.createPage({ title: "Quick win" });
    });

    act(() => {
      hook.result.current.workspace.updatePage(page.id, {
        completedAt: nowLocalISO(),
        status: "done",
      });
    });

    const result = hook.result.current.completed.completedPages;
    expect(result.map((p) => p.id)).toEqual([page.id]);
  });
});

// ─── Pagination ─────────────────────────────────────────────────────────────

describe("useCompletedPages — pagination", () => {
  it("onExpand surfaces historical completions that the session gate would exclude", async () => {
    // Two pages marked done long before the session started — neither should
    // be visible initially. After onExpand pulls them via listCompletedPages,
    // both land in loadedIds and become visible.
    const hook = await setup("inbox");
    const storage = hook.result.current.workspace.storage;
    if (!storage) throw new Error("storage should be available after selectWorkspace");

    let a!: Page, b!: Page;
    await act(async () => {
      a = await storage.createPage({
        content: "",
        folderId: null,
        priority: 0,
        status: "done",
        subtitle: null,
        tags: [],
        title: "Historical A",
      });
      await storage.updatePage(a.id, { completedAt: "2025-01-01T00:00:00" });
      b = await storage.createPage({
        content: "",
        folderId: null,
        priority: 0,
        status: "done",
        subtitle: null,
        tags: [],
        title: "Historical B",
      });
      await storage.updatePage(b.id, { completedAt: "2025-02-01T00:00:00" });
    });

    // Neither is in the workspace `pages` array yet, so nothing visible.
    expect(hook.result.current.completed.completedPages).toHaveLength(0);

    await act(async () => {
      await hook.result.current.completed.onExpand();
    });

    const ids = hook.result.current.completed.completedPages.map((p) => p.id);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
  });
});

// ─── Per-view isolation ─────────────────────────────────────────────────────

describe("useCompletedPages — per-view isolation", () => {
  it("a page completed in folder A does not appear in folder B's Completed list", async () => {
    const hook = await setup("folder-a");

    let pageInA!: Page;
    await act(async () => {
      pageInA = await hook.result.current.workspace.createPage({
        folderId: "folder-a",
        title: "A's page",
      });
    });

    act(() => {
      hook.result.current.workspace.updatePage(pageInA.id, {
        completedAt: nowLocalISO(),
        status: "done",
      });
    });

    // Folder A sees it via the session gate.
    expect(hook.result.current.completed.completedPages.map((p) => p.id)).toEqual([pageInA.id]);

    // Switch to folder B — the same hook instance now filters by B.
    hook.rerender({ viewId: "folder-b" });

    expect(hook.result.current.completed.completedPages).toHaveLength(0);
  });
});
