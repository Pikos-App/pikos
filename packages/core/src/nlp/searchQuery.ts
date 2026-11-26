// Search-palette operators (`tag:`, `folder:`, `is:`, `priority:`, `due:`) lifted out of a query,
// leaving the free text. Token-stripping as in the quick-add parser: an operator the grammar
// doesn't know stays in the text, so "ratio:1" still searches for "ratio:1".

import { addDays } from "date-fns";

import type { Folder, PageFilter, PagePriority } from "../types";
import { formatDateOnly } from "../utils/dates";
import { fuzzyMatchFolder } from "../utils/fuzzyMatchFolder";

export interface ParsedSearchQuery {
  /** Free text left after every recognised operator was lifted out. */
  text: string;
  /** In the order typed; matched conjunctively. */
  tags: string[];
  /** Raw; the caller resolves it against real folders. */
  folder: string | null;
  status: "done" | "not_started" | null;
  scheduled: boolean;
  priority: PagePriority | null;
  /** Inclusive, "YYYY-MM-DD". */
  dueFrom: string | null;
  /** Inclusive, "YYYY-MM-DDT23:59:59", as the CLI's `parse_due`. */
  dueTo: string | null;
  /** At least one operator was recognised and stripped. */
  hasOperators: boolean;
}

export interface SearchFilterBuild {
  filter: PageFilter;
  /** Set when `folder:` named something no folder matches — nothing can match. */
  unresolvedFolder: string | null;
}

/** Priority words and digits use the quick-add parser's scale (1 urgent ... 4 low, 0 none). */
const PRIORITY_VALUES: Record<string, PagePriority> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  high: 2,
  low: 4,
  medium: 3,
  none: 0,
  urgent: 1,
};

// `(^|\s)` anchors an operator to a word start, so "path/to:file" stays text. A value is a quoted
// string (spaces allowed) or a run of non-space characters.
const OPERATOR_RE = /(^|\s)(tag|folder|is|priority|due):(?:"([^"]*)"|(\S+))/gi;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-02-31" matches the shape but isn't a date. */
function isRealDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** One `due:` endpoint as the day span it names, or null. */
function resolveDueEndpoint(token: string, ref: Date): { from: string; to: string } | null {
  const t = token.toLowerCase();
  if (isRealDate(t)) return { from: t, to: t };
  const today = formatDateOnly(ref);
  switch (t) {
    case "month":
      return { from: today, to: formatDateOnly(addDays(ref, 29)) };
    case "today":
      return { from: today, to: today };
    case "tomorrow": {
      const d = formatDateOnly(addDays(ref, 1));
      return { from: d, to: d };
    }
    case "week":
      return { from: today, to: formatDateOnly(addDays(ref, 6)) };
    case "yesterday": {
      const d = formatDateOnly(addDays(ref, -1));
      return { from: d, to: d };
    }
    default:
      return null;
  }
}

/** One endpoint or an `a..b` range, either side omittable for an open bound. Null when any named
 * endpoint fails to resolve, so the whole token falls back to free text. */
function resolveDue(value: string, ref: Date): { from: string | null; to: string | null } | null {
  if (value.includes("..")) {
    const parts = value.split("..");
    if (parts.length !== 2) return null;
    const [rawFrom, rawTo] = parts as [string, string];
    const from = rawFrom ? resolveDueEndpoint(rawFrom, ref) : null;
    const to = rawTo ? resolveDueEndpoint(rawTo, ref) : null;
    if (rawFrom && !from) return null;
    if (rawTo && !to) return null;
    if (!from && !to) return null;
    return { from: from?.from ?? null, to: to?.to ?? null };
  }
  const single = resolveDueEndpoint(value, ref);
  return single ? { from: single.from, to: single.to } : null;
}

/** Splits a palette query into operators and free text. `now` is injectable for `due:today`. */
export function parseSearchQuery(raw: string, now?: Date): ParsedSearchQuery {
  const ref = now ?? new Date();

  const tags: string[] = [];
  let folder: string | null = null;
  let status: "done" | "not_started" | null = null;
  let scheduled = false;
  let priority: PagePriority | null = null;
  let dueFrom: string | null = null;
  let dueTo: string | null = null;
  let hasOperators = false;

  const stripped = raw.replace(
    OPERATOR_RE,
    (match, lead: string, key: string, quoted: string | undefined, bare: string | undefined) => {
      const value = (quoted ?? bare ?? "").trim();
      if (!value) return match;

      switch (key.toLowerCase()) {
        case "due": {
          const due = resolveDue(value, ref);
          if (!due) return match;
          dueFrom = due.from;
          dueTo = due.to === null ? null : `${due.to}T23:59:59`;
          break;
        }
        case "folder":
          folder = value; // last wins, mirroring the quick-add parser's ~folder
          break;
        case "is":
          switch (value.toLowerCase()) {
            case "done":
              status = "done";
              break;
            case "open":
              status = "not_started";
              break;
            case "scheduled":
              scheduled = true;
              break;
            default:
              return match;
          }
          break;
        case "priority": {
          const mapped = PRIORITY_VALUES[value.toLowerCase()];
          if (mapped === undefined) return match;
          priority = mapped;
          break;
        }
        case "tag":
          tags.push(value);
          break;
        default:
          return match;
      }

      hasOperators = true;
      // Keep the boundary character so the words either side stay separate.
      return lead;
    }
  );

  return {
    dueFrom,
    dueTo,
    folder,
    hasOperators,
    priority,
    scheduled,
    status,
    tags,
    text: stripped.replace(/\s+/g, " ").trim(),
  };
}

/**
 * The `PageFilter` for parsed operators. `text` is not mapped onto `PageFilter.query`, an
 * unindexed `title LIKE ... OR content_text LIKE ...` scan that `list_pages_impl` documents as
 * test-only; free text goes through FTS5 and the caller intersects the results.
 */
export function buildSearchFilter(parsed: ParsedSearchQuery, folders: Folder[]): SearchFilterBuild {
  const filter: PageFilter = {};
  let unresolvedFolder: string | null = null;

  if (parsed.folder !== null) {
    const match = fuzzyMatchFolder(parsed.folder, folders);
    if (match) {
      filter.folderId = match.id;
    } else if (parsed.folder.toLowerCase() === "inbox") {
      filter.folderId = null;
    } else {
      unresolvedFolder = parsed.folder;
    }
  }

  if (parsed.status !== null) filter.status = parsed.status;
  if (parsed.priority !== null) filter.priority = parsed.priority;
  if (parsed.tags.length > 0) filter.tags = [...parsed.tags];
  if (parsed.dueFrom !== null) filter.scheduledAfter = parsed.dueFrom;
  if (parsed.dueTo !== null) filter.scheduledBefore = parsed.dueTo;
  // A date bound only applies to a scheduled page, and the backends disagree on unscheduled rows
  // (SQL drops them on the NULL compare, the mock keeps them); requiring a schedule makes both
  // answer the same.
  if (parsed.scheduled || parsed.dueFrom !== null || parsed.dueTo !== null) {
    filter.hasSchedule = true;
  }

  return { filter, unresolvedFolder };
}
