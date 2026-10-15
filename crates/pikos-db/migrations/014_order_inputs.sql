-- The inputs the database sorts lists by, on the page row. Kept by the column definition and
-- by triggers rather than by each writer, so no write, raw SQL in the reconciler included, can
-- leave one stale.

-- The start as a sortable wall clock: an all-day date at the start of its day, a time without
-- seconds given them. Computed from the row, so no writer can leave it stale.
ALTER TABLE pages ADD COLUMN order_start TEXT GENERATED ALWAYS AS (
  CASE
    WHEN scheduled_start IS NULL THEN NULL
    WHEN length(scheduled_start) = 10 THEN scheduled_start || 'T00:00:00'
    WHEN length(scheduled_start) = 16 THEN scheduled_start || ':00'
    ELSE substr(scheduled_start, 1, 19)
  END
) VIRTUAL;

-- A synced page with a timed start is an instant shown in the viewer's zone, so it sorts by that
-- instant. Stored, because it reads other tables; the triggers below copy it from this view.
ALTER TABLE pages ADD COLUMN is_absolute INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN abs_start_utc TEXT;

-- The same test as `viewerStart` in syncedTime.ts: locked by sync, a zone on the page's rule or
-- schedule, and a time of day.
CREATE VIEW page_order_inputs AS
SELECT
  id,
  absolute AS is_absolute,
  CASE WHEN absolute THEN pikos_utc(scheduled_start, zone) END AS abs_start_utc
FROM (
  SELECT
    id,
    scheduled_start,
    zone,
    scheduled_start IS NOT NULL AND length(scheduled_start) > 10 AND locked
      AND COALESCE(zone, '') <> '' AS absolute
  FROM (
    SELECT
      p.id,
      p.scheduled_start,
      EXISTS (SELECT 1 FROM page_sync s WHERE s.page_id = p.id AND s.sync_state = 'active')
        AS locked,
      COALESCE(
        (SELECT timezone FROM page_recurrence_rules r WHERE r.page_id = p.id LIMIT 1),
        (SELECT timezone FROM page_schedules ps WHERE ps.page_id = p.id LIMIT 1)) AS zone
    FROM pages p
  )
);

-- Only a page with an active sync row can be absolute, so the triggers on the tables every page
-- writes stop there; the ones on page_sync always run, since a sync row arriving or leaving is
-- what moves a page in or out.

CREATE TRIGGER order_inputs_on_start AFTER UPDATE OF scheduled_start ON pages
WHEN EXISTS (SELECT 1 FROM page_sync WHERE page_id = NEW.id AND sync_state = 'active')
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id = NEW.id
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_sync_insert AFTER INSERT ON page_sync
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id = NEW.page_id
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_sync_update AFTER UPDATE OF sync_state, page_id ON page_sync
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id IN (OLD.page_id, NEW.page_id)
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_sync_delete AFTER DELETE ON page_sync
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id = OLD.page_id
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_schedule_insert AFTER INSERT ON page_schedules
WHEN EXISTS (SELECT 1 FROM page_sync WHERE page_id = NEW.page_id AND sync_state = 'active')
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id = NEW.page_id
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_schedule_update AFTER UPDATE OF timezone, page_id ON page_schedules
WHEN EXISTS (SELECT 1 FROM page_sync
  WHERE page_id IN (OLD.page_id, NEW.page_id) AND sync_state = 'active')
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id IN (OLD.page_id, NEW.page_id)
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_schedule_delete AFTER DELETE ON page_schedules
WHEN EXISTS (SELECT 1 FROM page_sync WHERE page_id = OLD.page_id AND sync_state = 'active')
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id = OLD.page_id
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_rule_insert AFTER INSERT ON page_recurrence_rules
WHEN EXISTS (SELECT 1 FROM page_sync WHERE page_id = NEW.page_id AND sync_state = 'active')
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id = NEW.page_id
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_rule_update AFTER UPDATE OF timezone, page_id
  ON page_recurrence_rules
WHEN EXISTS (SELECT 1 FROM page_sync
  WHERE page_id IN (OLD.page_id, NEW.page_id) AND sync_state = 'active')
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id IN (OLD.page_id, NEW.page_id)
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

CREATE TRIGGER order_inputs_on_rule_delete AFTER DELETE ON page_recurrence_rules
WHEN EXISTS (SELECT 1 FROM page_sync WHERE page_id = OLD.page_id AND sync_state = 'active')
BEGIN
  UPDATE pages SET (is_absolute, abs_start_utc) =
    (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
  WHERE id = OLD.page_id
    AND (is_absolute, abs_start_utc) IS NOT
      (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id);
END;

UPDATE pages SET (is_absolute, abs_start_utc) =
  (SELECT is_absolute, abs_start_utc FROM page_order_inputs v WHERE v.id = pages.id)
WHERE id IN (SELECT page_id FROM page_sync WHERE sync_state = 'active');
