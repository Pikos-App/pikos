// Parsers produce an ImportPlan, which the UI previews before committing.

import type { PagePriority, PageStatus } from "../types";

export interface ImageRef {
  fullMatch: string;
  /** Path as written in the source file. Where it points is {@link imageRefCandidates}'s call. */
  sourcePath: string;
  /** The folder of the referencing file, from the vault root; "" at the top. */
  fromDir: string;
  syntax: "wiki" | "standard";
  /** Filename for wiki embeds, explicit alt for standard. */
  altText: string;
  /** False for an extensionless wiki-embed, tried during resolution and left as-is if it fails. */
  speculative?: boolean;
}

export interface ImportPage {
  title: string;
  /** Markdown or plain text, before Tiptap conversion. */
  body: string;
  /** An ImportFolder.key in the same plan; null is the inbox. */
  folderKey: string | null;
  status: PageStatus;
  priority: PagePriority;
  tags: string[];
  /** 'YYYY-MM-DD' all-day, or 'YYYY-MM-DDTHH:MM:SS' timed. */
  scheduledStart: string | null;
  /** Null for all-day. */
  scheduledEnd: string | null;
  /** Overrides createdAt. */
  createdAt: string | null;
  /** Set when status is done. */
  completedAt: string | null;
  /** Overrides updatedAt. */
  updatedAt: string | null;
  /** Raw targets ("My Page"), resolved to IDs after import. */
  wikilinks: string[];
  /** Lead times in minutes (TickTick's Reminder column). */
  reminderMinutes: number[];
  /** No "RRULE:" prefix. Set only for a parseable rule with an anchor date. */
  rrule: string | null;
  /** The source system's ID (TickTick taskId), for parent resolution. */
  sourceId: string | null;
  /** The source system's parent ID, resolved to a Pikos parent_id after import. */
  sourceParentId: string | null;
  /** Markdown imports only. */
  imageRefs: ImageRef[];
}

export interface ImportFolder {
  /** Links pages to folders within a plan. */
  key: string;
  /** May be a flattened path ("Projects / Work"). */
  name: string;
}

export interface ImportWarning {
  type: "flattened_folder" | "unsupported_content" | "duplicate_folder" | "parse_error";
  message: string;
  source?: string;
}

export interface ImportMeta {
  skipped: { count: number; reason: string }[];
  transformations: string[];
}

export interface ImportPlan {
  source: string;
  pages: ImportPage[];
  folders: ImportFolder[];
  warnings: ImportWarning[];
  meta: ImportMeta;
  /** Markdown imports only; resolves image paths. */
  vaultRoot?: string;
}

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
  | "repeat"
  | "skip";

/** A CSV header mapped to a Pikos field. */
export interface ColumnMapping {
  csvHeader: string;
  pikosField: PikosFieldKey;
  /** A few non-empty values, for context in the UI. */
  sampleValues: string[];
}

/** Source values to Pikos values for enum fields (status, priority). */
export interface ValueMapping {
  field: "status" | "priority";
  entries: { sourceValue: string; targetValue: string }[];
}

export interface CSVMappingConfig {
  columnMappings: ColumnMapping[];
  valueMappings: ValueMapping[];
  /** Null for an unknown CSV. */
  detectedSource: string | null;
}
