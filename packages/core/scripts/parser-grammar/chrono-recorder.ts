// A recording stand-in for chrono-node.
//
// Aliased over the real module when bundling `measure.ts`, so the parser is
// measured exactly as it runs — no instrumentation in parser.ts, and no
// second copy of its pre-processing to drift from the first.
//
// The real module is loaded through `createRequire` rather than imported.
// A static import would be caught by the very alias that installs this
// recorder and redirect straight back into itself; a runtime require is
// resolved by Node, after bundling, so it reaches the genuine package — and
// without hard-coding a version-pinned path into the repo.

import { createRequire } from "node:module";

import type * as ChronoNode from "chrono-node";

const real = createRequire(import.meta.url)("chrono-node") as typeof ChronoNode;

export interface RecordedCall {
  fn: "parse" | "parseDate";
  /** Text as it reached chrono — after the parser's own rewriting. */
  text: string;
  /** The substring chrono claimed, or null when it found no date. */
  matched: string | null;
  index: number | null;
  /** Field granularities chrono was certain about. Drives the parser's branching. */
  certain: string[];
  /** Whether chrono parsed a range. */
  hasEnd: boolean;
}

export const calls: RecordedCall[] = [];

const GRANULARITIES = ["hour", "minute", "second", "day", "month", "year", "weekday"] as const;

export function parse(
  text: string,
  ref?: unknown,
  opts?: unknown
): ReturnType<typeof real.parse> {
  const results = real.parse(text, ref as Date, opts as Parameters<typeof real.parse>[2]);
  const first = results[0];
  calls.push({
    certain: first ? GRANULARITIES.filter((g) => first.start.isCertain(g)) : [],
    fn: "parse",
    hasEnd: Boolean(first?.end),
    index: first ? first.index : null,
    matched: first ? first.text : null,
    text,
  });
  return results;
}

export function parseDate(text: string, ref?: unknown, opts?: unknown): Date | null {
  const result = real.parseDate(text, ref as Date, opts as Parameters<typeof real.parseDate>[2]);
  calls.push({
    certain: [],
    fn: "parseDate",
    hasEnd: false,
    index: null,
    matched: result ? text : null,
    text,
  });
  return result;
}
