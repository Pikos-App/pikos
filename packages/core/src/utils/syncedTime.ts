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
 * The wall-clock a stored value occupies **for the viewer**, which is what every
 * surface that shows a time, files a page under a day, or sorts by one must read.
 * A timed value with a source zone converts; everything else is returned as it
 * came, and that is the model rather than a fallback. All-day values have no
 * meaningful zone, and native and detached pages carry none (detaching rewrites
 * the stored wall-clock into the device zone and clears the stamp).
 *
 * Reading the stored string directly is the bug this exists to prevent: a Tokyo
 * morning then reads as tomorrow to a viewer in California, showing the wrong
 * time in every list and dropping out of Today while its calendar block sits on
 * today's grid.
 *
 * Two things deliberately do **not** come through here. A completion map's KEY
 * stays the source-zone date, because that is what expansion suppresses by. An
 * editable date picker on a native page is already floating and has nothing to
 * convert.
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
}

/** A page's start in the viewer's zone, or null when it has no schedule. */
export function viewerStart(page: ViewerScheduled): string | null {
  return page.scheduledStart ? viewerWallClock(page.scheduledStart, page.timezone) : null;
}

/** A page's end in the viewer's zone, or null when it has none. */
export function viewerEnd(page: ViewerScheduled): string | null {
  return page.scheduledEnd ? viewerWallClock(page.scheduledEnd, page.timezone) : null;
}
