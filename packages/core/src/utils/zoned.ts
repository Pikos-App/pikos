// ─── Timezone-aware boundary layer ──────────────────────────────────────────
//
// Pikos-native pages are timezone-naive (local wall-clock strings), but
// externally synced calendar events are zone-aware: "every Wednesday 9am in
// America/New_York" keeps its 9am *New York* wall clock across DST, so its
// absolute time — and therefore the viewer-local time — varies by occurrence.
//
// RFC 5545 defines recurrence in the event's own local time, which is exactly
// the naive wall-clock space the wasm engine works in. So the engine stays
// timezone-free, and this module supplies the two conversions needed at its
// boundary:
//
//   viewer wall-clock ⇄ UTC instant ⇄ event wall-clock
//
// using the platform's own timezone database via Intl (zero bundle bytes —
// deliberately NOT embedded in the wasm; see crates/pikos-recurrence's
// feature-gated `zoned` module for the native mirror of this file).
//
// DST edge policy (identical in the Rust mirror — keep them in sync):
// - Nonexistent wall times (spring-forward gap, e.g. 02:30 on a US
//   spring-forward day) resolve with the pre-transition offset, which shifts
//   the wall clock forward by the gap (02:30 EST-that-never-was → 03:30 EDT).
//   This matches Google Calendar's behavior.
// - Ambiguous wall times (fall-back repeat) resolve to the EARLIEST instant
//   (the first time the clock shows that wall time).

import * as engine from "@pikos/recurrence-wasm";

import { isAllDayIso } from "./dates";

/** Engine wire shape for one expanded occurrence (same as recurrence.ts). */
interface EngineOccurrence {
  originalDate: string;
  scheduledStart: string;
  scheduledEnd: string | null;
}

// ─── Wall-clock string ⇄ fake-UTC millis ────────────────────────────────────
// A wall-clock time has no zone, so it is carried as the epoch millis of the
// UTC datetime with the same fields ("fake UTC") — never as a local Date.

function wallIsoToMs(iso: string): number {
  const [date, time] = iso.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  const [hh = 0, mm = 0, ss = 0] = time ? time.split(":").map(Number) : [];
  return Date.UTC(y!, m! - 1, d, hh, mm, ss);
}

function msToWallIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

// ─── Zone offset lookup via Intl ────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let dtf = formatterCache.get(zone);
  if (!dtf) {
    // en-CA date parts are unambiguous; hourCycle h23 avoids the "24:00" quirk.
    dtf = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: zone,
      year: "numeric",
    });
    formatterCache.set(zone, dtf);
  }
  return dtf;
}

/** Wall-clock fields (as fake-UTC ms) shown in `zone` at a UTC instant. */
function wallMsAt(zone: string, utcMs: number): number {
  const parts = zoneFormatter(zone).formatToParts(utcMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
}

/** Zone offset (wall − UTC) in ms at a UTC instant. */
function offsetAt(zone: string, utcMs: number): number {
  return wallMsAt(zone, utcMs) - utcMs;
}

// ─── Public conversions ─────────────────────────────────────────────────────

/**
 * Converts a wall-clock ISO string in `zone` to its UTC instant, applying the
 * DST edge policy documented above. Date-only input is treated as midnight.
 */
export function wallClockToUtc(zone: string, wallClockIso: string): Date {
  const wall = wallIsoToMs(wallClockIso);

  // Two candidate offsets: the one in effect if the wall value were UTC, and
  // the one in effect at the instant that first guess produces. Around a
  // transition these differ and bracket the answer.
  const off1 = offsetAt(zone, wall);
  const cand1 = wall - off1;
  const off2 = offsetAt(zone, cand1);
  const cand2 = wall - off2;

  const candidates = [...new Set([cand1, cand2])].sort((a, b) => a - b);
  const valid = candidates.filter((utc) => wallMsAt(zone, utc) === wall);

  if (valid.length > 0) {
    // Unique or ambiguous (fall-back): earliest instant wins.
    return new Date(valid[0]!);
  }
  // Nonexistent (spring-forward gap): interpret with the pre-transition
  // offset — the offset in effect at the earlier candidate — which shifts
  // the wall clock forward by the gap.
  return new Date(wall - offsetAt(zone, candidates[0]!));
}

/** Wall-clock ISO string ('YYYY-MM-DDTHH:MM:SS') shown in `zone` at `instant`. */
export function utcToWallClock(zone: string, instant: Date): string {
  return msToWallIso(wallMsAt(zone, instant.getTime()));
}

// ─── Zoned recurrence expansion ─────────────────────────────────────────────

export interface ZonedOccurrence {
  /**
   * The occurrence date (YYYY-MM-DD) in the EVENT's zone — the stable
   * identity used for exdates/overrides, matching what the source calendar
   * would report.
   */
  originalDate: string;
  /** Occurrence start as viewer-zone wall-clock ISO. */
  scheduledStart: string;
  /** Occurrence end as viewer-zone wall-clock ISO (null when the rule has none). */
  scheduledEnd: string | null;
  /** The exact UTC instant of the start, for callers that need to re-anchor. */
  utcStart: string;
}

/**
 * RFC 5545 expresses a timed UNTIL in UTC when DTSTART carries a TZID.
 * The engine compares occurrences in event-zone wall-clock, so rewrite the
 * UNTIL bound into that frame before expansion. Date-only UNTILs pass through.
 */
export function normalizeUntilToZone(rrule: string, eventZone: string): string {
  return rrule.replace(/UNTIL=(\d{8})T(\d{6})Z?/i, (_, date: string, time: string) => {
    const iso =
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
      `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
    const wall = utcToWallClock(eventZone, new Date(wallIsoToMs(iso)));
    return `UNTIL=${wall.replace(/[-:]/g, "")}Z`;
  });
}

/**
 * Expands a zone-aware recurrence (an externally synced event) into
 * occurrences expressed in the viewer's zone.
 *
 * The pipeline: normalize UNTIL (UTC → event wall-clock) → convert the
 * viewer-zone range bounds into event wall-clock → expand naively in the
 * event's zone via the wasm engine (RFC 5545 semantics: the wall clock is
 * what recurs) → convert each occurrence event → UTC → viewer wall-clock.
 *
 * All-day rules are zone-less by definition and pass through unconverted.
 *
 * @param rrule - RRULE string without "RRULE:" prefix
 * @param scheduledStart - base occurrence start, wall-clock in eventZone
 * @param scheduledEnd - base occurrence end, wall-clock in eventZone
 * @param eventZone - IANA zone the event recurs in (e.g. "America/New_York")
 * @param viewerZone - IANA zone to express results in (e.g. getLocalTimezone())
 * @param rangeStartIso / rangeEndIso - visible range as viewer-zone wall-clock
 *   ISO strings, [start, end) — end exclusive
 * @param exdates - YYYY-MM-DD dates (event zone) excluded from the series
 */
export function expandRecurrenceInZone(opts: {
  rrule: string;
  scheduledStart: string;
  scheduledEnd?: string | null;
  eventZone: string;
  viewerZone: string;
  rangeStartIso: string;
  rangeEndIso: string;
  exdates?: readonly string[];
}): ZonedOccurrence[] {
  const { eventZone, viewerZone } = opts;
  const allDay = isAllDayIso(opts.scheduledStart);

  const toEventWall = (viewerIso: string) =>
    utcToWallClock(eventZone, wallClockToUtc(viewerZone, viewerIso));

  const occurrences = JSON.parse(
    engine.expandRange(
      allDay ? opts.rrule : normalizeUntilToZone(opts.rrule, eventZone),
      opts.scheduledStart,
      opts.scheduledEnd ?? undefined,
      allDay ? opts.rangeStartIso : toEventWall(opts.rangeStartIso),
      allDay ? opts.rangeEndIso : toEventWall(opts.rangeEndIso),
      JSON.stringify(opts.exdates ?? [])
    )
  ) as EngineOccurrence[];

  return occurrences.map((occ) => {
    if (allDay) {
      return {
        originalDate: occ.originalDate,
        scheduledEnd: occ.scheduledEnd,
        scheduledStart: occ.scheduledStart,
        utcStart: occ.scheduledStart,
      };
    }
    const utcStart = wallClockToUtc(eventZone, occ.scheduledStart);
    return {
      originalDate: occ.originalDate,
      scheduledEnd: occ.scheduledEnd
        ? utcToWallClock(viewerZone, wallClockToUtc(eventZone, occ.scheduledEnd))
        : null,
      scheduledStart: utcToWallClock(viewerZone, utcStart),
      utcStart: utcStart.toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  });
}
