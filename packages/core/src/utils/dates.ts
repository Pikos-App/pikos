// Dates are local wall-clock ISO strings with no Z suffix and no UTC conversion: date-only
// ('YYYY-MM-DD') for all-day events, 'YYYY-MM-DDTHH:MM:SS' for timed ones.
//
// `new Date('YYYY-MM-DD')` parses as UTC midnight, which shifts the displayed date by a day for
// users west of UTC. Use `parseLocalISO()` for date-only strings.

import { format, parse, parseISO } from "date-fns";

/** Every all-day check goes through this, so the format has one place to change. */
export function isAllDayIso(iso: string): boolean {
  return !iso.includes("T");
}

export function isTimedIso(iso: string): boolean {
  return iso.includes("T");
}

/** A Pikos ISO string as a local Date. Use it instead of `new Date(iso)`: date-only strings
 *  parse through date-fns `parse()` to stay local midnight. */
export function parseLocalISO(iso: string): Date {
  return isAllDayIso(iso) ? parse(iso, "yyyy-MM-dd", new Date()) : parseISO(iso);
}

/** Local wall-clock ISO datetime, as stored for timed events. */
export function formatLocalISO(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm:ss");
}

/** Local 'YYYY-MM-DD'. */
export function formatDateOnly(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/** Today as a local 'YYYY-MM-DD'; `new Date().toISOString().slice(0, 10)` would be UTC. */
export function localToday(): string {
  return formatDateOnly(new Date());
}

/** The 'YYYY-MM-DD' day of a Pikos date string. Occurrence exclusion sets key by day (a rule
 *  yields at most one occurrence per date), so a timed exdate or override must be day-keyed to
 *  match. Mirrors the Rust engine's `date_key`. */
export function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

export function nowLocalISO(): string {
  return formatLocalISO(new Date());
}

/** The device's IANA timezone name. */
export function getLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
