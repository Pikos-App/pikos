// Differential fuzzing for the calendar layout port.
//
// `calendar.json` grades it against 32 hand-written scenarios and finds
// nothing. So did the 317-input parser corpus, right up until a fuzzer found
// six divergence classes behind it — so "the scenarios pass" is a weaker
// statement than it looks.
//
// Layout is where it is weakest of all, because the interesting behaviour is
// *combinatorial*. Column assignment depends on which events overlap which
// others and in what order they are considered; all-day row packing depends on
// span lengths, ties broken by creation time, and gaps that a later event can
// or cannot slot into. Thirty-two hand-written arrangements cannot cover that,
// and nobody can write the arrangement that breaks it because the whole
// difficulty is that it is not obvious which one does.
//
//   pnpm --filter @pikos/desktop gen:fuzz-calendar
//   FUZZ_CASES=5000 FUZZ_SEED=7 pnpm --filter @pikos/desktop gen:fuzz-calendar
//
// The density guard from the hand-written generator applies here too, and for
// the same reason: the Rust port assumes column assignment is pixel-independent,
// so every scenario is laid out at all three densities and any disagreement
// stops the run rather than being averaged away.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { PageSummary } from "@pikos/core";
import { CONTENT_SCHEMA_VERSION } from "@pikos/core";
import { assignStableAllDayRows, buildAllDayBars } from "@pikos/core";
import { computeCalendarMetrics } from "@pikos/core";
import { buildDayBlocks } from "@pikos/core";
import type { CalendarDensity } from "@pikos/core";

const EXPECTED_TZ = "UTC";
const DENSITIES: CalendarDensity[] = ["compact", "normal", "spacious"];

/** The day every timed scenario is laid out on. */
const DAY = "2026-03-18";
/** The week every all-day scenario is laid out across. */
const WEEK = [
  "2026-03-16",
  "2026-03-17",
  "2026-03-18",
  "2026-03-19",
  "2026-03-20",
  "2026-03-21",
  "2026-03-22",
];

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

function page(
  id: string,
  scheduledStart: string | null,
  scheduledEnd: string | null,
  createdAt: string
): PageSummary {
  return {
    contentSchemaVersion: CONTENT_SCHEMA_VERSION,
    createdAt,
    folderId: null,
    id,
    priority: 0,
    scheduledEnd,
    scheduledStart,
    sortOrder: 0,
    status: "not_started",
    subtitle: null,
    tags: [],
    title: id,
    updatedAt: createdAt,
  } as unknown as PageSummary;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Shuffle in place.
 *
 * Layout is handed whatever order the database returned, which is not id
 * order, and both sorts fall back to the page id only after every other
 * comparison ties. Emitting pages already in id order makes a stable sort
 * indistinguishable from one with that tiebreak — the ordering is preserved
 * either way — so the tiebreak goes untested unless the input is scrambled.
 */
function shuffle<T>(random: Random, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * Creation times drawn from a small pool, so ties happen often.
 *
 * Ties are the point: `createdAt` is the tiebreaker for equal-length all-day
 * spans, and a tiebreaker only gets tested when two things actually tie.
 */
const CREATED_AT = [
  "2026-03-01T00:00:00",
  "2026-03-01T00:00:01",
  "2026-03-02T12:00:00",
  "2026-03-03T08:30:00",
];

/**
 * One timed event on `DAY`, or something adjacent to it.
 *
 * The awkward shapes are deliberate and each has a reason: zero-length events
 * (start == end) decide whether "overlap" is inclusive; events that start
 * before midnight or end after it exercise the continuation flags; an event
 * wholly outside the day must be excluded entirely; and a missing end has to
 * be given one by the layout rather than crashing it.
 */
function timedEvent(random: Random, id: string): PageSummary {
  const createdAt = CREATED_AT[Math.floor(random() * CREATED_AT.length)]!;
  const shape = random();

  if (shape < 0.08) {
    // Starts the previous day, ends during this one.
    const endHour = Math.floor(random() * 12);
    return page(id, "2026-03-17T22:00:00", `${DAY}T${pad(endHour)}:00:00`, createdAt);
  }
  if (shape < 0.16) {
    // Starts during this day, ends the next.
    const startHour = 12 + Math.floor(random() * 11);
    return page(id, `${DAY}T${pad(startHour)}:00:00`, "2026-03-19T06:00:00", createdAt);
  }
  if (shape < 0.2) {
    // Entirely elsewhere — must not appear at all.
    return page(id, "2026-03-25T09:00:00", "2026-03-25T10:00:00", createdAt);
  }
  if (shape < 0.26) {
    // No end. The layout has to supply one.
    const startHour = Math.floor(random() * 24);
    return page(id, `${DAY}T${pad(startHour)}:${pad(random() < 0.5 ? 0 : 30)}:00`, null, createdAt);
  }

  // An ordinary event, on a 15-minute grid so back-to-back and exactly-equal
  // boundaries come up often rather than never.
  const startSlot = Math.floor(random() * 92);
  const lengthSlots = shape < 0.3 ? 0 : 1 + Math.floor(random() * 12);
  const endSlot = startSlot + lengthSlots;
  const toTime = (slot: number) => `${pad(Math.floor(slot / 4))}:${pad((slot % 4) * 15)}:00`;
  if (endSlot >= 96) {
    return page(id, `${DAY}T${toTime(startSlot)}`, "2026-03-19T00:00:00", createdAt);
  }
  return page(id, `${DAY}T${toTime(startSlot)}`, `${DAY}T${toTime(endSlot)}`, createdAt);
}

/** One all-day event somewhere in or around `WEEK`. */
function allDayEvent(random: Random, id: string): PageSummary {
  const createdAt = CREATED_AT[Math.floor(random() * CREATED_AT.length)]!;
  // Deliberately allowed to start before the week and end after it, so the
  // continues-left and continues-right flags are exercised.
  const startOffset = -2 + Math.floor(random() * 10);
  const span = random() < 0.45 ? 0 : Math.floor(random() * 8);
  const dayOf = (offset: number) => {
    const date = new Date("2026-03-16T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const start = dayOf(startOffset);
  const end = span === 0 ? null : dayOf(startOffset + span);
  return page(id, start, end, createdAt);
}

function packageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
        name?: string;
      };
      if (pkg.name === "@pikos/desktop") return dir;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("run this from within apps/desktop");
    dir = parent;
  }
}

function main(): void {
  if (process.env["TZ"] !== EXPECTED_TZ) {
    throw new Error(`TZ must be ${EXPECTED_TZ} (got ${process.env["TZ"] ?? "unset"})`);
  }
  const root = packageRoot();
  const seed = Number(process.env["FUZZ_SEED"] ?? 1);
  const wanted = Number(process.env["FUZZ_CASES"] ?? 300);
  const outPath = resolve(
    root,
    process.env["FUZZ_OUT"] ?? "../../crates/pikos-core/tests/corpus/calendar-fuzz.json"
  );
  const random = makeRandom(seed);

  const day = new Date(`${DAY}T00:00:00`);
  const weekDates = WEEK.map((d) => new Date(`${d}T00:00:00`));

  const timed = [];
  for (let i = 0; i < wanted; i++) {
    const count = 1 + Math.floor(random() * 7);
    const pages = shuffle(
      random,
      Array.from({ length: count }, (_, n) => timedEvent(random, `p${String(n).padStart(2, "0")}`))
    );

    // Same guard as the hand-written generator, for the same reason: the Rust
    // port assumes column assignment does not depend on pixels. If that ever
    // becomes false, stop — do not average it away.
    const perDensity = DENSITIES.map((density) =>
      buildDayBlocks(pages, day, computeCalendarMetrics(density))
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
        `cascadeDepth is density-dependent for a fuzzed scenario:\n` +
          `  pages: ${JSON.stringify(
            pages.map((p) => [p.id, p.scheduledStart, p.scheduledEnd])
          )}\n` +
          DENSITIES.map((d, i) => `  ${d}: ${signatures[i]!}`).join("\n") +
          `\nThe Rust port assumes column assignment is pixel-independent. ` +
          `That assumption is now false — stop and re-scope the port.`
      );
    }

    const blocks = perDensity[1]!; // "normal"
    timed.push({
      // Sorted by page id rather than emit order: emit order is a DOM painting
      // concern a native renderer will not share.
      blocks: blocks
        .map((b) => ({
          cascadeDepth: b.cascadeDepth,
          isContinuationAfter: b.isContinuationAfter === true,
          isContinuationBefore: b.isContinuationBefore === true,
          pageId: b.page.id,
        }))
        .sort((x, y) => x.pageId.localeCompare(y.pageId)),
      day: DAY,
      pages: pages.map((p) => ({
        createdAt: p.createdAt,
        id: p.id,
        scheduledEnd: p.scheduledEnd ?? null,
        scheduledStart: p.scheduledStart ?? null,
      })),
    });
  }

  const allDay = [];
  for (let i = 0; i < wanted; i++) {
    const count = 1 + Math.floor(random() * 7);
    const pages = shuffle(
      random,
      Array.from({ length: count }, (_, n) => allDayEvent(random, `p${String(n).padStart(2, "0")}`))
    );
    const slots = assignStableAllDayRows(pages, weekDates);
    const bars = buildAllDayBars(slots);
    allDay.push({
      bars: bars.map((b) => ({
        continuesLeft: b.continuesLeft,
        continuesRight: b.continuesRight,
        pageId: b.page.id,
        row: b.row,
        span: b.span,
        startCol: b.startCol,
      })),
      days: WEEK,
      pages: pages.map((p) => ({
        createdAt: p.createdAt,
        id: p.id,
        scheduledEnd: p.scheduledEnd ?? null,
        scheduledStart: p.scheduledStart ?? null,
      })),
      rowCount: slots[0]?.length ?? 0,
      slots: slots.map((d) => d.map((s) => (s === null ? null : s.page.id))),
    });
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        allDay,
        meta: {
          generatedBy: "apps/desktop/scripts/fuzz-calendar-parity.ts",
          note:
            "Randomly composed calendar scenarios, laid out by the TypeScript " +
            "reference. Regenerate with `pnpm --filter @pikos/desktop gen:fuzz-calendar`.",
          seed,
          timezone: EXPECTED_TZ,
        },
        timed,
      },
      null,
      2
    ) + "\n"
  );

  const overlapping = timed.filter((t) => t.blocks.some((b) => b.cascadeDepth > 0)).length;
  const stacked = allDay.filter((a) => a.rowCount > 1).length;
  process.stdout.write(
    `${timed.length} timed (${overlapping} with a cascade), ` +
      `${allDay.length} all-day (${stacked} stacked)\nout: ${outPath}\n`
  );
}

main();
