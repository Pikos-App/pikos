import { MockStorageAdapter } from "@pikos/core/testing";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useViewCacheController, useWorkspace } from "@/shared/context/WorkspaceContext";
import { lastOpened } from "@/shared/lib/recentOpens";
import { renderHookWithProviders } from "@/test/renderWithProviders";

async function setup() {
  const hook = renderHookWithProviders(() => ({
    pages: usePages(),
    viewCache: useViewCacheController()!,
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
  return hook;
}

afterEach(() => vi.restoreAllMocks());

describe("PagesContext — recording that a page was opened", () => {
  it("saves the open time and nothing else", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      id = (await hook.result.current.pages.createPage({ title: "A" })).id;
    });
    const write = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const page = hook.result.current.viewCache.store.get(id)!;

    await act(async () => {
      hook.result.current.pages.recordPageOpened(id);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    const [writtenId, patch] = write.mock.calls[0]!;
    expect(writtenId).toBe(id);
    expect(Object.keys(patch)).toEqual(["lastOpenedAt"]);
    expect(lastOpened(page)).toBe(patch.lastOpenedAt);
  });
});
