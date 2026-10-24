import type { Node as PmNode } from "@tiptap/pm/model";

/** Stands in for an inline node that isn't text, so an offset into a block's text is its position. */
const INLINE_NODE_CHAR = "￼";

const WORD = /\S+/g;

/**
 * What Find and the counts need from one textblock. An edit makes new nodes only for the blocks it
 * touched and the ones holding them, so keyed by node, every other block's read is reused and an
 * edit to a long page reads only what it changed.
 */
export interface TextblockRead {
  /** Lowercased, with each inline node that isn't text as one character per position it takes. */
  lower: string;
  /** Of the block's text trimmed. */
  chars: number;
  words: number;
}

const reads = new WeakMap<PmNode, TextblockRead>();

/** Lowercases without changing the length, which a few characters (`İ`) otherwise do. */
function lowerSameLength(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;

  return Array.from(text, (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  }).join("");
}

export function readTextblock(node: PmNode): TextblockRead {
  const cached = reads.get(node);
  if (cached) return cached;

  let text = "";
  node.forEach((child) => {
    text += child.isText ? (child.text ?? "") : INLINE_NODE_CHAR.repeat(child.nodeSize);
  });
  const trimmed = node.textContent.trim();
  const read = {
    chars: trimmed.length,
    lower: lowerSameLength(text),
    words: trimmed.match(WORD)?.length ?? 0,
  };
  reads.set(node, read);

  return read;
}
