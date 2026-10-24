-- A page body is stored only as its chunks. The writer saves them itself, so the
-- triggers that kept them from the column go with it.
DROP TRIGGER page_chunks_on_insert;
DROP TRIGGER page_chunks_on_content;
DROP INDEX idx_pages_untexted;

ALTER TABLE pages DROP COLUMN content;

CREATE INDEX idx_pages_untexted ON pages(id) WHERE content_text = '';
