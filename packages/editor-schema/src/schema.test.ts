import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { createDocumentExtensions } from "./index";

// These tests pin the shape of the stored document. An intentional change needs a
// `content_schema_version` bump in pikos-db and a content migration.

function editor(): Editor {
  return new Editor({
    content: "",
    // Resolution is render-time only and never reaches getJSON(), so any resolver will do.
    extensions: createDocumentExtensions({ resolveAssetUrl: (p) => `test://${p}` }),
  });
}

describe("document schema", () => {
  it("declares exactly the expected node types", () => {
    const names = Object.keys(editor().schema.nodes).sort();
    expect(names).toEqual([
      "blockquote",
      "bulletList",
      "codeBlock",
      "doc",
      "hardBreak",
      "heading",
      "horizontalRule",
      "image",
      "listItem",
      "orderedList",
      "pageLink",
      "paragraph",
      "table",
      "tableCell",
      "tableHeader",
      "tableRow",
      "taskItem",
      "taskList",
      "text",
    ]);
  });

  it("declares exactly the expected mark types", () => {
    const names = Object.keys(editor().schema.marks).sort();
    expect(names).toEqual(["bold", "code", "italic", "link", "strike", "underline"]);
  });

  it("keeps the image node's attribute set stable", () => {
    // Losing either would orphan every image in existing documents.
    const attrs = Object.keys(editor().schema.nodes["image"]!.spec.attrs ?? {}).sort();
    expect(attrs).toContain("data-asset-path");
    expect(attrs).toContain("src");
    expect(attrs).toContain("alt");
    expect(attrs).toContain("title");
  });

  it("declares colwidth on table cells and leaves it null in fresh tables", () => {
    // The attribute must exist everywhere so a resized table parses on every device, and be
    // null on a fresh insert so the same action produces the same document.
    const e = editor();
    e.commands.insertTable({ cols: 2, rows: 2, withHeaderRow: true });
    const json = JSON.stringify(e.getJSON());

    expect(Object.keys(e.schema.nodes["tableCell"]!.spec.attrs ?? {})).toContain("colwidth");
    expect(json).toContain('"colwidth":null');
    expect(json).not.toMatch(/"colwidth":\[/);
  });

  it("canonicalises a document containing every node type", () => {
    // Asserts the canonical form, because Tiptap normalises on load: codeBlock gains
    // `language: null`, and a trailing empty paragraph is appended since a horizontalRule
    // cannot be the last node in an editable doc. `indent: 0` and `tight: true` come from
    // TabIndent and tiptap-markdown, which a platform must not omit.
    const e = editor();
    e.commands.setContent({
      content: [
        { attrs: { level: 1 }, content: [{ text: "Title", type: "text" }], type: "heading" },
        { content: [{ text: "Body text", type: "text" }], type: "paragraph" },
        {
          content: [
            {
              content: [{ content: [{ text: "item", type: "text" }], type: "paragraph" }],
              type: "listItem",
            },
          ],
          type: "bulletList",
        },
        {
          content: [
            {
              attrs: { checked: false },
              content: [{ content: [{ text: "todo", type: "text" }], type: "paragraph" }],
              type: "taskItem",
            },
          ],
          type: "taskList",
        },
        { content: [{ text: "code()", type: "text" }], type: "codeBlock" },
        { type: "horizontalRule" },
      ],
      type: "doc",
    });

    expect(e.getJSON()).toEqual({
      content: [
        {
          attrs: { indent: 0, level: 1 },
          content: [{ text: "Title", type: "text" }],
          type: "heading",
        },
        { attrs: { indent: 0 }, content: [{ text: "Body text", type: "text" }], type: "paragraph" },
        {
          attrs: { tight: true },
          content: [
            {
              content: [
                {
                  attrs: { indent: 0 },
                  content: [{ text: "item", type: "text" }],
                  type: "paragraph",
                },
              ],
              type: "listItem",
            },
          ],
          type: "bulletList",
        },
        {
          content: [
            {
              attrs: { checked: false },
              content: [
                {
                  attrs: { indent: 0 },
                  content: [{ text: "todo", type: "text" }],
                  type: "paragraph",
                },
              ],
              type: "taskItem",
            },
          ],
          type: "taskList",
        },
        {
          attrs: { language: null },
          content: [{ text: "code()", type: "text" }],
          type: "codeBlock",
        },
        { type: "horizontalRule" },
        { attrs: { indent: 0 }, type: "paragraph" },
      ],
      type: "doc",
    });
  });

  it("is stable under a second round trip", () => {
    // Canonicalisation must be idempotent, or devices would ping-pong edits forever.
    const e = editor();
    e.commands.setContent({
      content: [
        { content: [{ text: "code()", type: "text" }], type: "codeBlock" },
        { type: "horizontalRule" },
      ],
      type: "doc",
    });
    const once = e.getJSON();

    const e2 = editor();
    e2.commands.setContent(once);
    expect(e2.getJSON()).toEqual(once);
  });

  it("preserves an image's asset path through a round trip", () => {
    const e = editor();
    const doc = {
      content: [
        {
          attrs: { alt: null, "data-asset-path": "assets/photo.png", src: null, title: null },
          type: "image",
        },
      ],
      type: "doc",
    };
    e.commands.setContent(doc);
    const out = e.getJSON();
    const image = out.content?.[0];
    expect(image?.type).toBe("image");
    expect(image?.attrs?.["data-asset-path"]).toBe("assets/photo.png");
  });

  it("keeps a page link's target id and title through a round trip", () => {
    const e = editor();
    const link = { attrs: { pageId: "target-1", title: "Plans" }, type: "pageLink" };
    e.commands.setContent({
      content: [{ content: [{ text: "See ", type: "text" }, link], type: "paragraph" }],
      type: "doc",
    });

    expect(e.getJSON().content?.[0]?.content?.[1]).toEqual(link);
  });

  it("writes a page link to Markdown as [[title]]", () => {
    const e = editor();
    e.commands.setContent({
      content: [
        {
          content: [{ attrs: { pageId: "target-1", title: "Plans" }, type: "pageLink" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    });

    const storage = e.storage as unknown as { markdown: { getMarkdown: () => string } };
    expect(storage.markdown.getMarkdown()).toBe("[[Plans]]");
  });

  it("keeps the stored src free of platform-specific URLs", () => {
    // A resolver URL leaking into getJSON() would break on every other device.
    const e = editor();
    e.commands.setContent({
      content: [{ attrs: { "data-asset-path": "assets/photo.png" }, type: "image" }],
      type: "doc",
    });
    expect(JSON.stringify(e.getJSON())).not.toContain("test://");
  });
});
