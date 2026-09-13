import type { Page } from "@pikos/core";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useMoveOverdueToToday } from "./useMoveOverdueToToday";

// Wed 2026-06-17, mid-morning — far from any day boundary.
const NOW = new Date(2026, 5, 17, 10, 0, 0);
const TODAY = "2026-06-17";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup() {
  return renderHookWithProviders(() => {
    const pages = usePages();
    const undo = useUndoDelete();
    const workspace = useWorkspace();
    const move = useMoveOverdueToToday();
    return { move, pages, undo, workspace };
  });
}

type Hook = ReturnType<typeof setup>;

async function init(hook: Hook) {
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
}

async function scheduled(hook: Hook, title: string, start: string, end?: string): Promise<Page> {
  let page!: Page;
  await act(async () => {
    page = await hook.result.current.pages.createPage({ title });
    await hook.result.current.pages.scheduleOnce(page.id, start, end);
  });
  return page;
}

function pageById(hook: Hook, id: string) {
  return hook.result.current.pages.pages.find((p) => p.id === id);
}

function overduePages(hook: Hook, ids: string[]) {
  return ids.flatMap((id) => {
    const page = pageById(hook, id);
    return page ? [page] : [];
  });
}

describe("useMoveOverdueToToday", () => {
  it("moves a timed page to today keeping its time and duration", async () => {
    const hook = setup();
    await init(hook);
    const page = await scheduled(hook, "Standup", "2026-06-10T09:00:00", "2026-06-10T10:00:00");

    act(() => hook.result.current.move.moveOverdueToToday(overduePages(hook, [page.id])));

    await waitFor(() => {
      expect(pageById(hook, page.id)?.scheduledStart).toBe(`${TODAY}T09:00:00`);
    });
    expect(pageById(hook, page.id)?.scheduledEnd).toBe(`${TODAY}T10:00:00`);
  });

  it("moves an all-day page to an all-day today", async () => {
    const hook = setup();
    await init(hook);
    const page = await scheduled(hook, "Renew passport", "2026-06-08");

    act(() => hook.result.current.move.moveOverdueToToday(overduePages(hook, [page.id])));

    await waitFor(() => {
      expect(pageById(hook, page.id)?.scheduledStart).toBe(TODAY);
    });
  });

  it("leaves synced mirrors in place and says so in the toast", async () => {
    const hook = setup();
    await init(hook);
    const movable = await scheduled(hook, "Movable", "2026-06-10T09:00:00");
    const locked = await scheduled(hook, "Synced", "2026-06-10T11:00:00");

    // The read model derives scheduleLocked from sync state; the mock has no
    // sync pipeline, so hand the hook the flagged summary directly.
    const lockedSummary = { ...pageById(hook, locked.id)!, scheduleLocked: true };
    act(() =>
      hook.result.current.move.moveOverdueToToday([pageById(hook, movable.id)!, lockedSummary])
    );

    await waitFor(() => {
      expect(pageById(hook, movable.id)?.scheduledStart).toBe(`${TODAY}T09:00:00`);
    });
    expect(pageById(hook, locked.id)?.scheduledStart).toBe("2026-06-10T11:00:00");
    expect(hook.result.current.undo.toastItems.map((t) => t.label)).toEqual([
      "Moved 1 · 1 synced left",
    ]);
  });

  it("leaves recurring occurrences to the gap dialog", async () => {
    const hook = setup();
    await init(hook);
    const page = await scheduled(hook, "Weekly review", "2026-06-10T09:00:00");
    await act(async () => {
      await hook.result.current.pages.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=WE",
        scheduledStart: "2026-06-10T09:00:00",
        timezone: "UTC",
      });
    });
    const before = pageById(hook, page.id)?.scheduledStart;

    act(() =>
      hook.result.current.move.moveOverdueToToday([
        { ...pageById(hook, page.id)!, isRecurring: true },
      ])
    );

    await waitFor(() => {
      expect(hook.result.current.undo.toastItems.map((t) => t.label)).toEqual([
        "Nothing to move · 1 recurring left",
      ]);
    });
    expect(pageById(hook, page.id)?.scheduledStart).toBe(before);
  });

  it("offers one undo for the whole batch that restores every original schedule", async () => {
    const hook = setup();
    await init(hook);
    const a = await scheduled(hook, "A", "2026-06-10T09:00:00", "2026-06-10T09:30:00");
    const b = await scheduled(hook, "B", "2026-06-12");

    act(() => hook.result.current.move.moveOverdueToToday(overduePages(hook, [a.id, b.id])));

    await waitFor(() => {
      expect(pageById(hook, b.id)?.scheduledStart).toBe(TODAY);
    });
    const toasts = hook.result.current.undo.toastItems;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.label).toBe("Moved 2 to today");

    act(() => toasts[0]?.action?.onClick());

    await waitFor(() => {
      expect(pageById(hook, a.id)?.scheduledStart).toBe("2026-06-10T09:00:00");
    });
    expect(pageById(hook, a.id)?.scheduledEnd).toBe("2026-06-10T09:30:00");
    expect(pageById(hook, b.id)?.scheduledStart).toBe("2026-06-12");
    expect(hook.result.current.undo.toastItems).toHaveLength(0);
  });

  it("shows a plain notice — no undo — when nothing was movable", async () => {
    const hook = setup();
    await init(hook);

    act(() => hook.result.current.move.moveOverdueToToday([]));

    expect(hook.result.current.undo.toastItems).toHaveLength(1);
    expect(hook.result.current.undo.toastItems[0]?.action).toBeUndefined();
    expect(hook.result.current.undo.toastItems[0]?.label).toBe("Nothing to move");
  });
});
