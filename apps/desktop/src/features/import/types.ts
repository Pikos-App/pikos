// Shared types for the import batch flow. Live here (not in WorkspaceContext)
// so feature → context is a one-way dependency.

import type { PagePriority, PageStatus } from "@pikos/core";

export interface ImportBatchItem {
  title: string;
  content: string;
  contentText: string;
  folderKey: string | null;
  status: PageStatus;
  priority: PagePriority;
  tags: string[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  sourceId: string | null;
  sourceParentId: string | null;
  /** Per-page reminder lead times in minutes (from TickTick import). */
  reminderMinutes: number[];
  /** iCal RRULE string (no "RRULE:" prefix). When set with scheduledStart, creates a recurrence rule. */
  rrule: string | null;
}

interface ImportBatchFolder {
  key: string;
  name: string;
}

export interface ImportBatchInput {
  pages: ImportBatchItem[];
  folders: ImportBatchFolder[];
  batchTag: string;
  source: string;
}

export interface ImportBatchResult {
  pageIds: string[];
  folderIds: string[];
}

export interface LastImportResult {
  pageIds: string[];
  folderIds: string[];
  pageCount: number;
  folderCount: number;
  source: string;
  importedAt: string;
}
