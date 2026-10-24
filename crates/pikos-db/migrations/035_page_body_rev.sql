-- Bumped by every write that changes a page's body. The body is stored only as chunks,
-- so this is the column of the row sync's capture can watch for it.
ALTER TABLE pages ADD COLUMN body_rev INTEGER NOT NULL DEFAULT 0;
