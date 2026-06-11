// ─── Local wall-clock date helpers ─────────────────────────────────────────
//
// All dates in Pikos are stored as local wall-clock ISO strings — no Z suffix,
// no UTC conversion.  Date-only strings ('YYYY-MM-DD') represent all-day events.
// Datetime strings ('YYYY-MM-DDTHH:MM:SS') represent timed events.
//
// IMPORTANT: `new Date('YYYY-MM-DD')` in JS parses as UTC midnight, which
// shifts the displayed date by one day for users west of UTC.  Always use
// `parseLocalISO()` for date-only strings to avoid this.

import { format, parse, parseISO } from "date-fns";

/**
 * True for date-only ISO strings ('YYYY-MM-DD') used to represent all-day events.
 * Load-bearing invariant — keep all detection going through this helper so a
 * future format change has a single site to update.
 */
export function isAllDayIso(iso: string): boolean {
  return !iso.includes("T");
}

/** True for datetime ISO strings ('YYYY-MM-DDTHH:MM:SS') used for timed events. */
export function isTimedIso(iso: string): boolean {
  return iso.includes("T");
}

/**
 * Parses a Pikos ISO string as a local Date.
 *
 * - Date-only ('YYYY-MM-DD'): parsed via date-fns `parse()` so it stays local midnight.
 * - Datetime ('YYYY-MM-DDTHH:MM:SS'): parsed via date-fns `parseISO()` (local, no Z).
 *
 * Use this instead of `new Date(iso)` for any Pikos date string.
 */
export function parseLocalISO(iso: string): Date {
  return isAllDayIso(iso) ? parse(iso, "yyyy-MM-dd", new Date()) : parseISO(iso);
}

/**
 * Formats a Date as a local wall-clock ISO datetime ('YYYY-MM-DDTHH:MM:SS').
 * No Z suffix, no UTC conversion — matches the DB storage format for timed events.
 */
export function formatLocalISO(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * Formats a Date as a local 'YYYY-MM-DD' string (date-only, for all-day events).
 */
export function formatDateOnly(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/**
 * Returns today's date as a local 'YYYY-MM-DD' string.
 * Use this instead of `new Date().toISOString().slice(0, 10)` which returns UTC.
 */
export function localToday(): string {
  return formatDateOnly(new Date());
}

export function nowLocalISO(): string {
  return formatLocalISO(new Date());
}

/** IANA timezone name for the user's current locale (e.g. "America/Los_Angeles"). */
export function getLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
