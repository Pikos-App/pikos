-- The search index's definition as it was when the index was last built: the
-- full-text table's own SQL and its triggers' SQL, which name the indexed
-- columns and the tokenizer. Opening a workspace compares it with the current
-- definition and rebuilds the index on any difference, so a migration that
-- changes what search indexes can't leave it stale by forgetting a version
-- bump. NULL means not recorded yet: the first open records it without a
-- rebuild, since every earlier definition change came with its own bump.

CREATE TABLE search_index_definition (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  definition TEXT
);
INSERT INTO search_index_definition (id, definition) VALUES (1, NULL);
