-- Remove pages.duration_mins — duration is always derivable from
-- page_schedules.scheduled_end - page_schedules.scheduled_start.
ALTER TABLE pages DROP COLUMN duration_mins;
