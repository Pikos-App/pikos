import type { Folder } from "@pikos/core";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useFolderList } from "./useFolderList";

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
    const folderList = useFolderList();
    return { folderList, pages, ui, undo, workspace };
  });
}

async function init(hook: ReturnType<typeof setup>) {
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
}

async function createFolder(hook: ReturnType<typeof setup>, name: string): Promise<Folder> {
  let folder!: Folder;
  await act(async () => {
    folder = await hook.result.current.pages.createFolder({ name });
  });
  return folder;
}

describe("useFolderList — counts", () => {
  it("computes pageCountByFolder excluding done pages", async () => {
    const hook = setup();
    await init(hook);

    const work = await createFolder(hook, "Work");

    await act(async () => {
      const a = await hook.result.current.pages.createPage({ folderId: work.id, title: "A" });
      const b = await hook.result.current.pages.createPage({ folderId: work.id, title: "B" });
      const c = await hook.result.current.pages.createPage({ folderId: work.id, title: "C" });
      hook.result.current.pages.updatePage(c.id, { status: "done" });
      // Silence unused-variable lint.
      void a;
      void b;
    });

    expect(hook.result.current.folderList.pageCountByFolder[work.id]).toBe(2);
  });

  it("inboxCount counts pages with no folder and not done", async () => {
    const hook = setup();
    await init(hook);

    await act(async () => {
      await hook.result.current.pages.createPage({ folderId: null, title: "I1" });
      await hook.result.current.pages.createPage({ folderId: null, title: "I2" });
      const done = await hook.result.current.pages.createPage({ folderId: null, title: "ID" });
      hook.result.current.pages.updatePage(done.id, { status: "done" });
    });

    expect(hook.result.current.folderList.inboxCount).toBe(2);
  });

  it("todayCount counts pages scheduled today or earlier and not done", async () => {
    const hook = setup();
    await init(hook);

    // Pick a yesterday timestamp so the value is unambiguously "today or earlier".
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    await act(async () => {
      const overdue = await hook.result.current.pages.createPage({ title: "Overdue" });
      await hook.result.current.pages.scheduleOnce(overdue.id, yesterdayStr);
      const future = await hook.result.current.pages.createPage({ title: "Future" });
      await hook.result.current.pages.scheduleOnce(future.id, "2099-01-01");
      const doneToday = await hook.result.current.pages.createPage({ title: "Done" });
      await hook.result.current.pages.scheduleOnce(doneToday.id, yesterdayStr);
      hook.result.current.pages.updatePage(doneToday.id, { status: "done" });
    });

    await waitFor(() => {
      expect(hook.result.current.folderList.todayCount).toBe(1);
    });
  });
});

describe("useFolderList — sorting", () => {
  it("manual: keeps workspace order unchanged", async () => {
    const hook = setup();
    await init(hook);

    const a = await createFolder(hook, "Alpha");
    const b = await createFolder(hook, "Bravo");
    const c = await createFolder(hook, "Charlie");

    expect(hook.result.current.folderList.folders.map((f) => f.id)).toEqual([a.id, b.id, c.id]);
  });

  it("alphabetical: sorts by name (emoji-aware)", async () => {
    const hook = setup();
    await init(hook);

    await createFolder(hook, "Bravo");
    await createFolder(hook, "Alpha");
    await createFolder(hook, "Charlie");

    act(() => hook.result.current.folderList.setSortOrder("alphabetical"));

    expect(hook.result.current.folderList.folders.map((f) => f.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("page-count: sorts by descending page count", async () => {
    const hook = setup();
    await init(hook);

    const a = await createFolder(hook, "A"); // 1 page
    const b = await createFolder(hook, "B"); // 0 pages
    const c = await createFolder(hook, "C"); // 2 pages

    await act(async () => {
      await hook.result.current.pages.createPage({ folderId: a.id, title: "x" });
      await hook.result.current.pages.createPage({ folderId: c.id, title: "y" });
      await hook.result.current.pages.createPage({ folderId: c.id, title: "z" });
    });

    act(() => hook.result.current.folderList.setSortOrder("page-count"));

    expect(hook.result.current.folderList.folders.map((f) => f.id)).toEqual([c.id, a.id, b.id]);
  });
});

describe("useFolderList — undo hiding", () => {
  it("filters out folders pending undo deletion", async () => {
    const hook = setup();
    await init(hook);

    const a = await createFolder(hook, "Alpha");
    const b = await createFolder(hook, "Bravo");

    act(() => {
      hook.result.current.folderList.handleDeleteRequest(a);
    });

    expect(hook.result.current.folderList.folders.map((f) => f.id)).toEqual([b.id]);
  });

  it("falls back to inbox when active view is the deleted folder", async () => {
    const hook = setup();
    await init(hook);

    const a = await createFolder(hook, "Alpha");
    act(() => hook.result.current.ui.setActiveViewId(a.id));
    expect(hook.result.current.folderList.activeViewId).toBe(a.id);

    act(() => {
      hook.result.current.folderList.handleDeleteRequest(a);
    });

    await waitFor(() => {
      expect(hook.result.current.folderList.activeViewId).toBe("inbox");
    });
  });
});

describe("useFolderList — handlers", () => {
  it("handleCreateFolder creates an empty-named folder, sets renamingId, and switches view", async () => {
    const hook = setup();
    await init(hook);

    await act(async () => {
      await hook.result.current.folderList.handleCreateFolder();
    });

    const fs = hook.result.current.pages.folders;
    const newFolder = fs[fs.length - 1];
    expect(newFolder).toBeDefined();
    expect(newFolder?.name).toBe("");
    expect(hook.result.current.folderList.renamingId).toBe(newFolder?.id);
    expect(hook.result.current.folderList.activeViewId).toBe(newFolder?.id);
  });

  it("handleRenameCommit writes the new name and clears renamingId", async () => {
    const hook = setup();
    await init(hook);
    const a = await createFolder(hook, "Alpha");

    act(() => hook.result.current.folderList.setRenamingId(a.id));
    act(() => hook.result.current.folderList.handleRenameCommit(a.id, "Renamed"));

    await waitFor(() => {
      expect(hook.result.current.pages.folders.find((f) => f.id === a.id)?.name).toBe("Renamed");
    });
    expect(hook.result.current.folderList.renamingId).toBeNull();
  });

  it("handleRenameCommit substitutes 'Untitled' for an empty name", async () => {
    const hook = setup();
    await init(hook);
    const a = await createFolder(hook, "Alpha");

    act(() => hook.result.current.folderList.handleRenameCommit(a.id, ""));

    await waitFor(() => {
      expect(hook.result.current.pages.folders.find((f) => f.id === a.id)?.name).toBe("Untitled");
    });
  });

  it("handleColorChange writes color through to workspace", async () => {
    const hook = setup();
    await init(hook);
    const a = await createFolder(hook, "Alpha");

    act(() => hook.result.current.folderList.handleColorChange(a.id, "#ff0000"));

    await waitFor(() => {
      expect(hook.result.current.pages.folders.find((f) => f.id === a.id)?.color).toBe("#ff0000");
    });
  });

  it("handleDeleteRequest registers a toast item for undo", async () => {
    const hook = setup();
    await init(hook);
    const a = await createFolder(hook, "Alpha");

    act(() => hook.result.current.folderList.handleDeleteRequest(a));

    expect(hook.result.current.undo.toastItems.length).toBeGreaterThan(0);
  });
});
