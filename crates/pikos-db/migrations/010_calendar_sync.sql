-- ─── External calendar sync: schema ───────────────────────────────────────────
--
-- Sync is read-only: Pikos never writes back to a provider, so no two-writer
-- conflict exists anywhere below. Secrets are never stored in SQLite — the OS
-- keychain holds them, keyed by the `sync_account` row id.
--
-- This migration adds no timezone column. Synced events are absolute and native
-- ones float, but both store a wall-clock start plus an IANA zone in the columns
-- migration 001 already has; the two are told apart by whether a `page_sync` row
-- exists, never by whether the zone column is populated (a native row may carry a
-- zone as authoring provenance).
--
-- All-day recurring synced events have no meaningful zone, and the reconciler
-- stamps a sentinel into the NOT NULL `page_recurrence_rules.timezone` rather than
-- relaxing that constraint: SQLite would need a table rebuild on live data, and
-- the column only carries provenance — real risk for no behavioural gain.

-- ─── sync_account ─────────────────────────────────────────────────────────────
-- The row id doubles as the keychain item key.
--
-- `provider` is deliberately not a CHECK constraint. SQLite can't ALTER one, so a
-- closed list would force a table rebuild on live data to add a provider — and
-- another if a pre-registered name turned out wrong. The command layer validates
-- instead. `auth_kind` stays closed because its set is internal and stable.
CREATE TABLE IF NOT EXISTS sync_account (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,                 -- 'google' | 'caldav' | 'outlook' | etc; validated app-side
  display_name  TEXT NOT NULL,                 -- email (Google) / server·username (CalDAV)
  auth_kind     TEXT NOT NULL CHECK (auth_kind IN ('basic', 'oauth')),
  -- Set when a poll's credentials are rejected. The scheduler then skips the account
  -- entirely until a manual resync clears it, so a dead credential can't hammer a
  -- provider's failed-login throttle every pass.
  reconnect_needed INTEGER NOT NULL DEFAULT 0,
  -- Disconnect is dormancy, not deletion: the row and its calendars survive so a
  -- later reconnect re-links detached pages by ical_uid instead of duplicating them.
  -- Only a full account removal cascades everything away.
  disconnected  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ─── sync_calendar ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_calendar (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES sync_account(id) ON DELETE CASCADE,
  calendar_id        TEXT NOT NULL,               -- provider's identifier, not this row's
  display_name       TEXT NOT NULL,
  color              TEXT,                        -- Pikos palette colour (not provider hex)
  -- Sync follows the provider's colour until the user picks one on either surface,
  -- then never overwrites it. Without the flag the two are indistinguishable, forcing
  -- a choice between clobbering a manual recolour and never tracking upstream at all.
  color_user_set     INTEGER NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 0,
  sync_token         TEXT,                        -- incremental cursor: Google syncToken / CalDAV sync-token
  ctag               TEXT,                        -- CalDAV change tag, for the no-sync-collection fallback
  last_full_sync_at  TEXT,
  last_synced_at     TEXT,                        -- freshness clock for the stale dot; every poll, not just full ones
  -- NULL while disabled, but kept across a disable that leaves owned survivors, so a
  -- re-enable re-flags the same folder in place.
  folder_id          TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (account_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_calendar_account ON sync_calendar(account_id);

-- ─── page_sync ────────────────────────────────────────────────────────────────
-- ONE ROW PER SERIES, never per occurrence: a recurring event is a single page,
-- with modified instances as `page_schedules` override rows and cancellations as
-- EXDATEs. Neither gets its own row, so there is no per-instance external_id/etag.
--
-- `schedule_locked` is deliberately not a column here or on `pages` — it is derived
-- from `sync_state = 'active'` at read time, so it cannot drift from the sync state.
--
-- FK choices err toward keeping data: a page hard-delete cascades the link away, and
-- account removal cascades too, but ordinary unsync/disconnect deletes no
-- `sync_account` row — so a detached page keeps the dormant identity a resync needs
-- to re-link it.
CREATE TABLE IF NOT EXISTS page_sync (
  id                              TEXT PRIMARY KEY,
  page_id                         TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  account_id                      TEXT NOT NULL REFERENCES sync_account(id) ON DELETE CASCADE,
  provider                        TEXT NOT NULL,  -- denorm hint; no CHECK, see sync_account.provider
  calendar_id                     TEXT NOT NULL,  -- denorm hint, kept on detach
  -- The dedup identity: a CalDAV resource href or a Google event id. NOT the ICS UID
  -- — etags and sync-collection are per-href, so href is the resource identity.
  external_id                     TEXT NOT NULL,
  ical_uid                        TEXT NOT NULL,  -- RFC 5545 UID; re-links a dormant page within its OWN calendar only
  etag                            TEXT,           -- change detection; reconciler no-ops on unchanged etag
  sync_state                      TEXT NOT NULL DEFAULT 'active'
  CHECK (sync_state IN ('active', 'detached', 'tombstoned')),
  user_modified                   INTEGER NOT NULL DEFAULT 0,  -- ownership signal; ONLY the editor path sets it
  seeded_description_hash         TEXT,           -- hash of pages.content_text as last written by sync
  seeded_description_hash_version INTEGER,        -- content_text projection version; lets a projection change re-seed rather than mis-classify
  mirror_location                 TEXT,           -- calendar-owned, rendered read-only
  mirror_attendees                TEXT,           -- JSON; same
  -- An upstream description change withheld because the user already edited the body.
  -- Parked rather than clobbered, and drives the editor's passive notice.
  pending_description             TEXT,
  last_synced_at                  TEXT,
  created_at                      TEXT NOT NULL
);

-- An event maps to at most ONE page per calendar. Deliberately not scoped wider:
-- the same meeting on two calendars is two resources and belongs in both folders.
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_sync_identity
  ON page_sync(account_id, calendar_id, external_id);

-- Non-unique on purpose — a misbehaving server can emit two hrefs sharing a UID in
-- one calendar, and the index above already holds the dedup line.
CREATE INDEX IF NOT EXISTS idx_page_sync_relink
  ON page_sync(account_id, calendar_id, ical_uid);

-- ─── folders: system-folder flag ──────────────────────────────────────────────
-- Drives the placement lock (pages can't move into or out of these folders) and the
-- separate sidebar area.
ALTER TABLE folders ADD COLUMN is_external_calendar INTEGER NOT NULL DEFAULT 0;

-- ─── completed_set / skip_set: unified recurring occurrence state ──────────────
-- One representation for both origins, replacing native head-advance + EXDATE-merge
-- and the synced completion JSON map.
--
-- A MOVED occurrence is a `page_schedules` override, never a skip — expansion already
-- excludes its original date, so the two are mutually exclusive.
--
-- Not cleared on soft-delete, so restoring a page preserves its completion history.
CREATE TABLE IF NOT EXISTS completed_set (
  page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,   -- YYYY-MM-DD occurrence key (or timed wall-clock, matching pages.scheduled_start format)
  clone_id        TEXT NOT NULL,   -- the done clone page; back-link drives uncomplete
  PRIMARY KEY (page_id, occurrence_date)
);

CREATE INDEX IF NOT EXISTS idx_completed_set_clone ON completed_set(clone_id);

CREATE TABLE IF NOT EXISTS skip_set (
  page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,   -- YYYY-MM-DD
  PRIMARY KEY (page_id, occurrence_date)
);
