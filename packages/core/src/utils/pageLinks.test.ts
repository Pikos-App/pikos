import { describe, expect, it } from "vitest";

import { resolveWikilinks, wikilinkTitles } from "./pageLinks";

const resolveKnown = (title: string) => (title === "Plans" ? "plans-id" : null);

describe("resolveWikilinks", () => {
  it("carries a text's marks onto the text either side of a link", () => {
    const bold = [{ type: "bold" }];
    const doc = {
      content: [
        { content: [{ marks: bold, text: "a [[Plans]] b", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    };

    expect(resolveWikilinks(doc, resolveKnown).content[0]!.content).toEqual([
      { marks: bold, text: "a ", type: "text" },
      { attrs: { label: null, pageId: "plans-id", title: "Plans" }, type: "pageLink" },
      { marks: bold, text: " b", type: "text" },
    ]);
  });

  it("leaves code alone", () => {
    const doc = {
      content: [
        { content: [{ text: "[[Plans]]", type: "text" }], type: "codeBlock" },
        {
          content: [{ marks: [{ type: "code" }], text: "[[Plans]]", type: "text" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    };

    expect(resolveWikilinks(doc, resolveKnown)).toEqual(doc);
    expect(wikilinkTitles(doc)).toEqual([]);
  });
});
