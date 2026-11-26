// Ground truth for the Rust date engine, recorded in situ. `date-corpus.ts` pins what each
// expression resolves to, but the engine is handed a whole title ("call the plumber tomorrow at
// 3pm"), where the match extent matters (the parser cuts `[index, index + text.length)` out of
// the title) and so does choosing among several date-ish candidates.
//
// Every corpus input runs through the real parser with the recording stand-in in chrono's place,
// at every pinned reference time, and the first `parse` call is captured: the text as chrono
// received it (after the parser's rewriting) and the full result.
//
// Re-run with `pnpm --filter @pikos/core gen:date-calls`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseInput } from "../../src/nlp/parser";
import { calls, type RecordedResult } from "./chrono-recorder";

/** The parser corpus's reference times. */
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

interface Case {
  /** What the user typed; context only, not the engine's input. */
  input: string;
  ref: string;
  /** What chrono was handed, after the parser's rewriting. */
  text: string;
  /** Null when chrono found no date. */
  result: RecordedResult | null;
}

function main(): void {
  const root = packageRoot();
  if (process.env["TZ"] !== "UTC") {
    throw new Error(`TZ must be UTC (got ${process.env["TZ"] ?? "unset"})`);
  }

  const corpusPath = resolve(root, "../../crates/pikos-core/tests/corpus/parser.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { cases: { input: string }[] };
  const inputs = [...new Set(corpus.cases.map((c) => c.input))].sort();

  // Different inputs can yield the same (text, ref) after the parser's rewriting. One case each,
  // so the corpus grades distinct engine behaviour and duplicates don't count as coverage.
  const seen = new Set<string>();
  const cases: Case[] = [];

  for (const ref of REFERENCES) {
    const now = new Date(ref.iso);
    for (const input of inputs) {
      calls.length = 0;
      parseInput(input, now);
      const call = calls.find((c) => c.fn === "parse");
      if (!call) continue;

      const key = `${ref.id}|${call.text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      cases.push({ input, ref: ref.id, result: call.result, text: call.text });
    }
  }

  const out = resolve(root, "../../crates/pikos-core/tests/corpus/date-calls.json");
  writeFileSync(
    out,
    JSON.stringify(
      {
        cases,
        meta: {
          generatedBy: "packages/core/scripts/parser-grammar/call-corpus.ts",
          note:
            "What chrono-node was asked, and answered, for every parser-corpus " +
            "input at every pinned reference — recorded through the real parser, " +
            "so the text is post-pre-processing and the match extents are the " +
            "ones the parser cuts out of the title.",
          references: REFERENCES,
          timezone: "UTC",
        },
      },
      null,
      2
    ) + "\n"
  );

  const matched = cases.filter((c) => c.result !== null).length;
  process.stdout.write(
    `${inputs.length} inputs × ${REFERENCES.length} refs → ${cases.length} distinct calls ` +
      `(${matched} matched, ${cases.length - matched} no date)\nout: ${out}\n`
  );
}

main();
