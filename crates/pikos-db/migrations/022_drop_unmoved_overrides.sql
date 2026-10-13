-- Overrides that put an occurrence exactly where its rule already does. Google sends
-- an instance as its own resource whenever anything about it differs, none of which an
-- override row stores, and the reconciler kept each as a move: it pushed a series' next
-- meeting past every copy and drew it twice. The reconciler stops writing them; this
-- clears the ones already synced. The heads they displaced are recomputed on the next
-- foreground load.
DELETE FROM page_schedules
WHERE original_date IS NOT NULL
  AND scheduled_start = original_date
  AND EXISTS (
    SELECT 1 FROM page_recurrence_rules r
    WHERE r.id = page_schedules.rule_id
      AND coalesce(page_schedules.timezone, r.timezone) = r.timezone
      AND round((julianday(page_schedules.scheduled_end) - julianday(page_schedules.scheduled_start)) * 86400)
          IS round((julianday(r.scheduled_end) - julianday(r.scheduled_start)) * 86400)
  );
