interface TiptapNode {
  type: string;
  text?: string;
  content?: TiptapNode[];
  marks?: { type: string }[];
}

/**
 * Extracts plain text from a Tiptap JSON document.
 * Used to populate `content_text` for full-text search in SQLite FTS5.
 *
 * Accepts either a parsed Tiptap JSON object or a JSON string.
 * Returns empty string for empty/invalid input (never throws).
 */
export function extractText(doc: unknown): string {
  if (typeof doc === "string") {
    if (doc === "" || doc === "{}") return "";
    try {
      doc = JSON.parse(doc);
    } catch {
      return "";
    }
  }

  if (!doc || typeof doc !== "object") return "";

  const parts: string[] = [];
  walkNode(doc as TiptapNode, parts);
  return parts.join("\n").trim();
}

function walkNode(node: TiptapNode, parts: string[]): void {
  if (node.text) {
    parts.push(node.text);
    return;
  }

  if (!node.content) return;

  // Block-level nodes get their children joined, then a newline separates blocks
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
    // Container nodes (doc, bulletList, orderedList, taskList)
    // just pass children through
    for (const part of childParts) {
      parts.push(part);
    }
  }
}
