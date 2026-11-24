-- When this device last had a change stored by the transport, and last took in one from another
-- device. The status line shows both, so a device that stopped sending reads as stale on each side.
ALTER TABLE replica_meta ADD COLUMN last_sent_at TEXT;
ALTER TABLE replica_meta ADD COLUMN last_received_at TEXT;
