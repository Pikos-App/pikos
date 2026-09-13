-- Version-stamp every page's editor content.
--
-- Numbered 013, not 010: this was written as 010 on a branch cut from main and
-- the external-calendar-sync work claimed 010 through 012 independently. sqlx
-- records a checksum per version, so two different files claiming one number
-- means a database that ran either refuses to open with the other — a loud
-- failure, but a total one. Renumbered on the way in.
--
-- Why now: pages.content is a ProseMirror/Tiptap JSON document, and until this
-- migration nothing recorded which document schema produced it. With one
-- writer (the desktop app, whose editor and database ship together) that was
-- survivable — the code reading a document was always the code that wrote it.
-- A second writer breaks that assumption. An iPhone running an older build
-- would happily open, re-serialise and save back a document written by a newer
-- editor, silently dropping any node type its schema does not know. The user
-- sees a table or a task list vanish, with nothing in the data to explain it.
--
-- A version column makes that case detectable rather than silent: a client can
-- refuse to save over content it does not fully understand, and a future
-- content migration can find exactly the rows it needs to touch.
--
-- Why a column rather than a key inside the JSON: Tiptap's getJSON() serialises
-- from its own schema, so an unrecognised top-level key would be dropped on the
-- very next save — the marker would erase itself precisely when content changes,
-- which is the only moment it matters. A column is also queryable without
-- parsing every document.
--
-- Existing rows backfill to 1 via the DEFAULT. That is correct by construction:
-- every document written before this migration came from the single desktop
-- editor, which is what version 1 denotes.

ALTER TABLE pages ADD COLUMN content_schema_version INTEGER NOT NULL DEFAULT 1;

-- Partial index, not a full one: the only query this needs to serve is "find
-- rows this build cannot safely write", which is always a comparison against
-- the current version. Indexing just the non-default rows keeps it empty — and
-- therefore free — until a version bump actually happens.
CREATE INDEX IF NOT EXISTS idx_pages_content_schema_version
  ON pages(content_schema_version)
  WHERE content_schema_version <> 1;
