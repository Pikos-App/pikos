// Pins the document schema the desktop app ships. @pikos/editor-schema's own tests exercise the
// package in isolation; this asserts what the composed production extension list produces, which is
// what ends up in users' files and which a behavioural extension could change by accident.
//
// An absolute snapshot, not a comparison against another list: comparing against a copy of the
// pre-extraction list passed vacuously, since both shared the same image node.
//
// A diff means either an intentional change, which needs a CONTENT_SCHEMA_VERSION bump in pikos-db
// and a content migration, or a document-corruption bug caught before it shipped.
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { editorExtensions } from "./components/EditorPane";

function productionSchema() {
  // SlashMenu is a suggestion plugin with no schema contribution; it is kept in
  // the list here rather than filtered, so that if it ever *did* start
  // contributing one, this test would say so.
  return new Editor({ content: "", extensions: editorExtensions }).schema;
}

function attrsOf(
  types: Record<string, { spec: { attrs?: Record<string, unknown> } }>
): Record<string, string[]> {
  const entries: [string, string[]][] = Object.entries(types).map(([name, type]) => [
    name,
    Object.keys(type.spec.attrs ?? {}).sort(),
  ]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries);
}

describe("production document schema", () => {
  it("declares exactly these nodes, with exactly these attributes", () => {
    expect(attrsOf(productionSchema().nodes)).toEqual({
      blockquote: [],
      // `tight` (tiptap-markdown) and `indent` (TabIndent) read as behavioural extensions but write into
      // every document, so they live in @pikos/editor-schema.
      bulletList: ["tight"],
      codeBlock: ["language"],
      doc: [],
      hardBreak: [],
      heading: ["indent", "level"],
      horizontalRule: [],
      image: ["alt", "data-asset-path", "height", "src", "title", "width"],
      listItem: [],
      orderedList: ["start", "tight", "type"],
      pageLink: ["label", "pageId", "title"],
      paragraph: ["indent"],
      table: [],
      tableCell: ["colspan", "colwidth", "rowspan"],
      tableHeader: ["colspan", "colwidth", "rowspan"],
      tableRow: [],
      taskItem: ["checked"],
      taskList: [],
      text: [],
    });
  });

  it("declares exactly these marks, with exactly these attributes", () => {
    expect(attrsOf(productionSchema().marks)).toEqual({
      bold: [],
      code: [],
      italic: [],
      link: ["class", "href", "rel", "target", "title"],
      strike: [],
      underline: [],
    });
  });

  it("keeps the image's durable asset reference", () => {
    // `data-asset-path` is how an image survives moving between devices; `src`
    // is derived from it at render time. Losing the attribute would orphan
    // every image in every existing document.
    const image = productionSchema().nodes["image"]!;
    expect(Object.keys(image.spec.attrs ?? {})).toContain("data-asset-path");
    expect(image.spec.attrs?.["data-asset-path"]?.default ?? null).toBeNull();
  });
});
