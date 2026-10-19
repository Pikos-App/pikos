import type { MockStorageAdapter } from "@pikos/core/testing";
import { act, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorSettingsProvider } from "@/shared/context/EditorSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspaceInternal } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { EditorPane } from "./EditorPane";

function body(...paragraphs: string[]): string {
  return JSON.stringify({
    content: paragraphs.map((text) => ({ content: [{ text, type: "text" }], type: "paragraph" })),
    type: "doc",
  });
}

function paragraphsOf(json: string | undefined): string[] {
  const doc = JSON.parse(json ?? "null") as { content: { content?: { text: string }[] }[] };
  return doc.content.map((p) => (p.content ?? []).map((t) => t.text).join(""));
}

beforeAll(() => {
  // jsdom lays nothing out, so it has no scrolling to offer.
  HTMLElement.prototype.scrollTo = () => {};
});

interface App {
  adapter: MockStorageAdapter;
  pages: ReturnType<typeof usePages>;
  ui: ReturnType<typeof useUI>;
  selectWorkspace: () => Promise<void>;
}

function Harness({ onApp }: { onApp: (app: App) => void }) {
  const workspace = useWorkspaceInternal();
  onApp({
    adapter: workspace.adapter as unknown as MockStorageAdapter,
    pages: usePages(),
    selectWorkspace: workspace.selectWorkspace,
    ui: useUI(),
  });
  return (
    <EditorSettingsProvider>
      <TooltipProvider>
        <EditorPane />
      </TooltipProvider>
    </EditorSettingsProvider>
  );
}

async function openNote(paragraphs: string[]) {
  let app!: App;
  const view = renderWithProviders(<Harness onApp={(next) => (app = next)} />);
  await act(() => app.selectWorkspace());
  const page = await act(() =>
    app.pages.createPage({ content: body(...paragraphs), title: "Groceries" })
  );
  act(() => app.ui.openPage(page.id));
  const surface = await waitFor(() => {
    const element = view.container.querySelector<HTMLElement>(`[data-page-id="${page.id}"]`);
    expect(element).not.toBeNull();
    return element!;
  });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;

  return { app, editor, id: page.id };
}

describe("EditorPane saving a body another device edited", () => {
  it("keeps the other device's edit and the typing here, in storage and on screen", async () => {
    const { app, editor, id } = await openNote(["Milk", "Eggs"]);

    app.adapter.applyRemoteBody(id, body("Milk", "Eggs and bread"));
    act(() => {
      editor.commands.insertContentAt(1, "Oat ");
    });

    await waitFor(
      async () => {
        const stored = await app.adapter.getPage(id);
        expect(paragraphsOf(stored?.content)).toEqual(["Oat Milk", "Eggs and bread"]);
      },
      { timeout: 3000 }
    );
    await waitFor(() => expect(editor.getText()).toContain("Eggs and bread"));
    expect(editor.getText()).toContain("Oat Milk");
  });
});
