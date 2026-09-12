// Golden-corpus generator for the TS → Rust port of the NL parser and
// recurrence math.
//
// The port's acceptance bar (iOS plan §4) is: "every ported Rust function gets
// a parity test comparing against the TS original on a fixture corpus before
// the TS path is deleted." This script produces that corpus. It runs the
// current TypeScript implementation — the reference, by definition — over every
// input the test-suite exercises, at several pinned reference times, and
// freezes the results as JSON the Rust crate reads back.
//
// Determinism requirements, both enforced below rather than documented and
// hoped for:
//   - TZ must be pinned. The suite's NOW is `new Date("2026-03-15T12:00:00")`
//     with no zone suffix, so it is *local* time; the same input parsed in
//     Europe/London and America/New_York yields different ISO output.
//   - Reference times are explicit, never `new Date()`.
//
// Inputs are scraped from parser.test.ts so the corpus tracks the suite instead
// of drifting from it, then supplemented with cases that exercise paths the
// table-driven tests reach only indirectly.
//
// Usage:  TZ=UTC node --experimental-strip-types scripts/gen-parity-corpus.ts
// or via: pnpm gen:parity

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseInput } from "../src/nlp/parser";
import type { PageRecurrenceRule, PageSummary } from "../src/types";
import {
  computeNextEnd,
  expandRecurrenceForRange,
  nextOccurrenceAfter,
} from "../src/utils/recurrence";

/**
 * Locate the @pikos/core package root by walking up from the working
 * directory. Resolving against `import.meta.url` would be the obvious choice
 * but breaks the moment the script is bundled — the bundle lives elsewhere and
 * every relative path silently retargets. Anchoring on a marker file fails
 * loudly instead.
 */
function packageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    const manifest = resolve(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (pkg.name === "@pikos/core") return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("run this from within packages/core — @pikos/core package root not found");
    }
    dir = parent;
  }
}

const ROOT = packageRoot();
const OUT_DIR = resolve(ROOT, "../../crates/pikos-core/tests/corpus");

const EXPECTED_TZ = "UTC";

function assertEnvironment(): void {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (process.env["TZ"] !== EXPECTED_TZ) {
    throw new Error(
      `TZ must be set to ${EXPECTED_TZ} (got ${process.env["TZ"] ?? "unset"}). ` +
        `The suite's reference times are zone-less and therefore local; an ` +
        `unpinned zone produces a corpus that only reproduces on one machine.`
    );
  }
  if (tz !== EXPECTED_TZ) {
    throw new Error(`resolved timezone is ${tz}, expected ${EXPECTED_TZ}`);
  }
}

// ─── Reference times ─────────────────────────────────────────────────────────
// NOW matches parser.test.ts. The others are the alternate references the suite
// reaches for when it needs a different weekday or hour-of-day, plus a DST
// boundary and a leap day — both places where date math historically breaks and
// where a naive Rust port is most likely to diverge.

const REFERENCES: { id: string; iso: string; note: string }[] = [
  { id: "sun_noon", iso: "2026-03-15T12:00:00", note: "suite NOW — Sunday, midday" },
  { id: "wed_noon", iso: "2026-03-18T12:00:00", note: "midweek — forward-date rollover differs" },
  { id: "mon_morning", iso: "2026-03-16T08:00:00", note: "before 9am — 'today vs tomorrow' flips" },
  { id: "sat_late", iso: "2026-03-21T22:30:00", note: "after 8pm — 'tonight' rolls to tomorrow" },
  { id: "dst_eve", iso: "2026-03-28T12:00:00", note: "eve of EU DST change" },
  { id: "leap_day", iso: "2024-02-29T09:00:00", note: "leap day" },
  { id: "year_end", iso: "2026-12-31T23:00:00", note: "year boundary" },
];

// ─── Input extraction ────────────────────────────────────────────────────────

function scrapeTestInputs(): string[] {
  const src = readFileSync(resolve(ROOT, "src/nlp/parser.test.ts"), "utf8");
  const found = new Set<string>();
  // Matches `input: "…"` rows in the table-driven cases. Escaped quotes inside
  // an input would break this; assert none appear rather than silently
  // truncating a case.
  for (const m of src.matchAll(/input:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const raw = m[1]!;
    if (raw.includes('\\"')) {
      throw new Error(`corpus scraper cannot represent escaped quotes: ${raw}`);
    }
    found.add(raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\"));
  }
  return [...found];
}

// Cases the table-driven suite covers only via `custom` assertions or property
// runs, plus adversarial shapes a port is likely to get wrong.
const SUPPLEMENTARY_INPUTS: string[] = [
  "",
  "   ",
  "task with no date at all",
  "meeting tonight",
  "meeting tonight at 9pm",
  "lunch this afternoon",
  "review tomorrow morning",
  "call last monday",
  "sync next friday at 3pm",
  "trip april 18-25",
  "workshop from monday to friday",
  "block 3pm to 5pm",
  "standup every other monday at 9am",
  "review every 3 weeks",
  "gym every weekday at 6am until june 1",
  "task @march20",
  "task 3/16",
  "task 16/3",
  "deadline by may 1",
  "party on friday",
  "#tag-only",
  "~folder-only",
  "!high !low !urgent",
  "meeting at 25:00",
  "meeting on february 30",
  "a".repeat(500),
  "task #a#b#c",
  "task    with     irregular   spacing",
  "MEETING TOMORROW AT 2PM",
];

// ─── Recurrence corpus ───────────────────────────────────────────────────────
// nextOccurrenceAfter / computeNextEnd / expandRecurrenceForRange are the three
// functions the Rust CLI currently shells to Node for, so they are the port's
// first target and need their own fixtures independent of the parser.

const RECURRENCE_CASES: {
  rrule: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  afterDate: string;
  exdates: string[];
}[] = [
  {
    afterDate: "2026-03-16T10:00:00",
    exdates: [],
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    scheduledEnd: "2026-03-16T09:30:00",
    scheduledStart: "2026-03-16T09:00:00",
  },
  {
    afterDate: "2026-03-18T09:00:00",
    exdates: ["2026-03-20"],
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    scheduledEnd: null,
    scheduledStart: "2026-03-16T09:00:00",
  },
  {
    afterDate: "2026-03-19T00:00:00",
    exdates: [],
    rrule: "FREQ=DAILY;INTERVAL=2",
    scheduledEnd: null,
    scheduledStart: "2026-03-15",
  },
  {
    afterDate: "2026-01-31T00:00:00",
    exdates: [],
    rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
    scheduledEnd: null,
    scheduledStart: "2026-01-31",
  },
  {
    afterDate: "2026-03-17T14:00:00",
    exdates: [],
    rrule: "FREQ=MONTHLY;BYDAY=3TU",
    scheduledEnd: "2026-03-17T15:00:00",
    scheduledStart: "2026-03-17T14:00:00",
  },
  {
    afterDate: "2024-03-01T00:00:00",
    exdates: [],
    rrule: "FREQ=YEARLY",
    scheduledEnd: null,
    scheduledStart: "2024-02-29",
  },
  {
    afterDate: "2026-03-30T09:00:00",
    exdates: [],
    rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260401T000000Z",
    scheduledEnd: null,
    scheduledStart: "2026-03-16T09:00:00",
  },
  {
    afterDate: "2026-03-30T09:00:00",
    exdates: [],
    rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    scheduledEnd: null,
    scheduledStart: "2026-03-16T09:00:00",
  },
  {
    afterDate: "2026-03-28T12:00:00",
    exdates: [],
    rrule: "FREQ=DAILY",
    scheduledEnd: "2026-03-28T13:00:00",
    scheduledStart: "2026-03-28T12:00:00",
  },
  {
    afterDate: "2026-03-20T22:00:00",
    exdates: [],
    // Overnight event: end wall-clock (01:00) is earlier than start (22:00),
    // so computeNextEnd must roll the end onto the following calendar day.
    // Without a fixture here the `nextEnd <= nextStart` boundary is untested,
    // and a port that writes `<` passes everything else.
    rrule: "FREQ=WEEKLY;BYDAY=FR",
    scheduledEnd: "2026-03-21T01:00:00",
    scheduledStart: "2026-03-20T22:00:00",
  },
  {
    afterDate: "2026-03-15T09:00:00",
    exdates: [],
    // Zero-length event: end equals start, which is the exact `<=` boundary.
    // The TS original rolls this forward a day; `<` would leave it collapsed.
    rrule: "FREQ=DAILY",
    scheduledEnd: "2026-03-15T09:00:00",
    scheduledStart: "2026-03-15T09:00:00",
  },
  {
    afterDate: "2026-03-21T00:00:00",
    exdates: [],
    // All-day series with a timed-looking end — computeNextEnd must return
    // null rather than inventing a time.
    rrule: "FREQ=WEEKLY;BYDAY=SA",
    scheduledEnd: null,
    scheduledStart: "2026-03-21",
  },
  {
    afterDate: "2026-03-15T09:00:00",
    exdates: ["2026-03-16", "2026-03-17"],
    // Every candidate in range excluded — exercises the skip loop's exhaustion
    // path rather than its happy path.
    rrule: "FREQ=DAILY;COUNT=3",
    scheduledEnd: null,
    scheduledStart: "2026-03-15T09:00:00",
  },
];

const EXPANSION_CASES: {
  id: string;
  rrule: string;
  scheduledStart: string;
  scheduledEnd?: string;
  exdates: string[];
  rangeStart: string;
  rangeEnd: string;
}[] = [
  {
    exdates: [],
    id: "weekly_monday",
    rangeEnd: "2026-04-30",
    rangeStart: "2026-03-01",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    scheduledEnd: "2026-03-16T09:30:00",
    scheduledStart: "2026-03-16T09:00:00",
  },
  {
    exdates: ["2026-03-23"],
    id: "weekly_monday_with_exdate",
    rangeEnd: "2026-04-30",
    rangeStart: "2026-03-01",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    scheduledEnd: "2026-03-16T09:30:00",
    scheduledStart: "2026-03-16T09:00:00",
  },
  {
    exdates: [],
    id: "daily_all_day",
    rangeEnd: "2026-03-31",
    rangeStart: "2026-03-15",
    rrule: "FREQ=DAILY",
    scheduledStart: "2026-03-15",
  },
  {
    exdates: [],
    // Short months: rrule skips months without a 31st rather than clamping.
    id: "monthly_31st",
    rangeEnd: "2026-12-31",
    rangeStart: "2026-01-01",
    rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
    scheduledStart: "2026-01-31",
  },
  {
    exdates: [],
    id: "weekend_days",
    rangeEnd: "2026-05-31",
    rangeStart: "2026-03-01",
    rrule: "FREQ=WEEKLY;BYDAY=SA,SU",
    scheduledStart: "2026-03-21",
  },
  {
    exdates: [],
    // Spans the EU DST transition (2026-03-29) — wall-clock time must hold at
    // 09:00 on both sides of the jump, which is the whole point of storing
    // local wall-clock rather than instants.
    id: "daily_across_dst",
    rangeEnd: "2026-04-02",
    rangeStart: "2026-03-25",
    rrule: "FREQ=DAILY",
    scheduledEnd: "2026-03-27T10:00:00",
    scheduledStart: "2026-03-27T09:00:00",
  },
];

/** Minimal PageSummary. Expansion copies page fields through untouched, so the
 *  values are irrelevant to the logic under test — only the occurrence dates
 *  the expander computes are projected into the corpus below. */
const TEMPLATE_PAGE: PageSummary = {
  createdAt: "2026-03-01T00:00:00",
  folderId: null,
  id: "page-0000",
  priority: 0,
  sortOrder: 0,
  status: "not_started",
  tags: [],
  title: "template",
  updatedAt: "2026-03-01T00:00:00",
};

// ─── Capture ─────────────────────────────────────────────────────────────────
// Errors are captured, not thrown. A Rust port must reproduce the TS behaviour
// on malformed input too, and "this input throws" is part of that behaviour.

type Captured<T> = { ok: true; value: T } | { ok: false; error: string };

function capture<T>(fn: () => T): Captured<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ok: false };
  }
}

function main(): void {
  assertEnvironment();

  const inputs = [...new Set([...scrapeTestInputs(), ...SUPPLEMENTARY_INPUTS])].sort();

  const parserCases = [];
  for (const ref of REFERENCES) {
    const now = new Date(ref.iso);
    if (Number.isNaN(now.getTime())) throw new Error(`bad reference time: ${ref.iso}`);
    for (const input of inputs) {
      parserCases.push({
        input,
        ref: ref.id,
        result: capture(() => parseInput(input, now)),
      });
    }
  }

  const recurrenceCases = RECURRENCE_CASES.map((c) => {
    const next = capture(() =>
      nextOccurrenceAfter(c.rrule, c.scheduledStart, new Date(c.afterDate), c.exdates)
    );
    const nextEnd = capture(() => {
      const n = nextOccurrenceAfter(c.rrule, c.scheduledStart, new Date(c.afterDate), c.exdates);
      return n && c.scheduledEnd ? computeNextEnd(c.scheduledEnd, n.scheduledStart) : null;
    });
    return { ...c, next, nextEnd };
  });

  const expansionCases = EXPANSION_CASES.map((c) => {
    // `exactOptionalPropertyTypes` is on, so an absent end must be omitted
    // rather than set to undefined — the two are not interchangeable here.
    const rule: PageRecurrenceRule = {
      createdAt: "2026-03-01T00:00:00",
      id: `rule-${c.id}`,
      pageId: TEMPLATE_PAGE.id,
      rrule: c.rrule,
      rruleExdates: c.exdates,
      scheduledStart: c.scheduledStart,
      timezone: EXPECTED_TZ,
      ...(c.scheduledEnd === undefined ? {} : { scheduledEnd: c.scheduledEnd }),
    };
    // Project to the three fields expansion actually computes. The rest of a
    // VirtualOccurrence is the template page copied through, which would bloat
    // the fixture without testing anything.
    const occurrences = capture(() =>
      expandRecurrenceForRange(
        rule,
        TEMPLATE_PAGE,
        new Date(c.rangeStart),
        new Date(c.rangeEnd)
      ).map((o) => ({
        originalDate: o.originalDate,
        scheduledEnd: o.scheduledEnd ?? null,
        scheduledStart: o.scheduledStart,
      }))
    );
    return { ...c, occurrences };
  });

  const meta = {
    generatedBy: "packages/core/scripts/gen-parity-corpus.ts",
    note:
      "Golden output of the TypeScript reference implementation. Regenerate with " +
      "`pnpm --filter @pikos/core gen:parity` after any intentional behaviour change, " +
      "and review the diff — an unexpected line here is a regression, not a rebase.",
    references: REFERENCES,
    timezone: EXPECTED_TZ,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    resolve(OUT_DIR, "parser.json"),
    JSON.stringify({ cases: parserCases, inputCount: inputs.length, meta }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "recurrence.json"),
    JSON.stringify({ expansionCases, meta, recurrenceCases }, null, 2) + "\n"
  );

  const failures = parserCases.filter((c) => !c.result.ok).length;
  process.stdout.write(
    `parser.json:     ${parserCases.length} cases (${inputs.length} inputs × ${REFERENCES.length} refs), ${failures} throwing\n` +
      `recurrence.json: ${recurrenceCases.length} next-occurrence, ${expansionCases.length} expansion\n` +
      `out: ${OUT_DIR}\n`
  );
}

main();
