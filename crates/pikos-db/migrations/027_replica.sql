-- Replica sync's bookkeeping: who this workspace and device are, the clock, what is waiting to
-- send, and each synced row's field clocks. Nothing here is captured until sync is first started.

-- One row. `workspace_id` travels with the file and names the workspace's zone; `device_id` is
-- minted when sync starts. `hlc` is the clock every capture advances. Rows with no entry in
-- `replica_clocks` hold `base_clock`, stamped when sync started, so starting writes nothing per
-- row. `started` stays set once sync has run, through pauses, until sync is forgotten on this
-- device. `seeded` lists the first-run rows, so joining can tell a workspace nobody used.
CREATE TABLE replica_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id  TEXT NOT NULL,
  device_id     TEXT,
  hlc           TEXT NOT NULL,
  base_clock    TEXT,
  started       INTEGER NOT NULL DEFAULT 0,
  paused        INTEGER NOT NULL DEFAULT 0,
  engine_state  BLOB,
  seeded        TEXT NOT NULL DEFAULT '[]',
  last_fetch_at TEXT,
  epoch_seen    TEXT
);
INSERT INTO replica_meta (id, workspace_id, hlc) VALUES (
  1,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
    || substr(lower(hex(randomblob(2))), 2) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-'
    || lower(hex(randomblob(6))),
  '00000000000000000000'
);

-- Holds a row only inside a transaction that applies remote records or runs maintenance, and is
-- emptied before that transaction commits. Every capture trigger skips while it holds one.
CREATE TABLE replica_applying (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

-- What is waiting to send: one row per record, with a bit per dirty field in the entity's field
-- order and the newest clock captured. Values aren't kept; a record is built from the live row.
-- `deleted` means the latest change removed the row.
CREATE TABLE replica_ops (
  entity  TEXT NOT NULL,
  key     TEXT NOT NULL,
  fields  INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  clock   TEXT NOT NULL,
  PRIMARY KEY (entity, key)
) WITHOUT ROWID;
CREATE INDEX idx_replica_ops_clock ON replica_ops(clock);

-- Records that arrived and couldn't be applied yet, kept as they came and retried on every apply:
-- a parent this device hasn't seen or has deleted (it can come back), a newer Pikos's format, or a
-- record this one can't read.
CREATE TABLE replica_pen (
  name   TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  awaits TEXT,
  since  TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unknown_parent', 'deleted_parent', 'newer_format', 'unreadable'))
) WITHOUT ROWID;
CREATE INDEX idx_replica_pen_awaits ON replica_pen(awaits);

-- Links shown NULL because the row they point at isn't here, purged or not yet arrived, with what
-- they point at. That target, not the NULL, is the link's synced value; the column shows it again
-- when the row arrives or comes back.
CREATE TABLE replica_detached (
  entity  TEXT NOT NULL,
  key     TEXT NOT NULL,
  field   INTEGER NOT NULL,
  col     TEXT NOT NULL,
  target  TEXT NOT NULL,
  PRIMARY KEY (entity, key, field)
) WITHOUT ROWID;
CREATE INDEX idx_replica_detached_target ON replica_detached(target);

-- Each synced row's clocks: `clocks` is 20 hex characters per slot, the row's creation first and
-- then one per field in the entity's field order. `tomb` is the clock of the delete, while the row
-- is gone. `system_fields` is the transport's own copy of the record's metadata.
CREATE TABLE replica_clocks (
  entity        TEXT NOT NULL,
  key           TEXT NOT NULL,
  clocks        TEXT NOT NULL,
  tomb          TEXT,
  system_fields BLOB,
  PRIMARY KEY (entity, key)
) WITHOUT ROWID;
