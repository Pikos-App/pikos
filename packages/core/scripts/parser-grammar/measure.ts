// How much of chrono-node does the quick-add parser actually need?
//
// The Rust port's estimate turns on this. parser.ts is 861 lines, but only
// three of them call chrono, and the file's bulk is pre-processing that
// rewrites casual phrasing ("tonight", "this afternoon", "last monday") into
// explicit forms. So the question is not how big parser.ts is — it is what
// grammar survives that rewriting and reaches chrono, because that is the part
// with no Rust equivalent.
//
// Every input in the parity corpus is run through the real parser with a
// recording stand-in installed in chrono's place, and the matched text is
// classified. Re-run it whenever the corpus grows:
//
//   pnpm --filter @pikos/core measure:parser-grammar
//
// Caveat worth keeping in view when reading the output: the corpus is drawn
// from the test suite, which is what the author thought to test rather than
// what users actually type. It is a lower bound on the grammar, not a census.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseInput } from "../../src/nlp/parser";
import { calls } from "./chrono-recorder";

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

/** Fixed reference so the classification is reproducible. */
const NOW = new Date("2026-03-15T12:00:00");

interface CorpusCase {
  input: string;
}

const TIME = String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})`;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
const WEEKDAY = "(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*";

/** Grammar families, in the order they are tested. */
function classify(raw: string): string {
  const t = raw.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return "ISO date";
  // Ranges are recognised before the single-value families, because every
  // range is built from two of them. The hyphen form has to allow a meridiem
  // before the separator ("9am-5pm") as well as a bare digit ("apr 5-9").
  if (/\bto\b|\bthrough\b|–|—|(?<=[\dm])-(?=\d)/.test(t)) return "range";
  if (new RegExp(`^(?:at\\s+)?${TIME}$`).test(t)) return "bare time";
  if (["noon", "midnight", "morning", "afternoon", "evening", "night"].includes(t)) {
    return "named time of day";
  }
  if (/^in \d+ \w+$/.test(t)) return "relative offset";
  if (/^(?:next|this|last)\s+(?:week|month|year|weekend)$/.test(t)) return "relative period";
  if (/^\d{1,2}\/\d{1,2}(?:\s+at\s+.*)?$/.test(t)) return "numeric date";
  if (new RegExp(`^(?:today|tomorrow)(?:\\s+at\\s+${TIME})?$`).test(t)) return "today/tomorrow";
  if (new RegExp(`^(?:on\\s+|next\\s+|this\\s+)?${WEEKDAY}(?:\\s+(?:at\\s+)?${TIME})?$`).test(t)) {
    return "weekday";
  }
  if (new RegExp(MONTH).test(t)) return "month-day";
  return "unclassified";
}

function main(): void {
  const root = packageRoot();
  const corpusPath = resolve(root, "../../crates/pikos-core/tests/corpus/parser.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { cases: CorpusCase[] };
  const inputs = [...new Set(corpus.cases.map((c) => c.input))].sort();

  const byFamily = new Map<string, Set<string>>();
  const familyCounts = new Map<string, number>();
  let reached = 0;

  for (const input of inputs) {
    calls.length = 0;
    parseInput(input, NOW);
    const match = calls.find((c) => c.fn === "parse" && c.matched !== null)?.matched;
    if (match == null) continue;

    reached += 1;
    const family = classify(match);
    const normalised = match.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family)!.add(normalised);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  const families = [...byFamily.entries()]
    .map(([family, forms]) => ({
      distinctForms: [...forms].sort(),
      family,
      inputs: familyCounts.get(family) ?? 0,
    }))
    .sort((a, b) => b.inputs - a.inputs);

  const report = {
    corpusInputs: inputs.length,
    families,
    generatedBy: "packages/core/scripts/parser-grammar/measure.ts",
    note:
      "Grammar the Rust parser must support, measured by recording what the " +
      "current parser asks of chrono-node. Drawn from the test corpus, so a " +
      "lower bound on real usage rather than a census.",
    reachedChrono: reached,
  };

  const outPath = resolve(root, "../../docs/ios/parser-grammar.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

  process.stdout.write(
    `${inputs.length} corpus inputs; ${reached} reached chrono\n` +
      families
        .map((f) => `  ${f.family.padEnd(20)} ${String(f.inputs).padStart(3)} inputs, ${f.distinctForms.length} forms`)
        .join("\n") +
      `\nout: ${outPath}\n`
  );
}

main();
