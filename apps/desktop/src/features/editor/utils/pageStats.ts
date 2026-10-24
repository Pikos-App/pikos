import type { Node } from "@tiptap/pm/model";

import { readTextblock } from "./textblocks";

const WORDS_PER_MINUTE = 238;

export interface PageStats {
  chars: number;
  paragraphs: number;
  words: number;
}

interface Totals extends PageStats {
  filledBlocks: number;
}

const totals = new WeakMap<Node, Totals>();

function totalsOf(node: Node): Totals {
  if (node.isTextblock) {
    const { chars, words } = readTextblock(node);
    return { chars, filledBlocks: chars > 0 ? 1 : 0, paragraphs: 1, words };
  }

  const cached = totals.get(node);
  if (cached) return cached;

  const sum = { chars: 0, filledBlocks: 0, paragraphs: 0, words: 0 };
  node.forEach((child) => {
    const part = totalsOf(child);
    sum.chars += part.chars;
    sum.filledBlocks += part.filledBlocks;
    sum.paragraphs += part.paragraphs;
    sum.words += part.words;
  });
  totals.set(node, sum);

  return sum;
}

/** Counts as if the non-empty blocks were joined with a space, without building that string: on a
 *  long page the joined copy was most of the cost. */
export function pageStats(doc: Node): PageStats {
  const { chars, filledBlocks, paragraphs, words } = totalsOf(doc);

  return { chars: chars + Math.max(filledBlocks - 1, 0), paragraphs, words };
}

/** Rounded rather than rounded up: rounding up put every short note at "1 min", so
 *  "< 1 min" only ever showed on an empty page. */
export function readingTime(wordCount: number): string {
  const minutes = wordCount / WORDS_PER_MINUTE;
  if (minutes < 1) return "< 1 min";
  return `${Math.round(minutes)} min`;
}
