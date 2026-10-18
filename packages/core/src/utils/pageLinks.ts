interface DocNode {
  type?: string;
  attrs?: { pageId?: unknown };
  content?: DocNode[];
}

/** The ids of the pages a Tiptap document links to, each once, in the order they first appear.
 *  Port of `pikos_core::page_links::link_targets`, which the Rust writer stores as `links`. */
export function linkTargets(doc: unknown): string[] {
  const targets: string[] = [];

  const visit = (node: DocNode) => {
    const pageId = node.attrs?.pageId;
    const isLink = node.type === "pageLink" && typeof pageId === "string" && pageId !== "";
    if (isLink && !targets.includes(pageId)) targets.push(pageId);

    node.content?.forEach(visit);
  };

  if (doc && typeof doc === "object") visit(doc as DocNode);

  return targets;
}
