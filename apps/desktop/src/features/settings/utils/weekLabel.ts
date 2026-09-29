import type { WorkspaceWeekActivity } from "@pikos/core";

/**
 * How a week bucket is named on the Data page's charts.
 *
 * Buckets are keyed and labelled by the **Monday that opens them**, so on any
 * day but Monday the newest bar carries a date that already passed — a chart
 * read on Thursday the 20th ends in "Aug 17" and looks days out of date. Naming
 * the newest bucket for the present instead of its start answers that on sight,
 * and it is the only bucket whose date is ambiguous this way: every earlier one
 * is safely in the past.
 */
export function weekLabel(weeks: WorkspaceWeekActivity[], index: number): string {
  const week = weeks[index];
  if (!week) return "";
  return index === weeks.length - 1 ? "This week" : week.week;
}
