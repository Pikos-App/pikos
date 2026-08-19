// Row wording and timestamps for the notification history list. Split from the
// component so both stay plain functions the tests can call directly — and so
// the component file exports nothing but a component.

import type { NotificationHistoryEntry } from "@pikos/core";
import { parseLocalISO } from "@pikos/core";
import { format, isToday, isYesterday } from "date-fns";

/** `fired_at` is written as SQLite's local `YYYY-MM-DD HH:MM:SS`, not ISO. */
function parseFiredAt(firedAt: string): Date {
  return parseLocalISO(firedAt.replace(" ", "T"));
}

/** "9:05am" today, "Yesterday 9:05am", "Mon 25 May 9:05am" beyond that — a log
 *  spanning 30 days needs the date, and today's rows don't. */
export function formatFiredAt(firedAt: string): string {
  const at = parseFiredAt(firedAt);
  if (Number.isNaN(at.getTime())) return firedAt;
  const time = format(at, "h:mmaaa");
  if (isToday(at)) return time;
  if (isYesterday(at)) return `Yesterday ${time}`;
  return `${format(at, "EEE d MMM")} ${time}`;
}

/** What this row says happened, in the user's terms. */
export function describeEntry(entry: NotificationHistoryEntry): string {
  if (entry.kind === "suppressed") return "Silenced by quiet hours";
  if (entry.kind === "overdue") return "Daily summary";
  return entry.action === "opened" ? "Reminder · opened" : "Reminder";
}
