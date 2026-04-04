// Shared types for import parsers.
// Parsers produce an ImportPlan which the UI previews before committing to the DB.

import type { PagePriority, PageStatus } from "@pikos/core";

/** A single page to be imported. */
export interface ImportPage {
  /** Original filename or CSV title — used as page title. */
  title: string;
  /** Markdown body (pre-Tiptap conversion) or plain text content. */
  body: string;
  /** Folder key — matches an ImportFolder.key in the same plan. Null = inbox. */
  folderKey: string | null;
  status: PageStatus;
  priority: PagePriority;
  tags: string[];
  /** ISO date string for an all-day schedule, if any. */
  scheduledDate: string | null;
  /** ISO date string for createdAt override, if any. */
  createdAt: string | null;
  /** Raw wikilink targets (e.g. "My Page") — resolved to IDs post-import. */
  wikilinks: string[];
}

/** A folder to be created (or matched to an existing one). */
export interface ImportFolder {
  /** Stable key for linking pages → folders within a plan. */
  key: string;
  /** Display name (may be a flattened path like "Projects / Work"). */
  name: string;
}

/** Warning surfaced in the preview UI. */
export interface ImportWarning {
  type:
    | "flattened_folder"
    | "unsupported_content"
    | "empty_content"
    | "duplicate_folder"
    | "parse_error";
  message: string;
  /** Source file path or CSV row number for context. */
  source?: string;
}

/** Complete import plan produced by a parser. */
export interface ImportPlan {
  source: "markdown" | "csv_ticktick" | "csv_todoist";
  pages: ImportPage[];
  folders: ImportFolder[];
  warnings: ImportWarning[];
}
