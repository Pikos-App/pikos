-- ─── Normalized tags tables ────────────────────────────────────────────────────
-- Decision (GOO-121): normalize tags before building tag chips (GOO-60).
-- pages.tags TEXT remains as a denorm cache for FTS5 and fast reads.
-- page_tags is the source of truth for tag ↔ page associations.

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

-- page_tags: many-to-many join between pages and tags
CREATE TABLE IF NOT EXISTS page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (page_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(tag_id);

-- Backfill: parse existing pages.tags JSON arrays into normalized tables.
-- lower(hex(randomblob(8))) produces a compact 16-char hex ID — unique enough for tags.
INSERT OR IGNORE INTO tags (id, name, created_at)
SELECT lower(hex(randomblob(8))), value, datetime('now')
FROM pages, json_each(pages.tags)
WHERE json_valid(pages.tags) AND json_type(pages.tags) = 'array' AND value != '';

INSERT OR IGNORE INTO page_tags (page_id, tag_id)
SELECT pages.id, tags.id
FROM pages, json_each(pages.tags)
JOIN tags ON tags.name = value
WHERE json_valid(pages.tags) AND json_type(pages.tags) = 'array' AND value != '';
