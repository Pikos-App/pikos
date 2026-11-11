-- notification_log.type gains 'refused': a reminder that came due while the
-- system had notifications turned off for Pikos, so it was never shown. It used
-- to be written as 'reminder', and the history said the person was told when
-- they weren't. A type of its own for the reason 012 gave 'suppressed' one:
-- every dedup predicate reads type = 'reminder', so a refused reminder is
-- dropped exactly like a silenced one and nothing is re-timed.
--
-- The table is recreated because a CHECK can't be altered. 024's trigger names
-- the table, so it is dropped first and recreated after the rename, along with
-- every index the old table carried.

DROP TRIGGER notification_log_on_page_delete;

CREATE TABLE notification_log_new (
  id              TEXT PRIMARY KEY,
  page_id         TEXT,
  schedule_id     TEXT,
  type            TEXT NOT NULL CHECK (type IN ('reminder', 'overdue', 'suppressed', 'refused')),
  fired_at        TEXT NOT NULL,
  action          TEXT CHECK (action IN ('dismissed', 'done', 'opened') OR action IS NULL)
);
INSERT INTO notification_log_new
  SELECT id, page_id, schedule_id, type, fired_at, action FROM notification_log;
DROP TABLE notification_log;
ALTER TABLE notification_log_new RENAME TO notification_log;
CREATE INDEX idx_notif_log_schedule ON notification_log(schedule_id, type, fired_at);
CREATE INDEX idx_notif_log_fired_at ON notification_log(fired_at DESC);
CREATE INDEX idx_notif_log_page ON notification_log(page_id);

CREATE TRIGGER notification_log_on_page_delete
AFTER DELETE ON pages
BEGIN
  DELETE FROM notification_log WHERE page_id = OLD.id;
END;
