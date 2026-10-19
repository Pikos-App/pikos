-- Why the transport stopped until the person chooses, as the transport names it, or NULL while it
-- runs. Kept in the file so a relaunch before the choice stays stopped; forgetting sync clears it.
ALTER TABLE replica_meta ADD COLUMN held_for TEXT;
