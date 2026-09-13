import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { createDocumentExtensions } from "./index";

/**
 * These tests pin the *shape of the stored document*, which is the only thing
 * this package exists to keep stable. If a change here is intentional it needs
 * a `content_schema_version` bump in pikos-db and a content migration — see
 * migration 013. If it is unintentional, it is a document-corruption bug that
 * would otherwise be discovered as missing content on somebody's phone.
 */

function editor(): Editor {
  return new Editor({
    content: "",
    // Stand-in for the platform resolver. Asset URL resolution is render-time
    // only and never reaches getJSON(), so any function will do here.
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
    // `data-asset-path` is the durable reference and `src` is derived from it.
    // Losing either would orphan every image in every existing document.
    const attrs = Object.keys(editor().schema.nodes["image"]!.spec.attrs ?? {}).sort();
    expect(attrs).toContain("data-asset-path");
    expect(attrs).toContain("src");
    expect(attrs).toContain("alt");
    expect(attrs).toContain("title");
  });

  it("declares colwidth on table cells and leaves it null in fresh tables", () => {
    // `colwidth` is declared whether or not resizing is enabled, and only a
    // resize gesture populates it. Both halves matter for cross-device
    // documents: the attribute must exist everywhere so a table resized on one
    // device parses on the other, and a freshly inserted table must be null on
    // both so the same action produces the same document.
    //
    // An earlier version of this test asserted the attribute's *absence* and
    // passed vacuously — the spec declares it either way.
    const e = editor();
    e.commands.insertTable({ cols: 2, rows: 2, withHeaderRow: true });
    const json = JSON.stringify(e.getJSON());

    expect(Object.keys(e.schema.nodes["tableCell"]!.spec.attrs ?? {})).toContain("colwidth");
    expect(json).toContain('"colwidth":null');
    expect(json).not.toMatch(/"colwidth":\[/);
  });

  it("canonicalises a document containing every node type", () => {
    // Asserts the *canonical* form rather than naive equality, because Tiptap
    // normalises on load in two ways that both platforms must agree on:
    //
    //   - codeBlock gains an explicit `language: null`
    //   - a trailing empty paragraph is appended, since a horizontalRule
    //     cannot be the document's last node in an editable doc
    //
    // Note `indent: 0` on every paragraph and heading, and `tight: true` on
    // lists. Those come from TabIndent and tiptap-markdown — two extensions
    // that read as purely behavioural and are not. A platform omitting them
    // would strip those attributes from every block on every save.
    //
    // A platform that skipped either would produce a document that differs
    // from the other's on every single save, which is exactly the silent
    // divergence this package exists to prevent.
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
                { attrs: { indent: 0 }, content: [{ text: "item", type: "text" }], type: "paragraph" },
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
                { attrs: { indent: 0 }, content: [{ text: "todo", type: "text" }], type: "paragraph" },
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
    // Canonicalisation must be idempotent. If it were not, every open-and-save
    // would mutate the document and two devices would ping-pong edits forever.
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

  it("keeps the stored src free of platform-specific URLs", () => {
    // The resolver runs at render time only. If it ever leaked into getJSON(),
    // documents would carry asset:// or custom-scheme URLs that resolve on one
    // device and break on every other.
    const e = editor();
    e.commands.setContent({
      content: [{ attrs: { "data-asset-path": "assets/photo.png" }, type: "image" }],
      type: "doc",
    });
    expect(JSON.stringify(e.getJSON())).not.toContain("test://");
  });
});
