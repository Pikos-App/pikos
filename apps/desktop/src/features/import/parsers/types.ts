// Shared types for import parsers.
// Parsers produce an ImportPlan which the UI previews before committing to the DB.

import type { PagePriority, PageStatus } from "@pikos/core";

/** An image reference found in a markdown body. */
export interface ImageRef {
  /** The full regex match (e.g. "![[photo.png]]" or "![alt](path/to/img.png)"). */
  fullMatch: string;
  /** Path as written in the source file (relative to vault root). */
  sourcePath: string;
  /** "wiki" for ![[...]] or "standard" for ![alt](...). */
  syntax: "wiki" | "standard";
  /** Alt text (filename for wiki, explicit alt for standard). */
  altText: string;
  /**
   * Whether this is definitely an image (has image extension) or a speculative
   * match (extensionless wiki-embed that might be an image or a note transclusion).
   * Speculative refs are tried during resolution but left as-is if they fail.
   */
  speculative?: boolean;
}

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
  /** 'YYYY-MM-DD' for all-day or 'YYYY-MM-DDTHH:MM:SS' for timed events. */
  scheduledStart: string | null;
  /** 'YYYY-MM-DDTHH:MM:SS' end time for timed events. Null for all-day. */
  scheduledEnd: string | null;
  /** ISO datetime string for createdAt override, if any. */
  createdAt: string | null;
  /** ISO datetime string for completedAt, if status is done. */
  completedAt: string | null;
  /** ISO datetime string for updatedAt override. */
  updatedAt: string | null;
  /** Raw wikilink targets (e.g. "My Page") — resolved to IDs post-import. */
  wikilinks: string[];
  /** Per-page reminder lead times in minutes (from TickTick Reminder column). */
  reminderMinutes: number[];
  /** Original ID from the source system (e.g. TickTick taskId). Used for parent resolution. */
  sourceId: string | null;
  /** Original parent ID from the source system. Resolved to Pikos parent_id post-import. */
  sourceParentId: string | null;
  /** Image references found in the body (markdown imports only). */
  imageRefs: ImageRef[];
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

/** Summary of what was skipped or transformed during parsing. */
export interface ImportMeta {
  /** Files/rows skipped entirely (not imported). */
  skipped: { count: number; reason: string }[];
  /** Transformations applied to imported data. */
  transformations: string[];
}

/** Complete import plan produced by a parser. */
export interface ImportPlan {
  source: string;
  pages: ImportPage[];
  folders: ImportFolder[];
  warnings: ImportWarning[];
  meta: ImportMeta;
  /** Vault root directory path (markdown imports only). Used to resolve image paths. */
  vaultRoot?: string;
}

// ─── CSV Column Mapping ──────────────────────────────────────────────────────

/** Which Pikos field a CSV column maps to. */
export type PikosFieldKey =
  | "title"
  | "body"
  | "folder"
  | "status"
  | "priority"
  | "tags"
  | "scheduledStart"
  | "scheduledEnd"
  | "createdAt"
  | "completedAt"
  | "updatedAt"
  | "sourceId"
  | "sourceParentId"
  | "reminder"
  | "skip";

/** A single column mapping: CSV header → Pikos field with sample data. */
export interface ColumnMapping {
  csvHeader: string;
  pikosField: PikosFieldKey;
  /** First few non-empty values from this column, for context in the UI. */
  sampleValues: string[];
}

/** Maps unique source values → Pikos values for enum fields (status, priority). */
export interface ValueMapping {
  field: "status" | "priority";
  entries: { sourceValue: string; targetValue: string }[];
}

/** Complete mapping configuration produced by the column mapping UI. */
export interface CSVMappingConfig {
  columnMappings: ColumnMapping[];
  valueMappings: ValueMapping[];
  /** Auto-detected source label, or null for unknown CSV. */
  detectedSource: string | null;
}
