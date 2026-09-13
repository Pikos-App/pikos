// Differential fuzzing for the recurrence port.
//
// `recurrence.json` grades four functions against 35 hand-written cases. That
// was enough to find nothing, which is the same thing the 317-input parser
// corpus said right up until a fuzzer found six divergence classes in it. The
// recurrence surface has at least as much edge to it: leap days, month ends a
// month does not have, `BYDAY=3TU`, `COUNT` and `UNTIL` interacting with
// exdates, all-day versus timed, and a DST boundary the wall-clock contract
// says must not move anything.
//
// So this generates rules and anchors by composition, runs the TypeScript
// reference over all four functions, and writes what it got.
// `crates/pikos-core/tests/recurrence_fuzz.rs` grades the Rust side against it.
//
//   pnpm --filter @pikos/core gen:fuzz-recurrence
//   FUZZ_CASES=20000 FUZZ_SEED=7 pnpm --filter @pikos/core gen:fuzz-recurrence
//
// Deterministic: same seed and count, byte-identical output.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { PageRecurrenceRule, PageSummary } from "../../src/types";
import {
  computeNextEnd,
  expandRecurrenceForRange,
  nextOccurrenceAfter,
  snapAnchorToRule,
} from "../../src/utils/recurrence";

/** mulberry32 — small, fast, reproducible. */
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

type Random = () => number;

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
/** Ordinal weekdays — "the third Tuesday", and the last Friday. */
const ORDINAL_WEEKDAYS = ["1MO", "2TU", "3TU", "4WE", "-1FR", "-1SU"] as const;
/** Month days chosen for the months that do not have them. */
const MONTH_DAYS = ["1", "15", "28", "29", "30", "31", "-1"] as const;

/**
 * Anchors chosen for their edges: a leap day, the day after one, month ends,
 * both sides of the 2026 EU DST transition, a year end, and ordinary days to
 * keep the distribution honest.
 */
const ANCHORS = [
  "2024-02-29",
  "2024-02-29T09:00:00",
  "2024-03-01T00:00:00",
  "2026-01-31",
  "2026-01-31T23:30:00",
  "2026-02-28T12:00:00",
  "2026-03-15T12:00:00",
  "2026-03-28T01:30:00",
  "2026-03-29T02:30:00",
  "2026-03-29T03:30:00",
  "2026-03-31T00:00:00",
  "2026-04-30T23:59:00",
  "2026-06-15T14:45:00",
  "2026-10-25T02:30:00",
  "2026-12-31T23:00:00",
  "2027-01-01T00:00:00",
  "2026-03-16T09:00:00",
  "2026-05-01",
];

function makeRrule(random: Random): string {
  const parts: string[] = [`FREQ=${pick(random, FREQUENCIES)}`];
  const freq = parts[0]!.slice(5);

  if (random() < 0.45) {
    if (freq === "MONTHLY" || freq === "YEARLY") {
      // Ordinal weekdays only mean anything on a monthly or yearly rule.
      parts.push(
        random() < 0.5
          ? `BYDAY=${pick(random, ORDINAL_WEEKDAYS)}`
          : `BYMONTHDAY=${pick(random, MONTH_DAYS)}`
      );
    } else {
      const days = new Set<string>();
      const count = 1 + Math.floor(random() * 3);
      for (let i = 0; i < count; i++) days.add(pick(random, WEEKDAYS));
      parts.push(`BYDAY=${[...days].join(",")}`);
    }
  }
  if (random() < 0.35) parts.push(`INTERVAL=${1 + Math.floor(random() * 5)}`);
  // A rule that names its own hour is the only thing that distinguishes
  // "snap keeps the anchor's wall-clock time" from "snap keeps whatever time
  // the occurrence came out at" — every other rule inherits its time from
  // DTSTART, which makes the two indistinguishable.
  if (random() < 0.15) {
    parts.push(`BYHOUR=${Math.floor(random() * 24)}`);
    if (random() < 0.5) parts.push(`BYMINUTE=${Math.floor(random() * 60)}`);
  }
  const bound = random();
  if (bound < 0.2) parts.push(`COUNT=${1 + Math.floor(random() * 12)}`);
  else if (bound < 0.4) parts.push(`UNTIL=${pick(random, UNTILS)}`);
  return parts.join(";");
}

const UNTILS = [
  "20260101T235959Z",
  "20260331T235959Z",
  "20260401T000000Z",
  "20260630T235959Z",
  "20261231T235959Z",
  "20270630T235959Z",
];

/** Dates near the anchors, so an exdate has a real chance of landing on one. */
function makeExdates(random: Random, anchor: string): string[] {
  if (random() < 0.55) return [];
  const day = anchor.slice(0, 10);
  const base = new Date(`${day}T00:00:00Z`);
  const out = new Set<string>();
  const count = 1 + Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    const shifted = new Date(base);
    shifted.setUTCDate(shifted.getUTCDate() + Math.floor(random() * 40));
    out.add(shifted.toISOString().slice(0, 10));
  }
  return [...out].sort();
}

const RANGES: [string, string][] = [
  ["2026-03-01", "2026-04-30"],
  ["2024-02-01", "2024-04-01"],
  ["2026-03-27", "2026-03-31"],
  ["2026-12-01", "2027-02-01"],
  ["2026-01-01", "2027-01-01"],
];

const TEMPLATE_PAGE = {
  content: "{}",
  createdAt: "2026-03-01T00:00:00",
  folderId: null,
  id: "page-1",
  priority: 0,
  status: "not_started",
  tags: [],
  title: "Template",
  updatedAt: "2026-03-01T00:00:00",
} as unknown as PageSummary;

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

function capture<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}

interface Case {
  rrule: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  exdates: string[];
  afterDate: string;
  rangeStart: string;
  rangeEnd: string;
  next: unknown;
  nextEnd: unknown;
  snapped: unknown;
  occurrences: unknown;
}

function main(): void {
  const root = packageRoot();
  if (process.env["TZ"] !== "UTC") {
    throw new Error(`TZ must be UTC (got ${process.env["TZ"] ?? "unset"})`);
  }

  const seed = Number(process.env["FUZZ_SEED"] ?? 1);
  const wanted = Number(process.env["FUZZ_CASES"] ?? 400);
  const outPath = resolve(
    root,
    process.env["FUZZ_OUT"] ?? "../../crates/pikos-core/tests/corpus/recurrence-fuzz.json"
  );
  const random = makeRandom(seed);

  // Deduplicated on the whole input tuple: the same rule and anchor at the same
  // range tests nothing twice.
  const seen = new Set<string>();
  const cases: Case[] = [];
  let threw = 0;

  for (let attempts = 0; cases.length < wanted && attempts < wanted * 20; attempts++) {
    const rrule = makeRrule(random);
    const scheduledStart = pick(random, ANCHORS);
    const isAllDay = !scheduledStart.includes("T");
    // An end only exists for a timed series, and must be after the start.
    const scheduledEnd =
      isAllDay || random() < 0.4
        ? null
        : new Date(
            new Date(`${scheduledStart}Z`).getTime() + (30 + Math.floor(random() * 300)) * 60000
          )
            .toISOString()
            .slice(0, 19);
    const exdates = makeExdates(random, scheduledStart);
    // "next occurrence after X" takes a full datetime; a date-only anchor
    // stands for midnight on that day.
    const chosenAfter = pick(random, ANCHORS);
    const afterDate = chosenAfter.includes("T") ? chosenAfter : `${chosenAfter}T00:00:00`;
    const [rangeStart, rangeEnd] = pick(random, RANGES);

    const key = [
      rrule,
      scheduledStart,
      scheduledEnd,
      exdates.join(","),
      afterDate,
      rangeStart,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    const rule: PageRecurrenceRule = {
      createdAt: "2026-03-01T00:00:00",
      id: "rule-1",
      pageId: TEMPLATE_PAGE.id,
      rrule,
      rruleExdates: exdates,
      scheduledStart,
      timezone: "UTC",
      ...(scheduledEnd === null ? {} : { scheduledEnd }),
    };

    const next = capture(() =>
      nextOccurrenceAfter(rrule, scheduledStart, new Date(`${afterDate}Z`), exdates)
    );
    const nextEnd = capture(() => {
      const n = nextOccurrenceAfter(rrule, scheduledStart, new Date(`${afterDate}Z`), exdates);
      return n && scheduledEnd ? computeNextEnd(scheduledEnd, n.scheduledStart) : null;
    });
    const snapped = capture(() => snapAnchorToRule(rrule, scheduledStart));
    const occurrences = capture(() =>
      expandRecurrenceForRange(
        rule,
        TEMPLATE_PAGE,
        new Date(`${rangeStart}T00:00:00Z`),
        new Date(`${rangeEnd}T00:00:00Z`)
      ).map((o) => ({
        originalDate: o.originalDate,
        scheduledEnd: o.scheduledEnd ?? null,
        scheduledStart: o.scheduledStart,
      }))
    );
    for (const captured of [next, nextEnd, snapped, occurrences]) {
      if (!captured.ok) threw += 1;
    }

    cases.push({
      afterDate,
      exdates,
      next,
      nextEnd,
      occurrences,
      rangeEnd,
      rangeStart,
      rrule,
      scheduledEnd,
      scheduledStart,
      snapped,
    });
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        cases,
        meta: {
          generatedBy: "packages/core/scripts/parser-grammar/fuzz-recurrence.ts",
          note:
            "Randomly composed recurrence rules and anchors, run through the " +
            "TypeScript reference. Regenerate with " +
            "`pnpm --filter @pikos/core gen:fuzz-recurrence`.",
          seed,
          timezone: "UTC",
        },
      },
      null,
      2
    ) + "\n"
  );

  process.stdout.write(`${cases.length} cases, ${threw} throwing\nout: ${outPath}\n`);
}

main();
