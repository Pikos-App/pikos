import { NoopPlatformAdapter } from "@pikos/core";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { setPlatform } from "@/shared/platform";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useExportPage } from "./useExportPage";

afterEach(() => {
  cleanup();
  setPlatform(null);
});

async function renderReady() {
  const hook = renderHookWithProviders(() => ({
    exporter: useExportPage(),
    workspace: useWorkspace(),
  }));
  await waitFor(() => expect(hook.result.current.workspace.storage).not.toBeNull());
  return hook;
}

describe("useExportPage", () => {
  it("writes the page and shows its file in Finder", async () => {
    const platform = new NoopPlatformAdapter();
    setPlatform(platform);
    const hook = await renderReady();

    await act(() => hook.result.current.exporter.exportPage({ id: "page-1" }));

    expect(platform.calls).toContainEqual({ args: ["/mock/page-1.md"], method: "revealInDir" });
  });

  it("opens nothing when the page can't be written", async () => {
    const platform = new NoopPlatformAdapter();
    setPlatform(platform);
    const hook = await renderReady();
    vi.spyOn(hook.result.current.workspace.storage!, "exportPageMarkdown").mockRejectedValueOnce(
      new Error("disk full")
    );

    await act(() => hook.result.current.exporter.exportPage({ id: "page-1" }));

    expect(platform.calls.map((c) => c.method)).not.toContain("revealInDir");
  });
});
