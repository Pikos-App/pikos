-- Add soft-delete support to folders: nullable timestamp column.
-- NULL = not deleted. ISO 8601 string = when it was trashed.
ALTER TABLE folders ADD COLUMN deleted_at TEXT;
