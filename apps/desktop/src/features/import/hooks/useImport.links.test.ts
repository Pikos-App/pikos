import type { ImportPlan, VaultFile } from "@pikos/core";
import {
  applyMappings,
  parseMarkdownVault,
  prepareCSVRows,
  suggestColumnMappings,
} from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { act, renderHook } from "@testing-library/react";
import type { JSONContent } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportBatchInput } from "../types";
import { useImport } from "./useImport";

vi.mock("@/shared/platform", () => ({ getPlatform: () => ({}) }));

const importBatch = vi.fn((input: ImportBatchInput) =>
  Promise.resolve({ folderIds: [], pageIds: input.pages.map((p) => p.id) })
);
vi.mock("@/shared/context/ImportContext", () => ({
  useImportBatch: () => ({ importBatch }),
}));
vi.mock("@/shared/context/PagesContext", () => ({
  usePages: () => ({ softDeleteFolder: vi.fn(), softDeletePage: vi.fn() }),
}));

const storage = vi.hoisted(() => ({ current: null as MockStorageAdapter | null }));
vi.mock("@/shared/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ storage: storage.current }),
}));

beforeEach(() => {
  importBatch.mockClear();
  storage.current = new MockStorageAdapter();
});

async function runImport(files: VaultFile[]) {
  const plan: ImportPlan = parseMarkdownVault(files);
  const { result } = renderHook(() => useImport());
  const shortfall = await act(() => result.current.executeImport(plan));

  const pages = importBatch.mock.calls[0]![0].pages;
  const byTitle = (title: string) => pages.find((p) => p.title === title)!;
  const linksIn = (title: string) => inlineNodes(JSON.parse(byTitle(title).content) as JSONContent);

  return { byTitle, linksIn, shortfall };
}

function inlineNodes(doc: JSONContent): JSONContent[] {
  return (doc.content ?? []).flatMap((block) => block.content ?? []);
}

async function addWorkspacePage(title: string): Promise<string> {
  const page = await storage.current!.createPage({
    content: "{}",
    folderId: null,
    priority: 0,
    status: "not_started",
    tags: [],
    title,
  });

  return page.id;
}

describe("a Markdown import's [[links]]", () => {
  it("link the imported pages to each other, an alias keeping its text", async () => {
    const { byTitle, linksIn } = await runImport([
      { content: "See [[Paris|the trip]].", path: "Packing.md" },
      { content: "Back to [[packing]]", path: "Trips/Paris.md" },
    ]);

    expect(linksIn("Packing")).toEqual([
      { text: "See ", type: "text" },
      {
        attrs: { label: "the trip", pageId: byTitle("Paris").id, title: "Paris" },
        type: "pageLink",
      },
      { text: ".", type: "text" },
    ]);
    expect(linksIn("Paris")).toContainEqual({
      attrs: { label: null, pageId: byTitle("Packing").id, title: "packing" },
      type: "pageLink",
    });
  });

  it("link a page already in the workspace when no imported page has the title", async () => {
    const readingList = await addWorkspacePage("Reading list");
    await addWorkspacePage("Paris");

    const { byTitle, linksIn } = await runImport([
      { content: "[[Reading list]] and [[Paris]]", path: "Inbox.md" },
      { content: "", path: "Paris.md" },
    ]);

    const targets = linksIn("Inbox").map((node) => node.attrs?.["pageId"] as string | undefined);
    expect(targets).toEqual([readingList, undefined, byTitle("Paris").id]);
  });

  it("leave a title no page has, or two pages share, as text and count it", async () => {
    const { linksIn, shortfall } = await runImport([
      { content: "[[Nobody]] then [[Notes]]", path: "Inbox.md" },
      { content: "", path: "Work/Notes.md" },
      { content: "", path: "Home/Notes.md" },
    ]);

    expect(linksIn("Inbox")).toEqual([{ text: "[[Nobody]] then [[Notes]]", type: "text" }]);
    expect(shortfall?.unlinkedLinks).toBe(2);
  });
});

describe("a TickTick task whose title is a link", () => {
  it("keeps the link's text as the title and its URL as a link in the body", async () => {
    const csv = [
      '"List Name","Title","Content"',
      '"Reading","[Local-first software](https://example.com/local-first)","Read before Friday"',
    ].join("\n");
    const { headers, rows } = prepareCSVRows(csv);
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);
    const plan = applyMappings(rows, {
      columnMappings: mappings,
      detectedSource,
      valueMappings: [],
    });

    const { result } = renderHook(() => useImport());
    await act(() => result.current.executeImport(plan));

    const page = importBatch.mock.calls[0]![0].pages[0]!;
    const blocks = (JSON.parse(page.content) as JSONContent).content ?? [];
    expect(page.title).toBe("Local-first software");
    const link = blocks[0]?.content?.[0];
    expect(link?.text).toBe("Local-first software");
    expect(link?.marks?.[0]?.attrs?.["href"]).toBe("https://example.com/local-first");
    expect(blocks[blocks.length - 1]?.content).toEqual([
      { text: "Read before Friday", type: "text" },
    ]);
  });
});
