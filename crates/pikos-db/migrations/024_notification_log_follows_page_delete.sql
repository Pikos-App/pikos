-- Deleting a page for good also deletes the notifications that name it.
--
-- notification_log has no foreign key to pages, so a hard delete (the 30-day
-- trash sweep, a purge, the calendar reconciler removing a mirror) left rows
-- naming a page that no longer exists: the history panel listed it, and the
-- page's id stayed on disk after the person deleted it. A trigger rather than a
-- delete in each writer, because pages are hard-deleted from several places,
-- the reconciler's raw SQL among them, and a trigger can't be skipped. A
-- foreign key would need the table recreated for no further gain.

CREATE INDEX IF NOT EXISTS idx_notif_log_page ON notification_log(page_id);

CREATE TRIGGER notification_log_on_page_delete
AFTER DELETE ON pages
BEGIN
  DELETE FROM notification_log WHERE page_id = OLD.id;
END;

DELETE FROM notification_log
WHERE page_id IS NOT NULL AND page_id NOT IN (SELECT id FROM pages);
