import { MockStorageAdapter } from "@pikos/core/testing";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorSettingsProvider } from "@/shared/context/EditorSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { EditorPane } from "./EditorPane";

const LINKING_BODY = JSON.stringify({
  content: [
    {
      content: [
        { text: "See ", type: "text" },
        { attrs: { pageId: "target-1", title: "Plans" }, type: "pageLink" },
      ],
      type: "paragraph",
    },
  ],
  type: "doc",
});

HTMLElement.prototype.scrollTo = () => {};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface App {
  pages: ReturnType<typeof usePages>;
  ui: ReturnType<typeof useUI>;
  workspace: ReturnType<typeof useWorkspace>;
}

function Probe({ onApp }: { onApp: (app: App) => void }) {
  const app = { pages: usePages(), ui: useUI(), workspace: useWorkspace() };
  useEffect(() => {
    onApp(app);
  });

  return null;
}

it("opens a page holding a page link without React refusing a flushSync mid-commit", async () => {
  let latest: App | null = null;
  renderWithProviders(
    <EditorSettingsProvider>
      <TooltipProvider>
        <EditorPane />
        <Probe onApp={(app) => (latest = app)} />
      </TooltipProvider>
    </EditorSettingsProvider>
  );
  const app = () => latest!;

  await act(async () => {
    await app().workspace.selectWorkspace();
  });
  let ids: string[] = [];
  await act(async () => {
    ids = [
      (await app().pages.createPage({ title: "Plain" })).id,
      (await app().pages.createPage({ content: LINKING_BODY, title: "Linking" })).id,
    ];
  });
  await act(async () => {
    app().ui.openPage(ids[0]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const consoleError = vi.spyOn(console, "error");

  await act(async () => {
    app().ui.openPage(ids[1]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(await screen.findByRole("button", { name: "Plans" })).toBeInTheDocument();
  const flushSyncWarnings = consoleError.mock.calls.filter((args) =>
    String(args[0]).includes("flushSync")
  );
  expect(flushSyncWarnings).toEqual([]);
});

it("retrying a save that failed sends the typed body again", async () => {
  let latest: App | null = null;
  renderWithProviders(
    <EditorSettingsProvider>
      <TooltipProvider>
        <EditorPane />
        <Probe onApp={(app) => (latest = app)} />
      </TooltipProvider>
    </EditorSettingsProvider>
  );
  const app = () => latest!;

  await act(async () => {
    await app().workspace.selectWorkspace();
  });
  let id = "";
  await act(async () => {
    id = (await app().pages.createPage({ title: "Draft" })).id;
  });
  await act(async () => {
    app().ui.openPage(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const updatePage = vi
    .spyOn(MockStorageAdapter.prototype, "updatePage")
    .mockRejectedValueOnce(new Error("disk full"));

  const body = await screen.findByRole("textbox", { name: "Page content" });
  act(() => {
    (body as HTMLElement & { editor: Editor }).editor.commands.insertContent("typed");
  });
  const retry = await screen.findByRole(
    "button",
    { name: "Save failed. Click to retry" },
    { timeout: 3000 }
  );
  const failed = updatePage.mock.calls[0]!;
  fireEvent.click(retry);

  await waitFor(() => expect(updatePage).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(updatePage.mock.calls[1]).toEqual(failed);
  expect(failed[1].content).toContain("typed");
});
