-- Every page body is stored as chunks too (PKOS-0192): runs of whole top-level blocks, kept by
-- the triggers below from every write that sets pages.content. The rules are in page_chunks.rs.
-- The body column stays the source of truth until saves write chunks alone.

CREATE TABLE page_chunks (
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  chunk_id  TEXT NOT NULL,
  ord       INTEGER NOT NULL,
  body      TEXT NOT NULL,
  PRIMARY KEY (page_id, chunk_id)
);

-- An empty body in a write means the stored bytes stand: no chunk's body is ever empty.
CREATE TRIGGER page_chunks_on_insert
AFTER INSERT ON pages
BEGIN
  INSERT INTO page_chunks (page_id, chunk_id, ord, body)
    SELECT NEW.id, w.value ->> 'id', w.value ->> 'ord', COALESCE(w.value ->> 'body', '')
    FROM json_each(pikos_chunk_writes(NEW.content, (
      SELECT group_concat(chunk_id || char(31) || ord || char(31) || body, char(30))
      FROM page_chunks WHERE page_id = NEW.id
    ))) AS w
    WHERE true
  ON CONFLICT (page_id, chunk_id) DO UPDATE
    SET ord = excluded.ord, body = iif(excluded.body = '', body, excluded.body);
  DELETE FROM page_chunks WHERE page_id = NEW.id AND ord < 0;
END;

CREATE TRIGGER page_chunks_on_content
AFTER UPDATE OF content ON pages
WHEN NEW.content IS NOT OLD.content
BEGIN
  INSERT INTO page_chunks (page_id, chunk_id, ord, body)
    SELECT NEW.id, w.value ->> 'id', w.value ->> 'ord', COALESCE(w.value ->> 'body', '')
    FROM json_each(pikos_chunk_writes(NEW.content, (
      SELECT group_concat(chunk_id || char(31) || ord || char(31) || body, char(30))
      FROM page_chunks WHERE page_id = NEW.id
    ))) AS w
    WHERE true
  ON CONFLICT (page_id, chunk_id) DO UPDATE
    SET ord = excluded.ord, body = iif(excluded.body = '', body, excluded.body);
  DELETE FROM page_chunks WHERE page_id = NEW.id AND ord < 0;
END;

INSERT INTO page_chunks (page_id, chunk_id, ord, body)
  SELECT p.id, w.value ->> 'id', w.value ->> 'ord', w.value ->> 'body'
  FROM pages AS p, json_each(pikos_chunk_writes(p.content, NULL)) AS w;
