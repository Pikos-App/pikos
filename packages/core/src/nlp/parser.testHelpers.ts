// Test helpers for the NL parser suite.
//
// Two pieces:
//   1. `runCases` — table-driven assertion runner. Each row is `{ input,
//      expected }`; the runner picks the right shape-specific matcher based
//      on `expected.type`. Replaces ~12 lines of `parseInput → expect.type
//      → narrow → expect.input` boilerplate per case with a one-line entry.
//   2. `forAll` — minimal property-based runner. Generates N random inputs
//      from a seed-table of fragments and asserts an invariant holds. Used
//      to catch compositional bugs no enumerable test will surface (random
//      orderings, overlong inputs, weird whitespace).

import { RRule } from "rrule";
import { expect } from "vitest";

import type { ParsedInput, ParseResult } from "./parser";
import { parseInput } from "./parser";

// ─── runCases — table-driven ─────────────────────────────────────────────────

/** Keys that must be undefined or absent on the parsed input. */
type InputAbsent = readonly (keyof ParsedInput)[];

/** Regex patterns each field must match — used when the value floats (date or
 * time depends on chrono's reference handling, so exact-equality isn't safe). */
type InputMatches = Partial<Record<keyof ParsedInput, RegExp>>;

export type Expectation =
  | {
      type: "single";
      input?: Partial<ParsedInput>;
      inputAbsent?: InputAbsent;
      inputMatches?: InputMatches;
      /** Escape hatch: arbitrary assertion run after the type check. */
      custom?: (r: Extract<ParseResult, { type: "single" }>) => void;
    }
  | {
      type: "recurring";
      /** Substrings the rrule must contain (e.g. ["BYDAY=MO", "INTERVAL=2"]). */
      rrule: string[];
      /** Substrings the rrule must NOT contain. Useful for "no UNTIL" checks. */
      rruleAbsent?: string[];
      /** Optional partial assertion on baseInput (title, scheduledStart, etc.). */
      input?: Partial<ParsedInput>;
      inputAbsent?: InputAbsent;
      inputMatches?: InputMatches;
      /** RRULE expansion check: count occurrences from a synthetic DTSTART. */
      expansion?: { dtstart: string; count: number };
      custom?: (r: Extract<ParseResult, { type: "recurring" }>) => void;
    }
  | {
      type: "finite";
      count: number;
      /** Asserts every page in `inputs` matches this shape (title, time, etc.). */
      eachInput?: Partial<ParsedInput>;
      /** Per-index assertions; sparse — element at index N is matched against inputs[N]. */
      inputs?: (Partial<ParsedInput> | undefined)[];
      custom?: (r: Extract<ParseResult, { type: "finite" }>) => void;
    };

export interface ParserCase {
  /** Input string passed to parseInput. */
  input: string;
  /** Reference date (defaults to the suite NOW). */
  now?: Date;
  /** Expected ParseResult shape + relevant fields. */
  expected: Expectation;
}

/**
 * Asserts a single case. Fails with the input string in the failure message.
 * Use directly or via `describe.each` / `it.each` for grouped tables.
 */
export function assertCase(c: ParserCase, defaultNow: Date): void {
  const r = parseInput(c.input, c.now ?? defaultNow);
  expect(r.type, `parsing "${c.input}"`).toBe(c.expected.type);

  if (c.expected.type === "single" && r.type === "single") {
    if (c.expected.input) expect(r.input).toMatchObject(c.expected.input);
    assertInputAbsent(r.input, c.expected.inputAbsent, c.input);
    assertInputMatches(r.input, c.expected.inputMatches, c.input);
    c.expected.custom?.(r);
    return;
  }

  if (c.expected.type === "recurring" && r.type === "recurring") {
    for (const fragment of c.expected.rrule) {
      expect(r.rrule, `rrule for "${c.input}"`).toContain(fragment);
    }
    for (const fragment of c.expected.rruleAbsent ?? []) {
      expect(r.rrule, `rrule for "${c.input}"`).not.toContain(fragment);
    }
    if (c.expected.input) expect(r.input).toMatchObject(c.expected.input);
    assertInputAbsent(r.input, c.expected.inputAbsent, c.input);
    assertInputMatches(r.input, c.expected.inputMatches, c.input);
    if (c.expected.expansion) {
      const { count, dtstart } = c.expected.expansion;
      const rule = RRule.fromString(`DTSTART:${dtstart}\nRRULE:${r.rrule}`);
      expect(rule.all().length, `expansion for "${c.input}"`).toBe(count);
    }
    c.expected.custom?.(r);
    return;
  }

  if (c.expected.type === "finite" && r.type === "finite") {
    expect(r.count).toBe(c.expected.count);
    expect(r.inputs).toHaveLength(c.expected.count);
    if (c.expected.eachInput) {
      for (const inp of r.inputs) expect(inp).toMatchObject(c.expected.eachInput);
    }
    if (c.expected.inputs) {
      for (let i = 0; i < c.expected.inputs.length; i++) {
        const expectedInp = c.expected.inputs[i];
        if (expectedInp) expect(r.inputs[i]).toMatchObject(expectedInp);
      }
    }
    c.expected.custom?.(r);
  }
}

function assertInputAbsent(
  input: ParsedInput,
  keys: InputAbsent | undefined,
  inputStr: string
): void {
  for (const key of keys ?? []) {
    expect(input[key], `${String(key)} should be absent for "${inputStr}"`).toBeUndefined();
  }
}

function assertInputMatches(
  input: ParsedInput,
  matches: InputMatches | undefined,
  inputStr: string
): void {
  if (!matches) return;
  for (const [key, pattern] of Object.entries(matches) as [keyof ParsedInput, RegExp][]) {
    const value = input[key];
    expect(typeof value === "string" ? value : String(value), `${key} for "${inputStr}"`).toMatch(
      pattern
    );
  }
}

// ─── forAll — minimal property-based runner ─────────────────────────────────
//
// Not as nice as fast-check (no shrinking, no replay), but adequate for
// invariant checks on a parser. The seed argument is logged on failure so
// failures are reproducible in a follow-up imperative test.

export interface FuzzOptions {
  runs?: number;
  seed?: number;
}

/**
 * Tiny LCG so we don't pull in a PRNG dep. Deterministic given the seed.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const TAGS = ["work", "home", "urgent", "review", "ops", "weekly"];
const FOLDERS = ["Projects", "Personal", "Engineering", "Inbox"];
const PRIORITIES = ["!urgent", "!high", "!medium", "!low", "!1", "!2", "!3", "!4", "!0"];
const TIMES = ["3pm", "9am", "noon", "midnight", "9:30am", "5p"];
const DATES = [
  "tomorrow",
  "next monday",
  "this friday",
  "in 3 days",
  "april 18",
  "march 5",
  "tonight",
  "tomorrow morning",
];
const DURATIONS = ["for 30m", "for 1h", "for 2 hours", "for 45 minutes"];
const RECURRENCE = [
  "every monday",
  "every other tuesday",
  "every weekday",
  "daily",
  "weekly",
  "every 2 weeks",
];
const TITLES = ["call mom", "review pr", "write notes", "buy groceries", "team sync", ""];

/**
 * Picks 0-2 fragments from each pool, shuffles, joins with a random
 * separator (space, double-space, tab). Used to stress-test composition.
 */
function genInput(rng: () => number): string {
  const pick = <T>(arr: readonly T[], maxN: number): T[] => {
    const n = Math.floor(rng() * (maxN + 1));
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(rng() * arr.length)]!);
    return out;
  };

  const fragments: string[] = [
    ...pick(TITLES, 1),
    ...pick(TAGS, 2).map((t) => `#${t}`),
    ...pick(FOLDERS, 1).map((f) => `~${f}`),
    ...pick(PRIORITIES, 1),
    ...pick(DATES, 1),
    ...pick(TIMES, 1).map((t) => `at ${t}`),
    ...pick(DURATIONS, 1),
    ...pick(RECURRENCE, 1),
  ];

  // Shuffle (Fisher-Yates).
  for (let i = fragments.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [fragments[i], fragments[j]] = [fragments[j]!, fragments[i]!];
  }

  const seps = [" ", "  ", " "];
  return fragments
    .filter(Boolean)
    .map((f, i) => (i === 0 ? f : seps[Math.floor(rng() * seps.length)]! + f))
    .join("");
}

/**
 * Runs `predicate` against `runs` randomly generated parser inputs. The
 * predicate is given the input string AND the parsed result. Throw or
 * return false to fail. The seed (used by the harness) is logged on
 * failure so the input can be reproduced.
 */
export function forAll(
  predicate: (input: string, r: ReturnType<typeof parseInput>) => boolean | void,
  opts: FuzzOptions = {}
): void {
  const seed = opts.seed ?? 0xc0ffee;
  const runs = opts.runs ?? 100;
  const rng = makeRng(seed);
  const failures: Array<{ input: string; error: unknown }> = [];

  for (let i = 0; i < runs; i++) {
    const input = genInput(rng);
    try {
      const r = parseInput(input);
      const result = predicate(input, r);
      if (result === false) {
        failures.push({ error: "predicate returned false", input });
      }
    } catch (e) {
      failures.push({ error: e, input });
    }
  }

  if (failures.length > 0) {
    const sample = failures.slice(0, 3);
    const msg = sample
      .map((f) => `  input: ${JSON.stringify(f.input)}\n  error: ${String(f.error)}`)
      .join("\n\n");
    throw new Error(
      `forAll: ${failures.length}/${runs} runs failed (seed ${seed}). First ${sample.length}:\n${msg}`
    );
  }
}
