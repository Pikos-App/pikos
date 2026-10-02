import { MockStorageAdapter } from "@pikos/core/testing";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useEditorPage } from "./useEditorPage";

async function setup(titles: string[]) {
  const hook = renderHookWithProviders(() => ({
    editor: useEditorPage(),
    pages: usePages(),
    ui: useUI(),
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
  const ids: string[] = [];
  await act(async () => {
    for (const title of titles)
      ids.push((await hook.result.current.pages.createPage({ title })).id);
  });
  return { hook, ids };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useEditorPage", () => {
  it("loads a page the moment it's opened", async () => {
    const { hook, ids } = await setup(["A"]);
    const load = vi.spyOn(MockStorageAdapter.prototype, "getPage");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    act(() => hook.result.current.ui.openPage(ids[0]!));

    expect(load).toHaveBeenCalledWith(ids[0]);
  });

  it("loads only the first and last page of a quick run of opens", async () => {
    const { hook, ids } = await setup(["A", "B", "C", "D", "E"]);
    const load = vi.spyOn(MockStorageAdapter.prototype, "getPage");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    for (const id of ids) {
      act(() => hook.result.current.ui.openPage(id));
      act(() => {
        vi.advanceTimersByTime(30);
      });
    }
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(load.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[4]]);
  });
});
