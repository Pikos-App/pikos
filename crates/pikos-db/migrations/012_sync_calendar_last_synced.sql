-- Per-calendar "last successful sync" timestamp, stamped by the sync engine on
-- every poll that completes (incremental or full re-enumerate). Drives the stale
-- status dot ("synced 3h ago") and the offline indicator. Distinct from
-- last_full_sync_at (which only marks full re-enumerates) and from updated_at
-- (which also bumps on enable/colour edits, so it can't be the freshness clock).
-- NULL until the first sync.
ALTER TABLE sync_calendar ADD COLUMN last_synced_at TEXT;
