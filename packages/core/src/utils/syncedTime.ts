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
 * The wall-clock a done clone of a synced occurrence should carry. The clone is
 * a NATIVE (floating) page, so a timed zoned occurrence stores its start as the
 * viewer-local wall-clock — the clone then floats at the same slot the absolute
 * occurrence rendered (a 3pm PT event shown at 6pm ET keeps a 6pm clone).
 * All-day / floating (no zone) occurrences keep the raw wall-clock.
 *
 * The completion map's KEY stays the source-zone date — that is what expansion
 * suppresses by — so only the clone's own timestamps come through here.
 */
export function cloneWallClock(wallClock: string, timezone: string | null | undefined): string {
  if (timezone && isTimedIso(wallClock)) {
    return formatLocalISO(resolveSyncedInstant(wallClock, timezone));
  }
  return wallClock;
}
