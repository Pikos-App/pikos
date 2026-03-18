/**
 * _db.ts — shared SQLite helpers for all Pikos seed scripts.
 *
 * Directly opens the SQLite file (no Tauri IPC) so scripts run outside the app.
 * Applies the initial migration if the schema doesn't exist yet.
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir, platform } from "os";
import { randomUUID } from "crypto";

export { randomUUID as uid };

// ── Path helpers ──────────────────────────────────────────────────────────────

export function defaultDbPath(): string {
  const os = platform();
  if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "com.pikos.app", "default.sqlite");
  }
  // Linux (and fallback)
  return join(homedir(), ".local", "share", "com.pikos.app", "default.sqlite");
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────

export function openDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // Run WAL mode + FK enforcement immediately
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply migrations in order. Each is idempotent (CREATE IF NOT EXISTS / ALTER IF needed).
  const migrationsDir = resolve(
    import.meta.dirname,
    "..",
    "..",
    "apps",
    "desktop",
    "src-tauri",
    "migrations"
  );
  const migrations = ["001_initial.sql", "002_drop_duration_mins.sql"];
  for (const filename of migrations) {
    const migrationPath = resolve(migrationsDir, filename);
    if (existsSync(migrationPath)) {
      try {
        const sql = readFileSync(migrationPath, "utf8");
        db.exec(sql);
        console.log(`  Applied migration: ${filename}`);
      } catch {
        // ALTER TABLE DROP COLUMN fails if the column is already gone — safe to ignore.
        console.log(`  Skipped migration (already applied): ${filename}`);
      }
    } else {
      console.warn(`  Warning: migration not found: ${migrationPath}`);
    }
  }

  return db;
}

// ── ISO timestamp ─────────────────────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── Tiptap JSON builder ───────────────────────────────────────────────────────

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export function tiptapDoc(...nodes: TiptapNode[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

export function paragraph(...texts: Array<string | TiptapNode>): TiptapNode {
  return {
    type: "paragraph",
    content: texts.map((t) => (typeof t === "string" ? { type: "text", text: t } : t)),
  };
}

export function heading(level: 1 | 2 | 3, text: string): TiptapNode {
  return {
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  };
}

export function bulletList(...items: string[]): TiptapNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: [paragraph(item)],
    })),
  };
}

export function taskList(...items: Array<{ text: string; checked?: boolean }>): TiptapNode {
  return {
    type: "taskList",
    content: items.map(({ text, checked = false }) => ({
      type: "taskItem",
      attrs: { checked },
      content: [paragraph(text)],
    })),
  };
}

export function codeBlock(lang: string, code: string): TiptapNode {
  return {
    type: "codeBlock",
    attrs: { language: lang },
    content: [{ type: "text", text: code }],
  };
}

// ── DB insert helpers ─────────────────────────────────────────────────────────

export interface PageData {
  id?: string;
  folderId?: string | null;
  title: string;
  subtitle?: string | null;
  content: string; // Tiptap JSON string
  contentText?: string;
  status?: "not_started" | "in_progress" | "done";
  priority?: 0 | 1 | 2 | 3 | 4;
  tags?: string[];
  sortOrder?: number;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  completedAt?: string | null;
}

export interface ScheduleData {
  pageId: string;
  scheduledStart: string;
  scheduledEnd?: string | null;
  timezone?: string | null;
  status?: "not_started" | "done" | "skipped";
}

const insertPageStmt = (db: Database.Database) =>
  db.prepare(`
    INSERT INTO pages
      (id, folder_id, title, subtitle, content, content_text,
       status, priority, tags, sort_order, scheduled_start, scheduled_end,
       completed_at, created_at, updated_at)
    VALUES
      (@id, @folderId, @title, @subtitle, @content, @contentText,
       @status, @priority, @tags, @sortOrder, @scheduledStart, @scheduledEnd,
       @completedAt, @createdAt, @updatedAt)
  `);

export function insertPage(db: Database.Database, page: PageData): string {
  const id = page.id ?? randomUUID();
  const ts = nowIso();
  insertPageStmt(db).run({
    id,
    folderId: page.folderId ?? null,
    title: page.title,
    subtitle: page.subtitle ?? null,
    content: page.content,
    contentText: page.contentText ?? page.subtitle ?? page.title,
    status: page.status ?? "not_started",
    priority: page.priority ?? 0,
    tags: JSON.stringify(page.tags ?? []),
    sortOrder: page.sortOrder ?? 0,
    scheduledStart: page.scheduledStart ?? null,
    scheduledEnd: page.scheduledEnd ?? null,
    completedAt: page.completedAt ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

const insertScheduleStmt = (db: Database.Database) =>
  db.prepare(`
    INSERT INTO page_schedules
      (id, page_id, scheduled_start, scheduled_end, timezone, status, created_at)
    VALUES
      (@id, @pageId, @scheduledStart, @scheduledEnd, @timezone, @status, @createdAt)
  `);

export function insertSchedule(db: Database.Database, sched: ScheduleData): string {
  const id = randomUUID();
  const ts = nowIso();
  const isTimed = sched.scheduledStart.includes("T");
  insertScheduleStmt(db).run({
    id,
    pageId: sched.pageId,
    scheduledStart: sched.scheduledStart,
    scheduledEnd: sched.scheduledEnd ?? null,
    timezone: sched.timezone ?? (isTimed ? "America/Los_Angeles" : null),
    status: sched.status ?? "not_started",
    createdAt: ts,
  });
  // Keep pages denorm in sync
  db.prepare("UPDATE pages SET scheduled_start=@start, scheduled_end=@end WHERE id=@id").run({
    start: sched.scheduledStart,
    end: sched.scheduledEnd ?? null,
    id: sched.pageId,
  });
  return id;
}

export function getOrCreateFolder(
  db: Database.Database,
  name: string,
  opts: { color?: string; icon?: string; sortOrder?: number } = {}
): string {
  const row = db.prepare("SELECT id FROM folders WHERE name = ?").get(name) as
    | { id: string }
    | undefined;
  if (row) return row.id;

  const id = randomUUID();
  const ts = nowIso();
  db.prepare(
    `
    INSERT INTO folders (id, name, parent_id, sort_order, color, icon, created_at, updated_at)
    VALUES (@id, @name, NULL, @sortOrder, @color, @icon, @ts, @ts)
  `
  ).run({
    id,
    name,
    sortOrder: opts.sortOrder ?? 0,
    color: opts.color ?? "#6366f1",
    icon: opts.icon ?? null,
    ts,
  });
  return id;
}

// ── Seed marker — idempotency guard ──────────────────────────────────────────

export function alreadySeeded(db: Database.Database, markerTitle: string): boolean {
  const row = db.prepare("SELECT id FROM pages WHERE title = ? LIMIT 1").get(markerTitle) as
    | { id: string }
    | undefined;
  return Boolean(row);
}
