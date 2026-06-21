// ─── Synced (external-calendar) absolute-time rendering ──────────────────────
//
// The one exception to Pikos's floating wall-clock model (see `dates.ts`): a
// synced event is ABSOLUTE. It is stored as source-zone wall-clock + the source
// IANA id, but rendered in the *viewer's* current zone — a 3pm Los_Angeles event
// shows at 6pm for a New_York viewer. Native pages float and never come here.
//
// The conversion is one step: source wall-clock + source zone → the absolute
// instant. The calendar's positioning/formatting then read that instant's fields
// in the device's local zone (= the viewer's zone in production), which yields
// the viewer-zone wall clock for free — so there is no explicit "to viewer zone"
// call. Tests pin TZ=UTC, so "the viewer zone" there is UTC.

import { fromZonedTime } from "date-fns-tz";

/**
 * Resolve a synced timed event's source-zone wall-clock string
 * ('YYYY-MM-DDTHH:MM:SS') to its absolute instant, given the source IANA zone.
 * The renderer then reads the instant's fields in the device (viewer) zone, so
 * the displayed time is the user's own local time.
 *
 * Callers must only use this for **timed** synced events. All-day synced events
 * are date-only and never shift — keep them on the floating `parseLocalISO` path.
 */
export function resolveSyncedInstant(wallClock: string, sourceZone: string): Date {
  return fromZonedTime(wallClock, sourceZone);
}
