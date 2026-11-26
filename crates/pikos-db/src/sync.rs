//! Row structs for the calendar sync tables. No writers, network or Tauri here; serialized
//! output DTOs come with the command layer, as with `FolderRow` and `Folder`.

/// The `sync_account.provider` tags: an open set validated app-side, with no DB CHECK.
pub const PROVIDER_CALDAV: &str = "caldav";
pub const PROVIDER_GOOGLE: &str = "google";

/// How far back a backfill reaches, so a mid-week connect still pulls events already past.
/// It bounds what is fetched only; the head and render floors anchor on the connect day (see
/// `recurrence_derive::synced_head_floor`, `Page::synced_since`).
pub const BACKFILL_DAYS: i64 = 7;

/// `page_sync.created_at` (UTC) as the local calendar day it fell on. Slicing the date prefix
/// is wrong for much of each day off-UTC: an evening connect west of UTC reads as tomorrow and
/// skips an occurrence. The head floor and the render floor both key on this.
pub fn local_day_of(utc_iso: &str) -> Option<String> {
    let utc = utc_iso.parse::<chrono::DateTime<chrono::Utc>>().ok()?;
    Some(
        utc.with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// The local calendar day a page's schedule falls on **for the person looking at
/// it**.
///
/// A synced timed event is absolute: source-zone wall-clock plus the zone, one instant that
/// lands on the viewer's day. Slicing the date prefix gives the source's day, so a Tokyo
/// morning reads as tomorrow in California and drops out of Today while its calendar block
/// sits on today's grid.
///
/// Everything else keeps its own date: native and detached pages float with no zone, and an
/// all-day value has none to convert from.
pub fn viewer_day_of(scheduled_start: &str, timezone: Option<&str>) -> String {
    viewer_wall_clock(scheduled_start, timezone)
        .chars()
        .take(10)
        .collect()
}

/// A schedule's start on the viewer's clock, by the same rule as [`viewer_day_of`]:
/// a zoned timed start converted from its source zone, anything else as stored.
pub fn viewer_wall_clock(scheduled_start: &str, timezone: Option<&str>) -> String {
    timezone
        .and_then(|tz| tz.parse::<chrono_tz::Tz>().ok())
        .and_then(|source| {
            crate::reconciler::to_device_wall_clock(
                scheduled_start,
                source,
                crate::pool::device_zone(),
            )
        })
        .unwrap_or_else(|| scheduled_start.to_string())
}

/// A `sync_account` row. Secrets aren't here, only a handle: `auth_kind` and the row id as
/// the keychain key.
#[derive(Debug, sqlx::FromRow)]
pub struct SyncAccountRow {
    pub id: String,
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

/// A `sync_calendar` row: per-calendar config and incremental cursors. `enabled` is the
/// opt-in, off by default.
#[derive(Debug, sqlx::FromRow)]
pub struct SyncCalendarRow {
    pub id: String,
    pub account_id: String,
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
    /// Last poll that completed, incremental or full, for the stale dot. `None` until the first sync.
    pub last_synced_at: Option<String>,
    /// `None` while disabled.
    pub folder_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A `page_sync` row linking a page to its source event, one per series. `external_id` is
/// the dedup identity; `ical_uid` only re-links a dormant or detached page on the same
/// calendar.
#[derive(Debug, sqlx::FromRow)]
pub struct PageSyncRow {
    pub id: String,
    pub page_id: String,
    pub account_id: String,
    /// Denorm hint, kept on detach — matches the account's provider.
    pub provider: String,
    pub calendar_id: String,
    /// CalDAV resource href or Google event id, not the ICS UID.
    pub external_id: String,
    /// RFC 5545 UID — same-calendar re-link only.
    pub ical_uid: String,
    /// Provider etag / CalDAV getetag; reconciler no-ops on unchanged etag.
    pub etag: Option<String>,
    /// 'active' | 'detached' | 'tombstoned'.
    pub sync_state: String,
    /// Ownership signal, set only by the editor command path, never by sync.
    pub user_modified: bool,
    /// Hash of `pages.content_text` as last written by sync (seeded description).
    pub seeded_description_hash: Option<String>,
    /// The `content_text` projection version behind the hash, so a projection change re-seeds
    /// instead of mis-classifying the corpus.
    pub seeded_description_hash_version: Option<i64>,
    pub mirror_location: Option<String>,
    /// JSON.
    pub mirror_attendees: Option<String>,
    /// Upstream description change withheld because the user edited the body.
    /// NULL = nothing pending; non-NULL drives the editor's passive notice.
    pub pending_description: Option<String>,
    pub last_synced_at: Option<String>,
    pub created_at: String,
}

// The locked-mirror guard holds for every command-layer writer, UI and CLI. Sync's own
// writes use raw SQL and bypass it.

/// User-facing message when a writer rejects an edit to a synced page's locked
/// mirror (title / schedule / recurrence).
pub(crate) const SYNCED_READONLY_MSG: &str =
    "This event is synced from an external calendar — its title and schedule are read-only.";

/// Message when a writer rejects moving a still-synced page out of its calendar folder.
/// Separate from [`SYNCED_READONLY_MSG`] because placement isn't part of the locked mirror and
/// frees on detach.
pub(crate) const SYNCED_PLACEMENT_MSG: &str =
    "This event is synced from an external calendar — it stays in its calendar folder.";

/// SQL boolean over `pages p` joined to `page_sync ps`. Pikos-owned means the user has
/// invested in the page, so teardown keeps it and an export ships it: it is completed, the
/// dirty bit is set, or it carries a field sync never writes (a user tag or reminder, or a
/// non-empty completed-set or skip-set). The row checks back up the dirty bit, so the
/// predicate stays correct if a future edit path forgets to set it. `last_opened_at` is no
/// signal: reading isn't authoring. Without the set checks a series whose only investment is
/// completed or skipped occurrences would hard-delete on upstream removal, losing that history
/// and resurrecting dismissed occurrences on reconnect.
pub(crate) const PAGE_OWNED_SQL: &str = "p.completed_at IS NOT NULL
      OR ps.user_modified
      OR (p.tags <> '[]' AND p.tags <> '')
      OR EXISTS (SELECT 1 FROM page_reminders pr WHERE pr.page_id = p.id)
      OR EXISTS (SELECT 1 FROM completed_set cs WHERE cs.page_id = p.id)
      OR EXISTS (SELECT 1 FROM skip_set ss WHERE ss.page_id = p.id)";

/// SQL boolean over an outer `pages p`, true for a live mirror carrying none of the user's
/// work. Negate it to keep a query to the user's own pages. A detached page never matches.
pub fn unactioned_mirror_sql() -> String {
    format!(
        "EXISTS (SELECT 1 FROM page_sync ps
                  WHERE ps.page_id = p.id AND ps.sync_state = 'active'
                    AND NOT ({PAGE_OWNED_SQL}))"
    )
}

/// True when an active `page_sync` row owns this page, locking its schedule.
pub(crate) async fn page_schedule_locked(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> crate::error::AppResult<bool> {
    let mut conn = pool.acquire().await?;
    page_schedule_locked_conn(&mut conn, page_id).await
}

/// [`page_schedule_locked`] on the caller's connection, to read the same snapshot as the
/// write it gates.
pub(crate) async fn page_schedule_locked_conn(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> crate::error::AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM page_sync WHERE page_id = ? AND sync_state = 'active')",
    )
    .bind(page_id)
    .fetch_one(&mut *conn)
    .await?)
}

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

/// True when destroying this page would let the next poll re-create it: any `page_sync` row
/// that isn't `detached`. Broader than [`page_schedule_locked`]: a tombstoned mirror is
/// unlocked, but the FK cascade takes its tombstone with the page and the event comes back.
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
