import { format, isSameMonth, isSameYear } from "date-fns";

import { parseLocalISO } from "../utils/dates";

/**
 * An all-day range as a chip label: "May 2 – 10", "May 2 – Jun 3", or across years "May 2, 2026 –
 * Jan 3, 2027". Inputs are local 'YYYY-MM-DD'. A missing, equal or earlier `end` gives the start
 * alone ("May 2", with the year when not the current one).
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
