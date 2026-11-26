# Replica sync glossary

Terms for keeping one workspace the same across a person's own devices. The person sees
"Sync"; code says replica, because `sync` in `pikos-db` already means calendar sync.

**Replica sync / `pikos-replica`**: the Rust engine that does it. Clocks, records and merge,
with no I/O of its own. Transports drive it and hold no policy.

**Capture**: recording, in the same transaction as a write, which synced fields of which row
changed and at what clock. Database triggers do it, so no writer can skip it. Writes applied
from another device, and maintenance every device runs for itself, run with capture held off.

**Tombstone**: the record of a delete, carrying its clock, so a delete and an offline edit
settle the same way on every device. A row is gone while its tombstone is newer than every
write to it, and a strictly later write brings it back. Not the same as a calendar-sync
tombstone (`sync_state = 'tombstoned'`), which suppresses a deleted event until unsync.

**Holding pen**: where an arriving record waits when it can't be applied yet: its parent
hasn't arrived or was deleted here, a newer Pikos wrote it, or it can't be read. Held records
are retried on every apply rather than dropped.
