import { differenceInMinutes, getHours, getMinutes } from "date-fns";

import { isTimedIso, parseLocalISO } from "../utils/dates";
import { parseInput } from "./parser";

export interface TypedTime {
  hour24: number;
  minute: number;
  durationMinutes?: number;
}

/**
 * Reads a time typed beside a page's date, such as "9:05" or "3pm for 45m", with the Quick
 * Add parser. Only the time of day and a length are kept: the day the parser picks for a
 * bare time is discarded, because the page already has its own. Anything left over that the
 * parser could not read refuses the whole input, so a typo can't set half of what was meant.
 */
export function readTypedTime(typed: string): TypedTime | null {
  const parsed = parseInput(typed);
  if (parsed.type !== "single") return null;

  const { scheduledEnd, scheduledStart, title } = parsed.input;
  const hasLeftover = title.trim() !== "";
  if (hasLeftover || !scheduledStart || !isTimedIso(scheduledStart)) return null;

  const start = parseLocalISO(scheduledStart);
  const time = { hour24: getHours(start), minute: getMinutes(start) };
  const hasEnd = scheduledEnd !== undefined && isTimedIso(scheduledEnd);
  if (!hasEnd) return time;

  return { ...time, durationMinutes: differenceInMinutes(parseLocalISO(scheduledEnd), start) };
}
