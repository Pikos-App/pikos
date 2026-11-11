-- Backlinks read the pages whose links name a page. Most pages link nowhere, so a partial
-- index over only the ones that do keeps that read off the page bodies, which share the row.
CREATE INDEX IF NOT EXISTS idx_pages_links ON pages(links, deleted_at) WHERE links <> '[]';
