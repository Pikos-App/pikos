import { act, screen } from "@testing-library/react";
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
