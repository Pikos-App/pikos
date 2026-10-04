-- Two checks run at every launch, and each scanned every page: the self-heal for a body saved
-- without its plain text, and the purge of pages trashed long ago. Each index holds only the rows
-- its check acts on, which is normally none, so at half a million pages the checks cost nothing
-- instead of three seconds of reading every body.
CREATE INDEX idx_pages_untexted ON pages(id)
  WHERE content_text = '' AND content != '' AND content != '{}';
CREATE INDEX idx_pages_trashed ON pages(deleted_at) WHERE deleted_at IS NOT NULL;
