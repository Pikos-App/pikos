// Markdown / Obsidian vault parser.
// Reads a directory of .md files, extracts YAML frontmatter, and produces an ImportPlan.
// File I/O uses @tauri-apps/plugin-fs for Tauri, or accepts pre-read file contents for testing.

import type { PagePriority, PageStatus } from "@pikos/core";
import { format, isValid, parse } from "date-fns";

import { NLP_PRIORITY_MAP } from "@/shared/constants/priorities";

import type { ImportFolder, ImportMeta, ImportPage, ImportPlan, ImportWarning } from "./types";

// ─── Date parsing ────────────────────────────────────────────────────────────

/** Known date formats from Obsidian Linter and common frontmatter conventions. */
const DATE_FORMATS = [
  "yyyy-MM-dd'T'HH:mm:ss",
  "yyyy-MM-dd'T'HH:mm",
  "yyyy-MM-dd",
  "EEEE, MMMM do yyyy, h:mm:ss a", // Obsidian Linter: "Monday, March 17th 2025, 11:03:04 am"
  "EEEE, MMMM do yyyy, h:mm a",
  "MMMM do yyyy, h:mm:ss a",
  "MMMM do yyyy",
  "MMMM d, yyyy",
  "MMM d, yyyy",
  "MM/dd/yyyy",
  "dd/MM/yyyy",
];

const REF = new Date(2000, 0, 1);

/**
 * Parse a date string into ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).
 * Tries known formats via date-fns. Returns null if unparseable.
 */
function parseDate(raw: string): string | null {
  const s = raw.replace(/^["']|["']$/g, "").trim();
  if (!s) return null;

  // ISO format — pass through directly (avoids timezone shifting)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;

  for (const fmt of DATE_FORMATS) {
    const d = parse(s, fmt, REF);
    if (isValid(d)) {
      const h = d.getHours();
      const min = d.getMinutes();
      const sec = d.getSeconds();
      if (h === 0 && min === 0 && sec === 0) return format(d, "yyyy-MM-dd");
      return format(d, "yyyy-MM-dd'T'HH:mm:ss");
    }
  }

  return null;
}

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

interface Frontmatter {
  tags: string[];
  status: PageStatus;
  priority: PagePriority;
  scheduled: string | null;
  created: string | null;
  modified: string | null;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal YAML frontmatter parser — handles the subset Obsidian/Pikos export uses. */
export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  const fm: Frontmatter = {
    created: null,
    modified: null,
    priority: 0,
    scheduled: null,
    status: "not_started",
    tags: [],
  };

  if (!match || !match[1]) return { body: raw, frontmatter: fm };

  const yaml = match[1];
  const body = raw.slice(match[0].length);

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // List items (e.g. "  - tag")
    if (trimmed.startsWith("- ")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    switch (key) {
      case "tags": {
        // Inline array: tags: [a, b] or tags: a, b
        if (value.startsWith("[")) {
          fm.tags = value
            .slice(1, -1)
            .split(",")
            .map((t) => t.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        } else if (value) {
          fm.tags = value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        } else {
          // Multi-line YAML list — collect subsequent "  - item" lines
          const lines = yaml.split("\n");
          const tagLineIdx = lines.findIndex((l) => l.trim().toLowerCase().startsWith("tags:"));
          if (tagLineIdx !== -1) {
            for (let i = tagLineIdx + 1; i < lines.length; i++) {
              const tl = lines[i]?.trim() ?? "";
              if (tl.startsWith("- ")) {
                fm.tags.push(
                  tl
                    .slice(2)
                    .trim()
                    .replace(/^["']|["']$/g, "")
                );
              } else {
                break;
              }
            }
          }
        }
        break;
      }
      case "status": {
        const lower = value.toLowerCase();
        if (lower === "done" || lower === "completed" || lower === "x") {
          fm.status = "done";
        }
        break;
      }
      case "priority": {
        const num = Number(value);
        if (num >= 1 && num <= 4) {
          fm.priority = num as PagePriority;
        } else {
          const mapped = NLP_PRIORITY_MAP[value.toLowerCase()];
          if (mapped) fm.priority = mapped;
        }
        break;
      }
      case "due":
      case "scheduled":
      case "scheduled_start": {
        const parsed = parseDate(value);
        if (parsed) fm.scheduled = parsed.slice(0, 10); // date-only for all-day
        break;
      }
      case "created":
      case "date created":
      case "created_at": {
        const parsed = parseDate(value);
        if (parsed) fm.created = parsed;
        break;
      }
      case "modified":
      case "date modified":
      case "updated":
      case "updated_at": {
        const parsed = parseDate(value);
        if (parsed) fm.modified = parsed;
        break;
      }
    }
  }

  return { body, frontmatter: fm };
}

// ─── Wikilink extraction ──────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function extractWikilinks(body: string): string[] {
  const links: string[] = [];
  let m;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    if (m[1]) links.push(m[1].trim());
  }
  return [...new Set(links)];
}

// ─── Unsupported content detection ────────────────────────────────────────────

const UNSUPPORTED_PATTERNS = [
  { label: "embedded image", pattern: /!\[\[.+?\]\]/g },
  { label: "mermaid diagram", pattern: /```mermaid[\s\S]*?```/g },
  { label: "dataview query", pattern: /```dataview[\s\S]*?```/g },
  { label: "callout", pattern: /^>\s*\[!.+?\]/gm },
];

function detectUnsupportedContent(body: string): string[] {
  const found: string[] = [];
  for (const { label, pattern } of UNSUPPORTED_PATTERNS) {
    if (pattern.test(body)) found.push(label);
    pattern.lastIndex = 0; // reset regex
  }
  return found;
}

// ─── File representation (for testability) ─────────────────────────────────────

/** A file with its path relative to the vault root and its text content. */
export interface VaultFile {
  /** Relative path from vault root, e.g. "Projects/Work/note.md" */
  path: string;
  content: string;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export function parseMarkdownVault(files: VaultFile[]): ImportPlan {
  const pages: ImportPage[] = [];
  const folderMap = new Map<string, ImportFolder>();
  const warnings: ImportWarning[] = [];

  const mdFiles = files.filter((f) => f.path.toLowerCase().endsWith(".md"));

  for (const file of mdFiles) {
    const { body, frontmatter } = parseFrontmatter(file.content);

    // Derive title from filename
    const parts = file.path.split("/");
    // split("/") always returns at least one element
    const filename = parts[parts.length - 1]!;
    const title = filename.replace(/\.md$/i, "");

    // Derive folder from directory path
    let folderKey: string | null = null;
    if (parts.length > 1) {
      const dirPath = parts.slice(0, -1).join(" / ");
      folderKey = dirPath;
      if (!folderMap.has(dirPath)) {
        folderMap.set(dirPath, { key: dirPath, name: dirPath });
      }
    }

    // Detect unsupported content
    const unsupported = detectUnsupportedContent(body);
    if (unsupported.length > 0) {
      warnings.push({
        message: `Contains unsupported content: ${unsupported.join(", ")}`,
        source: file.path,
        type: "unsupported_content",
      });
    }

    // Detect empty content
    if (!body.trim()) {
      warnings.push({
        message: "File has no content (title-only page)",
        source: file.path,
        type: "empty_content",
      });
    }

    // Extract wikilinks before any content transformation
    const wikilinks = extractWikilinks(body);

    pages.push({
      body,
      completedAt: null,
      createdAt: frontmatter.created,
      folderKey,
      priority: frontmatter.priority,
      reminderMinutes: [],
      scheduledEnd: null,
      scheduledStart: frontmatter.scheduled,
      sourceId: null,
      sourceParentId: null,
      status: frontmatter.status,
      tags: frontmatter.tags,
      title,
      updatedAt: frontmatter.modified,
      wikilinks,
    });
  }

  const meta: ImportMeta = {
    skipped: [], // Walker-level skips are merged in useImport
    transformations: [],
  };

  if (folderMap.size > 0) {
    meta.transformations.push(
      "Nested folder paths flattened (e.g. Projects/Work → Projects / Work)"
    );
  }

  const wikilinkPages = pages.filter((p) => p.wikilinks.length > 0).length;
  if (wikilinkPages > 0) {
    meta.transformations.push(`Wikilinks in ${wikilinkPages} pages preserved as text`);
  }

  return {
    folders: [...folderMap.values()],
    meta,
    pages,
    source: "markdown",
    warnings,
  };
}
