// Differential fuzzing: does the Rust parser agree with this one on inputs
// nobody thought to write down?
//
// `parser.json` is 317 inputs scraped from the test suite. That is what the
// author thought to test, which is a lower bound on what people type — and the
// port passing all of it says nothing about the space around it. The Rust
// parser is a pipeline whose *order* is load-bearing (cadence before date,
// intervals before day words, "biweekly" before "weekly"), and order bugs do
// not show up in inputs written one feature at a time. They show up when a
// line carries four features in an order nobody tried.
//
// So this composes lines out of fragments in random order, runs them through
// the reference, and writes what it got. `crates/pikos-core/tests/
// quick_add_fuzz.rs` grades the Rust parser against it.
//
//   pnpm --filter @pikos/core gen:fuzz                 # the committed corpus
//   FUZZ_CASES=20000 FUZZ_SEED=7 pnpm --filter @pikos/core gen:fuzz
//
// Deterministic: the same seed and count give byte-identical output, so a
// regeneration that changes the file means behaviour changed.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseInput } from "../../src/nlp/parser";

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

/** mulberry32 — small, fast, and reproducible across Node versions. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Fragments ───────────────────────────────────────────────────────────────
// Every group is something the parser handles separately, so mixing them is
// what exercises the interactions. The awkward members are deliberate: "may"
// as a bare month, "second" as both an ordinal and a time unit, day-of-month
// forms the date engine cannot read on its own.

const TITLES = [
  "call bob",
  "standup",
  "review the deck",
  "pay rent",
  "gym",
  "buy milk and eggs",
  "1:1 with sam",
  "ship it",
  "read chapter 3",
  "the second draft",
  "may day planning",
  "march madness bracket",
  "water the plants",
  "renew passport",
  "café meeting",
  "🎉 launch party",
  "a".repeat(80),
];

const DATES = [
  "today",
  "tomorrow",
  "next friday",
  "this monday",
  "monday",
  "on friday",
  "march 20",
  "may 1",
  "apr 13 2026",
  "3/16",
  "16/3",
  "2026-04-01",
  "in 3 days",
  "in 2 weeks",
  "next week",
  "on the 24th",
  "by the 1st",
  "sat 24",
  "last monday",
  "march",
  "sept",
];

const TIMES = [
  "at 3pm",
  "9am",
  "14:00",
  "at 11:59pm",
  "at 12am",
  "noon",
  "midnight",
  "morning",
  "this evening",
  "tomorrow night",
  "at 3:30pm",
  "tonight",
];

const RANGES = [
  "3pm to 5pm",
  "9am-5pm",
  "9pm to 5am",
  "april 18-25",
  "dec 28 to jan 3",
  "monday to friday",
  "may 2 to 10",
  "from 9am to 11am",
  "april 25 to april 18",
  "may 2 through 10",
];

const CADENCES = [
  "every monday",
  "every tuesday and thursday",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "biweekly",
  "fortnightly",
  "bimonthly",
  "every other tuesday",
  "every 3 days",
  "every 2 weeks",
  "m/w/f",
  "mon/wed/fri",
  "every m/w/f",
  "weekdays",
  "every weekday",
  "every weekend",
  "mondays",
  "tuesdays and thursdays",
  "every week",
];

const WINDOWS = [
  "for 2 weeks",
  "for 3 days",
  "for 1 month",
  "10 times",
  "through march 31",
  "until june 1",
  "till friday",
];

const DURATIONS = ["for 2h", "for 45m", "for 1.5 hours", "for 90 minutes", "for 1hr"];

const MARKERS = [
  "#work",
  "#home",
  "#work #urgent",
  "~inbox",
  "~Projects",
  "!urgent",
  "!high",
  "!low",
  "!0",
  "!3",
  "@tomorrow",
];

/** Junk that has no business parsing, to catch over-matching. */
const NOISE = [
  "section 24",
  "12345",
  "v1.2.3",
  "part 2 of 3",
  "3rd draft",
  "100% done",
  "a/b test",
  "re: the thing",
  "TODO: fix",
  "(draft)",
  "may",
  "second",
  "-",
  "",
];

const GROUPS = [TITLES, DATES, TIMES, RANGES, CADENCES, WINDOWS, DURATIONS, MARKERS, NOISE];

type Random = () => number;

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** Spacing and casing the way people actually type. */
function roughen(random: Random, text: string): string {
  let out = text;
  const roll = random();
  if (roll < 0.08) out = out.toUpperCase();
  else if (roll < 0.14) out = out.replace(/\b\w/g, (c) => c.toUpperCase());
  if (random() < 0.1) out = out.replace(/ /g, "  ");
  if (random() < 0.08) out = ` ${out} `;
  if (random() < 0.08) out = `${out}.`;
  if (random() < 0.05) out = `${out},`;
  return out;
}

/** One line: a handful of fragments from different groups, shuffled. */
function makeInput(random: Random): string {
  // Occasionally emit something with no structure at all — a parser that only
  // ever sees well-formed lines is not being tested.
  if (random() < 0.04) {
    const length = 1 + Math.floor(random() * 20);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 #~!@/:-.,";
    let out = "";
    for (let i = 0; i < length; i++) out += pick(random, [...alphabet]);
    return out;
  }

  const count = 1 + Math.floor(random() * 4);
  const chosen: string[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    let group = Math.floor(random() * GROUPS.length);
    // Two fragments from the same group is a realistic mistake ("tomorrow
    // next friday"), just not the common case.
    if (used.has(group) && random() < 0.7) group = (group + 1) % GROUPS.length;
    used.add(group);
    chosen.push(pick(random, GROUPS[group]!));
  }
  // Shuffle: the order features appear in is exactly what the pipeline's
  // ordering rules are sensitive to.
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j]!, chosen[i]!];
  }
  return roughen(random, chosen.filter(Boolean).join(" ")).slice(0, 300);
}

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

function main(): void {
  const root = packageRoot();
  if (process.env["TZ"] !== "UTC") {
    throw new Error(`TZ must be UTC (got ${process.env["TZ"] ?? "unset"})`);
  }

  const seed = Number(process.env["FUZZ_SEED"] ?? 1);
  const wanted = Number(process.env["FUZZ_CASES"] ?? 1200);
  const outPath = resolve(
    root,
    process.env["FUZZ_OUT"] ?? "../../crates/pikos-core/tests/corpus/parser-fuzz.json"
  );
  // Inputs that once diverged between the two implementations. Always included,
  // whatever the seed — a regression case is worth more than a random one.
  const regressionsPath = resolve(root, "scripts/parser-grammar/fuzz-regressions.json");
  let regressions: string[] = [];
  try {
    regressions = JSON.parse(readFileSync(regressionsPath, "utf8")) as string[];
  } catch {
    // None recorded yet.
  }

  const random = makeRandom(seed);
  const inputs = new Set<string>(regressions);
  // Bounded: the fragment space is finite, so asking for more unique lines than
  // exist would spin forever.
  for (let attempts = 0; inputs.size < wanted && attempts < wanted * 50; attempts++) {
    inputs.add(makeInput(random));
  }

  // A line like "mon/wed/fri 10 times" expands to a two-thousand-page series
  // — "fri 10" resolves to a date, leaving "2026  times" to be read as a
  // count. Recording those in full is 12MB of JSON and a minute of comparison
  // for one behaviour, which a unit test pins far more cheaply. They are
  // skipped rather than dropped: the count and the inputs are written out, so
  // the omission is visible rather than a silent hole in the corpus.
  const MAX_SERIES = 30;

  const cases: { input: string; ref: string; result: unknown }[] = [];
  const skipped: { input: string; ref: string; series: number }[] = [];
  let threw = 0;
  for (const input of [...inputs].sort()) {
    for (const ref of REFERENCES) {
      let result: unknown;
      try {
        const value = parseInput(input, new Date(ref.iso));
        if (value.type === "finite" && value.inputs.length > MAX_SERIES) {
          skipped.push({ input, ref: ref.id, series: value.inputs.length });
          continue;
        }
        result = { ok: true, value };
      } catch (error) {
        threw += 1;
        result = { error: error instanceof Error ? error.message : String(error), ok: false };
      }
      cases.push({ input, ref: ref.id, result });
    }
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cases,
        meta: {
          generatedBy: "packages/core/scripts/parser-grammar/fuzz.ts",
          maxSeries: MAX_SERIES,
          note:
            "Randomly composed quick-add lines, run through the TypeScript " +
            "reference. Regenerate with `pnpm --filter @pikos/core gen:fuzz`; " +
            "the seed and count are fixed, so a diff here means behaviour changed.",
          references: REFERENCES,
          seed,
          timezone: "UTC",
        },
        skipped,
      },
      null,
      2
    ) + "\n"
  );

  process.stdout.write(
    `${inputs.size} inputs (${regressions.length} regression) × ${REFERENCES.length} refs ` +
      `= ${cases.length} cases, ${threw} throwing, ` +
      `${skipped.length} skipped for series > ${MAX_SERIES}\nout: ${outPath}\n`
  );
}

main();
