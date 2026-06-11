// useActivePage — derives the active PageSummary from UIContext.activePageId.
// Verifies the three branches: null id → null, id with matching page, id
// pointing at a deleted/missing page → null.

import type { Page } from "@pikos/core";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useActivePage } from "./useActivePage";

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  return renderHookWithProviders(() => {
    const ui = useUI();
    const workspace = useWorkspace();
    const pages = usePages();
    const activePage = useActivePage();
    return { activePage, pages, ui, workspace };
  });
}

describe("useActivePage", () => {
  it("returns null when activePageId is null", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    expect(hook.result.current.ui.activePageId).toBeNull();
    expect(hook.result.current.activePage).toBeNull();
  });

  it("returns the matching PageSummary when activePageId is set", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let page!: Page;
    await act(async () => {
      page = await hook.result.current.pages.createPage({ title: "Active" });
    });
    act(() => {
      hook.result.current.ui.setActivePage(page.id);
    });

    expect(hook.result.current.activePage?.id).toBe(page.id);
    expect(hook.result.current.activePage?.title).toBe("Active");
  });

  it("returns null when activePageId points at a page that no longer exists", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    act(() => {
      hook.result.current.ui.setActivePage("nonexistent-id");
    });

    expect(hook.result.current.activePage).toBeNull();
  });

  it("reflects the latest title after an optimistic update", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let page!: Page;
    await act(async () => {
      page = await hook.result.current.pages.createPage({ title: "Stale" });
    });
    act(() => {
      hook.result.current.ui.setActivePage(page.id);
    });

    act(() => {
      hook.result.current.pages.updatePage(page.id, { title: "Fresh" });
    });

    expect(hook.result.current.activePage?.title).toBe("Fresh");
  });

  it("setActivePage(null) returns null without referencing the previous id", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.workspace.selectWorkspace();
    });

    let page!: Page;
    await act(async () => {
      page = await hook.result.current.pages.createPage({ title: "Ephemeral" });
    });
    act(() => {
      hook.result.current.ui.setActivePage(page.id);
    });
    expect(hook.result.current.activePage?.id).toBe(page.id);

    act(() => {
      hook.result.current.ui.setActivePage(null);
    });
    expect(hook.result.current.activePage).toBeNull();
  });
});
