import { MockStorageAdapter } from "@pikos/core";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UIProvider, useUI } from "@/shared/context/UIContext";
import { useWorkspace, WorkspaceProvider } from "@/shared/context/WorkspaceContext";

import { UndoDeleteProvider, useUndoDelete } from "./UndoDeleteContext";

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

/** Render all three hooks, init workspace, and seed a page + folder. */
async function setup() {
  const hook = renderHook(
    () => ({ ui: useUI(), undo: useUndoDelete(), workspace: useWorkspace() }),
    { wrapper }
  );

  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });

  let pageId!: string;
  let folderId!: string;
  await act(async () => {
    const folder = await hook.result.current.workspace.createFolder({ name: "Work" });
    folderId = folder.id;
    const page = await hook.result.current.workspace.createPage({
      folderId: folder.id,
      title: "Test Page",
    });
    pageId = page.id;
  });

  return { folderId, hook, pageId };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Page deletion ───────────────────────────────────────────────────────────

describe("requestDeletePage", () => {
  it("hides the page and creates an undo item", async () => {
    const { hook, pageId } = await setup();

    act(() => {
      hook.result.current.undo.requestDeletePage({ id: pageId, title: "Test Page" });
    });

    expect(hook.result.current.undo.hiddenPageIds.has(pageId)).toBe(true);
    expect(hook.result.current.undo.hiddenIds.has(pageId)).toBe(true);
    expect(hook.result.current.undo.undoItems).toEqual([{ id: pageId, label: "Test Page" }]);
  });

  it("ignores duplicate delete requests for the same page", async () => {
    const { hook, pageId } = await setup();

    act(() => {
      hook.result.current.undo.requestDeletePage({ id: pageId, title: "Test Page" });
      hook.result.current.undo.requestDeletePage({ id: pageId, title: "Test Page" });
    });

    expect(hook.result.current.undo.undoItems).toHaveLength(1);
  });

  it("closes the editor when the active page is deleted", async () => {
    const { hook, pageId } = await setup();

    act(() => {
      hook.result.current.ui.setActivePage(pageId);
    });
    expect(hook.result.current.ui.activePageId).toBe(pageId);

    act(() => {
      hook.result.current.undo.requestDeletePage({ id: pageId, title: "Test Page" });
    });

    expect(hook.result.current.ui.activePageId).toBeNull();
  });

  it("leaves the active page alone when a different page is deleted", async () => {
    const { hook, pageId } = await setup();
    let otherId!: string;
    await act(async () => {
      const other = await hook.result.current.workspace.createPage({ title: "Other" });
      otherId = other.id;
    });

    act(() => {
      hook.result.current.ui.setActivePage(pageId);
    });

    act(() => {
      hook.result.current.undo.requestDeletePage({ id: otherId, title: "Other" });
    });

    expect(hook.result.current.ui.activePageId).toBe(pageId);
  });
});

// ─── Folder deletion ─────────────────────────────────────────────────────────

describe("requestDeleteFolder", () => {
  it("hides the folder and creates an undo item with page count suffix", async () => {
    const { folderId, hook } = await setup();
    const folder = hook.result.current.workspace.folders.find((f) => f.id === folderId)!;

    act(() => {
      hook.result.current.undo.requestDeleteFolder(folder, 1);
    });

    expect(hook.result.current.undo.hiddenFolderIds.has(folderId)).toBe(true);
    expect(hook.result.current.undo.undoItems).toEqual([
      { duration: 16000, id: `folder:${folderId}`, label: "Work (1 page)" },
    ]);
  });

  it("pluralises page count suffix for multiple pages", async () => {
    const { folderId, hook } = await setup();
    const folder = hook.result.current.workspace.folders.find((f) => f.id === folderId)!;

    act(() => {
      hook.result.current.undo.requestDeleteFolder(folder, 3);
    });

    expect(hook.result.current.undo.undoItems[0]!.label).toBe("Work (3 pages)");
  });

  it("omits suffix when page count is 0", async () => {
    const { folderId, hook } = await setup();
    const folder = hook.result.current.workspace.folders.find((f) => f.id === folderId)!;

    act(() => {
      hook.result.current.undo.requestDeleteFolder(folder, 0);
    });

    expect(hook.result.current.undo.undoItems[0]!.label).toBe("Work");
  });

  it("closes the editor when the active page lives in the deleted folder", async () => {
    const { folderId, hook, pageId } = await setup();
    const folder = hook.result.current.workspace.folders.find((f) => f.id === folderId)!;

    act(() => {
      hook.result.current.ui.setActivePage(pageId);
    });

    act(() => {
      hook.result.current.undo.requestDeleteFolder(folder, 1);
    });

    expect(hook.result.current.ui.activePageId).toBeNull();
  });

  it("leaves the active page alone when it lives in a different folder", async () => {
    const { folderId, hook } = await setup();
    const folder = hook.result.current.workspace.folders.find((f) => f.id === folderId)!;

    // Page in another folder
    let otherId!: string;
    await act(async () => {
      const otherFolder = await hook.result.current.workspace.createFolder({ name: "Other" });
      const other = await hook.result.current.workspace.createPage({
        folderId: otherFolder.id,
        title: "Other page",
      });
      otherId = other.id;
    });

    act(() => {
      hook.result.current.ui.setActivePage(otherId);
    });

    act(() => {
      hook.result.current.undo.requestDeleteFolder(folder, 1);
    });

    expect(hook.result.current.ui.activePageId).toBe(otherId);
  });
});

// ─── handleUndoDismiss (toast timer expired → commit delete) ─────────────────

describe("handleUndoDismiss", () => {
  it("removes page from hidden set and undo items", async () => {
    const { hook, pageId } = await setup();

    act(() => {
      hook.result.current.undo.requestDeletePage({ id: pageId, title: "Test Page" });
    });
    act(() => {
      hook.result.current.undo.handleUndoDismiss(pageId);
    });

    expect(hook.result.current.undo.hiddenPageIds.size).toBe(0);
    expect(hook.result.current.undo.undoItems).toHaveLength(0);
  });

  it("removes folder from hidden set and undo items", async () => {
    const { folderId, hook } = await setup();
    const folder = hook.result.current.workspace.folders.find((f) => f.id === folderId)!;

    act(() => {
      hook.result.current.undo.requestDeleteFolder(folder, 1);
    });
    act(() => {
      hook.result.current.undo.handleUndoDismiss(`folder:${folderId}`);
    });

    expect(hook.result.current.undo.hiddenFolderIds.size).toBe(0);
    expect(hook.result.current.undo.undoItems).toHaveLength(0);
  });
});

// ─── handleUndoDelete (user clicked "Undo") ──────────────────────────────────

describe("handleUndoDelete", () => {
  it("restores a page — removes from hidden set and calls restorePage", async () => {
    const restoreSpy = vi.spyOn(MockStorageAdapter.prototype, "restorePage");
    const { hook, pageId } = await setup();

    act(() => {
      hook.result.current.undo.requestDeletePage({ id: pageId, title: "Test Page" });
    });
    act(() => {
      hook.result.current.undo.handleUndoDelete(pageId);
    });

    expect(hook.result.current.undo.hiddenPageIds.size).toBe(0);
    expect(hook.result.current.undo.undoItems).toHaveLength(0);
    expect(restoreSpy).toHaveBeenCalledWith(pageId);
  });

  it("restores a folder — removes from hidden set and calls restoreFolder", async () => {
    const restoreSpy = vi.spyOn(MockStorageAdapter.prototype, "restoreFolder");
    const { folderId, hook } = await setup();
    const folder = hook.result.current.workspace.folders.find((f) => f.id === folderId)!;

    act(() => {
      hook.result.current.undo.requestDeleteFolder(folder, 1);
    });
    act(() => {
      hook.result.current.undo.handleUndoDelete(`folder:${folderId}`);
    });

    expect(hook.result.current.undo.hiddenFolderIds.size).toBe(0);
    expect(hook.result.current.undo.undoItems).toHaveLength(0);
    expect(restoreSpy).toHaveBeenCalledWith(folderId);
  });
});
