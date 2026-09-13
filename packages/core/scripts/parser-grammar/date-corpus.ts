// Ground truth for the Rust date-expression engine.
//
// The parser hands chrono a string and reads four things back: the matched
// span, per-field certainty, the resolved start, and a range end. Those four
// are the whole of what chrono-node does for Pikos — see
// docs/ios/04-parser-grammar.md — so they are what a replacement has to
// reproduce.
//
// This records all four for every distinct expression the corpus exercises, at
// every pinned reference time, by calling chrono directly. Development-grade
// detail: the acceptance bar remains the full parser corpus, which exercises
// these through the parser rather than around it.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import type * as ChronoNode from "chrono-node";

const chrono = createRequire(import.meta.url)("chrono-node") as typeof ChronoNode;

const GRANULARITIES = ["hour", "minute", "second", "day", "month", "year", "weekday"] as const;

/** Matches the reference times in the parser corpus. */
const REFERENCES: { id: string; iso: string }[] = [
  { id: "sun_noon", iso: "2026-03-15T12:00:00" },
  { id: "wed_noon", iso: "2026-03-18T12:00:00" },
  { id: "mon_morning", iso: "2026-03-16T08:00:00" },
  { id: "sat_late", iso: "2026-03-21T22:30:00" },
  { id: "dst_eve", iso: "2026-03-28T12:00:00" },
  { id: "leap_day", iso: "2024-02-29T09:00:00" },
  { id: "year_end", iso: "2026-12-31T23:00:00" },
];

function packageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
        name?: string;
      };
      if (pkg.name === "@pikos/core") return dir;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("run this from within packages/core");
    dir = parent;
  }
}

/** Local wall-clock ISO, matching how Pikos stores dates. */
function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

interface Case {
  expression: string;
  ref: string;
  /** Null when chrono found no date in the expression. */
  result: {
    index: number;
    text: string;
    start: string;
    startCertain: string[];
    end: string | null;
    endCertain: string[];
  } | null;
}

function main(): void {
  const root = packageRoot();
  if (process.env["TZ"] !== "UTC") {
    throw new Error(`TZ must be UTC (got ${process.env["TZ"] ?? "unset"})`);
  }

  const grammar = JSON.parse(
    readFileSync(resolve(root, "../../docs/ios/parser-grammar.json"), "utf8")
  ) as { families: { family: string; distinctForms: string[] }[] };

  const expressions = [...new Set(grammar.families.flatMap((f) => f.distinctForms))].sort();

  const cases: Case[] = [];
  for (const ref of REFERENCES) {
    const now = new Date(ref.iso);
    for (const expression of expressions) {
      const [first] = chrono.parse(expression, now, { forwardDate: true });
      cases.push({
        expression,
        ref: ref.id,
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
      });
    }
  }

  const out = resolve(root, "../../crates/pikos-core/tests/corpus/date-expressions.json");
  writeFileSync(
    out,
    JSON.stringify(
      {
        cases,
        expressionCount: expressions.length,
        meta: {
          generatedBy: "packages/core/scripts/parser-grammar/date-corpus.ts",
          note:
            "What chrono-node returns for every date expression the parser corpus " +
            "exercises. Ground truth for the Rust engine that replaces it.",
          references: REFERENCES,
          timezone: "UTC",
        },
      },
      null,
      2
    ) + "\n"
  );

  const unmatched = cases.filter((c) => c.result === null).length;
  process.stdout.write(
    `${expressions.length} expressions × ${REFERENCES.length} refs = ${cases.length} cases ` +
      `(${unmatched} with no match)\nout: ${out}\n`
  );
}

main();
