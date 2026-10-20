import type { Node } from "@tiptap/pm/model";

const WORDS_PER_MINUTE = 238;

const WORD = /\S+/g;

export interface PageStats {
  chars: number;
  paragraphs: number;
  words: number;
}

/** Counts block by block, as if the non-empty blocks were joined with a space, without building
 *  that string: on a long page the joined copy was most of the cost. */
export function pageStats(doc: Node): PageStats {
  let chars = 0;
  let filledBlocks = 0;
  let paragraphs = 0;
  let words = 0;

  doc.descendants((node) => {
    if (!node.isTextblock) return true;

    paragraphs++;
    const text = node.textContent.trim();
    if (text) {
      filledBlocks++;
      chars += text.length;
      words += text.match(WORD)?.length ?? 0;
    }

    return false;
  });

  return { chars: chars + Math.max(filledBlocks - 1, 0), paragraphs, words };
}

/** Rounded rather than rounded up: rounding up put every short note at "1 min", so
 *  "< 1 min" only ever showed on an empty page. */
export function readingTime(wordCount: number): string {
  const minutes = wordCount / WORDS_PER_MINUTE;
  if (minutes < 1) return "< 1 min";
  return `${Math.round(minutes)} min`;
}
