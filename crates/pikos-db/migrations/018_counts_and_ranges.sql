-- Open and done pages per folder ('' is the Inbox), kept by triggers, so a list's total and the
-- sidebar's counts are one row read at any size. Bookkeeping: the change counter doesn't count it.
CREATE TABLE folder_counts (
  folder_key TEXT PRIMARY KEY,
  open       INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT INTO folder_counts (folder_key, open, done)
SELECT COALESCE(folder_id, ''), SUM(status <> 'done'), SUM(status = 'done')
FROM pages WHERE deleted_at IS NULL GROUP BY COALESCE(folder_id, '');

CREATE TRIGGER folder_counts_on_insert AFTER INSERT ON pages
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO folder_counts (folder_key) SELECT COALESCE(NEW.folder_id, '')
  WHERE NOT EXISTS (SELECT 1 FROM folder_counts WHERE folder_key = COALESCE(NEW.folder_id, ''));
  UPDATE folder_counts
  SET open = open + (NEW.status <> 'done'), done = done + (NEW.status = 'done')
  WHERE folder_key = COALESCE(NEW.folder_id, '');
END;

CREATE TRIGGER folder_counts_on_delete AFTER DELETE ON pages
WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE folder_counts
  SET open = open - (OLD.status <> 'done'), done = done - (OLD.status = 'done')
  WHERE folder_key = COALESCE(OLD.folder_id, '');
END;

CREATE TRIGGER folder_counts_on_update AFTER UPDATE OF folder_id, status, deleted_at ON pages
WHEN OLD.folder_id IS NOT NEW.folder_id
  OR (OLD.status = 'done') IS NOT (NEW.status = 'done')
  OR (OLD.deleted_at IS NULL) IS NOT (NEW.deleted_at IS NULL)
BEGIN
  UPDATE folder_counts
  SET open = open - (OLD.status <> 'done'), done = done - (OLD.status = 'done')
  WHERE OLD.deleted_at IS NULL AND folder_key = COALESCE(OLD.folder_id, '');
  INSERT INTO folder_counts (folder_key) SELECT COALESCE(NEW.folder_id, '')
  WHERE NEW.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM folder_counts WHERE folder_key = COALESCE(NEW.folder_id, ''));
  UPDATE folder_counts
  SET open = open + (NEW.status <> 'done'), done = done + (NEW.status = 'done')
  WHERE NEW.deleted_at IS NULL AND folder_key = COALESCE(NEW.folder_id, '');
END;

-- How many days a page spans, so a calendar range can reach back exactly as far as its longest
-- page and no further.
ALTER TABLE pages ADD COLUMN span_days REAL GENERATED ALWAYS AS (
  julianday(scheduled_end) - julianday(scheduled_start)
) VIRTUAL;
CREATE INDEX idx_span ON pages(span_days) WHERE deleted_at IS NULL AND span_days IS NOT NULL;

-- Pages by start across every folder, of any status, for calendar ranges and the date-bound
-- counts. Status and span are in the index, so a count of open pages, or setting aside a page
-- that ended before a range, never reads the row.
CREATE INDEX idx_range_floating ON pages(order_start, status, span_days)
  WHERE deleted_at IS NULL AND is_absolute = 0 AND order_start IS NOT NULL;
CREATE INDEX idx_range_absolute ON pages(abs_start_utc, status, span_days)
  WHERE deleted_at IS NULL AND is_absolute = 1;

CREATE INDEX idx_recent ON pages(last_opened_at DESC)
  WHERE deleted_at IS NULL AND status <> 'done' AND last_opened_at IS NOT NULL;

-- Open pages per tag, kept by triggers, for tag autocomplete (most used first). A page's tags count
-- while it's open and not trashed. A page's delete takes its tag rows with it after the page row
-- is gone, so the decrement for a deleted page runs before the delete, and the tag-row trigger
-- skips pages that no longer exist.
CREATE TABLE tag_counts (
  tag_id     TEXT PRIMARY KEY,
  open_pages INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT INTO tag_counts (tag_id, open_pages)
SELECT pt.tag_id, COUNT(*) FROM page_tags pt JOIN pages p ON p.id = pt.page_id
WHERE p.deleted_at IS NULL AND p.status <> 'done' GROUP BY pt.tag_id;

CREATE TRIGGER tag_counts_on_tag_insert AFTER INSERT ON page_tags
WHEN EXISTS (SELECT 1 FROM pages WHERE id = NEW.page_id AND deleted_at IS NULL AND status <> 'done')
BEGIN
  INSERT INTO tag_counts (tag_id) SELECT NEW.tag_id
  WHERE NOT EXISTS (SELECT 1 FROM tag_counts WHERE tag_id = NEW.tag_id);
  UPDATE tag_counts SET open_pages = open_pages + 1 WHERE tag_id = NEW.tag_id;
END;

CREATE TRIGGER tag_counts_on_tag_delete AFTER DELETE ON page_tags
WHEN EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id AND deleted_at IS NULL AND status <> 'done')
BEGIN
  UPDATE tag_counts SET open_pages = open_pages - 1 WHERE tag_id = OLD.tag_id;
END;

CREATE TRIGGER tag_counts_on_page_delete BEFORE DELETE ON pages
WHEN OLD.deleted_at IS NULL AND OLD.status <> 'done'
BEGIN
  UPDATE tag_counts SET open_pages = open_pages - 1
  WHERE tag_id IN (SELECT tag_id FROM page_tags WHERE page_id = OLD.id);
END;

CREATE TRIGGER tag_counts_on_page_update AFTER UPDATE OF status, deleted_at ON pages
WHEN (OLD.deleted_at IS NULL AND OLD.status <> 'done') IS NOT (NEW.deleted_at IS NULL AND NEW.status <> 'done')
BEGIN
  INSERT INTO tag_counts (tag_id) SELECT tag_id FROM page_tags
  WHERE page_id = NEW.id AND tag_id NOT IN (SELECT tag_id FROM tag_counts);
  UPDATE tag_counts
  SET open_pages = open_pages + CASE WHEN NEW.deleted_at IS NULL AND NEW.status <> 'done' THEN 1 ELSE -1 END
  WHERE tag_id IN (SELECT tag_id FROM page_tags WHERE page_id = NEW.id);
END;

-- Open pages by start across every folder in date order, for Today's and Upcoming's sections a
-- window at a time.
CREATE INDEX idx_dated_floating ON pages(order_start, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 0 AND order_start IS NOT NULL;
CREATE INDEX idx_dated_absolute ON pages(abs_start_utc, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 1;
