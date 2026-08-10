//! External calendar sync — row structs.
//!
//! The `010_calendar_sync.sql` tables mapped to Rust row structs. The reconciler,
//! providers, and Tauri command layer build their IO/output types and `*_impl`
//! writers on top of these. No writers, network, or Tauri here. Serialized
//! output DTOs (camelCase, for Tauri) come with the command layer, matching the
//! `FolderRow`→`Folder` split elsewhere in the crate.

/// The `sync_account.provider` tags. An open set validated app-side (no DB
/// CHECK), so the stored strings live here rather than as literals per call site.
pub const PROVIDER_CALDAV: &str = "caldav";
pub const PROVIDER_GOOGLE: &str = "google";

/// How far back a backfill reaches, so a calendar connected mid-week still renders
/// the days already past. These occurrences are deliberately below the head floor
/// (`recurrence_derive::synced_head_floor`) — they render, but predate the user and
/// can't open a series as overdue.
pub const BACKFILL_DAYS: i64 = 7;

/// `page_sync.created_at` (UTC) → the local calendar day it fell on.
///
/// Slicing the date prefix instead lands on the wrong day for much of every day
/// off-UTC: an evening connect west of UTC would read as tomorrow, skipping a
/// whole occurrence. Both the head floor and the render floor key on this, so it
/// resolves once here rather than in each.
pub fn local_day_of(utc_iso: &str) -> Option<String> {
    let utc = utc_iso.parse::<chrono::DateTime<chrono::Utc>>().ok()?;
    Some(
        utc.with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// `sync_account` row — one connected account. Secrets are NOT here; only a
/// stable handle (`auth_kind` + the row id as the keychain key).
#[derive(Debug, sqlx::FromRow)]
pub struct SyncAccountRow {
    pub id: String,
    /// One of [`PROVIDER_CALDAV`] / [`PROVIDER_GOOGLE`].
    pub provider: String,
    pub display_name: String,
    /// 'basic' (CalDAV app password) | 'oauth' (Google)
    pub auth_kind: String,
    /// Credentials were rejected on a poll; the background scheduler skips this
    /// account until a manual resync succeeds and clears it.
    pub reconnect_needed: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// `sync_calendar` row — per-calendar config + incremental cursors. `enabled` is
/// the per-calendar opt-in (off by default).
#[derive(Debug, sqlx::FromRow)]
pub struct SyncCalendarRow {
    pub id: String,
    pub account_id: String,
    /// Provider's calendar identifier.
    pub calendar_id: String,
    pub display_name: String,
    /// Pikos palette colour (not provider hex).
    pub color: Option<String>,
    pub enabled: bool,
    /// Google syncToken / CalDAV sync-token.
    pub sync_token: Option<String>,
    /// CalDAV change tag (no-sync-collection fallback).
    pub ctag: Option<String>,
    pub last_full_sync_at: Option<String>,
    /// Last poll that completed (incremental or full) — the engine stamps it for
    /// the stale dot. `None` until the first sync.
    pub last_synced_at: Option<String>,
    /// The calendar's system folder; `None` while disabled.
    pub folder_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `page_sync` row — links a Pikos page to its source event. One row per series.
///
/// `external_id` is the dedup identity; `ical_uid` only re-links a
/// dormant/detached page on the same calendar.
#[derive(Debug, sqlx::FromRow)]
pub struct PageSyncRow {
    pub id: String,
    pub page_id: String,
    pub account_id: String,
    /// Denorm hint, kept on detach — matches the account's provider.
    pub provider: String,
    pub calendar_id: String,
    /// CalDAV resource href / Google event id (NOT the ICS UID).
    pub external_id: String,
    /// RFC 5545 UID — same-calendar re-link only.
    pub ical_uid: String,
    /// Provider etag / CalDAV getetag; reconciler no-ops on unchanged etag.
    pub etag: Option<String>,
    /// 'active' | 'detached' | 'tombstoned'.
    pub sync_state: String,
    /// Ownership signal — set ONLY by the editor command path, never by sync.
    pub user_modified: bool,
    /// Hash of `pages.content_text` as last written by sync (seeded description).
    pub seeded_description_hash: Option<String>,
    /// `content_text` projection version that produced the hash — lets a
    /// projection change re-seed instead of mis-classifying the whole corpus.
    pub seeded_description_hash_version: Option<i64>,
    /// Calendar-owned metadata, rendered read-only.
    pub mirror_location: Option<String>,
    /// JSON; calendar-owned metadata, rendered read-only.
    pub mirror_attendees: Option<String>,
    /// Upstream description change withheld because the user edited the body.
    /// NULL = nothing pending; non-NULL drives the editor's passive notice.
    pub pending_description: Option<String>,
    pub last_synced_at: Option<String>,
    pub created_at: String,
}

// ─── Sync-state predicates (shared by the writers and the CLI) ────────────────
//
// Backs the locked-mirror guard so the same invariant holds for every
// command-layer writer (UI and CLI alike). Sync's own writes use raw SQL and
// bypass these guarded commands, so seeding is unaffected.

/// User-facing message when a writer rejects an edit to a synced page's locked
/// mirror (title / schedule / recurrence).
pub(crate) const SYNCED_READONLY_MSG: &str =
    "This event is synced from an external calendar — its title and schedule are read-only.";

/// User-facing message when a writer rejects moving a still-synced page out of
/// its calendar folder. Separate from [`SYNCED_READONLY_MSG`] because placement
/// isn't part of the locked mirror — it comes back the moment the page detaches.
pub(crate) const SYNCED_PLACEMENT_MSG: &str =
    "This event is synced from an external calendar — it stays in its calendar folder.";

/// True when an active `page_sync` row owns this page (its schedule is locked).
/// Detached/tombstoned pages are unlocked.
pub(crate) async fn page_schedule_locked(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> crate::error::AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM page_sync WHERE page_id = ? AND sync_state = 'active')",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await?)
}

/// Reject a locked-mirror edit on a synced page. No-op for native pages.
pub(crate) async fn ensure_page_schedule_unlocked(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> crate::error::AppResult<()> {
    if page_schedule_locked(pool, page_id).await? {
        return Err(crate::error::AppError::Conflict(
            SYNCED_READONLY_MSG.to_string(),
        ));
    }
    Ok(())
}

/// True when destroying this page would let the next poll re-create it: any
/// `page_sync` row that isn't `detached`. Deliberately broader than
/// [`page_schedule_locked`] — a tombstoned mirror is unlocked, but the FK cascade
/// takes its tombstone along with the page, so the suppression dies with it and
/// the event comes back.
pub async fn hard_delete_would_resurrect(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> crate::error::AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM page_sync WHERE page_id = ? AND sync_state <> 'detached')",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await?)
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod sync_tests;
