-- Per-page reminder configuration.
-- Each row = one reminder for a page (e.g. "10 min before").
-- If a page has no rows here, the global default from Settings applies.
-- minutes_before = 0 means "at start time".
CREATE TABLE page_reminders (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  minutes_before  INTEGER NOT NULL CHECK (minutes_before >= 0),
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_page_reminders_page ON page_reminders(page_id);

-- Deduplication log — tracks every notification that fired.
-- Prevents re-firing the same reminder and supports snooze.
CREATE TABLE notification_log (
  id              TEXT PRIMARY KEY,
  page_id         TEXT,
  schedule_id     TEXT,
  type            TEXT NOT NULL CHECK (type IN ('reminder', 'overdue')),
  fired_at        TEXT NOT NULL,
  action          TEXT CHECK (action IN ('dismissed', 'done', 'opened') OR action IS NULL)
);
CREATE INDEX idx_notif_log_schedule ON notification_log(schedule_id, type, fired_at);
