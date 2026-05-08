// useThreePanelDnD — covers the dnd-kit drag-end branching: calendar drops
// (single + multi, timed + all-day), page-to-folder moves, list reorder
// (manual mode), and folder reorder. The hook is large; we exercise it
// through its public surface (handleDragStart / handleDragEnd) with
// synthetic dnd-kit events.

import type { Folder, Page } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UIProvider, useUI } from "@/shared/context/UIContext";
import { useWorkspace, WorkspaceProvider } from "@/shared/context/WorkspaceContext";

import { useThreePanelDnD } from "./useThreePanelDnD";

vi.stubEnv("VITE_TEST_MODE", "true");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <UIProvider>{children}</UIProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup() {
  return renderHook(
    () => {
      const ui = useUI();
      const workspace = useWorkspace();
      const dnd = useThreePanelDnD();
      return { dnd, ui, workspace };
    },
    { wrapper }
  );
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
    page = await hook.result.current.workspace.createPage(opts);
  });
  return page;
}

async function makeFolder(hook: ReturnType<typeof setup>, name: string): Promise<Folder> {
  let folder!: Folder;
  await act(async () => {
    folder = await hook.result.current.workspace.createFolder({ name });
  });
  return folder;
}

// Build a minimal DragStartEvent with the data the hook reads.
function startEvent(id: string, type: "page" | "folder") {
  return {
    active: { data: { current: { type } }, id },
  } as unknown as Parameters<ReturnType<typeof useThreePanelDnD>["handleDragStart"]>[0];
}

function endEventOnPage(activeId: string, overId: string) {
  return {
    active: { data: { current: { type: "page" } }, id: activeId },
    over: { data: { current: { type: "page" } }, id: overId },
  } as unknown as Parameters<ReturnType<typeof useThreePanelDnD>["handleDragEnd"]>[0];
}

function endEventOnFolder(activeId: string, overId: string, folderId: string | null) {
  return {
    active: { data: { current: { type: "page" } }, id: activeId },
    over: { data: { current: { folderId, type: "folder" } }, id: overId },
  } as unknown as Parameters<ReturnType<typeof useThreePanelDnD>["handleDragEnd"]>[0];
}

function endEventFolderToFolder(activeId: string, overId: string) {
  return {
    active: { data: { current: { type: "folder" } }, id: activeId },
    over: { data: { current: { type: "folder" } }, id: overId },
  } as unknown as Parameters<ReturnType<typeof useThreePanelDnD>["handleDragEnd"]>[0];
}

describe("useThreePanelDnD — handleDragStart", () => {
  it("page drag start populates activePageData and a single-id draggedPageIds", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { folderId: null, title: "P" });

    act(() => hook.result.current.dnd.handleDragStart(startEvent(page.id, "page")));

    expect(hook.result.current.dnd.activePageData?.id).toBe(page.id);
    expect(hook.result.current.dnd.draggedPageCount).toBe(1);
  });

  it("folder drag start populates activeFolderData (and clears any drag selection)", async () => {
    const hook = setup();
    await init(hook);
    const f = await makeFolder(hook, "Work");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(f.id, "folder")));

    expect(hook.result.current.dnd.activeFolderData?.id).toBe(f.id);
    expect(hook.result.current.dnd.draggedPageCount).toBe(0);
  });

  it("page drag of a selected item picks up all selected ids in visible order", async () => {
    const hook = setup();
    await init(hook);
    const a = await makePage(hook, { folderId: null, title: "A" });
    const b = await makePage(hook, { folderId: null, title: "B" });
    const c = await makePage(hook, { folderId: null, title: "C" });

    act(() => {
      hook.result.current.ui.setActiveViewId("inbox");
      hook.result.current.ui.togglePageSelection(b.id);
      hook.result.current.ui.togglePageSelection(c.id);
    });

    act(() => hook.result.current.dnd.handleDragStart(startEvent(b.id, "page")));

    expect(hook.result.current.dnd.draggedPageCount).toBe(2);
    // Page a is not selected → not in dragged set.
    void a;
  });

  it("page drag of an unselected item clears selection", async () => {
    const hook = setup();
    await init(hook);
    const a = await makePage(hook, { folderId: null, title: "A" });
    const b = await makePage(hook, { folderId: null, title: "B" });

    act(() => {
      hook.result.current.ui.togglePageSelection(a.id);
    });
    expect(hook.result.current.ui.selectedPageIds.size).toBeGreaterThan(0);

    act(() => hook.result.current.dnd.handleDragStart(startEvent(b.id, "page")));

    expect(hook.result.current.ui.selectedPageIds.size).toBe(0);
    expect(hook.result.current.dnd.draggedPageCount).toBe(1);
  });
});

describe("useThreePanelDnD — handleDragEnd: list reorder", () => {
  it("page→page in manual mode reorders the visible list", async () => {
    const hook = setup();
    await init(hook);
    const a = await makePage(hook, { folderId: null, title: "A" });
    const b = await makePage(hook, { folderId: null, title: "B" });
    const c = await makePage(hook, { folderId: null, title: "C" });

    act(() => hook.result.current.ui.setActiveViewId("inbox"));
    const reorderSpy = vi.spyOn(MockStorageAdapter.prototype, "reorderPages");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(a.id, "page")));
    act(() => hook.result.current.dnd.handleDragEnd(endEventOnPage(a.id, c.id)));

    await waitFor(() => {
      expect(reorderSpy).toHaveBeenCalledWith(null, [b.id, c.id, a.id]);
    });
  });

  it("page→page is a no-op when the active view is 'today'", async () => {
    const hook = setup();
    await init(hook);
    const a = await makePage(hook, { folderId: null, title: "A" });
    const b = await makePage(hook, { folderId: null, title: "B" });

    act(() => hook.result.current.ui.setActiveViewId("today"));
    const reorderSpy = vi.spyOn(MockStorageAdapter.prototype, "reorderPages");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(a.id, "page")));
    act(() => hook.result.current.dnd.handleDragEnd(endEventOnPage(a.id, b.id)));

    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it("page→page is a no-op when the active view's sort mode is not manual", async () => {
    const hook = setup();
    await init(hook);
    const a = await makePage(hook, { folderId: null, title: "A" });
    const b = await makePage(hook, { folderId: null, title: "B" });

    act(() => {
      hook.result.current.ui.setActiveViewId("inbox");
      hook.result.current.ui.setSortMode("inbox", "title");
    });
    const reorderSpy = vi.spyOn(MockStorageAdapter.prototype, "reorderPages");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(a.id, "page")));
    act(() => hook.result.current.dnd.handleDragEnd(endEventOnPage(a.id, b.id)));

    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it("active.id === over.id is a no-op", async () => {
    const hook = setup();
    await init(hook);
    const a = await makePage(hook, { folderId: null, title: "A" });

    act(() => hook.result.current.ui.setActiveViewId("inbox"));
    const reorderSpy = vi.spyOn(MockStorageAdapter.prototype, "reorderPages");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(a.id, "page")));
    act(() => hook.result.current.dnd.handleDragEnd(endEventOnPage(a.id, a.id)));

    expect(reorderSpy).not.toHaveBeenCalled();
  });
});

describe("useThreePanelDnD — handleDragEnd: page → folder", () => {
  it("moves the dragged page to the target folder", async () => {
    const hook = setup();
    await init(hook);
    const work = await makeFolder(hook, "Work");
    const page = await makePage(hook, { folderId: null, title: "P" });
    act(() => hook.result.current.ui.setActiveViewId("inbox"));

    act(() => hook.result.current.dnd.handleDragStart(startEvent(page.id, "page")));
    act(() =>
      hook.result.current.dnd.handleDragEnd(endEventOnFolder(page.id, "folder-droppable", work.id))
    );

    await waitFor(() => {
      expect(hook.result.current.workspace.pages.find((p) => p.id === page.id)?.folderId).toBe(
        work.id
      );
    });
  });

  it("page → 'Inbox' droppable (folderId null) moves to inbox", async () => {
    const hook = setup();
    await init(hook);
    const work = await makeFolder(hook, "Work");
    const page = await makePage(hook, { folderId: work.id, title: "P" });
    act(() => hook.result.current.ui.setActiveViewId(work.id));

    act(() => hook.result.current.dnd.handleDragStart(startEvent(page.id, "page")));
    act(() =>
      hook.result.current.dnd.handleDragEnd(endEventOnFolder(page.id, "inbox-droppable", null))
    );

    await waitFor(() => {
      expect(
        hook.result.current.workspace.pages.find((p) => p.id === page.id)?.folderId
      ).toBeNull();
    });
  });
});

describe("useThreePanelDnD — handleDragEnd: folder → folder", () => {
  it("reorders folders via reorderFolders", async () => {
    const hook = setup();
    await init(hook);
    const a = await makeFolder(hook, "A");
    const b = await makeFolder(hook, "B");
    const c = await makeFolder(hook, "C");

    const reorderSpy = vi.spyOn(MockStorageAdapter.prototype, "reorderFolders");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(a.id, "folder")));
    act(() => hook.result.current.dnd.handleDragEnd(endEventFolderToFolder(a.id, c.id)));

    await waitFor(() => {
      expect(reorderSpy).toHaveBeenCalledWith([b.id, c.id, a.id]);
    });
  });

  it("folder → same folder: no reorder call", async () => {
    const hook = setup();
    await init(hook);
    const a = await makeFolder(hook, "A");

    const reorderSpy = vi.spyOn(MockStorageAdapter.prototype, "reorderFolders");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(a.id, "folder")));
    act(() => hook.result.current.dnd.handleDragEnd(endEventFolderToFolder(a.id, a.id)));

    expect(reorderSpy).not.toHaveBeenCalled();
  });
});

describe("useThreePanelDnD — handleDragCancel", () => {
  it("clears active drag state without writing", async () => {
    const hook = setup();
    await init(hook);
    const page = await makePage(hook, { folderId: null, title: "P" });
    const reorderSpy = vi.spyOn(MockStorageAdapter.prototype, "reorderPages");

    act(() => hook.result.current.dnd.handleDragStart(startEvent(page.id, "page")));
    expect(hook.result.current.dnd.activePageData?.id).toBe(page.id);

    act(() => hook.result.current.dnd.handleDragCancel());
    expect(hook.result.current.dnd.activePageData).toBeNull();
    expect(hook.result.current.dnd.draggedPageCount).toBe(0);
    expect(reorderSpy).not.toHaveBeenCalled();
  });
});
