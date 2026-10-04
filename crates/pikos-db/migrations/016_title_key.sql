-- A title's sort key, so lists can be ordered by title in the database the way the app orders
-- them (title_key.rs). Kept by triggers. `title_key_version` names what the stored keys were made
-- with; a process that makes them differently re-keys every page after opening.
ALTER TABLE pages ADD COLUMN title_key BLOB;

CREATE TABLE title_key_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT
);
INSERT INTO title_key_version (id, version) VALUES (1, NULL);

CREATE TRIGGER title_key_on_insert AFTER INSERT ON pages
BEGIN
  UPDATE pages SET title_key = pikos_title_key(NEW.title) WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER title_key_on_title AFTER UPDATE OF title ON pages
WHEN NEW.title IS NOT OLD.title
BEGIN
  UPDATE pages SET title_key = pikos_title_key(NEW.title) WHERE rowid = NEW.rowid;
END;

-- A new key isn't a change anyone sees, and re-keying a workspace would otherwise count every page.
DROP TRIGGER change_on_pages_update;
CREATE TRIGGER change_on_pages_update AFTER UPDATE ON pages
WHEN NEW.row_seq IS OLD.row_seq AND NEW.title_key IS OLD.title_key
BEGIN
  UPDATE change_counter SET seq = seq + 1;
  INSERT INTO change_writers SELECT pikos_writer(), 0, 0
  WHERE NOT EXISTS (SELECT 1 FROM change_writers WHERE writer = pikos_writer());
  UPDATE change_writers SET changes = changes + 1, last_change_at = unixepoch()
  WHERE writer = pikos_writer();
  UPDATE pages SET row_seq = (SELECT seq FROM change_counter) WHERE rowid = NEW.rowid;
END;
