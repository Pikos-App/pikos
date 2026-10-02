import { MockStorageAdapter } from "@pikos/core/testing";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMockStorageFactory } from "@/shared/adapters/mockStorageChunk";
import { STORAGE_KEYS } from "@/shared/constants/storage";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { usePages } from "./PagesContext";
import { useUI } from "./UIContext";
import { useWorkspace } from "./WorkspaceContext";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setup() {
  return renderHookWithProviders(() => useUI());
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("once the workspace loads", () => {
  async function loadWith(viewId: string, pageId: string | null) {
    localStorage.setItem(STORAGE_KEYS.lastActiveViewId, JSON.stringify(viewId));
    localStorage.setItem(STORAGE_KEYS.lastActivePageId, JSON.stringify(pageId));
    const hook = renderHookWithProviders(() => ({ ui: useUI(), workspace: useWorkspace() }));
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });
    return hook.result.current.ui;
  }

  it("drops a remembered folder and page the workspace no longer has", async () => {
    const ui = await loadWith("deleted-folder", "deleted-page");
    expect(ui.activeViewId).toBe("inbox");
    expect(ui.activePageId).toBeNull();
  });

  it("keeps a remembered view that still exists", async () => {
    const ui = await loadWith("today", null);
    expect(ui.activeViewId).toBe("today");
  });
});

describe("once a workspace with folders and pages loads", () => {
  afterEach(() => {
    setMockStorageFactory(() => new MockStorageAdapter());
  });

  async function relaunch(
    remember: (ids: { folder: string; page: string }) => {
      view: string;
      page: string;
      editorPage: string;
    }
  ) {
    const storage = new MockStorageAdapter();
    setMockStorageFactory(() => storage);
    const load = async () => {
      const hook = renderHookWithProviders(() => ({
        pages: usePages(),
        ui: useUI(),
        workspace: useWorkspace(),
      }));
      await act(async () => {
        await hook.result.current.workspace.selectWorkspace();
      });
      return hook;
    };

    const first = await load();
    let folder!: string;
    let page!: string;
    await act(async () => {
      folder = (await first.result.current.pages.createFolder({ name: "Work" })).id;
      page = (await first.result.current.pages.createPage({ folderId: folder, title: "Plan" })).id;
      await first.result.current.pages.createPage({ title: "Other" });
    });
    first.unmount();

    const saved = remember({ folder, page });
    localStorage.setItem(STORAGE_KEYS.lastActiveViewId, JSON.stringify(saved.view));
    localStorage.setItem(STORAGE_KEYS.lastActivePageId, JSON.stringify(saved.page));
    localStorage.setItem(STORAGE_KEYS.lastEditorPageId, JSON.stringify(saved.editorPage));
    const second = await load();
    return { folder, page, ui: second.result.current.ui };
  }

  it("reopens the folder and page you left, and the last page the editor showed", async () => {
    const { folder, page, ui } = await relaunch((ids) => ({
      editorPage: ids.page,
      page: ids.page,
      view: ids.folder,
    }));
    expect(ui.activeViewId).toBe(folder);
    expect(ui.activePageId).toBe(page);
    expect(ui.lastEditorPageId).toBe(page);
  });

  it("drops a remembered folder and pages that are gone, though others remain", async () => {
    const { ui } = await relaunch(() => ({
      editorPage: "deleted-page",
      page: "deleted-page",
      view: "deleted-folder",
    }));
    expect(ui.activeViewId).toBe("inbox");
    expect(ui.activePageId).toBeNull();
    expect(ui.lastEditorPageId).toBeNull();
  });
});

// ─── setActivePage ──────────────────────────────────────────────────────────

describe("setActivePage", () => {
  it("accepts null to clear", () => {
    const { result } = setup();
    act(() => result.current.setActivePage("some-id"));
    expect(result.current.activePageId).toBe("some-id");
    act(() => result.current.setActivePage(null));
    expect(result.current.activePageId).toBeNull();
  });

  it("accepts a string ID", () => {
    const { result } = setup();
    act(() => result.current.setActivePage("page-123"));
    expect(result.current.activePageId).toBe("page-123");
  });

  it("accepts a PageSummary-like object and extracts id", () => {
    const { result } = setup();
    act(() => result.current.setActivePage({ id: "page-456" } as never));
    expect(result.current.activePageId).toBe("page-456");
  });
});

// ─── setRightPanel — smart panel switching ──────────────────────────────────

describe("setRightPanel — smart panel switching", () => {
  it("switching to calendar saves current page and clears activePageId", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    expect(result.current.activePageId).toBe("page-1");

    act(() => result.current.setRightPanel("calendar"));
    expect(result.current.rightPanel).toBe("calendar");
    expect(result.current.activePageId).toBeNull();
    expect(result.current.lastEditorPageId).toBe("page-1");
  });

  it("switching back to editor restores lastEditorPageId", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    act(() => result.current.setRightPanel("calendar"));
    act(() => result.current.setRightPanel("editor"));

    expect(result.current.rightPanel).toBe("editor");
    expect(result.current.activePageId).toBe("page-1");
  });

  it("switching calendar→calendar is a no-op (no double save)", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    act(() => result.current.setRightPanel("calendar"));
    // Now activePageId is null, lastEditorPageId is "page-1"
    act(() => result.current.setRightPanel("calendar"));
    // Should not save null over "page-1"
    expect(result.current.lastEditorPageId).toBe("page-1");
  });

  it("switching editor→editor is a no-op", () => {
    const { result } = setup();

    act(() => result.current.setActivePage("page-1"));
    act(() => result.current.setRightPanel("editor"));
    // No change
    expect(result.current.activePageId).toBe("page-1");
  });
});

// ─── openPage ─────────────────────────────────────────────────────────────────

describe("openPage", () => {
  it("sets activePageId and switches to editor panel atomically", () => {
    const { result } = setup();

    // Start on calendar
    act(() => result.current.setRightPanel("calendar"));
    expect(result.current.rightPanel).toBe("calendar");

    act(() => result.current.openPage("page-99"));
    expect(result.current.activePageId).toBe("page-99");
    expect(result.current.rightPanel).toBe("editor");
  });

  it("accepts a PageSummary-like object", () => {
    const { result } = setup();
    act(() => result.current.openPage({ id: "page-obj" } as never));
    expect(result.current.activePageId).toBe("page-obj");
  });
});

// ─── getSortMode / setSortMode ──────────────────────────────────────────────

describe("sort modes", () => {
  it("defaults to 'manual' for unknown viewId", () => {
    const { result } = setup();
    expect(result.current.getSortMode("unknown-view")).toBe("manual");
  });

  it("persists sort mode per viewId", () => {
    const { result } = setup();
    act(() => result.current.setSortMode("inbox", "date"));
    expect(result.current.getSortMode("inbox")).toBe("date");
    expect(result.current.getSortMode("today")).toBe("manual"); // other views unaffected
  });
});

// ─── sidebarCollapsed ──────────────────────────────────────────────────────

describe("sidebarCollapsed", () => {
  it("defaults to false", () => {
    const { result } = setup();
    expect(result.current.sidebarCollapsed).toBe(false);
  });

  it("toggles via setter", () => {
    const { result } = setup();
    act(() => result.current.setSidebarCollapsed(true));
    expect(result.current.sidebarCollapsed).toBe(true);
  });
});

// ─── openDialog ─────────────────────────────────────────────────────────────

describe("openDialog", () => {
  it("defaults to null", () => {
    const { result } = setup();
    expect(result.current.openDialog).toBeNull();
  });

  it("sets and clears dialog", () => {
    const { result } = setup();
    act(() => result.current.setOpenDialog("quick-add"));
    expect(result.current.openDialog).toBe("quick-add");
    act(() => result.current.setOpenDialog(null));
    expect(result.current.openDialog).toBeNull();
  });

  it("closes Settings when a dialog opens", () => {
    const { result } = setup();
    act(() => result.current.setSettingsOpen(true));
    expect(result.current.settingsOpen).toBe(true);
    act(() => result.current.setOpenDialog("quick-add"));
    expect(result.current.settingsOpen).toBe(false);
  });

  it("does not touch Settings when a dialog closes", () => {
    const { result } = setup();
    act(() => result.current.setSettingsOpen(true));
    act(() => result.current.setOpenDialog(null));
    expect(result.current.settingsOpen).toBe(true);
  });
});

// ─── referenceDate ──────────────────────────────────────────────────────────

describe("referenceDate", () => {
  it("returns a valid Date", () => {
    const { result } = setup();
    expect(result.current.referenceDate).toBeInstanceOf(Date);
    expect(Number.isNaN(result.current.referenceDate.getTime())).toBe(false);
  });

  it("updates when setReferenceDate is called", () => {
    const { result } = setup();
    const target = new Date(2026, 5, 15);
    act(() => result.current.setReferenceDate(target));
    expect(result.current.referenceDate.toISOString()).toBe(target.toISOString());
  });
});

// ─── useUI outside provider ─────────────────────────────────────────────────

describe("useUI outside provider", () => {
  it("throws when used outside UIProvider", () => {
    // Suppress console.error from React for the expected error
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useUI())).toThrow("useUI must be used within <UIProvider>");
    spy.mockRestore();
  });
});
