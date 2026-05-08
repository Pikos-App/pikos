// useFolderList — covers folder ordering, page-count derivations, undo
// hiding, fallback when active view points at a missing folder, and the
// CRUD action handlers.

import type { Folder } from "@pikos/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UIProvider, useUI } from "@/shared/context/UIContext";
import { UndoDeleteProvider, useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace, WorkspaceProvider } from "@/shared/context/WorkspaceContext";

import { useFolderList } from "./useFolderList";

vi.stubEnv("VITE_TEST_MODE", "true");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <UIProvider>
        <UndoDeleteProvider>{children}</UndoDeleteProvider>
      </UIProvider>
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
      const undo = useUndoDelete();
      const workspace = useWorkspace();
      const folderList = useFolderList();
      return { folderList, ui, undo, workspace };
    },
    { wrapper }
  );
}

async function init(hook: ReturnType<typeof setup>) {
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
}

async function createFolder(hook: ReturnType<typeof setup>, name: string): Promise<Folder> {
  let folder!: Folder;
  await act(async () => {
    folder = await hook.result.current.workspace.createFolder({ name });
  });
  return folder;
}

describe("useFolderList — counts", () => {
  it("computes pageCountByFolder excluding done pages", async () => {
    const hook = setup();
    await init(hook);

    const work = await createFolder(hook, "Work");

    await act(async () => {
      const a = await hook.result.current.workspace.createPage({ folderId: work.id, title: "A" });
      const b = await hook.result.current.workspace.createPage({ folderId: work.id, title: "B" });
      const c = await hook.result.current.workspace.createPage({ folderId: work.id, title: "C" });
      hook.result.current.workspace.updatePage(c.id, { status: "done" });
      // Touch a/b too to silence unused warnings — not really needed.
      void a;
      void b;
    });

    expect(hook.result.current.folderList.pageCountByFolder[work.id]).toBe(2);
  });

  it("inboxCount counts pages with no folder and not done", async () => {
    const hook = setup();
    await init(hook);

    await act(async () => {
      await hook.result.current.workspace.createPage({ folderId: null, title: "I1" });
      await hook.result.current.workspace.createPage({ folderId: null, title: "I2" });
      const done = await hook.result.current.workspace.createPage({ folderId: null, title: "ID" });
      hook.result.current.workspace.updatePage(done.id, { status: "done" });
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
      const overdue = await hook.result.current.workspace.createPage({ title: "Overdue" });
      await hook.result.current.workspace.scheduleOnce(overdue.id, yesterdayStr);
      const future = await hook.result.current.workspace.createPage({ title: "Future" });
      await hook.result.current.workspace.scheduleOnce(future.id, "2099-01-01");
      const doneToday = await hook.result.current.workspace.createPage({ title: "Done" });
      await hook.result.current.workspace.scheduleOnce(doneToday.id, yesterdayStr);
      hook.result.current.workspace.updatePage(doneToday.id, { status: "done" });
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
      await hook.result.current.workspace.createPage({ folderId: a.id, title: "x" });
      await hook.result.current.workspace.createPage({ folderId: c.id, title: "y" });
      await hook.result.current.workspace.createPage({ folderId: c.id, title: "z" });
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

    const fs = hook.result.current.workspace.folders;
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
      expect(hook.result.current.workspace.folders.find((f) => f.id === a.id)?.name).toBe(
        "Renamed"
      );
    });
    expect(hook.result.current.folderList.renamingId).toBeNull();
  });

  it("handleRenameCommit substitutes 'Untitled' for an empty name", async () => {
    const hook = setup();
    await init(hook);
    const a = await createFolder(hook, "Alpha");

    act(() => hook.result.current.folderList.handleRenameCommit(a.id, ""));

    await waitFor(() => {
      expect(hook.result.current.workspace.folders.find((f) => f.id === a.id)?.name).toBe(
        "Untitled"
      );
    });
  });

  it("handleColorChange writes color through to workspace", async () => {
    const hook = setup();
    await init(hook);
    const a = await createFolder(hook, "Alpha");

    act(() => hook.result.current.folderList.handleColorChange(a.id, "#ff0000"));

    await waitFor(() => {
      expect(hook.result.current.workspace.folders.find((f) => f.id === a.id)?.color).toBe(
        "#ff0000"
      );
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
