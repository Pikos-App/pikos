// The mock's copy of the database's list reads (`views.rs`, `reads.rs`, `moves.rs` in pikos-db),
// written as plain sorts over every page, which a mock can afford. The differential suite holds
// it to the database's answers on the same workspace.

import { addDays, format } from "date-fns";

import type {
  CompletedCursor,
  CompletedWindow,
  DateBounds,
  PageSummary,
  ViewCursor,
  ViewKey,
  ViewScope,
  ViewWindow,
} from "../types";
import { parseLocalISO } from "../utils/dates";
import { emojiAwareCompare } from "../utils/sort";
import { utcToWallClock, wallClockToUtc } from "../utils/zoned";

/** The gap left between neighbouring manual order values: `ORDER_SPACING` in pikos-db. */
export const ORDER_SPACING = 1 << 20;

/** Upcoming's days, counting today. */
export const UPCOMING_DAYS = 7;

const PRIORITY_TIERS = [1, 2, 3, 4, 0];

/** A stored start as a full wall clock, as `order_start` computes it. */
export function wallClock(start: string): string {
  if (start.length === 10) return `${start}T00:00:00`;
  if (start.length === 16) return `${start}:00`;
  return start.slice(0, 19);
}

function isAbsolute(page: PageSummary): boolean {
  return (
    page.scheduleLocked &&
    !!page.timezone &&
    page.scheduledStart != null &&
    page.scheduledStart.length > 10
  );
}

/** The page's start as a wall clock in `zone`, or null when it has none. */
export function startIn(page: PageSummary, zone: string): string | null {
  if (!page.scheduledStart) return null;
  if (!isAbsolute(page)) return wallClock(page.scheduledStart);
  return utcToWallClock(zone, wallClockToUtc(page.timezone!, wallClock(page.scheduledStart)));
}

function inScope(page: PageSummary, scope: ViewScope): boolean {
  if (scope.kind === "inbox") return page.folderId == null;
  if (scope.kind === "folder") return page.folderId === scope.folderId;
  return true;
}

function inDates(start: string | null, bounds: DateBounds): boolean {
  if (start == null) return false;
  const day = start.slice(0, 10);
  return (bounds.from == null || day >= bounds.from) && day < bounds.until;
}

/** A page's place in its view, in the same shape as the database's cursor. */
function cursorOf(page: PageSummary, key: ViewKey): ViewCursor {
  const start = startIn(page, key.zone);
  const tie = { createdAt: page.createdAt, id: page.id, sortOrder: page.sortOrder };
  if (key.dates) return { key: start, section: 0, ...tie };
  switch (key.sort) {
    case "manual":
      return { key: null, section: 0, ...tie };
    case "title":
      return { key: page.title, section: 0, ...tie };
    case "date":
      return { key: start, section: start == null ? 1 : 0, ...tie };
    case "priority": {
      const tier = PRIORITY_TIERS.indexOf(page.priority);
      return { key: start, section: tier * 2 + (start == null ? 1 : 0), ...tie };
    }
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCursors(a: ViewCursor, b: ViewCursor, title: boolean): number {
  if (a.section !== b.section) return a.section - b.section;
  if (a.key !== b.key) {
    if (a.key == null) return -1;
    if (b.key == null) return 1;
    const byKey = title ? emojiAwareCompare(a.key, b.key) : compareText(a.key, b.key);
    if (byKey !== 0) return byKey;
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt !== b.createdAt) return compareText(a.createdAt, b.createdAt);
  return compareText(a.id, b.id);
}

/** Every row of the view in order, each with its cursor. */
export function orderedView(
  pages: PageSummary[],
  key: ViewKey
): { cursor: ViewCursor; page: PageSummary }[] {
  const title = !key.dates && key.sort === "title";
  return pages
    .filter((p) => p.status !== "done" && inScope(p, key.scope))
    .filter((p) => !key.dates || inDates(startIn(p, key.zone), key.dates))
    .map((page) => ({ cursor: cursorOf(page, key), page }))
    .sort((a, b) => compareCursors(a.cursor, b.cursor, title));
}

function after<T extends { cursor: ViewCursor }>(
  rows: T[],
  cursor: ViewCursor | null,
  title: boolean
): T[] {
  if (cursor == null) return rows;
  return rows.filter((r) => compareCursors(r.cursor, cursor, title) > 0);
}

export function listViewOf(
  pages: PageSummary[],
  key: ViewKey,
  cursor: ViewCursor | null,
  limit: number
): ViewWindow {
  const title = !key.dates && key.sort === "title";
  const all = orderedView(pages, key);
  const rest = after(all, cursor, title);
  const rows = rest.slice(0, limit);
  return {
    next: rest.length > limit ? rows[rows.length - 1]!.cursor : null,
    rows: rows.map((r) => r.page),
    total: cursor == null ? all.length : null,
  };
}

export function listViewIdsOf(
  pages: PageSummary[],
  key: ViewKey,
  from: ViewCursor | null,
  through: ViewCursor | null
): string[] {
  const title = !key.dates && key.sort === "title";
  return after(orderedView(pages, key), from, title)
    .filter((r) => through == null || compareCursors(r.cursor, through, title) <= 0)
    .map((r) => r.page.id);
}

export function listCompletedOf(
  pages: PageSummary[],
  scope: ViewScope | null,
  since: string | null,
  cursor: CompletedCursor | null,
  limit: number
): CompletedWindow {
  const newestFirst = (a: PageSummary, b: PageSummary) =>
    compareText(b.completedAt ?? "", a.completedAt ?? "") || compareText(b.id, a.id);
  const all = pages
    .filter((p) => p.status === "done" && p.completedAt != null)
    .filter((p) => scope == null || inScope(p, scope))
    .filter((p) => since == null || p.completedAt! >= since)
    .sort(newestFirst);
  const rest =
    cursor == null
      ? all
      : all.filter(
          (p) =>
            compareText(p.completedAt!, cursor.completedAt) < 0 ||
            (p.completedAt === cursor.completedAt && compareText(p.id, cursor.id) < 0)
        );
  const rows = rest.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    next: rest.length > limit && last ? { completedAt: last.completedAt!, id: last.id } : null,
    rows,
    total: cursor == null ? all.length : null,
  };
}

/** The page's span in `zone`, as the calendar places it. */
function spanIn(page: PageSummary, zone: string): [string, string] | null {
  const start = startIn(page, zone);
  if (start == null || !page.scheduledStart) return null;
  if (page.scheduledStart.length === 10) {
    const last =
      page.scheduledEnd && page.scheduledEnd.length === 10
        ? page.scheduledEnd
        : page.scheduledStart;
    return [start, `${format(addDays(parseLocalISO(last), 1), "yyyy-MM-dd")}T00:00:00`];
  }
  if (!page.scheduledEnd) return [start, start];
  const end = isAbsolute(page)
    ? utcToWallClock(zone, wallClockToUtc(page.timezone!, wallClock(page.scheduledEnd)))
    : wallClock(page.scheduledEnd);
  return [start, end];
}

export function listRangeOf(
  pages: PageSummary[],
  start: string | null,
  end: string,
  zone: string,
  openOnly: boolean
): PageSummary[] {
  const startWall = start == null ? null : utcToWallClock(zone, new Date(start));
  const endWall = utcToWallClock(zone, new Date(end));
  return pages
    .filter((p) => !openOnly || p.status !== "done")
    .map((page) => ({ page, span: spanIn(page, zone) }))
    .filter(
      ({ span }) => span != null && span[0] < endWall && (startWall == null || span[1] > startWall)
    )
    .sort(
      (a, b) =>
        compareText(a.span![0], b.span![0]) ||
        a.page.sortOrder - b.page.sortOrder ||
        compareText(a.page.createdAt, b.page.createdAt) ||
        compareText(a.page.id, b.page.id)
    )
    .map(({ page }) => page);
}

/** Open pages starting from `from` (or without limit) up to `until`, days in `zone`. */
export function countStarting(
  pages: PageSummary[],
  zone: string,
  from: string | null,
  until: string
): number {
  return pages.filter((p) => p.status !== "done" && inDates(startIn(p, zone), { from, until }))
    .length;
}

export function dayAfter(day: string, days = 1): string {
  return format(addDays(parseLocalISO(day), days), "yyyy-MM-dd");
}
