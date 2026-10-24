interface DocNode {
  type?: string | undefined;
  text?: string | undefined;
  marks?: { type?: string | undefined }[] | undefined;
  attrs?: Record<string, unknown> | undefined;
  content?: DocNode[] | undefined;
}

/** The ids of the pages a Tiptap document links to, each once, in the order they first appear.
 *  Port of `pikos_core::page_links::link_targets`, which the Rust writer stores as `links`. */
export function linkTargets(doc: unknown): string[] {
  const targets: string[] = [];

  const visit = (node: DocNode) => {
    const pageId = node.attrs?.["pageId"];
    const isLink = node.type === "pageLink" && typeof pageId === "string" && pageId !== "";
    if (isLink && !targets.includes(pageId)) targets.push(pageId);

    node.content?.forEach(visit);
  };

  if (doc && typeof doc === "object") visit(doc as DocNode);

  return targets;
}

/**
 * Turn each `[[title]]` or `[[title|label]]` in the document's text into a link to the page
 * `resolve` names. A title it can't place stays as text, and so does anything inside code.
 * Port of `pikos_core::page_links::resolve_wikilinks`, the CLI's reading of the same Markdown,
 * except that a link is written with every attribute the editor gives one.
 */
export function resolveWikilinks<T extends DocNode>(
  doc: T,
  resolve: (title: string) => string | null
): T {
  const isCodeBlock = doc.type === "codeBlock";
  if (isCodeBlock || !doc.content) return doc;

  const content = doc.content.flatMap((child) =>
    isPlainText(child) ? splitText(child, resolve) : [resolveWikilinks(child, resolve)]
  );

  return { ...doc, content };
}

/** The titles written as `[[title]]` in the document's text, outside code, each once. */
export function wikilinkTitles(doc: DocNode): string[] {
  const titles = new Set<string>();
  resolveWikilinks(doc, (title) => {
    titles.add(title);
    return null;
  });

  return [...titles];
}

function isPlainText(node: DocNode): boolean {
  const isCode = node.marks?.some((m) => m.type === "code") ?? false;

  return node.type === "text" && !isCode;
}

function isPlainPart(part: string): boolean {
  return part !== "" && !/[[\]|]/.test(part);
}

function splitText(node: DocNode, resolve: (title: string) => string | null): DocNode[] {
  const pieces: DocNode[] = [];
  let pending = "";
  let rest = node.text ?? "";

  for (let open = rest.indexOf("[["); open !== -1; open = rest.indexOf("[[")) {
    const after = rest.slice(open + 2);
    const close = after.indexOf("]]");
    if (close === -1) break;

    const inner = after.slice(0, close);
    const bar = inner.indexOf("|");
    const title = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const label = bar === -1 ? null : inner.slice(bar + 1).trim();
    const isLinkable = isPlainPart(title) && (label === null || isPlainPart(label));
    const pageId = isLinkable ? resolve(title) : null;
    if (pageId === null) {
      pending += rest.slice(0, open + 2);
      rest = after;
      continue;
    }

    pending += rest.slice(0, open);
    if (pending) pieces.push(textLike(node, pending));
    pending = "";
    pieces.push({ attrs: { label, pageId, title }, type: "pageLink" });
    rest = after.slice(close + 2);
  }

  if (pieces.length === 0) return [node];

  pending += rest;
  if (pending) pieces.push(textLike(node, pending));

  return pieces;
}

/** A text node with `text`, carrying the marks of the node it was cut from. */
function textLike(node: DocNode, text: string): DocNode {
  return node.marks ? { marks: node.marks, text, type: "text" } : { text, type: "text" };
}
