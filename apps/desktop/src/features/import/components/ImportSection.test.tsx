import { parseMarkdownVault } from "@pikos/core";
import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useImport } from "../hooks/useImport";
import { ImportSection } from "./ImportSection";

const platform = vi.hoisted(() => ({
  assetUrl: (path: string) => path,
  saveAsset: vi.fn((path: string) =>
    path.endsWith("/here.png") ? Promise.resolve("assets/here.png") : Promise.reject(new Error())
  ),
}));
vi.mock("@/shared/platform", () => ({ getPlatform: () => platform }));

vi.mock("@/shared/context/ImportContext", () => ({
  useImportBatch: () => ({
    importBatch: () => Promise.resolve({ folderIds: [], pageIds: ["p1"] }),
  }),
}));
vi.mock("@/shared/context/PagesContext", () => ({ usePages: () => ({}) }));
vi.mock("@/shared/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ storage: { backupBeforeImport: vi.fn() } }),
}));

describe("ImportSection after a Markdown import", () => {
  it("names each note and image the import couldn't find, and imports the note anyway", async () => {
    const plan = parseMarkdownVault([
      { content: "Day one\n\n![[gone.png]]\n\n![ok](here.png)", path: "Trip.md" },
    ]);
    plan.vaultRoot = "/vault";
    const { result } = renderHook(() => useImport());

    let shortfall: Awaited<ReturnType<typeof result.current.executeImport>> = null;
    await act(async () => {
      shortfall = await result.current.executeImport(plan);
    });

    expect(shortfall).toEqual({
      missingImages: [{ image: "gone.png", page: "Trip" }],
      unlinkedLinks: 0,
    });
    render(
      <ImportSection
        parseCSVFile={vi.fn()}
        parseMarkdownDir={vi.fn()}
        reset={vi.fn()}
        state={result.current.state}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 image wasn't in the folder, so it was left out"
    );
    expect(screen.getByText("gone.png")).toBeInTheDocument();
    expect(screen.getByText(/^Trip:/)).toBeInTheDocument();
  });
});
