// useActiveSortMode — the per-view sort default, and that a stored choice wins.

import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useActiveSortMode } from "./useActiveSortMode";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/** Navigates to a folder of the requested kind and returns the live hook result.
 *  The external one is made by enabling a calendar, the same path a real sync
 *  takes — `isExternalCalendar` is system-managed and createFolder can't set it. */
async function setupInFolder(kind: "calendar" | "regular") {
  const rendered = renderHookWithProviders(() => ({
    pages: usePages(),
    sortMode: useActiveSortMode(),
    ui: useUI(),
    workspace: useWorkspace(),
  }));
  const { result } = rendered;
  await act(async () => {
    await result.current.workspace.selectWorkspace();
  });

  let folderId: string;
  if (kind === "calendar") {
    const adapter = result.current.workspace.storage!;
    const account = await act(async () =>
      adapter.connectCaldavAccount({
        baseUrl: "",
        displayName: "Mock",
        password: "",
        username: "",
      })
    );
    const calendar = account.calendars[0]!;
    const enabled = await act(async () => adapter.toggleSyncCalendar(calendar.id, true, null));
    folderId = enabled.folderId!;
    // The adapter wrote the folder directly; PagesContext only sees it on reload
    // (the same step the seed and the real toggle command take).
    await act(async () => {
      await result.current.workspace.reload();
    });
  } else {
    await act(async () => {
      await result.current.pages.createFolder({ name: "Notes" });
    });
    folderId = result.current.pages.folders.find((f) => f.name === "Notes")!.id;
  }

  await waitFor(() =>
    expect(result.current.pages.folders.some((f) => f.id === folderId)).toBe(true)
  );
  act(() => result.current.ui.setActiveViewId(folderId));
  return { folderId, result };
}

describe("useActiveSortMode", () => {
  it("defaults an external calendar folder to date", async () => {
    const { result } = await setupInFolder("calendar");
    expect(result.current.sortMode).toBe("date");
  });

  it("defaults a regular folder to manual", async () => {
    const { result } = await setupInFolder("regular");
    expect(result.current.sortMode).toBe("manual");
  });

  it("lets a stored choice override the calendar default", async () => {
    const { folderId, result } = await setupInFolder("calendar");
    act(() => result.current.ui.setSortMode(folderId, "title"));
    expect(result.current.sortMode).toBe("title");
  });

  it("always date-orders Today, which has no manual order to fall back to", async () => {
    const { result } = await setupInFolder("regular");
    act(() => result.current.ui.setActiveViewId("today"));
    expect(result.current.sortMode).toBe("date");
  });
});
