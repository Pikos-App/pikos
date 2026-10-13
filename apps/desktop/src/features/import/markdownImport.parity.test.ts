// The app's markdown import is the reference the Rust importer in `pikos-core` is graded
// against: this test pins what `convertMarkdownToTiptap` makes of every input in the
// shared corpus, and the Rust side must produce the same document or refuse the input.
// A Tiptap upgrade that changes an answer fails here first.
//
// Regenerate after a deliberate change: UPDATE_MARKDOWN_CORPUS=1 pnpm --filter @pikos/desktop
// exec vitest run src/features/import/markdownImport.parity.test.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { convertMarkdownToTiptap } from "./hooks/useImport";

interface Case {
  name: string;
  markdown: string;
  doc: JSONContent | null;
}

const CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../crates/pikos-core/tests/corpus/markdown-import.json"
);

const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as { cases: Case[] };

const imported = (markdown: string): JSONContent =>
  JSON.parse(convertMarkdownToTiptap(markdown)) as JSONContent;

describe("markdown import corpus", () => {
  if (process.env["UPDATE_MARKDOWN_CORPUS"]) {
    it("regenerates the corpus from the app's converter", () => {
      const cases = corpus.cases.map((c) => ({ ...c, doc: imported(c.markdown) }));
      writeFileSync(CORPUS, `${JSON.stringify({ cases }, null, 2)}\n`);
    });
    return;
  }

  it.each(corpus.cases)("$name", ({ doc, markdown }) => {
    expect(imported(markdown)).toEqual(doc);
  });
});
