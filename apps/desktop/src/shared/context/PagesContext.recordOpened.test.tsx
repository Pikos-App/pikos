import { MockStorageAdapter } from "@pikos/core/testing";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { lastOpened } from "@/shared/lib/recentOpens";
import { renderHookWithProviders } from "@/test/renderWithProviders";

async function setup() {
  const hook = renderHookWithProviders(() => ({
    pages: usePages(),
    workspace: useWorkspace(),
  }));
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
  return hook;
}

afterEach(() => vi.restoreAllMocks());

describe("PagesContext — recording that a page was opened", () => {
  it("saves the open time without replacing the page list", async () => {
    const hook = await setup();
    let id = "";
    await act(async () => {
      id = (await hook.result.current.pages.createPage({ title: "A" })).id;
    });
    const write = vi.spyOn(MockStorageAdapter.prototype, "updatePage");
    const before = hook.result.current.pages.pages;

    await act(async () => {
      hook.result.current.pages.recordPageOpened(id);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(hook.result.current.pages.pages).toBe(before);
    const [writtenId, patch] = write.mock.calls[0]!;
    expect(writtenId).toBe(id);
    expect(Object.keys(patch)).toEqual(["lastOpenedAt"]);
    const page = before.find((p) => p.id === id)!;
    expect(lastOpened(page)).toBe(patch.lastOpenedAt);
  });
});
