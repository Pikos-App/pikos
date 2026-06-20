-- ─── External calendar sync: schema ───────────────────────────────────────────
--
-- Read-only sync of external calendars (CalDAV, then Google) into Pikos pages. A
-- synced event is a real `pages` row; the link and sync bookkeeping live in
-- `page_sync` (one row per series, never per occurrence). Account and per-calendar
-- config live in `sync_account` / `sync_calendar`. Secrets are never stored here —
-- they live in the OS keychain; these tables hold only a stable handle
-- (`sync_account.auth_kind` plus the keychain key derived from the row id).
--
-- Timezone model. Native Pikos pages are floating wall-clock: they show the same
-- clock time in any zone and do not move when the user travels. Synced events are
-- absolute: they shift to the viewer's current zone (a 3pm New York event shows as
-- 6pm to a viewer in London). Both are stored the same way — a wall-clock start
-- plus an IANA zone in the existing `page_schedules.timezone` /
-- `page_recurrence_rules.timezone` columns — so the two are told apart by whether a
-- `page_sync` row exists, not by whether the zone column is populated (native rows
-- may also carry a zone as authoring provenance). The stored zone is the source
-- zone; converting it to the viewer's zone happens at render time, so this
-- migration adds no timezone column and leaves migration 001 untouched. All-day
-- synced events are date-only and never shift.
--
-- All-day recurring synced events have no meaningful zone, but
-- `page_recurrence_rules.timezone` is NOT NULL. The reconciler stamps a sentinel
-- zone (the account's zone, or 'UTC') rather than relaxing the constraint:
-- relaxing it would mean rebuilding the table on live data for a column that only
-- carries provenance — real risk for no behavioural gain.

-- ─── sync_account ─────────────────────────────────────────────────────────────
-- One row per connected account. Tokens/passwords are NOT stored here — only a
-- stable handle. `auth_kind` records how the account authenticates ('basic' for
-- CalDAV app passwords, 'oauth' for Google) so the keychain wrapper knows what to
-- load. The row id doubles as the keychain item key.
-- `provider` is intentionally NOT a CHECK constraint. Known values today are
-- 'google' and 'caldav' (iCloud/Fastmail are 'caldav'); Outlook/Microsoft Graph
-- is the named next provider. SQLite can't ALTER a CHECK, so a closed list would
-- force a table rebuild on live data to add a provider (the same rebuild-on-live-
-- data risk we avoid for the TZ column) — and we'd still rebuild if a guessed
-- name turned out wrong. Validate the value in the reconciler/command layer
-- instead. `auth_kind` stays a closed CHECK: 'basic' (CalDAV app password) /
-- 'oauth' (Google, and Outlook later) is a stable internal set.
CREATE TABLE IF NOT EXISTS sync_account (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,                 -- 'google' | 'caldav' | 'outlook' | etc; validated app-side
  display_name  TEXT NOT NULL,                 -- email (Google) / server·username (CalDAV)
  auth_kind     TEXT NOT NULL CHECK (auth_kind IN ('basic', 'oauth')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ─── sync_calendar ────────────────────────────────────────────────────────────
-- Per-calendar configuration, including the per-calendar opt-in (`enabled`,
-- off by default). `sync_token` is the provider's incremental cursor (Google
-- syncToken / CalDAV sync-token); `ctag` is the CalDAV change tag used for the
-- no-sync-collection fallback.
CREATE TABLE IF NOT EXISTS sync_calendar (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES sync_account(id) ON DELETE CASCADE,
  calendar_id        TEXT NOT NULL,               -- provider's calendar identifier
  display_name       TEXT NOT NULL,
  color              TEXT,                        -- Pikos palette colour (not provider hex)
  enabled            INTEGER NOT NULL DEFAULT 0,  -- per-calendar opt-in, off by default
  sync_token         TEXT,
  ctag               TEXT,
  last_full_sync_at  TEXT,
  -- Freshness clock for the stale dot — unlike last_full_sync_at (full syncs only)
  -- and updated_at (any edit).
  last_synced_at     TEXT,
  -- The enabled calendar's system folder. NULL while disabled; kept across a disable
  -- that leaves owned survivors, so a re-enable re-flags the same folder in place.
  folder_id          TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (account_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_calendar_account ON sync_calendar(account_id);

-- ─── page_sync ────────────────────────────────────────────────────────────────
-- One row per synced page, linking a Pikos page to its source event. ONE ROW PER
-- SERIES — a recurring event is a single page: modified instances map to
-- `page_schedules` override rows (keyed by `original_date`) and cancellations to
-- `EXDATE`; none get their own `page_sync` row, so there is no per-instance
-- external_id/etag.
--
-- `external_id` is the dedup identity: the CalDAV resource **href** (NOT the ICS
-- UID) or the Google event id — `getetag`/`sync-collection` are per-href, so href
-- is the resource identity. `ical_uid` is the RFC 5545 UID, used ONLY to re-link a
-- dormant/detached page to its OWN calendar on resync — never to merge across
-- calendars (see the per-calendar UNIQUE below).
--
-- `schedule_locked` is intentionally NOT a column here or on `pages`: it is a
-- derived join (`EXISTS … WHERE page_id=? AND sync_state='active'`) surfaced on
-- PageSummary, so it can never drift from the sync state.
--
-- FK choices (data-loss-safe): page hard-delete cascades the link away (the
-- reconciler's explicit destroy path for non-owned upstream removals). Account
-- removal cascades too — but normal unsync/disconnect does NOT delete the
-- sync_account row (it stays so `ical_uid` re-link works on resync), so detached
-- owned pages keep their dormant identity across unsync. Only a full account
-- removal — the most destructive explicit action — cascades these rows away.
CREATE TABLE IF NOT EXISTS page_sync (
  id                              TEXT PRIMARY KEY,
  page_id                         TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  account_id                      TEXT NOT NULL REFERENCES sync_account(id) ON DELETE CASCADE,
  provider                        TEXT NOT NULL,  -- denorm hint; values as sync_account.provider (no CHECK — see there)
  calendar_id                     TEXT NOT NULL,  -- denorm hint, kept on detach
  external_id                     TEXT NOT NULL,  -- CalDAV href / Google event id (NOT the ICS UID)
  ical_uid                        TEXT NOT NULL,  -- RFC 5545 UID; same-calendar re-link only
  etag                            TEXT,           -- change detection; reconciler no-ops on unchanged etag
  sync_state                      TEXT NOT NULL DEFAULT 'active'
  CHECK (sync_state IN ('active', 'detached', 'tombstoned')),
  user_modified                   INTEGER NOT NULL DEFAULT 0,  -- ownership signal; ONLY the editor path sets it
  seeded_description_hash         TEXT,           -- hash of pages.content_text as last written by sync
  seeded_description_hash_version INTEGER,        -- content_text projection version; lets a projection change re-seed rather than mis-classify
  mirror_location                 TEXT,           -- calendar-owned, rendered read-only
  mirror_attendees                TEXT,           -- JSON; calendar-owned, rendered read-only
  -- Upstream description change withheld because the user already edited the body.
  -- The reconciler parks the new (projected) text here instead of clobbering; drives
  -- the editor's passive "calendar description changed" notice (rendered offline, no
  -- re-fetch). NULL = nothing pending; cleared on silent refresh or when upstream
  -- matches the body again.
  pending_description             TEXT,
  last_synced_at                  TEXT,
  created_at                      TEXT NOT NULL
);

-- Structural dedup — an event maps to at most ONE page per calendar (kills the
-- TickTick "duplicate events" gripe). Deliberately NOT scoped wider: the same
-- meeting on two calendars is two resources (one per calendar) and should appear
-- once in each folder.
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_sync_identity
  ON page_sync(account_id, calendar_id, external_id);

-- Re-link lookup: find a dormant/detached page by UID within its own calendar.
-- Non-unique on purpose (a misbehaving server could emit two hrefs sharing a UID
-- in one calendar; the UNIQUE above on external_id still holds the dedup line).
CREATE INDEX IF NOT EXISTS idx_page_sync_relink
  ON page_sync(account_id, calendar_id, ical_uid);

-- ─── folders: system-folder flag ──────────────────────────────────────────────
-- No special-folder concept existed before. Each synced calendar gets one
-- system-managed folder flagged here. Drives the placement lock (pages can't be
-- moved into or out of these folders, guarded in update_page_impl) and the
-- separate sidebar area. Existing folders default to 0 (regular).
ALTER TABLE folders ADD COLUMN is_external_calendar INTEGER NOT NULL DEFAULT 0;
