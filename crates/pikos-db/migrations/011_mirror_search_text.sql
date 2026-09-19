-- Make calendar-owned mirror metadata reachable from search.
--
-- `pages_fts` is an external-content index (`content=pages`), so every indexed
-- column has to resolve against `pages` — the room and attendee list live on
-- `page_sync` and were therefore unreachable. Denormed here as ONE projection
-- column rather than a column per field: a third piece of mirror metadata then
-- extends the projection (`mirror_search_text` in reconciler.rs, and its mock
-- twin) and needs no schema change, no trigger rewrite and no index rebuild.
-- The alternative — pointing `content=` at a view that joins `page_sync` —
-- was rejected because the 'delete' command has to be fed the exact values that
-- were indexed, and a page hard-delete cascades `page_sync` away, so the two
-- triggers race for values that no longer exist and silently orphan index rows.
--
-- Same denorm contract as `pages.tags` / `page_tags`: written in the reconciler's
-- own transaction, never by the user.
ALTER TABLE pages ADD COLUMN mirror_search_text TEXT;

-- Must agree with `mirror_search_text` in reconciler.rs: the non-empty parts
-- joined by a newline. Unchanged events never re-enter the reconciler (it
-- returns early on a matching etag), so an unbackfilled row would stay unindexed
-- until the event happened to change upstream.
UPDATE pages
SET mirror_search_text = (
  SELECT NULLIF(
    TRIM(
      COALESCE(ps.mirror_location, '') || CHAR(10) ||
      COALESCE((SELECT GROUP_CONCAT(value, CHAR(10)) FROM json_each(ps.mirror_attendees)), ''),
      CHAR(10)
    ),
    ''
  )
  FROM page_sync ps WHERE ps.page_id = pages.id
)
WHERE EXISTS (SELECT 1 FROM page_sync ps WHERE ps.page_id = pages.id);

-- FTS5 has no ADD COLUMN — the index is recreated and rebuilt from `pages`.
DROP TABLE IF EXISTS pages_fts;

CREATE VIRTUAL TABLE pages_fts USING fts5(
  title, subtitle, content_text, tags, mirror_search_text,
  content=pages, content_rowid=rowid
);

INSERT INTO pages_fts(pages_fts) VALUES('rebuild');

DROP TRIGGER IF EXISTS pages_fts_insert;
DROP TRIGGER IF EXISTS pages_fts_update;
DROP TRIGGER IF EXISTS pages_fts_delete;

CREATE TRIGGER pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, subtitle, content_text, tags, mirror_search_text)
  VALUES (new.rowid, new.title, new.subtitle, new.content_text, new.tags, new.mirror_search_text);
END;

CREATE TRIGGER pages_fts_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, subtitle, content_text, tags, mirror_search_text)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.content_text, old.tags, old.mirror_search_text);
  INSERT INTO pages_fts(rowid, title, subtitle, content_text, tags, mirror_search_text)
  VALUES (new.rowid, new.title, new.subtitle, new.content_text, new.tags, new.mirror_search_text);
END;

CREATE TRIGGER pages_fts_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, subtitle, content_text, tags, mirror_search_text)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.content_text, old.tags, old.mirror_search_text);
END;
