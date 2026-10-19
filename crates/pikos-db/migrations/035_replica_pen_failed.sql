-- A record whose write here failed waits too, with the error it failed on, rather than failing the
-- batch it came in. Recreated because the reason's CHECK gains a value.
CREATE TABLE replica_pen_new (
  name   TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  awaits TEXT,
  since  TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unknown_parent', 'deleted_parent', 'newer_format', 'unreadable', 'failed')),
  error  TEXT
) WITHOUT ROWID;

INSERT INTO replica_pen_new (name, record, awaits, since, reason)
SELECT name, record, awaits, since, reason FROM replica_pen;

DROP TABLE replica_pen;
ALTER TABLE replica_pen_new RENAME TO replica_pen;
CREATE INDEX idx_replica_pen_awaits ON replica_pen(awaits);
