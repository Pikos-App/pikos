// Golden-corpus generator for the Rust ports of the NL parser and recurrence math. It runs
// the TypeScript implementation, the reference, over every input the test suite exercises at
// several pinned reference times, and freezes the results as JSON the Rust crate's parity
// tests read back.
//
// Output must be deterministic: TZ is pinned (the suite's NOW has no zone suffix, so it is
// local time and parses differently per zone) and reference times are explicit, never
// `new Date()`. Inputs are scraped from parser.test.ts so the corpus tracks the suite, then
// supplemented with cases the table-driven tests reach only indirectly.
//
// Usage:  TZ=UTC node --experimental-strip-types scripts/gen-parity-corpus.ts
// or via: pnpm gen:parity

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { defaultColorForProvider, PALETTE_COLORS } from "../src/constants/colors";
import {
  formatElapsed,
  formatSessionLength,
  MIN_SESSION_S,
} from "../src/format/focusDuration";
import { parseInput } from "../src/nlp/parser";
import { parseSearchQuery } from "../src/nlp/searchQuery";
import {
  moveOverdueToTodayLabel,
  planMoveOverdueToToday,
} from "../src/pages/moveOverdueToToday";
import { belongsToView, groupTodayPages, upcomingWindowEnd } from "../src/pages/pageFilters";
import { groupUpcomingPages } from "../src/pages/upcoming";
import type { PageRecurrenceRule, PageSummary } from "../src/types";
import { extractText } from "../src/utils/extractText";
import {
  computeNextEnd,
  expandRecurrenceForRange,
  nextOccurrenceAfter,
  rruleEditWouldDegrade,
  snapAnchorToRule,
} from "../src/utils/recurrence";

/**
 * Locates the @pikos/core package root by walking up from the working directory. Resolving
 * against `import.meta.url` breaks once the script is bundled: every relative path silently
 * retargets. A marker file fails loudly instead.
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

// `sun_noon` matches parser.test.ts. The rest give other weekdays and hours, plus a DST
// boundary and a leap day, where a naive port is most likely to diverge.

const REFERENCES: { id: string; iso: string; note: string }[] = [
  { id: "sun_noon", iso: "2026-03-15T12:00:00", note: "suite NOW — Sunday, midday" },
  { id: "wed_noon", iso: "2026-03-18T12:00:00", note: "midweek — forward-date rollover differs" },
  { id: "mon_morning", iso: "2026-03-16T08:00:00", note: "before 9am — 'today vs tomorrow' flips" },
  { id: "sat_late", iso: "2026-03-21T22:30:00", note: "after 8pm — 'tonight' rolls to tomorrow" },
  { id: "dst_eve", iso: "2026-03-28T12:00:00", note: "eve of EU DST change" },
  { id: "leap_day", iso: "2024-02-29T09:00:00", note: "leap day" },
  { id: "year_end", iso: "2026-12-31T23:00:00", note: "year boundary" },
];

function scrapeTestInputs(): string[] {
  const src = readFileSync(resolve(ROOT, "src/nlp/parser.test.ts"), "utf8");
  const found = new Set<string>();
  // Escaped quotes inside an input would break the match; throw rather than truncate a case.
  for (const m of src.matchAll(/input:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const raw = m[1]!;
    if (raw.includes('\\"')) {
      throw new Error(`corpus scraper cannot represent escaped quotes: ${raw}`);
    }
    found.add(raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\"));
  }
  return [...found];
}

// Cases the suite covers only via `custom` assertions or property runs, plus adversarial shapes.
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
    // Overnight: the end's wall-clock is earlier than the start's, so computeNextEnd must roll
    // it onto the next day. Pins the `nextEnd <= nextStart` boundary against a port writing `<`.
    rrule: "FREQ=WEEKLY;BYDAY=FR",
    scheduledEnd: "2026-03-21T01:00:00",
    scheduledStart: "2026-03-20T22:00:00",
  },
  {
    afterDate: "2026-03-15T09:00:00",
    exdates: [],
    // Zero-length: end equals start, the exact `<=` boundary. The reference rolls it forward a day.
    rrule: "FREQ=DAILY",
    scheduledEnd: "2026-03-15T09:00:00",
    scheduledStart: "2026-03-15T09:00:00",
  },
  {
    afterDate: "2026-03-21T00:00:00",
    exdates: [],
    // All-day series: computeNextEnd must return null rather than invent a time.
    rrule: "FREQ=WEEKLY;BYDAY=SA",
    scheduledEnd: null,
    scheduledStart: "2026-03-21",
  },
  {
    afterDate: "2026-03-15T09:00:00",
    exdates: ["2026-03-16", "2026-03-17"],
    // Every candidate excluded: exercises the skip loop's exhaustion.
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
    // Months without a 31st are skipped, not clamped.
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
    // Spans the EU DST transition (2026-03-29): wall-clock time must hold at 09:00 on both sides.
    id: "daily_across_dst",
    rangeEnd: "2026-04-02",
    rangeStart: "2026-03-25",
    rrule: "FREQ=DAILY",
    scheduledEnd: "2026-03-27T10:00:00",
    scheduledStart: "2026-03-27T09:00:00",
  },
];

/** Minimal PageSummary. Expansion copies its fields through, so the values don't matter. */
const TEMPLATE_PAGE: PageSummary = {
  createdAt: "2026-03-01T00:00:00",
  detachIsReversible: false,
  folderId: null,
  id: "page-0000",
  isRecurring: false,
  priority: 0,
  scheduleLocked: false,
  sortOrder: 0,
  status: "not_started",
  tags: [],
  title: "template",
  updatedAt: "2026-03-01T00:00:00",
};

const REAL_DATE = Date;

/**
 * Runs `fn` with `new Date()` and `Date.now()` pinned to `iso`. Some captured functions
 * (`localToday`, `groupTodayPages`'s "now") read the clock and take no parameter, so the global
 * is the only seam. It is restored in a `finally`, so a throwing case can't leave a frozen clock.
 */
function withFrozenClock<T>(iso: string, fn: () => T): T {
  const frozen = new REAL_DATE(iso).getTime();
  class FrozenDate extends REAL_DATE {
    // `unknown[]`, not `ConstructorParameters<typeof Date>`, which resolves to the last overload
    // alone and makes the zero-argument branch look unreachable.
    constructor(...args: unknown[]) {
      if (args.length === 0) super(frozen);
      else if (args.length === 1) super(args[0] as string | number | Date);
      else super(...(args as [number, number, number, number, number, number, number]));
    }
    static override now(): number {
      return frozen;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = REAL_DATE;
  }
}

/** Each page sits a known distance from `sun_noon` (2026-03-15), so one fixture set exercises every reference time. */
const VIEW_PAGES: PageSummary[] = [
  // All-day, days overdue: stays overdue whatever the hour.
  { ...TEMPLATE_PAGE, id: "v_old_allday", scheduledStart: "2026-03-10", sortOrder: 1 },
  { ...TEMPLATE_PAGE, id: "v_old_timed", scheduledStart: "2026-03-10T08:00:00", sortOrder: 2 },
  // Earlier today, timed: the boundary the reference times cross.
  { ...TEMPLATE_PAGE, id: "v_today_early", scheduledStart: "2026-03-15T01:45:00", sortOrder: 3 },
  // All-day today: never overdue, sorts after today's timed items.
  { ...TEMPLATE_PAGE, id: "v_today_allday", scheduledStart: "2026-03-15", sortOrder: 4 },
  { ...TEMPLATE_PAGE, id: "v_today_late", scheduledStart: "2026-03-15T18:30:00", sortOrder: 5 },
  // Sharing a moment, to pin sort stability.
  { ...TEMPLATE_PAGE, id: "v_tie_a", scheduledStart: "2026-03-16T09:00:00", sortOrder: 6 },
  { ...TEMPLATE_PAGE, id: "v_tie_b", scheduledStart: "2026-03-16T09:00:00", sortOrder: 7 },
  // Inside the Upcoming window from sun_noon, outside it from later references.
  { ...TEMPLATE_PAGE, id: "v_day3", scheduledStart: "2026-03-17T12:00:00", sortOrder: 8 },
  { ...TEMPLATE_PAGE, id: "v_day7", scheduledStart: "2026-03-21", sortOrder: 9 },
  // The eighth day: outside the window from sun_noon, inside from later ones.
  { ...TEMPLATE_PAGE, id: "v_day8", scheduledStart: "2026-03-22T10:00:00", sortOrder: 10 },
  // Far future and unscheduled: in no date view.
  { ...TEMPLATE_PAGE, id: "v_far", scheduledStart: "2026-09-01", sortOrder: 11 },
  { ...TEMPLATE_PAGE, id: "v_none", sortOrder: 12 },
  // Done: date views list open work only.
  {
    ...TEMPLATE_PAGE,
    completedAt: "2026-03-15T09:00:00",
    id: "v_done",
    scheduledStart: "2026-03-15T07:00:00",
    sortOrder: 13,
    status: "done",
  },
  // Filed, to exercise the folder and inbox arms of belongsToView.
  {
    ...TEMPLATE_PAGE,
    folderId: "folder-1",
    id: "v_filed",
    scheduledStart: "2026-03-16",
    sortOrder: 14,
  },
];

const VIEW_IDS = ["today", "upcoming", "inbox", "trash", "folder-1"];

// Its own fixtures, since the view pages carry no recurrence, calendar lock or end time. Dated
// around 2026-03-15 so the reference times sweep each page from overdue through today to future.

const OVERDUE_PAGES: PageSummary[] = [
  // Must land on today as an all-day page, not as midnight.
  { ...TEMPLATE_PAGE, id: "o_allday", scheduledStart: "2026-03-10", sortOrder: 1 },
  // Start and end shift by the same whole days.
  {
    ...TEMPLATE_PAGE,
    id: "o_timed_span",
    scheduledEnd: "2026-03-10T09:00:00",
    scheduledStart: "2026-03-10T08:00:00",
    sortOrder: 2,
  },
  // Keeps its length.
  {
    ...TEMPLATE_PAGE,
    id: "o_allday_span",
    scheduledEnd: "2026-03-12",
    scheduledStart: "2026-03-09",
    sortOrder: 3,
  },
  // Recurring: the gap is a decision, not a drag.
  { ...TEMPLATE_PAGE, id: "o_recurring", isRecurring: true, scheduledStart: "2026-03-08", sortOrder: 4 },
  // Mirrored: the calendar owns the schedule.
  { ...TEMPLATE_PAGE, id: "o_locked", scheduledStart: "2026-03-08", scheduleLocked: true, sortOrder: 5 },
  // Earlier today: nowhere to go, neither moved nor reported as left behind.
  { ...TEMPLATE_PAGE, id: "o_today_early", scheduledStart: "2026-03-15T01:00:00", sortOrder: 6 },
  { ...TEMPLATE_PAGE, id: "o_today_allday", scheduledStart: "2026-03-15", sortOrder: 7 },
  // Ahead of all but one reference: a negative shift must not run backwards.
  { ...TEMPLATE_PAGE, id: "o_future", scheduledStart: "2026-03-20T10:00:00", sortOrder: 8 },
  { ...TEMPLATE_PAGE, id: "o_none", sortOrder: 9 },
  // Astride the EU DST change: a shift measured in seconds lands this an hour out.
  {
    ...TEMPLATE_PAGE,
    id: "o_across_dst",
    scheduledEnd: "2026-03-27T03:30:00",
    scheduledStart: "2026-03-27T02:30:00",
    sortOrder: 10,
  },
];

// Inputs are JSON strings, matching how pages.content is persisted and how the function is called.

const EXTRACT_TEXT_CASES: { id: string; doc: string }[] = [
  { doc: "", id: "empty_string" },
  { doc: "{}", id: "empty_object_literal" },
  { doc: "not json at all", id: "invalid_json" },
  { doc: "null", id: "json_null" },
  { doc: '"just a string"', id: "json_string" },
  { doc: "[]", id: "json_array" },
  { doc: JSON.stringify({ content: [{ type: "paragraph" }], type: "doc" }), id: "empty_paragraph" },
  {
    doc: JSON.stringify({
      content: [{ content: [{ text: "Hello world", type: "text" }], type: "paragraph" }],
      type: "doc",
    }),
    id: "single_paragraph",
  },
  {
    doc: JSON.stringify({
      content: [
        { content: [{ text: "First", type: "text" }], type: "paragraph" },
        { content: [{ text: "Second", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    }),
    id: "two_paragraphs",
  },
  {
    doc: JSON.stringify({
      content: [
        {
          content: [
            { text: "plain ", type: "text" },
            { marks: [{ type: "bold" }], text: "bold", type: "text" },
            { text: " tail", type: "text" },
          ],
          type: "paragraph",
        },
      ],
      type: "doc",
    }),
    id: "marks_are_transparent",
  },
  {
    doc: JSON.stringify({
      content: [
        { content: [{ text: "Heading", type: "text" }], type: "heading" },
        {
          content: [
            {
              content: [{ content: [{ text: "one", type: "text" }], type: "paragraph" }],
              type: "listItem",
            },
            {
              content: [{ content: [{ text: "two", type: "text" }], type: "paragraph" }],
              type: "listItem",
            },
          ],
          type: "bulletList",
        },
      ],
      type: "doc",
    }),
    id: "heading_and_bullet_list",
  },
  {
    doc: JSON.stringify({
      content: [
        {
          content: [
            {
              content: [{ content: [{ text: "task a", type: "text" }], type: "paragraph" }],
              type: "taskItem",
            },
            {
              content: [{ content: [{ text: "task b", type: "text" }], type: "paragraph" }],
              type: "taskItem",
            },
          ],
          type: "taskList",
        },
      ],
      type: "doc",
    }),
    id: "task_list",
  },
  {
    doc: JSON.stringify({
      content: [{ content: [{ text: "const x = 1;", type: "text" }], type: "codeBlock" }],
      type: "doc",
    }),
    id: "code_block",
  },
  {
    doc: JSON.stringify({
      content: [
        {
          content: [{ content: [{ text: "quoted", type: "text" }], type: "paragraph" }],
          type: "blockquote",
        },
      ],
      type: "doc",
    }),
    id: "blockquote",
  },
  {
    doc: JSON.stringify({
      content: [
        { attrs: { src: "asset://x.png" }, type: "image" },
        { content: [{ text: "after", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    }),
    id: "leaf_without_text",
  },
  {
    doc: JSON.stringify({
      content: [
        {
          content: [
            {
              content: [
                {
                  content: [{ content: [{ text: "deep", type: "text" }], type: "paragraph" }],
                  type: "listItem",
                },
              ],
              type: "bulletList",
            },
          ],
          type: "listItem",
        },
      ],
      type: "bulletList",
    }),
    id: "deeply_nested_lists",
  },
  {
    doc: JSON.stringify({
      content: [{ content: [{ text: "  padded  ", type: "text" }], type: "paragraph" }],
      type: "doc",
    }),
    id: "outer_whitespace_trimmed",
  },
  {
    doc: JSON.stringify({
      content: [{ content: [{ text: "emoji 🎉 and ünïcode", type: "text" }], type: "paragraph" }],
      type: "doc",
    }),
    id: "unicode",
  },
];

// Errors are captured, not thrown: a port must reproduce "this input throws" too.

type Captured<T> = { ok: true; value: T } | { ok: false; error: string };

function capture<T>(fn: () => T): Captured<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ok: false };
  }
}

// `rruleEditWouldDegrade` decides whether a structured editor may touch a rule. Being too
// permissive is the costly error: changing an interval would silently drop terms. The cases
// straddle the envelope `RecurrenceOptions` carries (FREQ, INTERVAL, BYDAY, BYSETPOS,
// BYMONTHDAY, BYMONTH, WKST, COUNT, UNTIL); anything outside it, or unparseable, must lock.

const DEGRADE_CASES: { rrule: string; note: string }[] = [
  { note: "plain daily", rrule: "FREQ=DAILY" },
  { note: "interval spelled out", rrule: "FREQ=DAILY;INTERVAL=1" },
  { note: "weekly single day", rrule: "FREQ=WEEKLY;BYDAY=MO" },
  { note: "weekly several days, out of order", rrule: "FREQ=WEEKLY;BYDAY=WE,MO,FR" },
  { note: "lower case", rrule: "freq=weekly;byday=mo" },
  { note: "with the RRULE: prefix", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO" },
  { note: "monthly by ordinal weekday", rrule: "FREQ=MONTHLY;BYDAY=3TU" },
  { note: "monthly by month-day", rrule: "FREQ=MONTHLY;BYMONTHDAY=15" },
  { note: "last weekday of the month", rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1" },
  { note: "yearly on a fixed date — the gap a term list missed", rrule: "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15" },
  { note: "week start changes weekly grouping", rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU" },
  { note: "count", rrule: "FREQ=DAILY;COUNT=10" },
  { note: "until, date only", rrule: "FREQ=DAILY;UNTIL=20260401" },
  { note: "until with a Z — syntactic only", rrule: "FREQ=DAILY;UNTIL=20260401T235959Z" },
  { note: "until at the provider's own cut-off", rrule: "FREQ=DAILY;UNTIL=20260401T120000" },
  { note: "plus-signed weekday", rrule: "FREQ=WEEKLY;BYDAY=+1MO" },
  // Outside the envelope: each must lock.
  { note: "byhour", rrule: "FREQ=DAILY;BYHOUR=9" },
  { note: "byminute", rrule: "FREQ=DAILY;BYMINUTE=30" },
  { note: "byweekno", rrule: "FREQ=YEARLY;BYWEEKNO=20" },
  { note: "byyearday", rrule: "FREQ=YEARLY;BYYEARDAY=100" },
  { note: "unsupported freq", rrule: "FREQ=HOURLY" },
  { note: "no freq at all", rrule: "INTERVAL=2" },
  { note: "not a rule", rrule: "banana" },
  { note: "empty", rrule: "" },
];

const SNAP_CASES: { rrule: string; anchor: string; note: string }[] = [
  { anchor: "2026-03-16T09:00:00", note: "already allowed", rrule: "FREQ=WEEKLY;BYDAY=MO" },
  {
    anchor: "2026-03-15T09:00:00",
    note: "sunday anchor on a M/W/F rule",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  },
  { anchor: "2026-03-15", note: "date-only anchor", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" },
  {
    anchor: "2026-03-15T14:30:00",
    note: "wall-clock time survives the move",
    rrule: "FREQ=WEEKLY;BYDAY=TU",
  },
  { anchor: "2026-03-15T09:00:00", note: "daily needs no move", rrule: "FREQ=DAILY" },
  {
    anchor: "2026-03-15T09:00:00",
    note: "interval rule",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR",
  },
  { anchor: "2026-03-15T09:00:00", note: "monthly by weekday", rrule: "FREQ=MONTHLY;BYDAY=3TU" },
  {
    anchor: "2026-03-15T09:00:00",
    note: "monthly by month-day skips short months",
    rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
  },
  {
    anchor: "2026-03-15T09:00:00",
    note: "count already exhausted",
    rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=0",
  },
  {
    anchor: "2026-03-15T09:00:00",
    note: "until already passed",
    rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T235959Z",
  },
  { anchor: "2026-03-15T09:00:00", note: "unparseable rule", rrule: "NOT A RULE" },
  { anchor: "2024-02-28T09:00:00", note: "leap day", rrule: "FREQ=WEEKLY;BYDAY=TH" },
  { anchor: "2026-12-31T23:00:00", note: "crosses the year", rrule: "FREQ=WEEKLY;BYDAY=MO" },
  // The anchor's wall-clock time wins over a time the rule names. Every other rule here
  // inherits its time from DTSTART, so only these tell the two apart.
  {
    anchor: "2026-03-15T09:00:00",
    note: "rule names an hour the anchor overrides",
    rrule: "FREQ=DAILY;BYHOUR=14",
  },
  {
    anchor: "2026-03-15T09:15:00",
    note: "rule names hour and minute, anchor overrides both",
    rrule: "FREQ=WEEKLY;BYDAY=WE;BYHOUR=6;BYMINUTE=30",
  },
  {
    anchor: "2026-03-15",
    note: "date-only anchor against a rule that names an hour",
    rrule: "FREQ=DAILY;BYHOUR=14",
  },
];

/** Search-palette queries, scraped from `searchQuery.test.ts` like the parser inputs. */
function scrapeSearchInputs(): string[] {
  const src = readFileSync(resolve(ROOT, "src/nlp/searchQuery.test.ts"), "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/parseSearchQuery\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const raw = m[1]!;
    if (raw.includes('\\"')) {
      throw new Error(`search scraper cannot represent escaped quotes: ${raw}`);
    }
    found.add(raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\"));
  }
  return [...found];
}

// Shapes the suite reaches indirectly or not at all: the word-boundary rule, the quoted-value
// branch, consecutive operators, and every `due:` range with a side missing.
const SUPPLEMENTARY_SEARCH_INPUTS: string[] = [
  "   ",
  "TAG:Work",
  'tag:"two words" left over',
  'tag:""',
  'folder:"my folder" and text',
  "notag:work",
  "path/to:file",
  "email is:done",
  "a is:done b is:open c",
  "tag:work tag:work",
  "due:2026-03-10..2026-03-10",
  "due:week..today",
  "due:....",
  "due:2026-03-10..2026-03-12..2026-03-14",
  "priority:0",
  "priority:none",
  "priority:MEDIUM",
  "priority:",
  "is:",
  "tag:#work",
  // Operator values match case-insensitively except a tag's, which is kept verbatim.
  "is:DONE",
  "is:Open",
  "is:SCHEDULED",
  "due:TODAY",
  "due:Week..TOMORROW",
  "FOLDER:Work",
  "  spaced   out  tag:work   again  ",
  "is:done is:open",
  "due:today is:open tag:a folder:b priority:1 leftover words",
  "\ttabbed\ttag:work",
  "tag:work\nnewline",
];

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
    // `exactOptionalPropertyTypes`: an absent end is omitted, not set to undefined.
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
    // Only the three fields expansion computes; the rest is the template page copied through.
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

  const degradeCases = DEGRADE_CASES.map((c) => ({
    ...c,
    degrades: capture(() => rruleEditWouldDegrade(c.rrule)),
  }));

  const snapCases = SNAP_CASES.map((c) => ({
    ...c,
    snapped: capture(() => snapAnchorToRule(c.rrule, c.anchor)),
  }));

  // One case per reference time: view membership, the window's last day, and the list's sections.
  const viewCases = REFERENCES.map((ref) => {
    const today = ref.iso.slice(0, 10);
    return withFrozenClock(ref.iso, () => {
      const membership = VIEW_PAGES.map((page) => ({
        id: page.id,
        views: Object.fromEntries(
          VIEW_IDS.map((viewId) => [viewId, belongsToView(page, viewId, today)])
        ),
      }));
      // What the list does: open pages that belong to the view, in section order.
      const open = VIEW_PAGES.filter((p) => p.status !== "done");
      const todayGroups = capture(() =>
        groupTodayPages(open.filter((p) => belongsToView(p, "today", today)))
      );
      const upcomingDays = capture(() =>
        groupUpcomingPages(
          open.filter((p) => belongsToView(p, "upcoming", today)),
          today
        )
      );
      return {
        membership,
        ref: ref.id,
        today,
        // Ids only; the rest of each page is the fixture copied through.
        todayGroups: todayGroups.ok
          ? {
              ok: true as const,
              overdue: todayGroups.value.overdue.map((p) => p.id),
              today: todayGroups.value.today.map((p) => p.id),
            }
          : todayGroups,
        upcomingDays: upcomingDays.ok
          ? {
              days: upcomingDays.value.map((d) => ({
                date: d.date,
                pages: d.pages.map((p) => p.id),
              })),
              ok: true as const,
            }
          : upcomingDays,
        windowEnd: capture(() => upcomingWindowEnd(today)),
      };
    });
  });

  const searchInputs = [
    ...new Set([...scrapeSearchInputs(), ...SUPPLEMENTARY_SEARCH_INPUTS]),
  ].sort();
  const searchCases = [];
  for (const ref of REFERENCES) {
    const now = new Date(ref.iso);
    for (const query of searchInputs) {
      searchCases.push({ parsed: capture(() => parseSearchQuery(query, now)), query, ref: ref.id });
    }
  }

  const overdueCases = REFERENCES.map((ref) =>
    withFrozenClock(ref.iso, () => {
      const plan = planMoveOverdueToToday(OVERDUE_PAGES);
      return { label: moveOverdueToTodayLabel(plan), plan, ref: ref.id };
    })
  );

  // Not a behaviour capture: the palette is the source of truth, written where a Rust test can
  // read it, so a drifted copy can't colour a folder in a shade the desktop picker lacks.
  const colors = {
    defaults: ["caldav", "google", "unknown"].map((provider) => ({
      color: defaultColorForProvider(provider),
      provider,
    })),
    palette: PALETTE_COLORS,
  };

  // Around every formatter boundary: the floor, minute rounding, the singular/plural switch,
  // the jump to `H:MM:SS`, and an exact hour (which drops the "5 min" tail).
  const focusDurations = [
    0, 1, 29, 30, 31, 59, 60, 61, 89, 90, 119, 120, 1799, 1800, 3540, 3599, 3600, 3601, 3660,
    5400, 7199, 7200, 86_399, 86_400,
  ];
  const focus = {
    cases: focusDurations.map((seconds) => ({
      elapsed: formatElapsed(seconds),
      seconds,
      sessionLength: formatSessionLength(seconds),
    })),
    minSessionS: MIN_SESSION_S,
  };

  const extractTextCases = EXTRACT_TEXT_CASES.map((c) => ({
    ...c,
    text: capture(() => extractText(c.doc)),
  }));

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
    resolve(OUT_DIR, "views.json"),
    JSON.stringify({ meta, pages: VIEW_PAGES, viewCases }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "focus.json"),
    JSON.stringify({ ...focus, meta }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "colors.json"),
    JSON.stringify({ ...colors, meta }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "overdue.json"),
    JSON.stringify({ cases: overdueCases, meta, pages: OVERDUE_PAGES }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "search.json"),
    JSON.stringify({ cases: searchCases, meta, queryCount: searchInputs.length }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "text.json"),
    JSON.stringify({ extractTextCases, meta }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "recurrence.json"),
    JSON.stringify({ degradeCases, expansionCases, meta, recurrenceCases, snapCases }, null, 2) +
      "\n"
  );

  const failures = parserCases.filter((c) => !c.result.ok).length;
  process.stdout.write(
    `parser.json:     ${parserCases.length} cases (${inputs.length} inputs × ${REFERENCES.length} refs), ${failures} throwing\n` +
      `recurrence.json: ${recurrenceCases.length} next-occurrence, ${expansionCases.length} expansion, ${snapCases.length} snap, ${degradeCases.length} degrade\n` +
      `focus.json:      ${focus.cases.length} durations, floor ${focus.minSessionS}s\n` +
      `colors.json:     ${colors.palette.length} palette entries, ${colors.defaults.length} provider defaults\n` +
      `overdue.json:    ${overdueCases.length} reference times × ${OVERDUE_PAGES.length} pages\n` +
      `search.json:     ${searchCases.length} cases (${searchInputs.length} queries × ${REFERENCES.length} refs)\n` +
      `text.json:       ${extractTextCases.length} extractText\n` +
      `views.json:      ${viewCases.length} reference times × ${VIEW_PAGES.length} pages\n` +
      `out: ${OUT_DIR}\n`
  );
}

main();
