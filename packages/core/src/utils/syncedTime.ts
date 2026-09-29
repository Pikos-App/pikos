// ─── Synced (external-calendar) absolute-time rendering ──────────────────────
//
// The one exception to Pikos's floating wall-clock model (see `dates.ts`): a
// synced event is ABSOLUTE. It's stored as source-zone wall-clock + the source
// IANA id, but rendered in the *viewer's* current zone — a 3pm Los_Angeles event
// shows at 6pm for a New_York viewer. Native pages float and never come here.

import { formatLocalISO, isTimedIso } from "./dates";
import { wallClockToUtc } from "./zoned";

/**
 * Resolve a synced timed event's source-zone wall-clock string
 * ('YYYY-MM-DDTHH:MM:SS') to its absolute instant, given the source IANA zone.
 * Positioning/formatting then reads that instant in the device's local zone —
 * there's no separate "to viewer zone" step. DST edge policy: see `zoned.ts`.
 *
 * Timed synced events only. All-day synced events are date-only and never
 * shift — keep them on the floating `parseLocalISO` path.
 */
export function resolveSyncedInstant(wallClock: string, sourceZone: string): Date {
  return wallClockToUtc(sourceZone, wallClock);
}

/**
 * Convert a zoned wall-clock into the viewer's. **The caller must already know
 * the value is absolute** — this takes the zone on trust and converts whenever
 * one is present. Surfaces reading a page go through [`viewerStart`] /
 * [`viewerEnd`], which decide that question; only a path that is synced-only by
 * construction calls this directly.
 *
 * All-day values are returned untouched: a date has no meaningful zone.
 */
export function viewerWallClock(wallClock: string, timezone: string | null | undefined): string {
  if (timezone && isTimedIso(wallClock)) {
    return formatLocalISO(resolveSyncedInstant(wallClock, timezone));
  }
  return wallClock;
}

/** What a page carries for [`viewerStart`] to read. Structural so `Page`,
 *  `PageSummary` and an expanded occurrence all satisfy it. */
export interface ViewerScheduled {
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  timezone?: string | null;
  /** Required, not optional: omitting it would default a synced page to floating
   *  and show a meeting at the wrong hour, where the native miss is harmless. */
  scheduleLocked: boolean;
}

/**
 * Whether a page's stored wall-clock is an absolute instant rather than a
 * floating one.
 *
 * **A populated `timezone` does not mean absolute.** Authoring stamps the device
 * zone on every native schedule as provenance, so `docs/time-handling.md` names
 * origin as the discriminator. Reading the column alone converted native pages as
 * if they were meetings, moving "take medication at 9am" whenever the device zone
 * differed from the one it was written in. Detaching unlocks a page and rewrites
 * its wall-clock into the device zone, so the gate is `scheduleLocked` rather than
 * sync provenance — the same gate the calendar grid's `resolveBlockInstant` uses,
 * and a page's date read two ways while they disagreed.
 */
function isAbsolute(page: ViewerScheduled): boolean {
  return page.scheduleLocked && !!page.timezone;
}

/** A page's start in the viewer's zone, or null when it has no schedule. */
export function viewerStart(page: ViewerScheduled): string | null {
  if (!page.scheduledStart) return null;
  return isAbsolute(page)
    ? viewerWallClock(page.scheduledStart, page.timezone)
    : page.scheduledStart;
}

/** A page's end in the viewer's zone, or null when it has none. */
export function viewerEnd(page: ViewerScheduled): string | null {
  if (!page.scheduledEnd) return null;
  return isAbsolute(page) ? viewerWallClock(page.scheduledEnd, page.timezone) : page.scheduledEnd;
}
