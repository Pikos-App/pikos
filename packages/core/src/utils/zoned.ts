// Pikos-native pages are timezone-naive, but synced events are zone-aware: "every Wednesday 9am
// in America/New_York" keeps its 9am New York wall clock across DST, so its absolute time varies
// by occurrence.
//
// RFC 5545 defines recurrence in the event's own local time, the naive wall-clock space the wasm
// engine works in. The engine stays timezone-free, and this module converts at its boundary:
// viewer wall clock, UTC instant, event wall clock. It uses the platform's timezone database via
// Intl, so the wasm carries none. The native mirror is the `zoned` module in
// crates/pikos-recurrence; keep the DST policy identical in both:
// - A nonexistent wall time (spring-forward gap) resolves with the pre-transition offset, which
//   shifts the wall clock forward by the gap (02:30 becomes 03:30). This matches Google Calendar.
// - An ambiguous wall time (fall-back repeat) resolves to the earliest instant.

import * as engine from "@pikos/recurrence-wasm";

import { isAllDayIso } from "./dates";

interface EngineOccurrence {
  originalDate: string;
  scheduledStart: string;
  scheduledEnd: string | null;
}

// A wall-clock time has no zone, so it is carried as the epoch millis of the UTC datetime with
// the same fields ("fake UTC"), never as a local Date.

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

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let dtf = formatterCache.get(zone);
  if (!dtf) {
    // hourCycle h23 avoids the "24:00" quirk.
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

/** An instant as the database stores one: UTC to the second, `YYYY-MM-DDTHH:MM:SSZ`. */
export function utcInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A wall-clock ISO string in `zone` as its UTC instant, by the DST policy above. Date-only input
 * is midnight. */
export function wallClockToUtc(zone: string, wallClockIso: string): Date {
  const wall = wallIsoToMs(wallClockIso);

  // Two candidate offsets: the one in effect if the wall value were UTC, and the one at the
  // instant that first guess produces. Around a transition they differ and bracket the answer.
  const off1 = offsetAt(zone, wall);
  const cand1 = wall - off1;
  const off2 = offsetAt(zone, cand1);
  const cand2 = wall - off2;

  const candidates = [...new Set([cand1, cand2])].sort((a, b) => a - b);
  const valid = candidates.filter((utc) => wallMsAt(zone, utc) === wall);

  if (valid.length > 0) {
    return new Date(valid[0]!);
  }
  // Spring-forward gap: the offset in effect at the earlier candidate.
  return new Date(wall - offsetAt(zone, candidates[0]!));
}

/** The wall clock ('YYYY-MM-DDTHH:MM:SS') shown in `zone` at `instant`. */
export function utcToWallClock(zone: string, instant: Date): string {
  return msToWallIso(wallMsAt(zone, instant.getTime()));
}

export interface ZonedOccurrence {
  /** The date (YYYY-MM-DD) in the event's zone: the identity for exdates and overrides, matching
   *  what the source calendar reports. */
  originalDate: string;
  /** Viewer-zone wall-clock ISO. */
  scheduledStart: string;
  /** Viewer-zone wall-clock ISO; null when the rule has none. */
  scheduledEnd: string | null;
  /** For callers that need to re-anchor. */
  utcStart: string;
}

/** RFC 5545 gives a timed UNTIL in UTC when DTSTART carries a TZID, but the engine compares in
 * event-zone wall clock, so this rewrites the bound into that frame. Date-only UNTILs pass
 * through. */
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
 * Expands a synced zone-aware recurrence into occurrences in the viewer's zone. The range
 * bounds are viewer-zone wall-clock ISO, end exclusive; `rrule` has no "RRULE:" prefix;
 * `scheduledStart`/`scheduledEnd` and `exdates` (YYYY-MM-DD) are in `eventZone`. All-day rules are
 * zone-less and pass through unconverted.
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
      utcStart: utcInstant(utcStart),
    };
  });
}
