//! External calendar sync — row structs.
//!
//! The `010_calendar_sync.sql` tables mapped to Rust row structs. The reconciler,
//! providers, and Tauri command layer build their IO/output types and `*_impl`
//! writers on top of these. No writers, network, or Tauri here. Serialized
//! output DTOs (camelCase, for Tauri) come with the command layer, matching the
//! `FolderRow`→`Folder` split elsewhere in the crate.

/// `sync_account` row — one connected account. Secrets are NOT here; only a
/// stable handle (`auth_kind` + the row id as the keychain key).
#[derive(Debug, sqlx::FromRow)]
pub struct SyncAccountRow {
    pub id: String,
    /// e.g. 'google', 'caldav' — open set, validated app-side (no DB CHECK).
    pub provider: String,
    pub display_name: String,
    /// 'basic' (CalDAV app password) | 'oauth' (Google)
    pub auth_kind: String,
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
    /// Stored 0/1 in SQLite.
    pub enabled: bool,
    /// Google syncToken / CalDAV sync-token.
    pub sync_token: Option<String>,
    /// CalDAV change tag (no-sync-collection fallback).
    pub ctag: Option<String>,
    pub last_full_sync_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `page_sync` row — links a Pikos page to its source event. One row per series.
///
/// `external_id` is the dedup identity (CalDAV href / Google event id, NOT the
/// ICS UID). `ical_uid` is used only for same-calendar re-link of a
/// dormant/detached page. `sync_state` is 'active' | 'detached' | 'tombstoned'.
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

#[cfg(test)]
#[path = "sync_tests.rs"]
mod sync_tests;
