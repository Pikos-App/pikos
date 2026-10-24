import { MockStorageAdapter } from "@pikos/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { linkTargetFinder } from "./usePageLinkTargets";

let adapter: MockStorageAdapter;

async function page(title: string, content = ""): Promise<string> {
  const created = await adapter.createPage({
    content,
    folderId: null,
    priority: 0,
    status: "not_started",
    tags: [],
    title,
  });
  return created.id;
}

function linkTo(id: string): string {
  return JSON.stringify({
    content: [
      { content: [{ attrs: { pageId: id, title: "" }, type: "pageLink" }], type: "paragraph" },
    ],
    type: "doc",
  });
}

beforeEach(() => {
  adapter = new MockStorageAdapter();
});

describe("the [[ picker's pages", () => {
  it("lists pages whose titles match, never one that only mentions the words, nor the open page", async () => {
    const open = await page("Plans for the week");
    const match = await page("Garden plans");
    await page(
      "Shopping",
      JSON.stringify({
        content: [{ content: [{ text: "plans", type: "text" }], type: "paragraph" }],
        type: "doc",
      })
    );

    const find = linkTargetFinder(adapter, (q, c) => adapter.searchPages(q, c), open);

    expect(await find("plans")).toEqual([{ id: match, title: "Garden plans" }]);
  });

  it("offers recently opened pages before anything is typed", async () => {
    const recent = await page("Journal");
    await adapter.updatePage(recent, { lastOpenedAt: "2026-10-18T09:00:00" });

    const find = linkTargetFinder(adapter, (q, c) => adapter.searchPages(q, c), null);

    expect(await find("")).toEqual([{ id: recent, title: "Journal" }]);
  });
});

describe("backlinks", () => {
  it("are the pages whose bodies link to a page, and follow an edit that removes the link", async () => {
    const target = await page("Plans");
    const source = await page("Journal", linkTo(target));

    expect((await adapter.listBacklinks(target)).map((p) => p.id)).toEqual([source]);

    await adapter.updatePage(source, { content: JSON.stringify({ content: [], type: "doc" }) });

    expect(await adapter.listBacklinks(target)).toEqual([]);
  });
});
