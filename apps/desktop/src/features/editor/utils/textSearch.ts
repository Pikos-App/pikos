import type { Node as PmNode } from "@tiptap/pm/model";

/** Stands in for an inline node that isn't text, so an offset into a block's text is its position. */
const INLINE_NODE_CHAR = "\uFFFC";

/** Keeps a match inside one block; a query from the Find field can't contain it. */
const BLOCK_SEPARATOR = "\n";

/**
 * A document's text lowercased into one string, block by block: `offsets[i]` is where block `i`
 * starts in `text`, and `positions[i]` the document position of its first character.
 */
interface TextProjection {
  text: string;
  offsets: number[];
  positions: number[];
}

const projections = new WeakMap<PmNode, TextProjection>();

/** Lowercases without changing the length, which a few characters (`İ`) otherwise do. */
function lowerSameLength(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;

  return Array.from(text, (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  }).join("");
}

function project(doc: PmNode): TextProjection {
  const cached = projections.get(doc);
  if (cached) return cached;

  const parts: string[] = [];
  const offsets: number[] = [];
  const positions: number[] = [];
  let length = 0;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;

    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.textContent : INLINE_NODE_CHAR.repeat(child.nodeSize);
    });
    offsets.push(length);
    positions.push(pos + 1);
    parts.push(text);
    length += text.length + BLOCK_SEPARATOR.length;

    return false;
  });

  const projection = { offsets, positions, text: lowerSameLength(parts.join(BLOCK_SEPARATOR)) };
  projections.set(doc, projection);

  return projection;
}

/**
 * The document position of every match, ascending; a match ends `query.length` later. Searches each
 * textblock's text as one string, so a match may span marks but never two blocks. The text is read
 * once per document, so each new query is one scan.
 */
export function findDocMatches(doc: PmNode, query: string): number[] {
  const starts: number[] = [];
  if (!query) return starts;

  const { offsets, positions, text } = project(doc);
  const lowerQuery = query.toLowerCase();
  let block = 0;
  let found = text.indexOf(lowerQuery);
  while (found !== -1) {
    while ((offsets[block + 1] ?? Number.POSITIVE_INFINITY) <= found) block++;
    starts.push((positions[block] ?? 0) + found - (offsets[block] ?? 0));
    found = text.indexOf(lowerQuery, found + 1);
  }

  return starts;
}
