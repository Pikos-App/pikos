// @pikos/core — central type definitions
// No Tauri / React / DOM dependencies — safe to import in tests and packages.

// ─── Vault ───────────────────────────────────────────────────────────────────
// Multi-vault: each vault is a separate SQLite file. The list of known vaults
// lives in @tauri-apps/plugin-store (JSON config, not SQLite).

export interface Vault {
  id: string; // UUID, stable across renames
  name: string; // display name (user-editable)
  dbPath: string; // absolute path to the vault .sqlite file
  createdAt: string; // ISO 8601
  lastOpenedAt: string | null;
}

// ─── Folder ──────────────────────────────────────────────────────────────────
// v1: flat list only — parentId is always null. Schema supports nesting for later.

export interface Folder {
  id: string; // UUID
  name: string;
  parentId: string | null; // always null in v1; reserved for nested folders
  sortOrder: number; // manual position in the flat folder list
  color?: string;
  icon?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ─── Page ────────────────────────────────────────────────────────────────────

export type PageStatus = "not_started" | "in_progress" | "done";

// 0 = none  1 = urgent  2 = high  3 = medium  4 = low
export type PagePriority = 0 | 1 | 2 | 3 | 4;

export interface Page {
  id: string; // UUID
  folderId: string | null;
  title: string;
  subtitle?: string; // one-sentence summary; shown in page list + calendar blocks; in FTS
  content: string; // Tiptap JSON string (NOT markdown)
  // Internal FTS denorm — extracted plain text from Tiptap JSON.
  // Written by the adapter on every content save; never rendered in UI directly.
  contentText?: string;
  status: PageStatus;
  priority: PagePriority;
  tags: string[]; // stored as JSON array in SQLite
  sortOrder: number; // manual position within folder (or inbox)
  scheduledStart?: string; // ISO 8601 — denorm of next upcoming page_schedules row
  scheduledEnd?: string; // ISO 8601 — denorm of next upcoming page_schedules row
  completedAt?: string; // ISO 8601
  durationMinutes?: number; // planned duration (not focus-session time)
  links?: string[]; // [[wikilink]] target page UUIDs; stored as JSON array
  parentId?: string | null; // sub-page nesting (GOO-12, max 3 levels)
  rrule?: string; // iCal RRULE string — infinite recurring template
  // NULL = not a template. Calendar expands virtual blocks via rrule.js.
  // Finite recurrence produces N independent pages (each with rrule = null).
  lastOpenedAt?: string; // ISO 8601; updated on open → drives recent-pages query
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ─── PageSchedule ─────────────────────────────────────────────────────────────
// One calendar occurrence for a page (from page_schedules table).
// Distinct from rrule-based virtual occurrences — those are expanded at render
// time with no DB row. Multiple rows = multiple blocks on the calendar.

export interface PageSchedule {
  id: string; // UUID
  pageId: string;
  scheduledStart: string; // ISO 8601
  scheduledEnd?: string; // ISO 8601; null = 1-hour default block height
  scheduledAllDay: boolean; // true = all-day event (no time grid position)
  createdAt: string; // ISO 8601
}

// ─── FolderNode ───────────────────────────────────────────────────────────────
// Used by buildFolderTree() in packages/core/src/page.ts.
// In v1, children is always [] (flat list); the type supports nesting for later.

export interface FolderNode extends Folder {
  children: FolderNode[];
}

// ─── Tag ──────────────────────────────────────────────────────────────────────
// Derived at query time — not stored as a separate table.

export interface Tag {
  name: string;
  pageCount: number;
  pageIds: string[];
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  title: string;
  excerpt: string; // highlighted snippet with <mark> tags from FTS5 snippet()
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface PageFilter {
  folderId?: string | null;
  status?: PageStatus;
  priority?: PagePriority;
  tags?: string[];
  query?: string;
  scheduledAfter?: string; // ISO 8601
  scheduledBefore?: string; // ISO 8601
}
