import type { PageSummary } from "../types";
import { formatLocalISO, isTimedIso } from "../utils/dates";
import { isDone } from "../utils/page";
import { resolveSyncedInstant } from "../utils/syncedTime";
import { formatTriggerLabel } from "./dateTimePicker";

/**
 * Read-only schedule label for a synced (locked) event, shared by the editor byline and the
 * calendar block popover. A timed event resolves to the viewer's zone, so the time is the
 * user's local time and no zone qualifier shows ("4pm in Tokyo" reads as Tokyo time, the
 * opposite of what's meant). All-day events never shift.
 *
 * Gated on `scheduleLocked`, like `viewerStart` and `resolveBlockInstant`, so the three paths
 * can't disagree about what "absolute" means.
 */
export function syncedScheduleLabel(page: PageSummary): string | null {
  const start = page.scheduledStart;
  if (!start) return null;
  const done = isDone(page);
  const tz = page.scheduleLocked ? (page.timezone ?? undefined) : undefined;
  if (isTimedIso(start) && tz) {
    const startIso = formatLocalISO(resolveSyncedInstant(start, tz));
    const endIso =
      page.scheduledEnd && isTimedIso(page.scheduledEnd)
        ? formatLocalISO(resolveSyncedInstant(page.scheduledEnd, tz))
        : null;
    return formatTriggerLabel(startIso, endIso, done).label;
  }
  return formatTriggerLabel(start, page.scheduledEnd ?? null, done).label;
}
