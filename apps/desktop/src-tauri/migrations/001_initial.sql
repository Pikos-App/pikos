-- ─── Folders ──────────────────────────────────────────────────────────────────
-- v1: flat list only. parent_id always NULL — nested folders NOT implemented.
CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  color       TEXT,
  icon        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_sort ON folders(sort_order);

-- ─── Pages ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pages (
  id              TEXT PRIMARY KEY,
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT '',
  subtitle        TEXT,
  content         TEXT NOT NULL DEFAULT '{}',
  content_text    TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'not_started',
  priority        INTEGER NOT NULL DEFAULT 0,
  tags            TEXT NOT NULL DEFAULT '[]',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  scheduled_start TEXT,
  scheduled_end   TEXT,
  completed_at    TEXT,
  duration_mins   INTEGER,
  links           TEXT DEFAULT '[]',
  parent_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
  rrule           TEXT,
  rrule_exdates   TEXT NOT NULL DEFAULT '[]', -- JSON array of ISO date strings excluded from rrule expansion
  timezone        TEXT,                        -- IANA timezone e.g. 'America/New_York'; NULL = system default
  last_opened_at  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_folder_sort    ON pages(folder_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pages_status         ON pages(status);
CREATE INDEX IF NOT EXISTS idx_pages_scheduled      ON pages(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_pages_priority       ON pages(priority);
CREATE INDEX IF NOT EXISTS idx_pages_last_opened    ON pages(last_opened_at);
CREATE INDEX IF NOT EXISTS idx_pages_parent         ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_pages_completed_at   ON pages(completed_at);
CREATE INDEX IF NOT EXISTS idx_pages_rrule          ON pages(rrule) WHERE rrule IS NOT NULL;

-- ─── Page Schedules ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS page_schedules (
  id                   TEXT PRIMARY KEY,
  page_id              TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  scheduled_start      TEXT NOT NULL,
  scheduled_end        TEXT,
  scheduled_all_day    INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'not_started', -- 'not_started' | 'done' | 'skipped'
  original_rrule_date  TEXT,  -- set when this row materialises/overrides a virtual rrule occurrence
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_page_schedules_page    ON page_schedules(page_id);
CREATE INDEX IF NOT EXISTS idx_page_schedules_start   ON page_schedules(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_page_schedules_all_day  ON page_schedules(scheduled_all_day) WHERE scheduled_all_day = 1;
CREATE INDEX IF NOT EXISTS idx_page_schedules_rrule    ON page_schedules(page_id, original_rrule_date) WHERE original_rrule_date IS NOT NULL;

-- ─── Focus Sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS focus_sessions (
  id            TEXT PRIMARY KEY,
  page_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  duration_s    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_focus_sessions_page    ON focus_sessions(page_id);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_started ON focus_sessions(started_at);

-- ─── FTS5 ─────────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, subtitle, content_text, tags,
  content=pages, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, subtitle, content_text, tags)
  VALUES (new.rowid, new.title, new.subtitle, new.content_text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, subtitle, content_text, tags)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.content_text, old.tags);
  INSERT INTO pages_fts(rowid, title, subtitle, content_text, tags)
  VALUES (new.rowid, new.title, new.subtitle, new.content_text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, subtitle, content_text, tags)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.content_text, old.tags);
END;
