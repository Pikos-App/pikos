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

/** Everything the parser reads back off a chrono result. */
export interface RecordedResult {
  index: number;
  text: string;
  /** Local wall-clock ISO, matching how Pikos stores dates. */
  start: string;
  startCertain: string[];
  end: string | null;
  endCertain: string[];
}

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
  /** The first result in full, or null when chrono found no date. */
  result: RecordedResult | null;
}

export const calls: RecordedCall[] = [];

const GRANULARITIES = ["hour", "minute", "second", "day", "month", "year", "weekday"] as const;

function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function parse(text: string, ref?: unknown, opts?: unknown): ReturnType<typeof real.parse> {
  const results = real.parse(text, ref as Date, opts as Parameters<typeof real.parse>[2]);
  const first = results[0];
  calls.push({
    certain: first ? GRANULARITIES.filter((g) => first.start.isCertain(g)) : [],
    fn: "parse",
    hasEnd: Boolean(first?.end),
    index: first ? first.index : null,
    matched: first ? first.text : null,
    result: first
      ? {
          end: first.end ? localIso(first.end.date()) : null,
          endCertain: first.end ? GRANULARITIES.filter((g) => first.end!.isCertain(g)) : [],
          index: first.index,
          start: localIso(first.start.date()),
          startCertain: GRANULARITIES.filter((g) => first.start.isCertain(g)),
          text: first.text,
        }
      : null,
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
    result: null,
    text,
  });
  return result;
}
