// Import, run against the table the Rust exporter also runs.
//
// A vault export writes Markdown from `prosemirror_to_markdown`; re-importing it
// comes back through `convertMarkdownToTiptap`. Those are the two dialects that meet,
// and until this table nothing compared them: `roundtrip.test.ts` serializes with
// `tiptap-markdown`, so it round-trips the importer against itself.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractText } from "@pikos/core";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { convertMarkdownToTiptap } from "./hooks/useImport";

interface Case {
  name: string;
  doc: JSONContent;
  markdown: string;
  blocks: { type: string; text: string }[];
}

const TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../crates/pikos-db/tests/fixtures/markdown-export.json"
);

const { cases } = JSON.parse(readFileSync(TABLE, "utf8")) as { cases: Case[] };

/** Blank lines arrive as empty paragraphs (`insertBlankLineParagraphs`); they carry
 *  no block of their own, so the table describes the content around them. */
function blocksOf(doc: JSONContent): { type: string; text: string }[] {
  return (doc.content ?? [])
    .filter((node) => !(node.type === "paragraph" && !node.content?.length))
    .map((node) => ({ text: extractText(node), type: node.type ?? "" }));
}

describe("markdown export/import conformance", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$name", (testCase) => {
    // A column this runner never reads would pass here while the Rust runner's
    // `deny_unknown_fields` enforces it — the asymmetry the shared tables guard against.
    expect(Object.keys(testCase).sort()).toEqual(["blocks", "doc", "markdown", "name"]);
    const imported = JSON.parse(convertMarkdownToTiptap(testCase.markdown)) as JSONContent;
    expect(blocksOf(imported)).toEqual(testCase.blocks);
  });
});
