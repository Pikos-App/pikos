import type { Node as PmNode } from "@tiptap/pm/model";

import { readTextblock } from "./textblocks";

/** Each node's matches for the last query it was searched for, as offsets into its content. */
const matches = new WeakMap<PmNode, { query: string; starts: number[] }>();

function textMatches(text: string, query: string): number[] {
  const starts: number[] = [];
  for (let found = text.indexOf(query); found !== -1; found = text.indexOf(query, found + 1)) {
    starts.push(found);
  }

  return starts;
}

function matchesIn(node: PmNode, query: string): number[] {
  const cached = matches.get(node);
  if (cached?.query === query) return cached.starts;

  let starts: number[];
  if (node.isTextblock) {
    starts = textMatches(readTextblock(node).lower, query);
  } else {
    starts = [];
    node.forEach((child, offset) => {
      for (const start of matchesIn(child, query)) starts.push(offset + 1 + start);
    });
  }
  matches.set(node, { query, starts });

  return starts;
}

/**
 * The document position of every match, ascending; a match ends `query.length` later. Searches each
 * textblock's text as one string, so a match may span marks but never two blocks.
 */
export function findDocMatches(doc: PmNode, query: string): number[] {
  if (!query) return [];

  return matchesIn(doc, query.toLowerCase());
}
