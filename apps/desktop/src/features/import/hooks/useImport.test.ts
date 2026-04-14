import type { JSONContent } from "@tiptap/core";
import { afterAll, describe, expect, it } from "vitest";

import { convertMarkdownToTiptap, insertBlankLineParagraphs } from "./useImport";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const p = (text: string): JSONContent => ({
  content: [{ text, type: "text" }],
  type: "paragraph",
});

const emptyP: JSONContent = { type: "paragraph" };

const doc = (...nodes: JSONContent[]): JSONContent => ({
  content: nodes,
  type: "doc",
});

/** Parse the JSON string returned by convertMarkdownToTiptap. */
function convert(md: string): JSONContent {
  return JSON.parse(convertMarkdownToTiptap(md)) as JSONContent;
}

/** Get just the top-level node types from a doc. */
function nodeTypes(json: JSONContent): string[] {
  return (json.content ?? []).map((n) => n.type ?? "unknown");
}

/** Check if a node is an empty paragraph (no content). */
function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === "paragraph" && (!node.content || node.content.length === 0);
}

/** Get the flat text of a node (ignoring hardBreaks). */
function textOf(node: JSONContent): string {
  if (!node.content) return "";
  return node.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

// ─── insertBlankLineParagraphs (unit) ────────────────────────────────────────

describe("insertBlankLineParagraphs", () => {
  it("returns unchanged when fewer than 2 nodes", () => {
    const json = doc(p("only one"));
    expect(insertBlankLineParagraphs("only one", json)).toEqual(json);
  });

  it("inserts one empty paragraph for standard \\n\\n separator", () => {
    const md = "Hello\n\nWorld";
    const json = doc(p("Hello"), p("World"));
    const result = insertBlankLineParagraphs(md, json);
    expect(result.content).toEqual([p("Hello"), emptyP, p("World")]);
  });

  it("inserts two empty paragraphs for \\n\\n\\n (extra blank line)", () => {
    const md = "Hello\n\n\nWorld";
    const json = doc(p("Hello"), p("World"));
    const result = insertBlankLineParagraphs(md, json);
    expect(result.content).toEqual([p("Hello"), emptyP, emptyP, p("World")]);
  });

  it("handles multiple separators with varying blank lines", () => {
    const md = "A\n\nB\n\n\n\nC";
    const json = doc(p("A"), p("B"), p("C"));
    const result = insertBlankLineParagraphs(md, json);
    expect(result.content).toEqual([p("A"), emptyP, p("B"), emptyP, emptyP, emptyP, p("C")]);
  });

  it("returns unchanged for empty doc", () => {
    const json: JSONContent = { content: [], type: "doc" };
    expect(insertBlankLineParagraphs("", json)).toEqual(json);
  });

  it("returns unchanged when content is undefined", () => {
    const json: JSONContent = { type: "doc" };
    expect(insertBlankLineParagraphs("", json)).toEqual(json);
  });

  it("defaults to 1 blank line when separator count falls short", () => {
    const md = "A\n\nB";
    const json = doc(p("A"), p("B"), p("C"));
    const result = insertBlankLineParagraphs(md, json);
    expect(result.content).toEqual([p("A"), emptyP, p("B"), emptyP, p("C")]);
  });
});

// ─── convertMarkdownToTiptap (integration) ──────────────────────────────────

describe("convertMarkdownToTiptap", () => {
  afterAll(() => {
    // Shared editor cleanup isn't strictly needed (process exits), but be tidy
  });

  it("converts a simple paragraph", () => {
    const json = convert("Hello world");
    expect(nodeTypes(json)).toEqual(["paragraph"]);
    expect(textOf(json.content![0]!)).toBe("Hello world");
  });

  it("converts single \\n to hardBreak (Obsidian behavior)", () => {
    const json = convert("Line one\nLine two");
    // Should be one paragraph with hardBreak between the lines
    expect(json.content).toHaveLength(1);
    const para = json.content![0]!;
    expect(para.type).toBe("paragraph");
    const types = (para.content ?? []).map((c) => c.type);
    expect(types).toContain("hardBreak");
  });

  it("converts \\n\\n to separate paragraphs with empty paragraph between", () => {
    const json = convert("Paragraph one\n\nParagraph two");
    // Two content paragraphs + one empty paragraph between them
    const nonEmpty = json.content!.filter((n) => !isEmptyParagraph(n));
    const empty = json.content!.filter(isEmptyParagraph);
    expect(nonEmpty).toHaveLength(2);
    expect(empty).toHaveLength(1);
    expect(textOf(nonEmpty[0]!)).toBe("Paragraph one");
    expect(textOf(nonEmpty[1]!)).toBe("Paragraph two");
  });

  it("preserves extra blank lines as additional empty paragraphs", () => {
    const json = convert("A\n\n\n\nB");
    // \n\n\n\n = 3 blank lines → 3 empty paragraphs between A and B
    const empty = json.content!.filter(isEmptyParagraph);
    expect(empty.length).toBeGreaterThanOrEqual(3);
  });

  it("converts headings", () => {
    const json = convert("# Title\n\nBody text");
    const types = nodeTypes(json);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
  });

  it("converts bullet lists", () => {
    const json = convert("- Item one\n- Item two");
    const types = nodeTypes(json);
    expect(types).toContain("bulletList");
  });

  it("converts task lists", () => {
    const json = convert("- [ ] Todo\n- [x] Done");
    const types = nodeTypes(json);
    expect(types).toContain("taskList");
  });

  it("converts bold and italic inline marks", () => {
    const json = convert("**bold** and *italic*");
    const para = json.content![0]!;
    const marks = (para.content ?? []).flatMap((c) => (c.marks ?? []).map((m) => m.type));
    expect(marks).toContain("bold");
    expect(marks).toContain("italic");
  });

  it("handles empty input", () => {
    const json = convert("");
    expect(json.type).toBe("doc");
  });

  it("handles mixed content: heading, paragraphs with blank lines, list", () => {
    const md = "# Notes\n\nFirst paragraph\n\nSecond paragraph\n\n- bullet one\n- bullet two";
    const json = convert(md);
    const types = nodeTypes(json);
    expect(types).toContain("heading");
    expect(types).toContain("bulletList");
    // Should have empty paragraphs between blocks
    expect(types.filter((t) => t === "paragraph").length).toBeGreaterThanOrEqual(4); // 2 content + 3 empty separators
  });
});
