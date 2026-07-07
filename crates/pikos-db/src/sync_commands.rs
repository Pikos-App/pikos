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
}

/// One account plus its calendars — the panel's account-centric read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWithCalendars {
    #[serde(flatten)]
    pub account: SyncAccount,
    pub calendars: Vec<SyncCalendar>,
}

const CAL_COLS: &str =
    "id, account_id, calendar_id, display_name, color, enabled, last_synced_at, folder_id";

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
    fetch_account(pool, &id).await
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

/// Find a dormant account to reuse on reconnect, matched by the stable
/// provider+display_name identity (`display_name` embeds `username · base_url`).
pub async fn find_dormant_account_impl(
    pool: &sqlx::SqlitePool,
    provider: &str,
    display_name: &str,
) -> AppResult<Option<SyncAccount>> {
    Ok(sqlx::query_as::<_, SyncAccount>(
        "SELECT id, provider, display_name, auth_kind, created_at FROM sync_account
         WHERE provider = ? AND display_name = ? AND disconnected = 1 LIMIT 1",
    )
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
    let accounts = sqlx::query_as::<_, SyncAccount>(
        "SELECT id, provider, display_name, auth_kind, created_at
         FROM sync_account WHERE disconnected = 0 ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(accounts.len());
    for account in accounts {
        let calendars = list_sync_calendars_impl(pool, &account.id).await?;
        out.push(AccountWithCalendars { account, calendars });
    }
    Ok(out)
}

async fn fetch_account(pool: &sqlx::SqlitePool, id: &str) -> AppResult<SyncAccount> {
    sqlx::query_as::<_, SyncAccount>(
        "SELECT id, provider, display_name, auth_kind, created_at FROM sync_account WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("sync account not found: {id}")))
}

// ─── calendars ──────────────────────────────────────────────────────────────────

/// Persist a discovered calendar (disabled, no folder). Idempotent on
/// `(account_id, calendar_id)`: a re-discovery refreshes only the display name,
/// leaving the user's enable/colour/cursor untouched.
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
           display_name = excluded.display_name, updated_at = excluded.updated_at",
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
    fetch_calendar_by_keys(pool, account_id, calendar_id).await
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

/// Materialize the calendar's system folder (creating it, or re-flagging the one a
/// prior disable de-flagged) and mark the calendar enabled. The actual backfill is
/// the engine's job on the next resync/poll.
async fn enable_sync_calendar(
    pool: &sqlx::SqlitePool,
    sync_calendar_id: &str,
    color: Option<&str>,
) -> AppResult<SyncCalendar> {
    let cal = fetch_calendar(pool, sync_calendar_id).await?;
    let now = now_iso();
    let mut tx = pool.begin().await?;

    let folder_id = match &cal.folder_id {
        // Re-enable: the de-flagged folder still exists → re-flag it in place so its
        // surviving owned pages rejoin a live sync folder.
        Some(fid)
            if folder_exists(&mut tx, fid).await? =>
        {
            sqlx::query("UPDATE folders SET is_external_calendar = 1, color = ?, updated_at = ? WHERE id = ?")
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
    fetch_calendar(pool, sync_calendar_id).await
}

/// Tear the calendar down (detach owned pages / delete bare mirrors, remove or
/// de-flag the folder) and clear the cursor so a later re-enable backfills fresh.
async fn disable_sync_calendar(
    pool: &sqlx::SqlitePool,
    sync_calendar_id: &str,
) -> AppResult<SyncCalendar> {
    let cal = fetch_calendar(pool, sync_calendar_id).await?;
    if let Some(folder_id) = &cal.folder_id {
        teardown_calendar(pool, &cal.account_id, &cal.calendar_id, folder_id).await?;
    }

    // teardown may have deleted the folder (no survivors) or de-flagged it (owned
    // survivors); keep the link only while the folder still exists.
    let folder_id = match &cal.folder_id {
        Some(fid) if folder_exists_pool(pool, fid).await? => Some(fid.clone()),
        _ => None,
    };
    sqlx::query(
        "UPDATE sync_calendar
         SET enabled = 0, folder_id = ?, sync_token = NULL, ctag = NULL,
             last_full_sync_at = NULL, last_synced_at = NULL, updated_at = ?
         WHERE id = ?",
    )
    .bind(&folder_id)
    .bind(now_iso())
    .bind(&cal.id)
    .execute(pool)
    .await?;
    fetch_calendar(pool, sync_calendar_id).await
}

// ─── internal ───────────────────────────────────────────────────────────────────

async fn create_external_folder(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    name: &str,
    color: Option<&str>,
    now: &str,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let sort_order: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sort_order) + 1, 0) FROM folders")
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
