/**
 * Which words of a quick-add line the parser took, so the field can colour them where they were
 * typed.
 *
 * The parser reports what it understood, not where. What it leaves behind is the title, so the
 * words of the line that are not in the title, in order, are the ones it read. A word-level
 * longest common subsequence finds them without a second grammar. The phone's
 * `QuickAddHighlight` is the same diff, and its tests are mirrored here.
 */

/** `when` is a date, a time, a repeat or a reminder: everything the parser reads that has no sigil. */
export type QuickAddHighlightKind = "folder" | "note" | "priority" | "tag" | "when";

/** A half-open range of UTF-16 offsets into the typed line. */
export interface QuickAddHighlightToken {
  end: number;
  kind: QuickAddHighlightKind;
  start: number;
}

interface Word {
  end: number;
  start: number;
}

const NOTE_MARKER = "//";

export function quickAddHighlightTokens(line: string, title: string): QuickAddHighlightToken[] {
  const words = splitWords(line);
  if (words.length === 0) return [];

  const tokens: QuickAddHighlightToken[] = [];
  let considered = words;
  const markerAt = line.indexOf(NOTE_MARKER);
  const hasNote = markerAt !== -1;
  if (hasNote) {
    tokens.push({ end: line.length, kind: "note", start: markerAt });
    considered = words.filter((word) => word.end <= markerAt);
  }

  const titleWords = splitWords(title).map((word) => normalised(title.slice(word.start, word.end)));
  const lineWords = considered.map((word) => normalised(line.slice(word.start, word.end)));
  const kept = commonSubsequence(lineWords, titleWords);

  considered.forEach((word, index) => {
    if (kept.has(index)) return;
    tokens.push({ ...word, kind: kindOf(line.slice(word.start, word.end)) });
  });

  return tokens.sort((a, b) => a.start - b.start);
}

function splitWords(text: string): Word[] {
  return [...text.matchAll(/\S+/g)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
  }));
}

function normalised(word: string): string {
  return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function kindOf(word: string): QuickAddHighlightKind {
  switch (word[0]) {
    case "#":
      return "tag";
    case "~":
      return "folder";
    case "!":
      return "priority";
    default:
      return "when";
  }
}

/** Indices into `a` of one longest subsequence shared with `b`. */
function commonSubsequence(a: string[], b: string[]): Set<number> {
  const kept = new Set<number>();
  if (a.length === 0 || b.length === 0) return kept;

  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(i);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }

  return kept;
}
