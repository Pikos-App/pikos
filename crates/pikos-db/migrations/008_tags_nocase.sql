-- Normalize tag case + whitespace.
--
-- Policy: tag identity is case- and whitespace-insensitive — "Work", "work", and
-- "  work  " are the same tag. The first-seen display casing is preserved.
--
-- Migration 003 created tags.name as a case-sensitive UNIQUE column, so variants
-- survived as distinct rows and showed as duplicates in autocomplete. This
-- migration dedupes to one canonical row per normalized key (earliest-created
-- wins), repoints associations onto it, then enforces case-insensitive
-- uniqueness with a NOCASE unique index.
--
-- We add a UNIQUE NOCASE index rather than rebuilding the table: page_tags.tag_id
-- carries ON DELETE CASCADE, so DROP TABLE tags would implicitly delete every tag
-- row and cascade-wipe page_tags. The index gives the same case-insensitive
-- uniqueness with none of that risk. (In practice there is little-to-no tag data
-- yet, so the dedupe below is a safe no-op on current workspaces.)

-- Canonical id per normalized (lower+trim) name: earliest created_at, then
-- smallest id for determinism.
CREATE TEMP TABLE _tag_dedup AS
SELECT
  t.id AS old_id,
  (SELECT w.id FROM tags w
   WHERE lower(trim(w.name)) = lower(trim(t.name))
   ORDER BY w.created_at ASC, w.id ASC
   LIMIT 1) AS keep_id
FROM tags t;

-- Preserve associations: point every page_tags row at its canonical tag. The
-- (page_id, tag_id) primary key dedupes when a page already had the canonical tag.
INSERT OR IGNORE INTO page_tags (page_id, tag_id)
SELECT pt.page_id, d.keep_id
FROM page_tags pt
JOIN _tag_dedup d ON d.old_id = pt.tag_id
WHERE d.keep_id <> d.old_id;

-- Drop the losing tag rows; ON DELETE CASCADE removes their now-redundant
-- page_tags rows (the canonical association was inserted above).
DELETE FROM tags
WHERE id IN (SELECT old_id FROM _tag_dedup WHERE keep_id <> old_id);

-- Clean display casing/whitespace on the survivors. Safe: survivors are already
-- unique by lower(trim), so trimming can't collide.
UPDATE tags SET name = trim(name);

-- Enforce case-insensitive uniqueness going forward.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags(name COLLATE NOCASE);

DROP TABLE _tag_dedup;
