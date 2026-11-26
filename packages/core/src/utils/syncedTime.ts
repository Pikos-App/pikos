// The one exception to the floating wall-clock model (`dates.ts`): a synced event is absolute.
// It is stored as source-zone wall clock plus the source IANA id and rendered in the viewer's
// zone, so a 3pm Los_Angeles event shows at 6pm for a New_York viewer. Native pages float and
// never come here.

import { formatLocalISO, isTimedIso } from "./dates";
import { wallClockToUtc } from "./zoned";

/** A synced timed event's source-zone wall clock as its absolute instant; reading that instant
 * in the device zone is the viewer conversion. DST policy: see `zoned.ts`. Timed events only:
 * all-day ones are date-only and never shift. */
export function resolveSyncedInstant(wallClock: string, sourceZone: string): Date {
  return wallClockToUtc(sourceZone, wallClock);
}

/**
 * A zoned wall clock in the viewer's zone. The caller must already know the value is absolute:
 * this converts whenever a zone is present. Surfaces reading a page use `viewerStart` and
 * `viewerEnd`, which decide that. All-day values come back untouched.
 */
export function viewerWallClock(wallClock: string, timezone: string | null | undefined): string {
  if (timezone && isTimedIso(wallClock)) {
    return formatLocalISO(resolveSyncedInstant(wallClock, timezone));
  }
  return wallClock;
}

/** What `viewerStart` reads; `Page`, `PageSummary` and an expanded occurrence all satisfy it. */
export interface ViewerScheduled {
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  timezone?: string | null;
  /** Required so a synced page can't silently default to floating and show a meeting at the wrong hour. */
  scheduleLocked: boolean;
}

/**
 * Whether a page's stored wall clock is an absolute instant rather than a floating one.
 *
 * A populated `timezone` does not mean absolute: authoring stamps the device zone on every native
 * schedule as provenance, so origin is the discriminator (`docs/time-handling.md`). Reading the
 * column alone would move "take medication at 9am" whenever the device zone changed. Detaching
 * rewrites the wall clock into the device zone, so the gate is `scheduleLocked`, the same gate
 * the calendar grid's `resolveBlockInstant` uses.
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
