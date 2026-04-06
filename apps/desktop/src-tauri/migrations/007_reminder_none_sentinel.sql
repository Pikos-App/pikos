-- Allow minutes_before = -1 as a sentinel meaning "no reminders for this page."
-- SQLite cannot ALTER CHECK constraints, so we recreate the table.
CREATE TABLE page_reminders_new (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  minutes_before  INTEGER NOT NULL CHECK (minutes_before >= -1),
  created_at      TEXT NOT NULL
);
INSERT INTO page_reminders_new SELECT * FROM page_reminders;
DROP TABLE page_reminders;
ALTER TABLE page_reminders_new RENAME TO page_reminders;
CREATE INDEX idx_page_reminders_page ON page_reminders(page_id);
