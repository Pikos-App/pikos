import { parseLocalISO } from "@pikos/core";
import { format, isSameMonth, isSameYear } from "date-fns";

/**
 * Formats an all-day date range as a compact chip label.
 *
 * - Same month, same year: "May 2 – 10"
 * - Different months, same year: "May 2 – Jun 3"
 * - Different years: "May 2, 2026 – Jan 3, 2027"
 *
 * Both inputs must be local 'YYYY-MM-DD' strings. If `end` is missing, equal
 * to `start`, or earlier than `start`, returns the start date alone
 * ("May 2", "May 2, 2025" when not the current year).
 */
export function formatDateRange(start: string, end: string | null | undefined): string {
  const now = new Date();
  const startDate = parseLocalISO(start);
  const startInCurrentYear = isSameYear(startDate, now);

  const startLong = startInCurrentYear
    ? format(startDate, "MMM d")
    : format(startDate, "MMM d, yyyy");

  if (!end || end <= start) return startLong;

  const endDate = parseLocalISO(end);

  if (isSameYear(startDate, endDate) && startInCurrentYear) {
    if (isSameMonth(startDate, endDate)) {
      return `${format(startDate, "MMM d")} – ${format(endDate, "d")}`;
    }
    return `${format(startDate, "MMM d")} – ${format(endDate, "MMM d")}`;
  }

  return `${format(startDate, "MMM d, yyyy")} – ${format(endDate, "MMM d, yyyy")}`;
}
