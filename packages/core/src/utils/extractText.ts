interface TiptapNode {
  type: string;
  text?: string;
  content?: TiptapNode[];
  marks?: { type: string }[];
  attrs?: { label?: unknown; title?: unknown };
}

/**
 * Plain text of a Tiptap document (parsed or a JSON string) for `content_text`, which FTS5
 * indexes. Empty or invalid input gives "" and never throws.
 */
export function extractText(doc: unknown): string {
  if (typeof doc === "string") {
    if (doc === "" || doc === "{}") return "";
    try {
      doc = JSON.parse(doc);
      // eslint-disable-next-line pikos/no-silent-catch -- a body that isn't a document has no text, as the Rust writer also decides
    } catch {
      return "";
    }
  }

  if (!doc || typeof doc !== "object") return "";

  const parts: string[] = [];
  walkNode(doc as TiptapNode, parts);
  return parts.join("\n").trim();
}

/** Port of `pikos_core::page_links::link_text`: the label a link shows, else its title. */
function pageLinkText(attrs: { label?: unknown; title?: unknown } | undefined): string {
  const label = typeof attrs?.label === "string" ? attrs.label : "";
  if (label) return label;

  return typeof attrs?.title === "string" ? attrs.title : "";
}

function walkNode(node: TiptapNode, parts: string[]): void {
  if (node.text) {
    parts.push(node.text);
    return;
  }
  // A block's children join with no separator, so a line break has to bring its own.
  if (node.type === "hardBreak") {
    parts.push("\n");
    return;
  }

  if (node.type === "pageLink") {
    parts.push(pageLinkText(node.attrs));
    return;
  }

  if (!node.content) return;

  const isBlock =
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "codeBlock" ||
    node.type === "blockquote" ||
    node.type === "listItem" ||
    node.type === "taskItem";

  const childParts: string[] = [];
  for (const child of node.content) {
    walkNode(child, childParts);
  }

  if (isBlock) {
    parts.push(childParts.join(""));
  } else {
    for (const part of childParts) {
      parts.push(part);
    }
  }
}
