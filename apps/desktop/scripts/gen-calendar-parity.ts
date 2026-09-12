// Golden-corpus generator for the calendar layout port.
//
// Companion to packages/core/scripts/gen-parity-corpus.ts, kept in the desktop
// app because the layout utilities live here and importing them into
// packages/core would invert the dependency direction the workspace enforces.
//
// ## What is captured, and what deliberately is not
//
// Only the *algorithmic* half of calendar layout ports to Rust. The pixel half
// must not:
//
//   portable   overlap clustering, sweep-line column assignment, all-day row
//              packing, bar coalescing, continuation flags — pure interval and
//              index math, identical on any platform
//   NOT        hour↔pixel mapping, density tables, collapse-band geometry,
//              `barPositionStyle`, and the text-collision heuristic, which
//              compares pixel gaps against CASCADE_MIN_TOP_GAP_PX
//
// iOS has its own text metrics and row heights; inheriting a 28px threshold
// would be a bug, not reuse. So the corpus records `cascadeDepth` (the
// sweep-line column) and the continuation flags, and ignores top/height/
// leftPct/widthPct.
//
// ## The metrics-independence check
//
// Porting `cascadeDepth` without the pixel layer is only sound if it does not
// depend on the pixel layer. `buildDayBlocks` takes `metrics`, and `isCompact`
// is derived from pixel height, so this is an assumption rather than an
// obvious truth. The generator therefore computes every timed scenario at all
// three densities and fails if any page's `cascadeDepth` differs between them.
//
// The comparison is deliberately keyed by page id rather than positional.
// `buildDayBlocks` ends with `blocks.sort((a, b) => a.leftPct - b.leftPct ...)`,
// emitting in DOM paint order so deeper-cascade events paint over their hosts.
// `leftPct` comes from the text-collision split, which is pixel-based, so the
// emitted *order* genuinely does vary with density — while each page's column
// assignment does not. An ordered comparison conflates the two and reports a
// false positive; this one separates them.
//
// Emit order is therefore not captured at all: it is a DOM painting concern
// that a native calendar renderer will not share.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { PageSummary } from "@pikos/core";

import {
  assignStableAllDayRows,
  buildAllDayBars,
  crossingMidnightsCount,
} from "@/features/calendar/utils/allDayLayout";
import { computeCalendarMetrics } from "@/features/calendar/utils/calendarGeometry";
import { buildDayBlocks } from "@/features/calendar/utils/calendarLayout";
import type { CalendarDensity } from "@/shared/constants/calendar";
import { parseDeepLink } from "@/shared/deep-link/parseDeepLink";
import { computeScheduleTransition, normalizeEndInput } from "@/shared/utils/schedule";

const EXPECTED_TZ = "UTC";
const DENSITIES: CalendarDensity[] = ["compact", "normal", "spacious"];

function packageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
        name?: string;
      };
      if (pkg.name === "@pikos/desktop") return dir;
    } catch {
      // not a package dir — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("run this from within apps/desktop");
    dir = parent;
  }
}

const ROOT = packageRoot();
const OUT_DIR = resolve(ROOT, "../../crates/pikos-core/tests/corpus");

function assertEnvironment(): void {
  if (process.env["TZ"] !== EXPECTED_TZ) {
    throw new Error(`TZ must be ${EXPECTED_TZ} (got ${process.env["TZ"] ?? "unset"})`);
  }
}

// ─── Page fixtures ───────────────────────────────────────────────────────────
// Only the four fields the layout algorithms read are meaningful. The rest is
// filler to satisfy PageSummary, and is never inspected.

function page(
  id: string,
  scheduledStart: string | null,
  scheduledEnd?: string | null,
  createdAt = "2026-03-01T00:00:00"
): PageSummary {
  return {
    createdAt,
    folderId: null,
    id,
    priority: 0,
    scheduledEnd: scheduledEnd ?? null,
    scheduledStart,
    sortOrder: 0,
    status: "not_started",
    tags: [],
    title: id,
    updatedAt: createdAt,
  };
}

const D = "2026-03-16"; // a Monday

interface TimedScenario {
  id: string;
  note: string;
  day: string;
  pages: PageSummary[];
}

const TIMED_SCENARIOS: TimedScenario[] = [
  {
    day: D,
    id: "disjoint",
    note: "no overlap — every event owns column 0",
    pages: [
      page("a", `${D}T09:00:00`, `${D}T10:00:00`),
      page("b", `${D}T11:00:00`, `${D}T12:00:00`),
      page("c", `${D}T14:00:00`, `${D}T15:00:00`),
    ],
  },
  {
    day: D,
    id: "back_to_back",
    note: "end == next start — touching, not overlapping, so both take column 0",
    pages: [
      page("a", `${D}T09:00:00`, `${D}T10:00:00`),
      page("b", `${D}T10:00:00`, `${D}T11:00:00`),
    ],
  },
  {
    day: D,
    id: "simple_overlap",
    note: "two overlapping events — columns 0 and 1",
    pages: [
      page("a", `${D}T09:00:00`, `${D}T10:30:00`),
      page("b", `${D}T10:00:00`, `${D}T11:00:00`),
    ],
  },
  {
    day: D,
    id: "transitive_cluster",
    note: "A-B and B-C overlap but A-C do not — one cluster, three columns needed?",
    pages: [
      page("a", `${D}T09:00:00`, `${D}T10:30:00`),
      page("b", `${D}T10:00:00`, `${D}T11:30:00`),
      page("c", `${D}T11:00:00`, `${D}T12:00:00`),
    ],
  },
  {
    day: D,
    id: "nested_host_guest",
    note: "long host with a short guest fully inside it",
    pages: [
      page("host", `${D}T09:00:00`, `${D}T17:00:00`),
      page("guest", `${D}T11:00:00`, `${D}T11:30:00`),
    ],
  },
  {
    day: D,
    id: "point_events",
    note: "no scheduledEnd — the 15-minute minimum decides whether they overlap",
    pages: [
      page("p1", `${D}T09:00:00`),
      page("p2", `${D}T09:10:00`),
      page("p3", `${D}T09:30:00`),
    ],
  },
  {
    day: D,
    id: "sub_minimum_duration",
    note: "5-minute event — quantized up to the 15-minute floor for overlap math",
    pages: [
      page("short", `${D}T09:00:00`, `${D}T09:05:00`),
      page("next", `${D}T09:10:00`, `${D}T09:20:00`),
    ],
  },
  {
    day: D,
    id: "continuation_before",
    note: "starts the previous day — clamped to the day's start, flagged as continuing",
    pages: [page("overnight", "2026-03-15T22:00:00", `${D}T02:00:00`)],
  },
  {
    day: D,
    id: "continuation_after",
    note: "runs past midnight into the next day",
    pages: [page("late", `${D}T22:00:00`, "2026-03-17T02:00:00")],
  },
  {
    day: D,
    id: "spans_whole_day",
    note: "continues in both directions — the day is entirely interior",
    pages: [page("multi", "2026-03-15T08:00:00", "2026-03-18T08:00:00")],
  },
  {
    day: D,
    id: "identical_times",
    note: "same start and end — id breaks the tie deterministically",
    pages: [
      page("zeta", `${D}T09:00:00`, `${D}T10:00:00`),
      page("alpha", `${D}T09:00:00`, `${D}T10:00:00`),
    ],
  },
  {
    day: D,
    id: "column_reuse",
    note: "a freed column is reused only when every column above it is free too",
    pages: [
      page("a", `${D}T09:00:00`, `${D}T12:00:00`),
      page("b", `${D}T09:30:00`, `${D}T10:00:00`),
      page("c", `${D}T10:30:00`, `${D}T11:00:00`),
    ],
  },
  {
    day: D,
    id: "all_day_excluded",
    note: "all-day pages never appear in the timed grid",
    pages: [page("allday", D, "2026-03-18"), page("timed", `${D}T09:00:00`, `${D}T10:00:00`)],
  },
  {
    day: D,
    id: "unscheduled_excluded",
    note: "pages with no schedule are filtered out",
    pages: [page("none", null), page("timed", `${D}T09:00:00`, `${D}T10:00:00`)],
  },
  {
    day: D,
    id: "other_day_excluded",
    note: "events on neighbouring days do not leak into this day",
    pages: [
      page("yesterday", "2026-03-15T09:00:00", "2026-03-15T10:00:00"),
      page("today", `${D}T09:00:00`, `${D}T10:00:00`),
    ],
  },
];

// ─── All-day scenarios ───────────────────────────────────────────────────────

const WEEK = [
  "2026-03-16",
  "2026-03-17",
  "2026-03-18",
  "2026-03-19",
  "2026-03-20",
  "2026-03-21",
  "2026-03-22",
];

interface AllDayScenario {
  id: string;
  note: string;
  days: string[];
  pages: PageSummary[];
}

const ALL_DAY_SCENARIOS: AllDayScenario[] = [
  {
    days: WEEK,
    id: "single_day_stack",
    note: "three single-day events on the same day stack into three rows",
    pages: [
      page("a", "2026-03-16"),
      page("b", "2026-03-16"),
      page("c", "2026-03-16"),
    ],
  },
  {
    days: WEEK,
    id: "multi_day_anchors_top",
    note: "longer spans sort to the top rows regardless of declaration order",
    pages: [
      page("short", "2026-03-18"),
      page("long", "2026-03-16", "2026-03-20"),
    ],
  },
  {
    days: WEEK,
    id: "non_contiguous_shared_id",
    note:
      "recurring virtuals share one page id on non-adjacent days (M/W/F). Rows must " +
      "claim only the days actually occupied, and the bars must not coalesce across gaps.",
    pages: [
      page("mwf", "2026-03-16"),
      page("mwf", "2026-03-18"),
      page("mwf", "2026-03-20"),
      page("tue", "2026-03-17"),
    ],
  },
  {
    days: WEEK,
    id: "adjacent_same_id_single_day",
    note:
      "same id on consecutive days but each single-day — must stay separate bars, " +
      "since neither flags continuation",
    pages: [page("daily", "2026-03-16"), page("daily", "2026-03-17")],
  },
  {
    days: WEEK,
    id: "crosses_week_start",
    note: "begins before the visible range — continuesLeft on the first column",
    pages: [page("early", "2026-03-13", "2026-03-18")],
  },
  {
    days: WEEK,
    id: "crosses_week_end",
    note: "ends after the visible range — continuesRight on the last column",
    pages: [page("late", "2026-03-20", "2026-03-25")],
  },
  {
    days: WEEK,
    id: "spans_entire_week",
    note: "continues in both directions",
    pages: [page("whole", "2026-03-09", "2026-03-30")],
  },
  {
    days: WEEK,
    id: "interleaved_spans",
    note: "overlapping multi-day spans must not share a row",
    pages: [
      page("x", "2026-03-16", "2026-03-19"),
      page("y", "2026-03-18", "2026-03-21"),
      page("z", "2026-03-17", "2026-03-17"),
    ],
  },
  {
    days: WEEK,
    id: "createdat_tiebreak",
    note: "equal-length spans starting the same day fall back to createdAt order",
    pages: [
      page("later", "2026-03-16", "2026-03-17", "2026-06-01T00:00:00"),
      page("earlier", "2026-03-16", "2026-03-17", "2026-01-01T00:00:00"),
    ],
  },
  {
    days: WEEK,
    id: "timed_excluded",
    note: "timed events never enter the all-day section",
    pages: [page("timed", "2026-03-16T09:00:00", "2026-03-16T10:00:00"), page("ad", "2026-03-16")],
  },
  {
    days: WEEK,
    id: "empty",
    note: "no all-day pages at all",
    pages: [page("timed", "2026-03-16T09:00:00", "2026-03-16T10:00:00")],
  },
];

// ─── Midnight-crossing scenarios ─────────────────────────────────────────────

const MIDNIGHT_CASES: { id: string; start: string; end: string }[] = [
  { end: "2026-03-16T17:00:00", id: "same_day", start: "2026-03-16T09:00:00" },
  { end: "2026-03-17T00:00:00", id: "ends_exactly_at_midnight", start: "2026-03-16T23:00:00" },
  { end: "2026-03-17T00:01:00", id: "one_minute_past_midnight", start: "2026-03-16T23:00:00" },
  { end: "2026-03-18T01:00:00", id: "two_nights", start: "2026-03-16T23:00:00" },
  { end: "2026-03-16T09:00:00", id: "end_before_start", start: "2026-03-16T10:00:00" },
  { end: "2026-03-30T01:00:00", id: "across_dst", start: "2026-03-27T23:00:00" },
];

// ─── Deep-link corpus ────────────────────────────────────────────────────────
// iOS needs the same pikos:// grammar for App Intents, widget taps and
// notification handling, so the parser must agree byte-for-byte with desktop.

const DEEP_LINKS: string[] = [
  "pikos://page/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "pikos://page/3F2504E0-4F89-41D3-9A0C-0305E82C3301",
  "pikos://page/not-a-uuid",
  "pikos://page/",
  "pikos://page",
  "pikos://page/3f2504e0-4f89-41d3-9a0c-0305e82c3301/extra",
  "pikos://today",
  "pikos://today/",
  "pikos://today/extra",
  "pikos://inbox",
  "pikos://calendar",
  "pikos://calendar/extra",
  "pikos://quick-add?text=buy%20milk",
  "pikos://quick-add?text=",
  "pikos://quick-add",
  "pikos://quick-add?other=x",
  "pikos://quick-add?text=tomorrow%20at%203pm%20%23work",
  "pikos://search?q=invoice",
  "pikos://search",
  "pikos://search?q=%C3%BCnicode%20%F0%9F%8E%89",
  "pikos://unknown",
  "pikos://",
  "https://pikos.app/page/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "notpikos://today",
  "",
  "garbage",
  "pikos://TODAY",
];

// ─── Schedule-transition corpus ──────────────────────────────────────────────
// The four all-day/timed transitions the date picker can produce. Shared
// because a mobile date picker has to make exactly the same decisions.

const SCHEDULE_CASES: {
  id: string;
  start: string | null;
  end: string | null;
  iso: string;
}[] = [
  { end: null, id: "none_to_timed", iso: "2026-03-16T09:00:00", start: null },
  { end: null, id: "none_to_all_day", iso: "2026-03-16", start: null },
  { end: "2026-03-18", id: "all_day_to_timed", iso: "2026-03-16T09:00:00", start: "2026-03-16" },
  {
    end: "2026-03-16T11:00:00",
    id: "timed_to_all_day_end_after",
    iso: "2026-03-15",
    start: "2026-03-16T09:00:00",
  },
  {
    end: "2026-03-16T11:00:00",
    id: "timed_to_all_day_end_before",
    iso: "2026-03-20",
    start: "2026-03-16T09:00:00",
  },
  {
    end: "2026-03-16T10:30:00",
    id: "timed_to_timed_preserves_duration",
    iso: "2026-03-20T14:00:00",
    start: "2026-03-16T09:00:00",
  },
  {
    end: "2026-03-16T09:00:00",
    id: "timed_to_timed_zero_duration",
    iso: "2026-03-20T14:00:00",
    start: "2026-03-16T09:00:00",
  },
  {
    end: "2026-03-17T01:00:00",
    id: "timed_to_timed_overnight",
    iso: "2026-03-20T22:00:00",
    start: "2026-03-16T22:00:00",
  },
  { end: "2026-03-20", id: "all_day_to_all_day_end_after", iso: "2026-03-17", start: "2026-03-16" },
  { end: "2026-03-17", id: "all_day_to_all_day_end_before", iso: "2026-03-20", start: "2026-03-16" },
  { end: "2026-03-17", id: "all_day_to_all_day_end_equal", iso: "2026-03-17", start: "2026-03-16" },
  { end: null, id: "timed_no_end_to_timed", iso: "2026-03-20T14:00:00", start: "2026-03-16T09:00:00" },
];

const NORMALIZE_END_CASES: { id: string; start: string; end: string | null }[] = [
  { end: null, id: "cleared", start: "2026-03-16" },
  { end: "2026-03-18", id: "all_day_after", start: "2026-03-16" },
  { end: "2026-03-14", id: "all_day_before", start: "2026-03-16" },
  { end: "2026-03-16", id: "all_day_equal", start: "2026-03-16" },
  { end: "2026-03-18T15:00:00", id: "all_day_start_timed_end", start: "2026-03-16" },
  { end: "2026-03-16T10:00:00", id: "timed_after", start: "2026-03-16T09:00:00" },
  { end: "2026-03-16T08:00:00", id: "timed_before", start: "2026-03-16T09:00:00" },
  { end: "2026-03-16T09:00:00", id: "timed_equal", start: "2026-03-16T09:00:00" },
];

// ─── Capture ─────────────────────────────────────────────────────────────────

function main(): void {
  assertEnvironment();

  const timed = TIMED_SCENARIOS.map((scenario) => {
    const day = new Date(`${scenario.day}T00:00:00`);

    // Compute at every density and require cascadeDepth agreement — see the
    // module docs. A mismatch means cascadeDepth is pixel-dependent after all
    // and must not be ported without the pixel layer.
    const perDensity = DENSITIES.map((density) =>
      buildDayBlocks(scenario.pages, day, computeCalendarMetrics(density))
    );
    const signatures = perDensity.map((blocks) =>
      JSON.stringify(
        blocks
          .map((b) => [b.page.id, b.cascadeDepth] as const)
          .sort((x, y) => x[0].localeCompare(y[0]))
      )
    );
    if (new Set(signatures).size !== 1) {
      throw new Error(
        `cascadeDepth is density-dependent for scenario "${scenario.id}":\n` +
          DENSITIES.map((d, i) => `  ${d}: ${signatures[i]!}`).join("\n") +
          `\nThe Rust port assumes column assignment is pixel-independent. ` +
          `That assumption is now false — stop and re-scope the port.`
      );
    }

    const blocks = perDensity[1]!; // "normal"
    return {
      // Sorted by page id, not emit order — see the module docs on why emit
      // order is a rendering concern rather than portable behaviour.
      blocks: blocks
        .map((b) => ({
          cascadeDepth: b.cascadeDepth,
          isContinuationAfter: b.isContinuationAfter === true,
          isContinuationBefore: b.isContinuationBefore === true,
          pageId: b.page.id,
        }))
        .sort((x, y) => x.pageId.localeCompare(y.pageId)),
      day: scenario.day,
      id: scenario.id,
      note: scenario.note,
      pages: scenario.pages.map((p) => ({
        createdAt: p.createdAt,
        id: p.id,
        scheduledEnd: p.scheduledEnd ?? null,
        scheduledStart: p.scheduledStart ?? null,
      })),
    };
  });

  const allDay = ALL_DAY_SCENARIOS.map((scenario) => {
    const days = scenario.days.map((d) => new Date(`${d}T00:00:00`));
    const slots = assignStableAllDayRows(scenario.pages, days);
    const bars = buildAllDayBars(slots);
    return {
      bars: bars.map((b) => ({
        continuesLeft: b.continuesLeft,
        continuesRight: b.continuesRight,
        pageId: b.page.id,
        row: b.row,
        span: b.span,
        startCol: b.startCol,
      })),
      days: scenario.days,
      id: scenario.id,
      note: scenario.note,
      pages: scenario.pages.map((p) => ({
        createdAt: p.createdAt,
        id: p.id,
        scheduledEnd: p.scheduledEnd ?? null,
        scheduledStart: p.scheduledStart ?? null,
      })),
      rowCount: slots[0]?.length ?? 0,
      slots: slots.map((day) => day.map((s) => (s === null ? null : s.page.id))),
    };
  });

  const midnights = MIDNIGHT_CASES.map((c) => ({
    ...c,
    count: crossingMidnightsCount(new Date(c.start), new Date(c.end)),
  }));

  const deepLinks = DEEP_LINKS.map((url) => ({
    action: parseDeepLink(url),
    url,
  }));

  const scheduleTransitions = SCHEDULE_CASES.map((c) => {
    const r = computeScheduleTransition({ end: c.end, start: c.start }, c.iso);
    return { ...c, result: { end: r.end ?? null, start: r.start } };
  });

  const normalizeEnds = NORMALIZE_END_CASES.map((c) => ({
    ...c,
    result: normalizeEndInput(c.start, c.end) ?? null,
  }));

  const meta = {
    generatedBy: "apps/desktop/scripts/gen-calendar-parity.ts",
    note:
      "Golden output of the TypeScript calendar layout. Captures only the " +
      "pixel-independent half — cascade columns, continuation flags, all-day rows " +
      "and bars. Pixel mapping is per-platform and deliberately absent. " +
      "Regenerate with `pnpm --filter @pikos/desktop gen:parity`.",
    timezone: EXPECTED_TZ,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    resolve(OUT_DIR, "platform.json"),
    JSON.stringify({ deepLinks, meta, normalizeEnds, scheduleTransitions }, null, 2) + "\n"
  );
  writeFileSync(
    resolve(OUT_DIR, "calendar.json"),
    JSON.stringify({ allDay, meta, midnights, timed }, null, 2) + "\n"
  );

  process.stdout.write(
    `calendar.json: ${timed.length} timed, ${allDay.length} all-day, ${midnights.length} midnight\n` +
      `platform.json: ${deepLinks.length} deep-link, ${scheduleTransitions.length} transition, ${normalizeEnds.length} normalize-end\n` +
      `cascadeDepth verified density-independent across ${DENSITIES.length} densities\n` +
      `out: ${OUT_DIR}\n`
  );
}

main();
