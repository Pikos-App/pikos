-- Live pages in their manual order, so a list that wants the first fifty reads fifty
-- index entries instead of scanning and sorting the whole table. Partial on
-- `deleted_at IS NULL` because every list query carries that predicate, and trashed
-- pages would only make the index larger.
CREATE INDEX IF NOT EXISTS idx_pages_live_sort ON pages(sort_order) WHERE deleted_at IS NULL;
