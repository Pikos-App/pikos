import type { PagePriority, PageStatus } from "@pikos/core";
import { isAllDayIso, isDone, isTimedIso, parseRrule } from "@pikos/core";

import type {
  ColumnMapping,
  CSVMappingConfig,
  ImportFolder,
  ImportPage,
  ImportPlan,
  ImportWarning,
  PikosFieldKey,
  ValueMapping,
} from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a Date to local 'YYYY-MM-DDTHH:MM:SS'. */
function toLocalISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

/**
 * Parse a date/datetime string from CSV. Returns:
 * - 'YYYY-MM-DD' for date-only values
 * - 'YYYY-MM-DDTHH:MM:SS' for datetime values (converted to local time)
 * - null if unparseable
 */
function parseDateValue(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // Date-only: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Full ISO datetime (possibly with timezone offset like +0000)
  const isoMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s);
  if (isoMatch) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return toLocalISO(d);
    return s.slice(0, 19); // fallback: take the datetime portion as-is
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return toLocalISO(d);

  const dateMatch = /\d{4}-\d{2}-\d{2}/.exec(s);
  if (dateMatch) return dateMatch[0];

  return null;
}

/**
 * Parse a date value as date-only (YYYY-MM-DD). Used when the source row has
 * an "Is All Day" flag set: TickTick exports all-day events as midnight-UTC
 * timestamps (e.g. "2026-06-15T00:00:00+0000"), and converting through
 * `new Date()` shifts the date in non-UTC timezones. Take the calendar date
 * directly from the leading YYYY-MM-DD without timezone math.
 */
function parseAllDayDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return match ? match[1]! : null;
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/** Handles quoted fields containing commas/newlines. */
export function parseCSV(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const lines = splitCSVLines(text);
  if (lines.length < 2) return rows;

  const headers = parseCSVRow(lines[0]!);

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVRow(lines[i]!);
    if (values.length === 0 || (values.length === 1 && !values[0])) continue;

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!.trim()] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }

  return rows;
}

/** Split CSV text into logical lines (respecting quoted fields that span multiple lines). */
function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++; // skip \r\n
      if (current.trim()) lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─── Pre-processing ──────────────────────────────────────────────────────────

/** Strip TickTick backup preamble (metadata lines before the actual CSV headers). */
function stripTickTickPreamble(text: string): string {
  const headerPattern = /^"?Folder Name"?|^"?List Name"?/m;
  const match = headerPattern.exec(text);
  if (match) return text.slice(match.index);
  return text;
}

// ─── ISO 8601 duration parsing ───────────────────────────────────────────────

/**
 * Parse an ISO 8601 duration offset to minutes.
 * TickTick uses: PT0S (on time), -PT5M (5 min before), -PT30M, -PT1H, -P1D, etc.
 * Returns minutes_before (>= 0), or null if unparseable.
 */
export function parseDurationToMinutes(duration: string): number | null {
  const trimmed = duration.trim();
  if (!trimmed) return null;

  // Strip leading minus — TickTick uses negative durations for "before"
  const normalized = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;

  // Match ISO 8601 duration: P[nD][T[nH][nM][nS]]
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(normalized);
  if (!match) return null;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  // Seconds: round to nearest minute (PT0S = 0 min)
  const seconds = Number(match[4] ?? 0);

  return days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
}

/**
 * Pre-process Todoist-style rows: merge TYPE="note" into previous task,
 * skip TYPE="meta"/"section"/empty rows.
 */
function preprocessTodoistRows(rows: Record<string, string>[]): Record<string, string>[] {
  const result: Record<string, string>[] = [];

  for (const row of rows) {
    const type = (row["TYPE"] ?? "").toLowerCase();

    if (type === "meta" || type === "section") continue;
    if (!type && !(row["CONTENT"] ?? "").trim()) continue;

    if (type === "note") {
      if (result.length > 0) {
        const prev = result[result.length - 1]!;
        const noteContent = row["CONTENT"] ?? "";
        const prevDesc = prev["DESCRIPTION"] ?? "";
        prev["DESCRIPTION"] = prevDesc ? `${prevDesc}\n\n${noteContent}` : noteContent;
      }
      continue;
    }

    result.push({ ...row });
  }

  return result;
}

// ─── Prepare CSV rows ────────────────────────────────────────────────────────

export interface PreparedCSV {
  rows: Record<string, string>[];
  headers: string[];
}

/** Parse a CSV string into rows and headers, with BOM/preamble handling. */
export function prepareCSVRows(text: string): PreparedCSV {
  // Strip UTF-8 BOM
  let clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  clean = stripTickTickPreamble(clean);

  const rows = parseCSV(clean);
  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = Object.keys(rows[0]!);

  const normalized = new Set(headers.map((h) => h.toLowerCase().trim()));
  if (normalized.has("type") && normalized.has("content")) {
    return { headers, rows: preprocessTodoistRows(rows) };
  }

  return { headers, rows };
}

// ─── Column mapping suggestions ──────────────────────────────────────────────

/** Header name → suggested Pikos field (case-insensitive lookup). */
const HEADER_HEURISTICS: Record<string, PikosFieldKey> = {
  body: "body",
  category: "folder",
  completed: "status",
  completed_at: "completedAt",
  "completed at": "completedAt",
  "completed date": "completedAt",
  "completed time": "completedAt",
  content: "body",
  created: "createdAt",
  created_at: "createdAt",
  "created at": "createdAt",
  "created date": "createdAt",
  "created time": "createdAt",
  date: "scheduledStart",
  deadline: "scheduledStart",
  description: "body",
  due: "scheduledStart",
  "due date": "scheduledStart",
  "end date": "scheduledEnd",
  folder: "folder",
  "folder name": "folder",
  importance: "priority",
  labels: "tags",
  list: "folder",
  "list name": "folder",
  name: "title",
  notes: "body",
  parent_id: "sourceParentId",
  parentid: "sourceParentId",
  priority: "priority",
  project: "folder",
  reminder: "reminder",
  // Recurrence (iCal RRULE)
  repeat: "repeat",
  rrule: "repeat",
  scheduled: "scheduledStart",
  "start date": "scheduledStart",
  state: "status",
  status: "status",
  tags: "tags",
  task: "title",
  taskid: "sourceId",
  "task name": "title",
  title: "title",
  updated: "updatedAt",
  updated_at: "updatedAt",
  "updated at": "updatedAt",
  "updated date": "updatedAt",
};

function detectSource(headers: string[]): string | null {
  const normalized = new Set(headers.map((h) => h.toLowerCase().trim()));
  if ((normalized.has("folder name") || normalized.has("list name")) && normalized.has("title")) {
    return "TickTick";
  }
  if (normalized.has("type") && normalized.has("content")) {
    return "Todoist";
  }
  return null;
}

export interface SuggestedMappings {
  mappings: ColumnMapping[];
  detectedSource: string | null;
}

export function suggestColumnMappings(
  headers: string[],
  rows: Record<string, string>[]
): SuggestedMappings {
  const detectedSource = detectSource(headers);
  const assigned = new Set<PikosFieldKey>();

  const mappings: ColumnMapping[] = headers.map((header) => {
    const normalized = header.toLowerCase().trim();

    let suggested: PikosFieldKey | undefined;
    if (detectedSource === "Todoist") {
      if (normalized === "content") suggested = "title";
      else if (normalized === "description") suggested = "body";
      else if (normalized === "type") suggested = "skip";
      else if (normalized === "indent") suggested = "skip";
      else if (normalized === "deadline") suggested = "scheduledEnd";
    } else if (detectedSource === "TickTick") {
      // TickTick: "Folder Name" is always empty, "List Name" has the actual folder
      if (normalized === "folder name") suggested = "skip";
      else if (normalized === "list name") suggested = "folder";
      else if (normalized === "start date") suggested = "scheduledStart";
      else if (normalized === "due date") suggested = "scheduledEnd";
    }

    if (!suggested) {
      suggested = HEADER_HEURISTICS[normalized];
    }

    if (suggested && suggested !== "skip" && assigned.has(suggested)) {
      suggested = "skip";
    }

    const field = suggested ?? "skip";
    if (field !== "skip") assigned.add(field);

    const sampleValues: string[] = [];
    for (const row of rows) {
      if (sampleValues.length >= 3) break;
      const val = (row[header] ?? "").trim();
      if (val) sampleValues.push(val.length > 60 ? val.slice(0, 57) + "..." : val);
    }

    return { csvHeader: header, pikosField: field, sampleValues };
  });

  return { detectedSource, mappings };
}

// ─── Value mapping ───────────────────────────────────────────────────────────

export function detectUniqueValues(rows: Record<string, string>[], header: string): string[] {
  const values = new Set<string>();
  for (const row of rows) {
    const val = (row[header] ?? "").trim();
    if (val) values.add(val);
  }
  return [...values].sort();
}

export function suggestValueMappings(
  field: "status" | "priority",
  uniqueValues: string[],
  detectedSource: string | null
): ValueMapping {
  if (field === "status") {
    return {
      entries: uniqueValues.map((v) => {
        let target = "not_started";

        if (detectedSource === "TickTick") {
          // 0=Normal, 1=Completed, 2=Archived, -1=completed recurring
          if (v === "1" || v === "2" || v === "-1") target = "done";
        } else {
          const lower = v.toLowerCase();
          if (
            lower === "done" ||
            lower === "completed" ||
            lower === "complete" ||
            lower === "closed" ||
            lower === "true" ||
            lower === "yes" ||
            lower === "1" ||
            lower === "x"
          ) {
            target = "done";
          }
        }

        return { sourceValue: v, targetValue: target };
      }),
      field: "status",
    };
  }

  return {
    entries: uniqueValues.map((v) => {
      let target = "0"; // none

      if (detectedSource === "TickTick") {
        const map: Record<string, string> = { "0": "0", "1": "4", "3": "3", "5": "2" };
        target = map[v] ?? "0";
      } else if (detectedSource === "Todoist") {
        const map: Record<string, string> = { "1": "1", "2": "2", "3": "3", "4": "0" };
        target = map[v] ?? "0";
      } else {
        const num = Number(v);
        if (!isNaN(num) && num >= 0 && num <= 4) {
          target = String(Math.round(num));
        } else {
          const lower = v.toLowerCase();
          const labelMap: Record<string, string> = {
            critical: "1",
            high: "2",
            low: "4",
            medium: "3",
            none: "0",
            normal: "0",
            urgent: "1",
          };
          if (labelMap[lower]) target = labelMap[lower]!;
        }
      }

      return { sourceValue: v, targetValue: target };
    }),
    field: "priority",
  };
}

// ─── Known skip reasons (per source) ─────────────────────────────────────────

/** Explanations for why known columns are safe to skip, keyed by lowercase header. */
const KNOWN_SKIP_REASONS: Record<string, Record<string, string>> = {
  TickTick: {
    "column name": "TickTick Kanban column — no equivalent in Pikos",
    "column order": "TickTick Kanban ordering — no equivalent in Pikos",
    "folder name": "empty in TickTick exports — List Name used instead",
    "is all day": "handled automatically from date format",
    "is check list": "checklists imported as plain text content",
    "is floating": "TickTick internal flag — not needed",
    kind: "TickTick content type — all imported as pages",
    order: "TickTick sort order — Pikos assigns its own",
    reminder: "reminders not yet supported in Pikos",
    timezone: "timezone handled automatically during date conversion",
    "view mode": "TickTick display preference — not needed",
  },
  Todoist: {
    author: "task author — not tracked in Pikos",
    date_lang: "date language hint — handled automatically",
    deadline_lang: "deadline language hint — handled automatically",
    duration: "duration computed from scheduled start + end instead",
    duration_unit: "duration computed from scheduled start + end instead",
    indent: "subtask nesting level — map manually via Parent ID if needed",
    is_collapsed: "section collapse state — not applicable",
    responsible: "task assignee — not tracked in Pikos",
    timezone: "timezone handled automatically",
    type: "row type — already processed during import",
  },
};

/**
 * Find a column value from the raw row by matching header names (case-insensitive).
 * Used for auxiliary columns like DURATION that aren't mapped to a Pikos field.
 */
function findColumnValue(
  row: Record<string, string>,
  headers: string[],
  names: string[]
): string | null {
  const normalizedNames = new Set(names.map((n) => n.toLowerCase()));
  for (const h of headers) {
    if (normalizedNames.has(h.toLowerCase())) {
      const val = (row[h] ?? "").trim();
      if (val) return val;
    }
  }
  return null;
}

// ─── Apply mappings → ImportPlan ──────────────────────────────────────────────

export function applyMappings(
  rows: Record<string, string>[],
  config: CSVMappingConfig
): ImportPlan {
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const pages: ImportPage[] = [];
  const folderMap = new Map<string, ImportFolder>();
  const warnings: ImportWarning[] = [];

  const fieldToHeader = new Map<PikosFieldKey, string>();
  for (const cm of config.columnMappings) {
    if (cm.pikosField !== "skip") {
      fieldToHeader.set(cm.pikosField, cm.csvHeader);
    }
  }

  const statusMap = new Map<string, PageStatus>();
  const priorityMap = new Map<string, PagePriority>();
  for (const vm of config.valueMappings) {
    for (const entry of vm.entries) {
      if (vm.field === "status") {
        statusMap.set(entry.sourceValue, entry.targetValue as PageStatus);
      } else {
        priorityMap.set(entry.sourceValue, Number(entry.targetValue) as PagePriority);
      }
    }
  }

  const get = (row: Record<string, string>, field: PikosFieldKey): string => {
    const header = fieldToHeader.get(field);
    if (!header) return "";
    return (row[header] ?? "").trim();
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    const title = get(row, "title");
    if (!title) {
      warnings.push({
        message: `Row ${i + 2} has no title, skipped`,
        source: `row ${i + 2}`,
        type: "parse_error",
      });
      continue;
    }

    const body = get(row, "body");

    const folderName = get(row, "folder");
    let folderKey: string | null = null;
    if (folderName && folderName.toLowerCase() !== "inbox") {
      folderKey = folderName;
      if (!folderMap.has(folderName)) {
        folderMap.set(folderName, { key: folderName, name: folderName });
      }
    }

    const rawStatus = get(row, "status");
    const status: PageStatus = rawStatus
      ? (statusMap.get(rawStatus) ?? "not_started")
      : "not_started";

    const rawPriority = get(row, "priority");
    const priority: PagePriority = rawPriority ? (priorityMap.get(rawPriority) ?? 0) : 0;

    const rawTags = get(row, "tags");
    const tags = rawTags
      ? rawTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    // Dates — if scheduledStart is unparseable (e.g. Todoist natural language),
    // fall back to scheduledEnd (e.g. DEADLINE) as the scheduled date.
    // TickTick exports all-day events as midnight-UTC timestamps and signals
    // all-day via a separate column; parse those as date-only so the calendar
    // renders them in the all-day row instead of as zero-duration timed blocks.
    const isAllDayFlag =
      (findColumnValue(row, headers, ["is all day", "is_all_day"]) ?? "").toLowerCase() === "true";
    const parseDate = isAllDayFlag ? parseAllDayDate : parseDateValue;
    let scheduledStart = parseDate(get(row, "scheduledStart"));
    let scheduledEnd = parseDate(get(row, "scheduledEnd"));
    const usedEndAsFallback = !scheduledStart && !!scheduledEnd;
    if (usedEndAsFallback) {
      scheduledStart = scheduledEnd;
      scheduledEnd = null; // clear so duration can compute a proper end
    }

    // Duration → scheduledEnd: compute end time from start + duration
    // (e.g. Todoist DURATION=30, DURATION_UNIT=minute). Skip for all-day events.
    if (!isAllDayFlag && scheduledStart && !scheduledEnd) {
      const durationStr = findColumnValue(row, headers, ["duration"]);
      if (durationStr) {
        const durationMinutes = Number(durationStr);
        if (!isNaN(durationMinutes) && durationMinutes > 0) {
          let timedStart = scheduledStart;

          // If start is date-only, try to extract time from the raw field value
          // (e.g. Todoist DATE = "today at 11:00" → extract "11:00")
          if (isAllDayIso(timedStart)) {
            const rawDateField = get(row, "scheduledStart");
            const timeMatch = /(\d{1,2}):(\d{2})/.exec(rawDateField);
            if (timeMatch) {
              const h = timeMatch[1]!.padStart(2, "0");
              const m = timeMatch[2]!;
              timedStart = `${scheduledStart}T${h}:${m}:00`;
            } else {
              // No time info — create an all-day block, skip duration
              timedStart = "";
            }
          }

          if (timedStart && isTimedIso(timedStart)) {
            const startDate = new Date(timedStart);
            if (!isNaN(startDate.getTime())) {
              scheduledStart = timedStart;
              startDate.setMinutes(startDate.getMinutes() + durationMinutes);
              scheduledEnd = toLocalISO(startDate);
            }
          }
        }
      }
    }
    const createdAt = parseDateValue(get(row, "createdAt"));
    const completedAt = parseDateValue(get(row, "completedAt"));
    const updatedAt = parseDateValue(get(row, "updatedAt"));

    // Source IDs for parent resolution
    const sourceId = get(row, "sourceId") || null;
    const sourceParentId = get(row, "sourceParentId") || null;

    // Reminders: TickTick uses ISO 8601 durations (e.g. "PT0S", "-PT5M", "-PT1H").
    // Multiple reminders may be comma- or semicolon-separated.
    const rawReminder = get(row, "reminder");
    const reminderMinutes: number[] = [];
    if (rawReminder) {
      for (const part of rawReminder.split(/[,;]/)) {
        const mins = parseDurationToMinutes(part);
        if (mins !== null) reminderMinutes.push(mins);
      }
    }

    const effectiveCompletedAt =
      status === "done" ? (completedAt ?? new Date().toISOString()) : completedAt;

    // Recurrence rule (TickTick "Repeat" column uses iCal RRULE format).
    // Completed rows are historical occurrences — drop the rule silently so the
    // page stays a one-off completed record. The active template imports as a
    // separate row with the same rule.
    let rrule: string | null = null;
    const rawRepeat = get(row, "repeat");
    if (rawRepeat && status !== "done") {
      const cleaned = rawRepeat.replace(/^RRULE:/i, "").trim();
      if (!scheduledStart) {
        warnings.push({
          message: `Row ${i + 2} has a recurrence rule but no start/due date — rule dropped`,
          source: `row ${i + 2}`,
          type: "unsupported_content",
        });
      } else if (!parseRrule(cleaned)) {
        warnings.push({
          message: `Row ${i + 2} has an unsupported recurrence rule (${cleaned}) — rule dropped`,
          source: `row ${i + 2}`,
          type: "unsupported_content",
        });
      } else {
        rrule = cleaned;
      }
    }

    pages.push({
      body,
      completedAt: effectiveCompletedAt,
      createdAt,
      folderKey,
      imageRefs: [],
      priority,
      reminderMinutes,
      rrule,
      scheduledEnd,
      scheduledStart,
      sourceId,
      sourceParentId,
      status,
      tags,
      title,
      updatedAt: updatedAt ?? effectiveCompletedAt ?? createdAt,
      wikilinks: [],
    });
  }

  const skippedCount = warnings.filter((w) => w.type === "parse_error").length;
  const skippedColumns = config.columnMappings.filter((cm) => cm.pikosField === "skip").length;
  const meta = {
    skipped: [
      ...(skippedCount > 0 ? [{ count: skippedCount, reason: "rows without a title" }] : []),
      ...(skippedColumns > 0
        ? [{ count: skippedColumns, reason: `column${skippedColumns !== 1 ? "s" : ""} not mapped` }]
        : []),
    ],
    transformations: [] as string[],
  };

  const mapped = [...fieldToHeader.keys()];

  if (!mapped.includes("scheduledEnd") && mapped.includes("scheduledStart")) {
    meta.transformations.push("Only start/due dates imported — no end times");
  }

  const doneCount = pages.filter(isDone).length;
  if (doneCount > 0) {
    meta.transformations.push(`${doneCount} tasks marked as completed`);
  }

  const parentCount = pages.filter((p) => p.sourceParentId).length;
  if (parentCount > 0) {
    meta.transformations.push(`${parentCount} subtasks linked to parent pages`);
  }

  const recurringCount = pages.filter((p) => p.rrule).length;
  if (recurringCount > 0) {
    meta.transformations.push(`${recurringCount} recurring rules imported`);
  }

  const skippedMappings = config.columnMappings.filter((cm) => cm.pikosField === "skip");
  if (skippedMappings.length > 0) {
    const explained: string[] = [];
    const unexplained: string[] = [];

    for (const cm of skippedMappings) {
      const reason = KNOWN_SKIP_REASONS[config.detectedSource ?? ""]?.[cm.csvHeader.toLowerCase()];
      if (reason) {
        explained.push(`${cm.csvHeader}: ${reason}`);
      } else if (cm.sampleValues.length > 0) {
        unexplained.push(cm.csvHeader);
      }
    }

    for (const note of explained) {
      meta.transformations.push(note);
    }
    if (unexplained.length > 0) {
      meta.transformations.push(`Skipped columns: ${unexplained.join(", ")}`);
    }
  }

  if (!mapped.includes("createdAt")) {
    meta.transformations.push("No created date mapped — using current time");
  }

  if (mapped.includes("status") && !mapped.includes("completedAt")) {
    meta.transformations.push("No completed date column — completed tasks use current time");
  }

  const sourceLabel = config.detectedSource ? `csv_${config.detectedSource.toLowerCase()}` : "csv";

  return {
    folders: [...folderMap.values()],
    meta,
    pages,
    source: sourceLabel,
    warnings,
  };
}
