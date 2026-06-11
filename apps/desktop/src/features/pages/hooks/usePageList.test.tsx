import type { Page } from "@pikos/core";
import { act, waitFor } from "@testing-library/react";
import { format } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { usePageList } from "./usePageList";

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup() {
  return renderHookWithProviders(() => {
    const ui = useUI();
    const undo = useUndoDelete();
    const workspace = useWorkspace();
    const pages = usePages();
    const pageList = usePageList();
    return { pageList, pages, ui, undo, workspace };
  });
}

async function init(hook: ReturnType<typeof setup>) {
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
}

async function makePage(
  hook: ReturnType<typeof setup>,
  opts: { title: string; folderId?: string | null }
): Promise<Page> {
  let page!: Page;
  await act(async () => {
    page = await hook.result.current.pages.createPage(opts);
  });
  return page;
}

describe("usePageList — visible pages", () => {
  it("inbox view: includes folderless pages, excludes folder pages", async () => {
    const hook = setup();
    await init(hook);

    let folder!: { id: string };
    await act(async () => {
      folder = await hook.result.current.pages.createFolder({ name: "Work" });
    });

    const inbox1 = await makePage(hook, { folderId: null, title: "I1" });
    const inbox2 = await makePage(hook, { folderId: null, title: "I2" });
    await makePage(hook, { folderId: folder.id, title: "F1" });

    act(() => hook.result.current.ui.setActiveViewId("inbox"));

    const ids = hook.result.current.pageList.visiblePages.map((p) => p.id).sort();
    expect(ids).toEqual([inbox1.id, inbox2.id].sort());
  });

  it("folder view: only that folder's pages", async () => {
    const hook = setup();
    await init(hook);

    let workFolder!: { id: string };
    let homeFolder!: { id: string };
    await act(async () => {
      workFolder = await hook.result.current.pages.createFolder({ name: "Work" });
      homeFolder = await hook.result.current.pages.createFolder({ name: "Home" });
    });

    const w = await makePage(hook, { folderId: workFolder.id, title: "W" });
    await makePage(hook, { folderId: homeFolder.id, title: "H" });
    await makePage(hook, { folderId: null, title: "I" });

    act(() => hook.result.current.ui.setActiveViewId(workFolder.id));

    const ids = hook.result.current.pageList.visiblePages.map((p) => p.id);
    expect(ids).toEqual([w.id]);
  });

  it("today view: skips the sortPages step (visible filter is applied as-is)", async () => {
    // Freeze the clock — `format(new Date(), ...)` and the `today` view's
    // `localToday()` are read at slightly different moments. If the test runs
    // across local midnight (or UTC midnight on UTC-aware code paths) the two
    // disagree by a day and the assertion flakes. Pin a clearly mid-day instant
    // so neither call straddles a boundary. `shouldAdvanceTime` keeps real
    // setTimeouts in the React render path firing — pure fake timers would
    // deadlock waitFor on its internal setTimeouts.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    try {
      const hook = setup();
      await init(hook);

      const today = format(new Date(), "yyyy-MM-dd");

      const a = await makePage(hook, { folderId: null, title: "A" });
      const b = await makePage(hook, { folderId: null, title: "B" });
      await act(async () => {
        await hook.result.current.pages.scheduleOnce(b.id, today);
        await hook.result.current.pages.scheduleOnce(a.id, today);
      });

      act(() => hook.result.current.ui.setActiveViewId("today"));

      await waitFor(() => {
        expect(hook.result.current.pageList.visiblePages).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters out pages pending undo deletion", async () => {
    const hook = setup();
    await init(hook);

    const a = await makePage(hook, { folderId: null, title: "Keep" });
    const b = await makePage(hook, { folderId: null, title: "Remove" });

    act(() => hook.result.current.ui.setActiveViewId("inbox"));
    expect(hook.result.current.pageList.visiblePages).toHaveLength(2);

    act(() => hook.result.current.pageList.handleDeleteRequest(b));

    expect(hook.result.current.pageList.visiblePages.map((p) => p.id)).toEqual([a.id]);
  });
});

describe("usePageList — handleToggleStatus", () => {
  it("non-recurring page → flips status to done with completedAt timestamp", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "Plain" });

    act(() => hook.result.current.pageList.handleToggleStatus(page.id, "not_started"));

    await waitFor(() => {
      const updated = hook.result.current.pages.pages.find((p) => p.id === page.id);
      expect(updated?.status).toBe("done");
      expect(updated?.completedAt).toBeTruthy();
    });
  });

  it("done page → flips back to not_started, clears completedAt", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "Plain" });

    act(() => hook.result.current.pageList.handleToggleStatus(page.id, "not_started"));
    await waitFor(() => {
      expect(hook.result.current.pages.pages.find((p) => p.id === page.id)?.status).toBe("done");
    });

    act(() => hook.result.current.pageList.handleToggleStatus(page.id, "done"));
    await waitFor(() => {
      const updated = hook.result.current.pages.pages.find((p) => p.id === page.id);
      expect(updated?.status).toBe("not_started");
      expect(updated?.completedAt).toBeNull();
    });
  });

  it("recurring page → routes through requestRecurringComplete instead of writing status", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "Recurring" });

    await act(async () => {
      await hook.result.current.pages.scheduleOnce(page.id, "2099-01-05T09:00:00");
      await hook.result.current.pages.createRecurrence({
        pageId: page.id,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2099-01-05T09:00:00",
        timezone: "America/New_York",
      });
    });

    await act(async () => {
      hook.result.current.pageList.handleToggleStatus(page.id, "not_started");
      // Allow the workspace's awaited adapter ops to resolve.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The page itself remains not_started — the head advanced to a future occurrence.
    const updated = hook.result.current.pages.pages.find((p) => p.id === page.id);
    expect(updated?.status).toBe("not_started");
  });
});

describe("usePageList — handlers", () => {
  it("handlePriorityChange writes priority through to workspace", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "Plain" });

    act(() => hook.result.current.pageList.handlePriorityChange(page.id, 1));

    await waitFor(() => {
      const updated = hook.result.current.pages.pages.find((p) => p.id === page.id);
      expect(updated?.priority).toBe(1);
    });
  });

  it("handleMoveToFolder updates folderId", async () => {
    const hook = setup();
    await init(hook);

    let work!: { id: string };
    await act(async () => {
      work = await hook.result.current.pages.createFolder({ name: "Work" });
    });
    const page = await makePage(hook, { folderId: null, title: "P" });

    act(() => hook.result.current.pageList.handleMoveToFolder(page.id, work.id));

    await waitFor(() => {
      expect(hook.result.current.pages.pages.find((p) => p.id === page.id)?.folderId).toBe(work.id);
    });
  });

  it("handleRenameCommit writes the title and clears renamingId", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "Old" });

    act(() => hook.result.current.pageList.setRenamingId(page.id));
    expect(hook.result.current.pageList.renamingId).toBe(page.id);

    act(() => hook.result.current.pageList.handleRenameCommit(page.id, "New"));

    await waitFor(() => {
      expect(hook.result.current.pages.pages.find((p) => p.id === page.id)?.title).toBe("New");
    });
    expect(hook.result.current.pageList.renamingId).toBeNull();
  });

  it("handleRenameCancel clears renamingId without writing", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "Original" });

    act(() => hook.result.current.pageList.setRenamingId(page.id));
    act(() => hook.result.current.pageList.handleRenameCancel());

    expect(hook.result.current.pageList.renamingId).toBeNull();
    expect(hook.result.current.pages.pages.find((p) => p.id === page.id)?.title).toBe("Original");
  });

  it("handleSelectPage(null) clears the active page", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "P" });

    act(() => hook.result.current.ui.setActivePage(page.id));
    expect(hook.result.current.pageList.activePage?.id).toBe(page.id);

    act(() => hook.result.current.pageList.handleSelectPage(null));
    expect(hook.result.current.pageList.activePage).toBeNull();
  });

  it("handleSelectPage(page) opens the page in the editor", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "P" });

    act(() => hook.result.current.pageList.handleSelectPage(page));

    expect(hook.result.current.ui.activePageId).toBe(page.id);
    expect(hook.result.current.ui.rightPanel).toBe("editor");
  });

  it("handleDeleteRequest queues an undo toast", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { title: "Bye" });

    act(() => hook.result.current.pageList.handleDeleteRequest(page));

    expect(hook.result.current.undo.toastItems.length).toBeGreaterThan(0);
  });
});
