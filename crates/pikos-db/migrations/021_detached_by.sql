-- Why a page's link to its calendar was severed. Turning a calendar off keeps the pages the user
-- owned, and turning it back on re-links them; an event deleted upstream leaves its owned page
-- with nothing to re-link to. The re-enable dialog counts what it will take back, so it has to
-- tell the two apart, and only the moment of severing knows which it was.
ALTER TABLE page_sync ADD COLUMN detached_by TEXT
  CHECK (detached_by IS NULL OR detached_by IN ('turn_off', 'upstream'));

-- A page severed while its calendar is still on can't have been severed by turning it off. In a
-- calendar that is off, an older row's cause is unknown; counting it as kept is what the dialog
-- has always done.
UPDATE page_sync
SET detached_by = CASE
  WHEN EXISTS (
    SELECT 1 FROM sync_calendar c
    WHERE c.account_id = page_sync.account_id
      AND c.calendar_id = page_sync.calendar_id
      AND c.enabled = 1
  ) THEN 'upstream'
  ELSE 'turn_off'
END
WHERE sync_state = 'detached';
