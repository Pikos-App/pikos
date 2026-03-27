-- Add soft-delete support: nullable timestamp column.
-- NULL = not deleted. ISO 8601 string = when it was trashed.
ALTER TABLE pages ADD COLUMN deleted_at TEXT;
