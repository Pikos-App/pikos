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
-- scheduled_start / scheduled_end are denorms: the next upcoming page_schedules
-- row for this page. Updated by create/delete_page_schedule commands, not triggers.
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
  scheduled_start TEXT,  -- denorm: next upcoming schedule start
  scheduled_end   TEXT,  -- denorm: next upcoming schedule end
  completed_at    TEXT,
  duration_mins   INTEGER,
  links           TEXT DEFAULT '[]',
  parent_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
  last_opened_at  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_folder_sort  ON pages(folder_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pages_status       ON pages(status);
CREATE INDEX IF NOT EXISTS idx_pages_scheduled    ON pages(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_pages_priority     ON pages(priority);
CREATE INDEX IF NOT EXISTS idx_pages_last_opened  ON pages(last_opened_at);
CREATE INDEX IF NOT EXISTS idx_pages_parent       ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_pages_completed_at ON pages(completed_at);

-- ─── Page Recurrence Rules ─────────────────────────────────────────────────────
-- One row per recurring page (UNIQUE on page_id — a page has at most one rule).
-- The calendar expands virtual occurrences from rrule + timezone at render time
-- via rrule.js. Exceptions: excluded dates in rrule_exdates (JSON array), and
-- materialised overrides in page_schedules with rule_id pointing here.
-- Defined before page_schedules so the FK reference below is not a forward ref.
CREATE TABLE IF NOT EXISTS page_recurrence_rules (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  rrule           TEXT NOT NULL,         -- iCal RRULE string
  rrule_exdates   TEXT NOT NULL DEFAULT '[]',  -- JSON array of excluded ISO date strings
  scheduled_start TEXT NOT NULL,         -- base occurrence start (local wall-clock)
  scheduled_end   TEXT,                  -- base occurrence end; NULL = 1h default
  timezone        TEXT NOT NULL,         -- IANA; required for DST-correct expansion
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recurrence_rules_page ON page_recurrence_rules(page_id);

-- ─── Page Schedules ───────────────────────────────────────────────────────────
-- One explicit calendar block per row. All-day vs timed is inferred from the
-- scheduled_start format: 'YYYY-MM-DD' = all-day, 'YYYY-MM-DDTHH:MM:SS' = timed.
-- timezone is required for timed events; NULL is acceptable for all-day events.
-- rule_id + original_date are only set when this row materialises/overrides a
-- specific occurrence from a page_recurrence_rules template.
CREATE TABLE IF NOT EXISTS page_schedules (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  scheduled_start TEXT NOT NULL,
  scheduled_end   TEXT,
  timezone        TEXT,  -- IANA e.g. 'America/New_York'; NULL for all-day
  rule_id         TEXT REFERENCES page_recurrence_rules(id) ON DELETE CASCADE,
  original_date   TEXT,  -- the virtual rrule date this row overrides
  status          TEXT NOT NULL DEFAULT 'not_started',  -- 'not_started'|'done'|'skipped'
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_page_schedules_page         ON page_schedules(page_id);
CREATE INDEX IF NOT EXISTS idx_page_schedules_start        ON page_schedules(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_page_schedules_rule_overrides
  ON page_schedules(rule_id, original_date) WHERE rule_id IS NOT NULL;

-- ─── Focus Sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS focus_sessions (
  id         TEXT PRIMARY KEY,
  page_id    TEXT REFERENCES pages(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  duration_s INTEGER
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
