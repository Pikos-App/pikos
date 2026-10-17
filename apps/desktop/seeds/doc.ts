// Tiptap JSON builders for seed content. They emit the shapes
// @pikos/editor-schema stores, so a seeded document parses the same on desktop
// and in the phone's webview.

export type Node = Record<string, unknown>;

/** A string is plain text; a node is anything `text`, `link` or `br` returns. */
export type Inline = string | Node;

type Mark = "bold" | "italic" | "underline" | "strike" | "code";

/** A list item with a nested list beneath it. */
export interface NestedItem {
  text: Inline | Inline[];
  children?: Node;
}

export type ListItem = Inline | NestedItem;

export interface TaskItem {
  text: Inline | Inline[];
  checked: boolean;
  children?: Node;
}

export const EMPTY_DOC = doc(p());

export function doc(...blocks: Node[]): string {
  return JSON.stringify({ content: blocks, type: "doc" });
}

export function text(value: string, ...marks: Mark[]): Node {
  return marks.length === 0
    ? { text: value, type: "text" }
    : { marks: marks.map((type) => ({ type })), text: value, type: "text" };
}

export const bold = (value: string): Node => text(value, "bold");
export const italic = (value: string): Node => text(value, "italic");
export const underline = (value: string): Node => text(value, "underline");
export const strike = (value: string): Node => text(value, "strike");
export const code = (value: string): Node => text(value, "code");

export function link(label: string, href: string): Node {
  return { marks: [{ attrs: { href }, type: "link" }], text: label, type: "text" };
}

export const br: Node = { type: "hardBreak" };

function inlines(parts: Inline[]): Node[] {
  return parts
    .filter((part) => part !== "")
    .map((part) => (typeof part === "string" ? text(part) : part));
}

function withIndent(node: Node, indent: number): Node {
  return indent > 0 ? { ...node, attrs: { ...(node["attrs"] as Node | undefined), indent } } : node;
}

export function p(...parts: Inline[]): Node {
  const content = inlines(parts);
  return content.length === 0 ? { type: "paragraph" } : { content, type: "paragraph" };
}

/** A paragraph at a Tab indent level, as TabIndent stores it. */
export function indentedP(indent: number, ...parts: Inline[]): Node {
  return withIndent(p(...parts), indent);
}

export function h(level: 1 | 2 | 3, ...parts: Inline[]): Node {
  return { attrs: { level }, content: inlines(parts), type: "heading" };
}

export const h1 = (...parts: Inline[]): Node => h(1, ...parts);
export const h2 = (...parts: Inline[]): Node => h(2, ...parts);
export const h3 = (...parts: Inline[]): Node => h(3, ...parts);

export function indentedH(level: 1 | 2 | 3, indent: number, ...parts: Inline[]): Node {
  return withIndent(h(level, ...parts), indent);
}

function isNested(item: ListItem): item is NestedItem {
  return typeof item !== "string" && !("type" in item);
}

function listItem(item: ListItem): Node {
  if (!isNested(item)) return { content: [p(item)], type: "listItem" };
  const line = Array.isArray(item.text) ? p(...item.text) : p(item.text);
  return { content: item.children ? [line, item.children] : [line], type: "listItem" };
}

export function bullets(...items: ListItem[]): Node {
  return { content: items.map(listItem), type: "bulletList" };
}

export function ordered(...items: ListItem[]): Node {
  return orderedFrom(1, ...items);
}

export function orderedFrom(start: number, ...items: ListItem[]): Node {
  return { attrs: { start }, content: items.map(listItem), type: "orderedList" };
}

export function tasks(...items: TaskItem[]): Node {
  return {
    content: items.map(({ checked, children, text: line }) => {
      const first = Array.isArray(line) ? p(...line) : p(line);
      return {
        attrs: { checked },
        content: children ? [first, children] : [first],
        type: "taskItem",
      };
    }),
    type: "taskList",
  };
}

export function quote(...blocks: Node[]): Node {
  return { content: blocks, type: "blockquote" };
}

/** `language` null is a code block with no language selected. */
export function codeBlock(language: string | null, source: string): Node {
  return { attrs: { language }, content: [text(source)], type: "codeBlock" };
}

export const hr: Node = { type: "horizontalRule" };

/** A table whose first row is a header row. Every cell holds one paragraph. */
export function table(header: Inline[], ...rows: Inline[][]): Node {
  const cell = (type: "tableHeader" | "tableCell") => (value: Inline) => ({
    attrs: { colspan: 1, colwidth: null, rowspan: 1 },
    content: [p(value)],
    type,
  });
  return {
    content: [
      { content: header.map(cell("tableHeader")), type: "tableRow" },
      ...rows.map((row) => ({ content: row.map(cell("tableCell")), type: "tableRow" })),
    ],
    type: "table",
  };
}
