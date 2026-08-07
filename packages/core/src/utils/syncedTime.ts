// ─── Synced (external-calendar) absolute-time rendering ──────────────────────
//
// The one exception to Pikos's floating wall-clock model (see `dates.ts`): a
// synced event is ABSOLUTE. It's stored as source-zone wall-clock + the source
// IANA id, but rendered in the *viewer's* current zone — a 3pm Los_Angeles event
// shows at 6pm for a New_York viewer. Native pages float and never come here.

import { fromZonedTime } from "date-fns-tz";

/**
 * Resolve a synced timed event's source-zone wall-clock string
 * ('YYYY-MM-DDTHH:MM:SS') to its absolute instant, given the source IANA zone.
 * Positioning/formatting then reads that instant in the device's local zone —
 * there's no separate "to viewer zone" step.
 *
 * Timed synced events only. All-day synced events are date-only and never
 * shift — keep them on the floating `parseLocalISO` path.
 */
export function resolveSyncedInstant(wallClock: string, sourceZone: string): Date {
  return fromZonedTime(wallClock, sourceZone);
}
