-- An all-day date sorts after every time on its day: `T24:00:00` reads as text after `T23:59:59`
-- and before the next day's `T00:00:00`. SQLite can't alter a generated column, so the column and
-- the indexes that read it are dropped and made again as they were.

DROP INDEX idx_view_floating;
DROP INDEX idx_view_priority_floating;
DROP INDEX idx_range_floating;
DROP INDEX idx_dated_floating;

ALTER TABLE pages DROP COLUMN order_start;

ALTER TABLE pages ADD COLUMN order_start TEXT GENERATED ALWAYS AS (
  CASE
    WHEN scheduled_start IS NULL THEN NULL
    WHEN length(scheduled_start) = 10 THEN scheduled_start || 'T24:00:00'
    WHEN length(scheduled_start) = 16 THEN scheduled_start || ':00'
    ELSE substr(scheduled_start, 1, 19)
  END
) VIRTUAL;

CREATE INDEX idx_view_floating ON pages(folder_id, order_start, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 0 AND order_start IS NOT NULL;

CREATE INDEX idx_view_priority_floating
  ON pages(folder_id, priority, order_start, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 0 AND order_start IS NOT NULL;

CREATE INDEX idx_range_floating ON pages(order_start, status, span_days)
  WHERE deleted_at IS NULL AND is_absolute = 0 AND order_start IS NOT NULL;

CREATE INDEX idx_dated_floating ON pages(order_start, sort_order, created_at, id)
  WHERE deleted_at IS NULL AND status <> 'done' AND is_absolute = 0 AND order_start IS NOT NULL;
