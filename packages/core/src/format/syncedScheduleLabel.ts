import type { PageSummary } from "../types";
import { formatLocalISO, isTimedIso } from "../utils/dates";
import { isDone } from "../utils/page";
import { resolveSyncedInstant } from "../utils/syncedTime";
import { formatTriggerLabel } from "./dateTimePicker";

/**
 * Read-only schedule label for a synced (locked) event, shared by the editor
 * byline and the calendar block popover. Timed events resolve to the viewer's
 * zone (absolute) — the returned time IS the user's local time, so no zone
 * qualifier is shown (a "4pm in Tokyo" tag reads as Tokyo time, the opposite of
 * what's meant). All-day synced events never shift. Native pages never call this.
 */
export function syncedScheduleLabel(page: PageSummary): string | null {
  const start = page.scheduledStart;
  if (!start) return null;
  const done = isDone(page);
  const tz = page.timezone ?? undefined;
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
