-- Lowercase all tags.
--
-- Decision (2026-05-28): pre-launch, with no real users yet, tags are stored
-- lowercase — no case preservation, no case-insensitive machinery. Uniqueness
-- falls out of the data being lowercase. (When tag management ships later we can
-- allow display-casing changes and enforce case-insensitive uniqueness then.)
--
-- Migration 008 already collapsed case/whitespace variants to one row per group
-- (keeping first-seen casing), so lowercasing the survivors here can't collide.
-- Drop 008's NOCASE index — redundant once every name is lowercase.

UPDATE tags SET name = lower(trim(name));

DROP INDEX IF EXISTS idx_tags_name_nocase;

-- Lowercase the pages.tags JSON denorm too (the cache the UI + FTS read), dedupe
-- within each array, preserve first-occurrence order. Updating pages.tags fires
-- the FTS sync trigger, so the index follows.
UPDATE pages
SET tags = (
  SELECT COALESCE(json_group_array(name), '[]')
  FROM (
    SELECT lower(trim(je.value)) AS name, MIN(je.key) AS ord
    FROM json_each(pages.tags) je
    WHERE trim(je.value) <> ''
    GROUP BY lower(trim(je.value))
    ORDER BY ord
  )
)
WHERE json_valid(tags) AND json_type(tags) = 'array';
