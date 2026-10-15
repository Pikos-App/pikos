-- A counter that moves forward with every change to something a page view shows, so the app can
-- tell whether anything changed since it last looked and whether another process made the change.
-- `epoch` changes when the counter could move backwards (a restored or reset workspace).
CREATE TABLE change_counter (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  seq   INTEGER NOT NULL,
  epoch TEXT NOT NULL
);
INSERT INTO change_counter (id, seq, epoch) VALUES (1, 0, lower(hex(randomblob(16))));

-- Each process's share of the counter, by `pikos_writer()`. The changes another process made are
-- the counter minus your own. A row a process stopped writing to is pruned after a day.
CREATE TABLE change_writers (
  writer         TEXT PRIMARY KEY,
  changes        INTEGER NOT NULL,
  last_change_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The counter's value at the page row's last change, its own or a child row's, so a copy of the
-- page held elsewhere can be shown to be current.
ALTER TABLE pages ADD COLUMN row_seq INTEGER NOT NULL DEFAULT 0;

-- The search index re-indexed a page on every update, including the counter's own. Only these
-- columns are indexed.
DROP TRIGGER pages_fts_update;
CREATE TRIGGER pages_fts_update
AFTER UPDATE OF title, subtitle, content_text, tags, mirror_search_text ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, subtitle, content_text, tags, mirror_search_text)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.content_text, old.tags, old.mirror_search_text);
  INSERT INTO pages_fts(rowid, title, subtitle, content_text, tags, mirror_search_text)
  VALUES (new.rowid, new.title, new.subtitle, new.content_text, new.tags, new.mirror_search_text);
END;

-- Every trigger below counts one change, against the process that made it, and stamps the page it
-- belongs to with the new value. The sync tables count only columns a person sees, because every
-- quiet poll stamps their sync times and tokens.

CREATE TRIGGER change_on_pages_insert AFTER INSERT ON pages
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE rowid = NEW.rowid;
END;

-- Stamping `row_seq` is itself an update, and is the one that doesn't count.
CREATE TRIGGER change_on_pages_update AFTER UPDATE ON pages
WHEN NEW.row_seq IS OLD.row_seq
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER change_on_pages_delete AFTER DELETE ON pages
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_page_tags_insert AFTER INSERT ON page_tags
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = NEW.page_id;
END;

CREATE TRIGGER change_on_page_tags_update AFTER UPDATE ON page_tags
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id IN (OLD.page_id, NEW.page_id);
END;

CREATE TRIGGER change_on_page_tags_delete AFTER DELETE ON page_tags
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = OLD.page_id;
END;

CREATE TRIGGER change_on_page_schedules_insert AFTER INSERT ON page_schedules
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = NEW.page_id;
END;

CREATE TRIGGER change_on_page_schedules_update AFTER UPDATE ON page_schedules
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id IN (OLD.page_id, NEW.page_id);
END;

CREATE TRIGGER change_on_page_schedules_delete AFTER DELETE ON page_schedules
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = OLD.page_id;
END;

CREATE TRIGGER change_on_page_recurrence_rules_insert AFTER INSERT ON page_recurrence_rules
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = NEW.page_id;
END;

CREATE TRIGGER change_on_page_recurrence_rules_update AFTER UPDATE ON page_recurrence_rules
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id IN (OLD.page_id, NEW.page_id);
END;

CREATE TRIGGER change_on_page_recurrence_rules_delete AFTER DELETE ON page_recurrence_rules
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = OLD.page_id;
END;

CREATE TRIGGER change_on_completed_set_insert AFTER INSERT ON completed_set
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = NEW.page_id;
END;

CREATE TRIGGER change_on_completed_set_update AFTER UPDATE ON completed_set
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id IN (OLD.page_id, NEW.page_id);
END;

CREATE TRIGGER change_on_completed_set_delete AFTER DELETE ON completed_set
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = OLD.page_id;
END;

CREATE TRIGGER change_on_skip_set_insert AFTER INSERT ON skip_set
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = NEW.page_id;
END;

CREATE TRIGGER change_on_skip_set_update AFTER UPDATE ON skip_set
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id IN (OLD.page_id, NEW.page_id);
END;

CREATE TRIGGER change_on_skip_set_delete AFTER DELETE ON skip_set
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = OLD.page_id;
END;

CREATE TRIGGER change_on_tags_insert AFTER INSERT ON tags
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_tags_update AFTER UPDATE ON tags
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_tags_delete AFTER DELETE ON tags
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_folders_insert AFTER INSERT ON folders
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_folders_update AFTER UPDATE ON folders
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_folders_delete AFTER DELETE ON folders
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_page_sync_insert AFTER INSERT ON page_sync
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = NEW.page_id;
END;

CREATE TRIGGER change_on_page_sync_update AFTER UPDATE OF page_id, account_id, calendar_id, sync_state, mirror_location, mirror_attendees, pending_description ON page_sync
WHEN OLD.page_id IS NOT NEW.page_id
  OR OLD.account_id IS NOT NEW.account_id
  OR OLD.calendar_id IS NOT NEW.calendar_id
  OR OLD.sync_state IS NOT NEW.sync_state
  OR OLD.mirror_location IS NOT NEW.mirror_location
  OR OLD.mirror_attendees IS NOT NEW.mirror_attendees
  OR OLD.pending_description IS NOT NEW.pending_description
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id IN (OLD.page_id, NEW.page_id);
END;

CREATE TRIGGER change_on_page_sync_delete AFTER DELETE ON page_sync
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE id = OLD.page_id;
END;

CREATE TRIGGER change_on_sync_calendar_insert AFTER INSERT ON sync_calendar
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_sync_calendar_update AFTER UPDATE OF enabled, color, display_name, folder_id ON sync_calendar
WHEN OLD.enabled IS NOT NEW.enabled
  OR OLD.color IS NOT NEW.color
  OR OLD.display_name IS NOT NEW.display_name
  OR OLD.folder_id IS NOT NEW.folder_id
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_sync_calendar_delete AFTER DELETE ON sync_calendar
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_sync_account_insert AFTER INSERT ON sync_account
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_sync_account_update AFTER UPDATE OF disconnected, reconnect_needed, display_name ON sync_account
WHEN OLD.disconnected IS NOT NEW.disconnected
  OR OLD.reconnect_needed IS NOT NEW.reconnect_needed
  OR OLD.display_name IS NOT NEW.display_name
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;

CREATE TRIGGER change_on_sync_account_delete AFTER DELETE ON sync_account
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
END;
