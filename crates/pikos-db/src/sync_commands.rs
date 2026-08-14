//! Sync-settings writers + DTOs — the account/calendar CRUD behind the Calendar
//! Sync panel. Pure SQLite: the networked orchestration (autodiscovery, keychain,
//! the poll engine) lives in `pikos-calendar-sync` and calls these. Kept here so
//! the schema, row structs, and reconciler teardown stay co-located.

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::now_iso;
use crate::reconciler::teardown_calendar;

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SyncAccount {
    pub id: String,
    pub provider: String,
    pub display_name: String,
    pub auth_kind: String,
    pub created_at: String,
    /// Set when a poll hits a rejected credential, and the scheduler then skips the
    /// account entirely — so the panel must surface it, or a background rejection is
    /// invisible until someone resyncs by hand.
    pub reconnect_needed: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SyncCalendar {
    pub id: String,
    pub account_id: String,
    pub calendar_id: String,
    pub display_name: String,
    pub color: Option<String>,
    pub enabled: bool,
    pub last_synced_at: Option<String>,
    pub folder_id: Option<String>,
    /// Pages this calendar left behind when it was unsynced — owned, so teardown
    /// detached them instead of deleting. Derived, not stored. Re-enabling re-links
    /// them and overwrites their mirror fields, so the panel confirms first; a zero
    /// here means there is nothing to warn about and the toggle stays instant.
    pub detached_pages: i64,
}

/// One account plus its calendars — the panel's account-centric read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWithCalendars {
    #[serde(flatten)]
    pub account: SyncAccount,
    pub calendars: Vec<SyncCalendar>,
}

const ACCOUNT_COLS: &str = "id, provider, display_name, auth_kind, created_at, reconnect_needed";

const CAL_COLS: &str = "id, account_id, calendar_id, display_name, color, enabled, \
     last_synced_at, folder_id, \
     (SELECT COUNT(*) FROM page_sync ps \
        WHERE ps.account_id = sync_calendar.account_id \
          AND ps.calendar_id = sync_calendar.calendar_id \
          AND ps.sync_state = 'detached') AS detached_pages";

// ─── accounts ───────────────────────────────────────────────────────────────────

pub async fn insert_sync_account_impl(
    pool: &sqlx::SqlitePool,
    provider: &str,
    display_name: &str,
    auth_kind: &str,
) -> AppResult<SyncAccount> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(provider)
    .bind(display_name)
    .bind(auth_kind)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    get_sync_account_impl(pool, &id).await
}

/// Mark an account dormant (disconnected) rather than deleting it, so its calendars
/// and detached `page_sync` rows survive for a later reconnect to re-link. Clears
/// `reconnect_needed` — a dormant account isn't polled (its calendars are disabled),
/// so the stale-credential flag no longer applies.
pub async fn mark_account_disconnected_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE sync_account SET disconnected = 1, reconnect_needed = 0, updated_at = ? WHERE id = ?",
    )
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Find an existing account to reuse on (re)connect, matched by the stable
/// provider+display_name identity (`display_name` embeds `username · base_url` for
/// CalDAV, the signed-in email for Google). Matches whether the row is dormant *or*
/// still active: reconnecting an already-connected account must refresh it in place,
/// never insert a second row — a duplicate account re-syncs every event twice (dedup
/// is per-account). An active row wins the tiebreak in the unlikely event both exist.
pub async fn find_account_by_identity_impl(
    pool: &sqlx::SqlitePool,
    provider: &str,
    display_name: &str,
) -> AppResult<Option<SyncAccount>> {
    let sql = format!(
        "SELECT {ACCOUNT_COLS} FROM sync_account
         WHERE provider = ? AND display_name = ?
         ORDER BY disconnected ASC, created_at ASC LIMIT 1"
    );
    Ok(sqlx::query_as::<_, SyncAccount>(&sql)
        .bind(provider)
        .bind(display_name)
        .fetch_optional(pool)
        .await?)
}

/// Clear the dormant flag when a reconnect reuses the account.
pub async fn reactivate_account_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE sync_account SET disconnected = 0, reconnect_needed = 0, updated_at = ? WHERE id = ?",
    )
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_sync_status_impl(pool: &sqlx::SqlitePool) -> AppResult<Vec<AccountWithCalendars>> {
    // Dormant (disconnected) accounts are hidden — disconnect reads as removal in
    // the panel even though the row survives for reconnect re-link.
    let sql = format!(
        "SELECT {ACCOUNT_COLS} FROM sync_account WHERE disconnected = 0 ORDER BY created_at ASC"
    );
    let accounts = sqlx::query_as::<_, SyncAccount>(&sql)
        .fetch_all(pool)
        .await?;

    let mut out = Vec::with_capacity(accounts.len());
    for account in accounts {
        let calendars = list_sync_calendars_impl(pool, &account.id).await?;
        out.push(AccountWithCalendars { account, calendars });
    }
    Ok(out)
}

pub async fn get_sync_account_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<SyncAccount> {
    let sql = format!("SELECT {ACCOUNT_COLS} FROM sync_account WHERE id = ?");
    sqlx::query_as::<_, SyncAccount>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("sync account not found: {id}")))
}

// ─── calendars ──────────────────────────────────────────────────────────────────

/// Persist a discovered calendar (disabled, no folder). Idempotent on
/// `(account_id, calendar_id)`: a re-discovery refreshes the display name and —
/// unless the user has picked one — the colour, leaving enable state and cursor
/// untouched. Growing this `ON CONFLICT` set is how a reconnect silently disables
/// every calendar or resets its cursor, so add a column here only deliberately.
/// Both refreshed fields then flow onto the calendar's folder, which holds a
/// derived copy rather than a second truth.
pub async fn upsert_sync_calendar_impl(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    calendar_id: &str,
    display_name: &str,
    color: Option<&str>,
) -> AppResult<SyncCalendar> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_calendar
           (id, account_id, calendar_id, display_name, color, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (account_id, calendar_id) DO UPDATE SET
           display_name = excluded.display_name,
           color = CASE WHEN color_user_set = 1
                        THEN color
                        ELSE COALESCE(excluded.color, color) END,
           updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(account_id)
    .bind(calendar_id)
    .bind(display_name)
    .bind(color)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    let cal = fetch_calendar_by_keys(pool, account_id, calendar_id).await?;
    if let Some(folder_id) = &cal.folder_id {
        reconcile_folder_to_calendar(pool, folder_id, &cal.display_name, cal.color.as_deref())
            .await?;
    }
    Ok(cal)
}

pub async fn list_sync_calendars_impl(
    pool: &sqlx::SqlitePool,
    account_id: &str,
) -> AppResult<Vec<SyncCalendar>> {
    let sql = format!(
        "SELECT {CAL_COLS} FROM sync_calendar WHERE account_id = ? ORDER BY display_name ASC"
    );
    Ok(sqlx::query_as::<_, SyncCalendar>(&sql)
        .bind(account_id)
        .fetch_all(pool)
        .await?)
}

/// Enabling materializes/re-flags its folder + sets the colour; disabling tears it
/// down.
pub async fn toggle_sync_calendar_impl(
    pool: &sqlx::SqlitePool,
    sync_calendar_id: &str,
    enabled: bool,
    color: Option<&str>,
) -> AppResult<SyncCalendar> {
    if enabled {
        enable_sync_calendar(pool, sync_calendar_id, color).await
    } else {
        disable_sync_calendar(pool, sync_calendar_id).await
    }
}

/// Discard every enabled calendar's cursor on an account, so the next poll
/// re-enumerates the whole backfill window instead of polling from where it left
/// off. Backs the panel's full-refresh action; a disabled calendar has no cursor
/// to clear (disable already did).
///
/// `last_full_sync_at` is deliberately left alone: it clocks the engine's own
/// periodic re-enumerate, and the poll this precedes restamps it anyway.
pub async fn clear_sync_cursors_impl(pool: &sqlx::SqlitePool, account_id: &str) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        sqlx::query(
            "UPDATE sync_calendar SET sync_token = NULL, ctag = NULL, updated_at = ?
             WHERE account_id = ? AND enabled = 1",
        )
        .bind(now_iso())
        .bind(account_id)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

/// Record a colour the **user** picked, from either surface — latching
/// `color_user_set` (see the column) and repainting the folder to match.
pub async fn set_sync_calendar_color_impl(
    pool: &sqlx::SqlitePool,
    sync_calendar_id: &str,
    color: &str,
) -> AppResult<SyncCalendar> {
    let cal = fetch_calendar(pool, sync_calendar_id).await?;
    crate::tx::retry_on_busy(|| async {
        sqlx::query(
            "UPDATE sync_calendar SET color = ?, color_user_set = 1, updated_at = ? WHERE id = ?",
        )
        .bind(color)
        .bind(now_iso())
        .bind(&cal.id)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await?;
    if let Some(folder_id) = &cal.folder_id {
        reconcile_folder_to_calendar(pool, folder_id, &cal.display_name, Some(color)).await?;
    }
    fetch_calendar(pool, sync_calendar_id).await
}

/// Materialize the calendar's system folder (creating it, or re-flagging the one a
/// prior disable de-flagged) and mark the calendar enabled. The actual backfill is
/// the engine's job on the next resync/poll.
async fn enable_sync_calendar(
    pool: &sqlx::SqlitePool,
    sync_calendar_id: &str,
    color: Option<&str>,
) -> AppResult<SyncCalendar> {
    let cal = fetch_calendar(pool, sync_calendar_id).await?;
    crate::tx::retry_on_busy(|| async {
        let now = now_iso();
        let mut tx = pool.begin().await?;

        let folder_id = match &cal.folder_id {
            // Re-enable: the de-flagged folder still exists → re-flag it in place so its
            // surviving owned pages rejoin a live sync folder.
            Some(fid) if folder_exists(&mut tx, fid).await? => {
                sqlx::query("UPDATE folders SET is_external_calendar = 1, name = ?, color = ?, updated_at = ? WHERE id = ?")
                    .bind(&cal.display_name)
                    .bind(color)
                    .bind(&now)
                    .bind(fid)
                    .execute(&mut *tx)
                    .await?;
                fid.clone()
            }
            _ => create_external_folder(&mut tx, &cal.display_name, color, &now).await?,
        };

        sqlx::query(
            "UPDATE sync_calendar SET enabled = 1, color = ?, folder_id = ?, updated_at = ? WHERE id = ?",
        )
        .bind(color)
        .bind(&folder_id)
        .bind(&now)
        .bind(&cal.id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    })
    .await?;
    fetch_calendar(pool, sync_calendar_id).await
}

/// Tear the calendar down (detach owned pages / delete bare mirrors, remove or
/// de-flag the folder) and clear the cursor so a later re-enable backfills fresh.
///
/// Ordered so a failure anywhere after the first step leaves the calendar durably
/// off rather than live over half-severed mirrors: the poll loop selects on
/// `enabled`, so clearing it up front both excludes the scheduler and makes a
/// rerun of disable finish the job.
async fn disable_sync_calendar(
    pool: &sqlx::SqlitePool,
    sync_calendar_id: &str,
) -> AppResult<SyncCalendar> {
    let cal = fetch_calendar(pool, sync_calendar_id).await?;
    crate::tx::retry_on_busy(|| async {
        sqlx::query(
            "UPDATE sync_calendar
             SET enabled = 0, sync_token = NULL, ctag = NULL,
                 last_full_sync_at = NULL, last_synced_at = NULL, updated_at = ?
             WHERE id = ?",
        )
        .bind(now_iso())
        .bind(&cal.id)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await?;

    if let Some(folder_id) = &cal.folder_id {
        teardown_calendar(pool, &cal.account_id, &cal.calendar_id, folder_id).await?;
    }

    // teardown may have deleted the folder (no survivors) or de-flagged it (owned
    // survivors); keep the link only while the folder still exists.
    let folder_id = match &cal.folder_id {
        Some(fid) if folder_exists_pool(pool, fid).await? => Some(fid.clone()),
        _ => None,
    };
    crate::tx::retry_on_busy(|| async {
        sqlx::query("UPDATE sync_calendar SET folder_id = ?, updated_at = ? WHERE id = ?")
            .bind(&folder_id)
            .bind(now_iso())
            .bind(&cal.id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await?;
    fetch_calendar(pool, sync_calendar_id).await
}

// ─── internal ───────────────────────────────────────────────────────────────────

/// Repaint an external folder from its calendar. Guarded on an actual difference:
/// every discovery pass calls this for every enabled calendar, and an
/// unconditional write would restamp `updated_at` on each one.
async fn reconcile_folder_to_calendar(
    pool: &sqlx::SqlitePool,
    folder_id: &str,
    name: &str,
    color: Option<&str>,
) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        sqlx::query(
            "UPDATE folders SET name = ?1, color = ?2, updated_at = ?3
             WHERE id = ?4 AND (name IS NOT ?1 OR color IS NOT ?2)",
        )
        .bind(name)
        .bind(color)
        .bind(now_iso())
        .bind(folder_id)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

async fn create_external_folder(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    name: &str,
    color: Option<&str>,
    now: &str,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let sort_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order) + 1, 0) FROM folders")
            .fetch_one(&mut **tx)
            .await
            .unwrap_or(0);
    sqlx::query(
        "INSERT INTO folders (id, name, sort_order, color, is_external_calendar, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(sort_order)
    .bind(color)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

async fn folder_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    folder_id: &str,
) -> AppResult<bool> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?)")
            .bind(folder_id)
            .fetch_one(&mut **tx)
            .await?
            != 0,
    )
}

async fn folder_exists_pool(pool: &sqlx::SqlitePool, folder_id: &str) -> AppResult<bool> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?)")
            .bind(folder_id)
            .fetch_one(pool)
            .await?
            != 0,
    )
}

async fn fetch_calendar(pool: &sqlx::SqlitePool, id: &str) -> AppResult<SyncCalendar> {
    let sql = format!("SELECT {CAL_COLS} FROM sync_calendar WHERE id = ?");
    sqlx::query_as::<_, SyncCalendar>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("sync calendar not found: {id}")))
}

async fn fetch_calendar_by_keys(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    calendar_id: &str,
) -> AppResult<SyncCalendar> {
    let sql =
        format!("SELECT {CAL_COLS} FROM sync_calendar WHERE account_id = ? AND calendar_id = ?");
    sqlx::query_as::<_, SyncCalendar>(&sql)
        .bind(account_id)
        .bind(calendar_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("sync calendar not found: {calendar_id}")))
}

#[cfg(test)]
#[path = "sync_commands_tests.rs"]
mod sync_commands_tests;
