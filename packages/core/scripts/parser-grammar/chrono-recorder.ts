// A recording stand-in for chrono-node, aliased over the real module when bundling `measure.ts`,
// so the parser is measured as it runs, with no instrumentation in parser.ts.
//
// The real module loads through `createRequire` because a static import would be caught by the
// alias that installs this recorder and redirect into itself. A runtime require resolves after
// bundling and reaches the genuine package, without a version-pinned path in the repo.

import { createRequire } from "node:module";

import type * as ChronoNode from "chrono-node";

const real = createRequire(import.meta.url)("chrono-node") as typeof ChronoNode;

/** What the parser reads back off a chrono result. */
export interface RecordedResult {
  index: number;
  text: string;
  start: string;
  startCertain: string[];
  end: string | null;
  endCertain: string[];
}

export interface RecordedCall {
  fn: "parse" | "parseDate";
  /** After the parser's rewriting. */
  text: string;
  /** The substring chrono claimed; null when it found no date. */
  matched: string | null;
  index: number | null;
  /** Field granularities chrono was certain about; drives the parser's branching. */
  certain: string[];
  hasEnd: boolean;
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
