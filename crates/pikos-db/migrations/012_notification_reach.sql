-- Two reach-widening changes to the notification tables, both of which SQLite
-- can only make by recreating the table (CHECK constraints are not ALTERable).
--
-- 1. `page_reminders.minutes_before` gains -2 alongside 007's -1. Both are
--    anchor sentinels rather than lead times: -1 means "never remind for this
--    page", and -2 means "the day before, at 09:00 local". An all-day page has
--    no start time to lead off, so a minutes-before number cannot express its
--    reminder at all — the scheduler resolves -2 against the event's *date*
--    instead. Storing it in the same column keeps one reminder row shape for
--    the UI, the adapters, the CSV round-trip and the mock twin; a second
--    column would have had every one of them branch on which half is set.
--
-- 2. `notification_log.type` gains 'suppressed'. A reminder dropped for quiet
--    hours used to leave no trace at all, so "why didn't Pikos tell me?" had no
--    answer anywhere in the app. It now writes a log row marked 'suppressed',
--    which the history panel renders as "silenced by quiet hours". The
--    vocabulary lives in `type` rather than in `action` deliberately: `action`
--    records what the *user* did with a notification (opened/done/dismissed),
--    and nothing was delivered for the user to do anything with. Keeping the
--    two apart also leaves every dedup predicate — all of which read
--    `type = 'reminder'` — matching exactly the rows it matched before, so
--    suppression stays a bookkeeping change and not a re-timing one.
--
-- Forward-only: existing rows carry over unchanged, and both changes only widen
-- what the constraints admit, so nothing already stored can fail them.

CREATE TABLE page_reminders_new (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  minutes_before  INTEGER NOT NULL CHECK (minutes_before >= -2),
  created_at      TEXT NOT NULL
);
INSERT INTO page_reminders_new SELECT id, page_id, minutes_before, created_at FROM page_reminders;
DROP TABLE page_reminders;
ALTER TABLE page_reminders_new RENAME TO page_reminders;
CREATE INDEX idx_page_reminders_page ON page_reminders(page_id);

CREATE TABLE notification_log_new (
  id              TEXT PRIMARY KEY,
  page_id         TEXT,
  schedule_id     TEXT,
  type            TEXT NOT NULL CHECK (type IN ('reminder', 'overdue', 'suppressed')),
  fired_at        TEXT NOT NULL,
  action          TEXT CHECK (action IN ('dismissed', 'done', 'opened') OR action IS NULL)
);
INSERT INTO notification_log_new
  SELECT id, page_id, schedule_id, type, fired_at, action FROM notification_log;
DROP TABLE notification_log;
ALTER TABLE notification_log_new RENAME TO notification_log;
CREATE INDEX idx_notif_log_schedule ON notification_log(schedule_id, type, fired_at);
-- The history panel reads newest-first across every type, which the dedup index
-- above cannot serve (it leads with schedule_id).
CREATE INDEX idx_notif_log_fired_at ON notification_log(fired_at DESC);
