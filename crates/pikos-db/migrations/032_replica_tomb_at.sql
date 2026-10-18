-- When this device wrote each tombstone, in milliseconds by its own clock, which is what expiry
-- counts the retention window from. The tombstone's own clock can be far older: purging a page
-- trashed long ago takes the clock of its trashing. A tombstone already here when this runs is
-- counted from now, so none is forgotten sooner than it would have been.
ALTER TABLE replica_clocks ADD COLUMN tomb_at INTEGER;

UPDATE replica_clocks SET tomb_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE tomb IS NOT NULL;
