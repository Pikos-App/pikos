// CSV parser for TickTick and Todoist exports.
// Auto-detects source from header row.

import type { PagePriority, PageStatus } from "@pikos/core";

import type { ImportFolder, ImportPage, ImportPlan, ImportWarning } from "./types";

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/** Parse CSV text into rows of key-value pairs. Handles quoted fields with commas/newlines. */
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

/** Parse a single CSV row into field values. */
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

// ─── Source detection ─────────────────────────────────────────────────────────

type CSVSource = "ticktick" | "todoist" | "unknown";

function detectSource(headers: string[]): CSVSource {
  const normalized = new Set(headers.map((h) => h.toLowerCase().trim()));

  // TickTick: has "Folder Name" or "List Name" and "Title"
  if ((normalized.has("folder name") || normalized.has("list name")) && normalized.has("title")) {
    return "ticktick";
  }

  // Todoist: has "TYPE" and "CONTENT"
  if (normalized.has("type") && normalized.has("content")) {
    return "todoist";
  }

  return "unknown";
}

// ─── TickTick parser ──────────────────────────────────────────────────────────

function parseTickTick(rows: Record<string, string>[]): ImportPlan {
  const pages: ImportPage[] = [];
  const folderMap = new Map<string, ImportFolder>();
  const warnings: ImportWarning[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const title = row["Title"] ?? "";
    if (!title) {
      warnings.push({
        message: `Row ${i + 2} has no title, skipped`,
        source: `row ${i + 2}`,
        type: "parse_error",
      });
      continue;
    }

    // Folder
    const folderName = row["Folder Name"] || row["List Name"] || "";
    let folderKey: string | null = null;
    if (folderName && folderName.toLowerCase() !== "inbox") {
      folderKey = folderName;
      if (!folderMap.has(folderName)) {
        folderMap.set(folderName, { key: folderName, name: folderName });
      }
    }

    // Status: TickTick uses 0=active, 2=completed
    const rawStatus = row["Status"] ?? "0";
    const status: PageStatus = rawStatus === "2" ? "done" : "not_started";

    // Priority: TickTick uses 0=none, 1=low, 3=medium, 5=high
    const rawPriority = Number(row["Priority"] ?? "0");
    const priorityMap: Record<number, PagePriority> = { 0: 0, 1: 4, 3: 3, 5: 2 };
    const priority: PagePriority = priorityMap[rawPriority] ?? 0;

    // Tags
    const rawTags = row["Tags"] ?? "";
    const tags = rawTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Due date
    const rawDue = row["Due Date"] ?? "";
    let scheduledDate: string | null = null;
    if (rawDue) {
      const dateMatch = /\d{4}-\d{2}-\d{2}/.exec(rawDue);
      if (dateMatch) scheduledDate = dateMatch[0];
    }

    // Created date
    const rawCreated = row["Created Date"] ?? row["Created Time"] ?? "";
    let createdAt: string | null = null;
    if (rawCreated) {
      const dateMatch = /\d{4}-\d{2}-\d{2}/.exec(rawCreated);
      if (dateMatch) createdAt = dateMatch[0];
    }

    // Content
    const body = row["Content"] ?? "";

    pages.push({
      body,
      createdAt,
      folderKey,
      priority,
      scheduledDate,
      status,
      tags,
      title,
      wikilinks: [],
    });
  }

  return {
    folders: [...folderMap.values()],
    pages,
    source: "csv_ticktick",
    warnings,
  };
}

// ─── Todoist parser ───────────────────────────────────────────────────────────

function parseTodoist(rows: Record<string, string>[]): ImportPlan {
  const pages: ImportPage[] = [];
  const folderMap = new Map<string, ImportFolder>();
  const warnings: ImportWarning[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const type = (row["TYPE"] ?? "").toLowerCase();

    // Skip sections — Pikos has no section concept
    if (type === "section") continue;

    // Notes become content appended to the previous task if possible
    if (type === "note") {
      if (pages.length > 0) {
        const prev = pages[pages.length - 1]!;
        const noteContent = row["CONTENT"] ?? "";
        prev.body = prev.body ? `${prev.body}\n\n${noteContent}` : noteContent;
      }
      continue;
    }

    const title = row["CONTENT"] ?? "";
    if (!title) {
      warnings.push({
        message: `Row ${i + 2} has no content, skipped`,
        source: `row ${i + 2}`,
        type: "parse_error",
      });
      continue;
    }

    // Project → folder
    const projectName = row["PROJECT"] ?? "";
    let folderKey: string | null = null;
    if (projectName && projectName.toLowerCase() !== "inbox") {
      folderKey = projectName;
      if (!folderMap.has(projectName)) {
        folderMap.set(projectName, { key: projectName, name: projectName });
      }
    }

    // Priority: Todoist inverts (4=p1/urgent, 3=p2/high, 2=p3/medium, 1=p4/low)
    const rawPriority = Number(row["PRIORITY"] ?? "1");
    const priorityMap: Record<number, PagePriority> = { 1: 0, 2: 3, 3: 2, 4: 1 };
    const priority: PagePriority = priorityMap[rawPriority] ?? 0;

    // Date
    const rawDate = row["DATE"] ?? "";
    let scheduledDate: string | null = null;
    if (rawDate) {
      const dateMatch = /\d{4}-\d{2}-\d{2}/.exec(rawDate);
      if (dateMatch) scheduledDate = dateMatch[0];
    }

    // Labels → tags
    const rawLabels = row["LABELS"] ?? "";
    const tags = rawLabels
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Description
    const body = row["DESCRIPTION"] ?? "";

    pages.push({
      body,
      createdAt: null,
      folderKey,
      priority,
      scheduledDate,
      status: "not_started", // Todoist CSV export typically only includes active tasks
      tags,
      title,
      wikilinks: [],
    });
  }

  return {
    folders: [...folderMap.values()],
    pages,
    source: "csv_todoist",
    warnings,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function parseCSVImport(text: string): ImportPlan {
  const rows = parseCSV(text);
  if (rows.length === 0) {
    return {
      folders: [],
      pages: [],
      source: "csv_ticktick",
      warnings: [{ message: "CSV file is empty or has no data rows", type: "parse_error" }],
    };
  }

  const headers = Object.keys(rows[0]!);
  const source = detectSource(headers);

  if (source === "ticktick") return parseTickTick(rows);
  if (source === "todoist") return parseTodoist(rows);

  return {
    folders: [],
    pages: [],
    source: "csv_ticktick",
    warnings: [
      {
        message: "Could not detect CSV format. Expected TickTick or Todoist export headers.",
        type: "parse_error",
      },
    ],
  };
}
