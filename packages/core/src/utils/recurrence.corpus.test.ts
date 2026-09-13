// ─── Conformance corpus — a regression fixture, no longer a live oracle ───────
//
// The committed JSON is genuine rrule.js output, captured when `recurrence.ts`
// still wrapped it, and the Rust engine must keep matching it byte for byte. What
// changed with the wasm harvest is where a *regeneration* now reads from:
// `recurrence.ts` calls the same engine under test, so `GEN_CORPUS=1` would
// re-bless whatever the engine currently does. Regenerate only against a real
// rrule.js install (see `scripts/gen-rrule-goldens.mjs`), and treat
// `rrule_js_goldens.rs` as the external oracle.
//
// It runs as a golden-file guard: normally it regenerates in-memory and asserts
// equality with the committed fixture, so any drift in rrule.js behavior (a
// version bump, a change to the wrapper semantics) fails here and forces a
// regenerate + Rust re-check. Regenerate with `GEN_CORPUS=1 pnpm --filter
// @pikos/core test recurrence.corpus`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PageRecurrenceRule, PageSummary } from "../types";
import { parseLocalISO } from "./dates";
import {
  alignWeeklyRuleToAnchor,
  buildRrule,
  computeNextEnd,
  expandRecurrenceForRange,
  missedOccurrencesBetween,
  nextOccurrenceAfter,
  parseRrule,
  rruleToShortLabel,
  snapAnchorToRule,
} from "./recurrence";

const CORPUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../crates/pikos-recurrence/tests/fixtures/corpus.json"
);

function page(): PageSummary {
  return {
    createdAt: "2026-01-01T00:00:00",
    folderId: null,
    id: "page-1",
    isRecurring: true,
    links: [],
    priority: 0,
    scheduledEnd: null,
    scheduledStart: null,
    scheduleLocked: false,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: "Corpus",
    updatedAt: "2026-01-01T00:00:00",
  };
}

function rule(
  rrule: string,
  start: string,
  end: string | null,
  exdates: string[] = []
): PageRecurrenceRule {
  return {
    createdAt: "2026-01-01T00:00:00",
    id: "rule-1",
    pageId: "page-1",
    rrule,
    rruleExdates: exdates,
    scheduledStart: start,
    timezone: "America/New_York",
    ...(end !== null ? { scheduledEnd: end } : {}),
  };
}

// ─── Case inputs (divergence-prone RRULE features are the point) ──────────────

interface ExpandCase {
  name: string;
  rrule: string;
  start: string;
  end: string | null;
  exdates?: string[];
  rangeStart: string;
  rangeEnd: string;
}

// Monday 2026-03-02 09:00 is the shared timed anchor; all-day cases use date-only.
const EXPAND_CASES: ExpandCase[] = [
  {
    end: "2026-03-02T09:30:00",
    name: "daily timed",
    rangeEnd: "2026-03-09T00:00:00",
    rangeStart: "2026-03-02T00:00:00",
    rrule: "FREQ=DAILY",
    start: "2026-03-02T09:00:00",
  },
  {
    end: "2026-03-02T10:00:00",
    name: "weekly single BYDAY",
    rangeEnd: "2026-03-31T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    start: "2026-03-02T09:00:00",
  },
  {
    // BYSETPOS beyond the period's candidate count selects nothing (no month has a
    // 10th Monday) — the empty-period path, terminating rather than looping.
    end: "2026-03-02T10:00:00",
    name: "monthly BYSETPOS out of range yields nothing",
    rangeEnd: "2026-06-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=10",
    start: "2026-03-02T09:00:00",
  },
  {
    end: "2026-03-02T10:00:00",
    name: "weekly multi BYDAY",
    rangeEnd: "2026-03-15T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    start: "2026-03-02T09:00:00",
  },
  {
    end: "2026-03-03T10:00:00",
    name: "weekly interval=2 WKST=MO (default)",
    rangeEnd: "2026-04-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
    start: "2026-03-03T09:00:00",
  },
  {
    end: "2026-03-03T10:00:00",
    name: "weekly interval=2 WKST=SU (shifts grouping)",
    rangeEnd: "2026-04-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU",
    start: "2026-03-03T09:00:00",
  },
  // Sun+Mon straddle the week boundary, so WKST genuinely changes the interval grouping.
  {
    end: "2026-03-01T10:00:00",
    name: "weekly interval=2 BYDAY=SU,MO WKST=MO",
    rangeEnd: "2026-04-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO",
    start: "2026-03-01T09:00:00",
  },
  {
    end: "2026-03-01T10:00:00",
    name: "weekly interval=2 BYDAY=SU,MO WKST=SU",
    rangeEnd: "2026-04-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU",
    start: "2026-03-01T09:00:00",
  },
  {
    end: "2026-01-15T09:30:00",
    name: "monthly BYMONTHDAY=15",
    rangeEnd: "2026-06-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYMONTHDAY=15",
    start: "2026-01-15T09:00:00",
  },
  {
    end: "2026-01-31T09:30:00",
    name: "monthly BYMONTHDAY=-1 (last day)",
    rangeEnd: "2026-06-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYMONTHDAY=-1",
    start: "2026-01-31T09:00:00",
  },
  {
    end: "2026-01-31T09:30:00",
    name: "monthly BYMONTHDAY=31 (skips short months)",
    rangeEnd: "2026-08-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
    start: "2026-01-31T09:00:00",
  },
  {
    end: "2026-01-30T09:30:00",
    name: "monthly BYSETPOS=-1 last weekday",
    rangeEnd: "2026-06-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    start: "2026-01-30T09:00:00",
  },
  {
    end: "2026-01-05T09:30:00",
    name: "monthly BYDAY=1MO (first Monday ordinal)",
    rangeEnd: "2026-06-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYDAY=1MO",
    start: "2026-01-05T09:00:00",
  },
  {
    end: "2026-01-30T09:30:00",
    name: "monthly BYDAY=-1FR (last Friday ordinal)",
    rangeEnd: "2026-06-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYDAY=-1FR",
    start: "2026-01-30T09:00:00",
  },
  {
    // BYSETPOS over a BYMONTHDAY set — supported but never paired above; picks the
    // first & last of {1st, 15th, last-day} each month.
    end: "2026-01-01T09:30:00",
    name: "monthly BYMONTHDAY + BYSETPOS",
    rangeEnd: "2026-04-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=MONTHLY;BYMONTHDAY=1,15,-1;BYSETPOS=1,-1",
    start: "2026-01-01T09:00:00",
  },
  {
    end: "2026-02-14T10:00:00",
    name: "yearly",
    rangeEnd: "2030-01-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=YEARLY",
    start: "2026-02-14T09:00:00",
  },
  {
    end: "2026-03-02T09:30:00",
    name: "count-limited",
    rangeEnd: "2026-04-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=DAILY;COUNT=5",
    start: "2026-03-02T09:00:00",
  },
  {
    end: "2026-03-02T10:00:00",
    name: "until-limited",
    rangeEnd: "2026-05-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260330T235959Z",
    start: "2026-03-02T09:00:00",
  },
  {
    end: "2026-03-02T09:30:00",
    exdates: ["2026-03-03", "2026-03-04"],
    name: "count-vs-exdate (count applies pre-exclusion)",
    rangeEnd: "2026-04-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=DAILY;COUNT=5",
    start: "2026-03-02T09:00:00",
  },
  {
    // A synced cancelled instance: the exdate is stored as full wall-clock, but
    // occurrences match by day. Both engines must day-key it and drop Mar 16.
    end: "2026-03-02T10:00:00",
    exdates: ["2026-03-16T09:00:00"],
    name: "weekly timed exdate (full wall-clock)",
    rangeEnd: "2026-03-31T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    start: "2026-03-02T09:00:00",
  },
  {
    end: null,
    name: "all-day weekly",
    rangeEnd: "2026-03-31T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    start: "2026-03-02",
  },
  {
    end: "2026-03-01T10:00:00",
    name: "weekly Sunday across spring-forward (wall-clock preserved)",
    rangeEnd: "2026-03-22T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=SU",
    start: "2026-03-01T09:00:00",
  },
  {
    end: "2026-10-30T10:00:00",
    name: "daily across fall-back",
    rangeEnd: "2026-11-04T00:00:00",
    rangeStart: "2026-10-30T00:00:00",
    rrule: "FREQ=DAILY",
    start: "2026-10-30T09:00:00",
  },
  // Real provider RRULEs lifted from the CalDAV/ICS fixtures.
  {
    end: "2026-01-06T10:00:00",
    name: "provider weekly TU,TH count=12",
    rangeEnd: "2026-03-01T00:00:00",
    rangeStart: "2026-01-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=12",
    start: "2026-01-06T09:00:00",
  },
  {
    end: "2026-03-03T10:00:00",
    name: "provider weekly TU interval=2 until",
    rangeEnd: "2026-07-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=TU;INTERVAL=2;UNTIL=20260511T235959Z",
    start: "2026-03-03T09:00:00",
  },
  // UNTIL forms providers emit beyond the T235959Z form the rest of the corpus uses.
  {
    end: "2026-03-02T10:00:00",
    name: "until date-only form",
    rangeEnd: "2026-05-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260315",
    start: "2026-03-02T09:00:00",
  },
  {
    end: "2026-03-02T10:00:00",
    name: "until datetime no-Z form",
    rangeEnd: "2026-05-01T00:00:00",
    rangeStart: "2026-03-01T00:00:00",
    rrule: "FREQ=DAILY;UNTIL=20260315T100000",
    start: "2026-03-02T09:00:00",
  },
  // Leap-day yearly anchor: only leap years have a Feb 29.
  {
    end: "2024-02-29T10:00:00",
    name: "leap-day yearly anchor",
    rangeEnd: "2033-01-01T00:00:00",
    rangeStart: "2024-01-01T00:00:00",
    rrule: "FREQ=YEARLY",
    start: "2024-02-29T09:00:00",
  },
];

// Seeded property cases: deterministic pseudo-random rules across the supported
// envelope. Hand-picked cases above pin known divergences; these catch unknown
// ones on each regeneration without introducing nondeterminism.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

interface PropertyCase {
  rrule: string;
  start: string;
  rangeStart: string;
  rangeEnd: string;
}

function propertyExpandCases(): PropertyCase[] {
  const rand = mulberry32(0x9e3779b9);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const cases: PropertyCase[] = [];

  for (let i = 0; i < 32; i++) {
    const freq = pick(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const);
    const parts = [`FREQ=${freq}`, `INTERVAL=${int(1, 4)}`];
    if (freq === "WEEKLY") {
      const days = WEEKDAY_CODES.filter(() => rand() < 0.4);
      if (days.length === 0) days.push(pick(WEEKDAY_CODES));
      parts.push(`BYDAY=${days.join(",")}`);
      if (rand() < 0.3) parts.push(`WKST=${pick(["MO", "SU"])}`);
    } else if (freq === "MONTHLY") {
      if (rand() < 0.5) {
        parts.push(`BYMONTHDAY=${pick([1, 15, 28, 31, -1])}`);
      } else {
        parts.push(`BYDAY=${WEEKDAY_CODES.filter(() => rand() < 0.5).join(",") || "MO"}`);
        if (rand() < 0.5) parts.push(`BYSETPOS=${pick([1, 2, -1])}`);
      }
    }
    // COUNT bounds each case to a handful of occurrences (keeps the fixture
    // small) while still exercising the enumeration + COUNT interaction.
    parts.push(`COUNT=${int(3, 8)}`);
    // Day 5 exists in every month, keeping the anchor rule-agnostic.
    const startMonth = String(int(1, 12)).padStart(2, "0");
    cases.push({
      rangeEnd: "2033-01-01T00:00:00",
      rangeStart: "2026-01-01T00:00:00",
      rrule: parts.join(";"),
      start: `2026-${startMonth}-05T08:15:00`,
    });
  }
  return cases;
}

interface NextCase {
  name: string;
  rrule: string;
  start: string;
  after: string;
  exdates?: string[];
}

const NEXT_CASES: NextCase[] = [
  {
    after: "2026-03-02T12:00:00",
    name: "simple next",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    start: "2026-03-02T09:00:00",
  },
  {
    after: "2026-03-02T12:00:00",
    exdates: ["2026-03-03", "2026-03-04"],
    name: "skips exdates",
    rrule: "FREQ=DAILY",
    start: "2026-03-02T09:00:00",
  },
  {
    after: "2026-03-20T00:00:00",
    name: "past until returns null",
    rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260309T235959Z",
    start: "2026-03-02T09:00:00",
  },
  {
    after: "2026-03-02T00:00:00",
    name: "all-day next",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    start: "2026-03-02",
  },
  {
    after: "2027-06-01T00:00:00",
    name: "far-future seek (no drop under 500-cap)",
    rrule: "FREQ=DAILY",
    start: "2026-01-01T08:00:00",
  },
  // Far-future seek for the non-daily frequencies — bases years before `after`,
  // so seek_near's WEEKLY/MONTHLY/YEARLY period approximation is load-bearing.
  {
    after: "2027-06-01T00:00:00",
    name: "far-future seek WEEKLY;INTERVAL=2;WKST=SU",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU",
    start: "2020-01-01T08:00:00",
  },
  {
    after: "2027-06-01T00:00:00",
    name: "far-future seek MONTHLY BYSETPOS=-1 last weekday",
    rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    start: "2020-01-01T08:00:00",
  },
  {
    after: "2027-06-01T00:00:00",
    name: "far-future seek YEARLY;INTERVAL=2",
    rrule: "FREQ=YEARLY;INTERVAL=2",
    start: "2020-03-15T08:00:00",
  },
];

interface AnchorCase {
  name: string;
  rrule: string;
  anchor: string;
}

const SNAP_CASES: AnchorCase[] = [
  {
    anchor: "2026-03-01T09:00:00",
    name: "snaps Sunday anchor to first M/W/F",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  },
  {
    anchor: "2026-03-02T09:00:00",
    name: "anchor already valid",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  },
  { anchor: "2026-03-02", name: "all-day snap", rrule: "FREQ=WEEKLY;BYDAY=WE" },
  {
    anchor: "2026-03-02T09:00:00",
    name: "exhausted rule unchanged",
    rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T000000Z",
  },
];

const ALIGN_CASES: { name: string; rrule: string; anchor: string }[] = [
  {
    anchor: "2026-03-04T09:00:00",
    name: "single BYDAY realigns to moved weekday",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
  },
  {
    anchor: "2026-03-04T09:00:00",
    name: "multi BYDAY unchanged",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  },
  { anchor: "2026-03-04T09:00:00", name: "non-weekly unchanged", rrule: "FREQ=DAILY" },
  {
    anchor: "2026-03-04T09:00:00",
    name: "already aligned unchanged",
    rrule: "FREQ=WEEKLY;BYDAY=WE",
  },
];

interface MissedCase {
  name: string;
  rrule: string;
  start: string;
  after: string;
  before: string;
  exdates?: string[];
}

const MISSED_CASES: MissedCase[] = [
  {
    after: "2026-03-02T00:00:00",
    before: "2026-03-06T00:00:00",
    name: "daily gap",
    rrule: "FREQ=DAILY",
    start: "2026-03-02T09:00:00",
  },
  {
    after: "2026-03-02T00:00:00",
    before: "2026-03-06T00:00:00",
    exdates: ["2026-03-04"],
    name: "daily gap with exdate",
    rrule: "FREQ=DAILY",
    start: "2026-03-02T09:00:00",
  },
  {
    after: "2026-03-06T00:00:00",
    before: "2026-03-02T00:00:00",
    name: "empty when before <= after",
    rrule: "FREQ=DAILY",
    start: "2026-03-02T09:00:00",
  },
];

const NEXT_END_CASES: { name: string; baseEnd: string; nextStart: string }[] = [
  { baseEnd: "2026-03-02T10:00:00", name: "same-day duration", nextStart: "2026-03-09T09:00:00" },
  {
    baseEnd: "2026-03-03T01:00:00",
    name: "overnight rolls to next day",
    nextStart: "2026-03-09T22:00:00",
  },
  { baseEnd: "2026-03-02", name: "all-day yields null", nextStart: "2026-03-09" },
];

const LABEL_CASES = [
  "FREQ=DAILY",
  "FREQ=WEEKLY;BYDAY=MO",
  "FREQ=WEEKLY;INTERVAL=2",
  "FREQ=MONTHLY;BYMONTHDAY=15",
  "FREQ=YEARLY",
  "FREQ=DAILY;COUNT=10",
  "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260628T235959Z",
];

const ROUNDTRIP_CASES = [
  "FREQ=DAILY",
  "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
  "FREQ=MONTHLY;COUNT=12",
  "FREQ=YEARLY;UNTIL=20301231T235959Z",
  "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
  "FREQ=WEEKLY;BYDAY=SA,SU;WKST=SU",
  "FREQ=MONTHLY;BYMONTHDAY=15",
  "FREQ=MONTHLY;BYMONTHDAY=-1",
  // Provider terms the editor never authors, but must not drop on a save.
  "FREQ=MONTHLY;BYDAY=1MO",
  "FREQ=MONTHLY;BYDAY=-1FR",
  "FREQ=MONTHLY;BYDAY=MO,2WE",
  "FREQ=WEEKLY;BYDAY=MO;BYMONTH=6,7",
  "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
  "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
];

function generateCorpus() {
  return {
    alignWeekly: ALIGN_CASES.map((c) => ({
      ...c,
      expected: alignWeeklyRuleToAnchor(c.rrule, c.anchor),
    })),
    computeNextEnd: NEXT_END_CASES.map((c) => ({
      ...c,
      expected: computeNextEnd(c.baseEnd, c.nextStart),
    })),
    expandRange: EXPAND_CASES.map((c) => ({
      ...c,
      exdates: c.exdates ?? [],
      expected: expandRecurrenceForRange(
        rule(c.rrule, c.start, c.end, c.exdates ?? []),
        page(),
        parseLocalISO(c.rangeStart),
        parseLocalISO(c.rangeEnd)
      ).map((o) => ({
        originalDate: o.originalDate,
        scheduledEnd: o.scheduledEnd,
        scheduledStart: o.scheduledStart,
      })),
    })),
    generatedFrom: "rrule.js ^2.8.1 (captured; see the header before regenerating)",
    missedBetween: MISSED_CASES.map((c) => ({
      ...c,
      exdates: c.exdates ?? [],
      expected: missedOccurrencesBetween(
        c.rrule,
        c.start,
        parseLocalISO(c.after),
        parseLocalISO(c.before),
        c.exdates ?? []
      ),
    })),
    nextAfter: NEXT_CASES.map((c) => ({
      ...c,
      exdates: c.exdates ?? [],
      expected: nextOccurrenceAfter(c.rrule, c.start, parseLocalISO(c.after), c.exdates ?? []),
    })),
    // Compact date-only parity for the seeded property rules — start/end
    // formatting is already pinned by the hand-written expandRange cases.
    propertyExpand: propertyExpandCases().map((c) => ({
      ...c,
      dates: expandRecurrenceForRange(
        rule(c.rrule, c.start, `${c.start.slice(0, 10)}T09:15:00`),
        page(),
        parseLocalISO(c.rangeStart),
        parseLocalISO(c.rangeEnd)
      )
        .map((o) => o.originalDate)
        .join(","),
    })),
    roundtrip: ROUNDTRIP_CASES.map((rrule) => {
      const options = parseRrule(rrule);
      return { built: options ? buildRrule(options) : null, options, rrule };
    }),
    shortLabel: LABEL_CASES.map((rrule) => ({ expected: rruleToShortLabel(rrule), rrule })),
    snapAnchor: SNAP_CASES.map((c) => ({ ...c, expected: snapAnchorToRule(c.rrule, c.anchor) })),
  };
}

describe("recurrence conformance corpus", () => {
  it("matches the committed fixture the Rust engine reads", () => {
    const corpus = generateCorpus();
    if (process.env["GEN_CORPUS"]) {
      process.stdout.write(
        `\n===CORPUS_BEGIN===\n${JSON.stringify(corpus, null, 2)}\n===CORPUS_END===\n`
      );
      return;
    }
    expect(existsSync(CORPUS_PATH), `missing ${CORPUS_PATH} — run GEN_CORPUS=1`).toBe(true);
    expect(corpus).toEqual(JSON.parse(readFileSync(CORPUS_PATH, "utf8")));
  });
});
