//! Sync-settings orchestration — the networked half of the Calendar Sync panel's
//! commands. Pairs `pikos-db`'s pure account/calendar writers with the keychain,
//! the provider's autodiscovery, and the poll engine. The desktop command shims
//! are thin wrappers over these; the CLI never calls them (sync is desktop-only).

use serde::Serialize;
use sqlx::SqlitePool;

use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_commands::{
    delete_sync_account_impl, insert_sync_account_impl, list_sync_calendars_impl,
    upsert_sync_calendar_impl, AccountWithCalendars,
};
use pikos_db::reconciler::teardown_calendar;
use pikos_db::sync_delta::CalendarProvider;

use crate::caldav::{CaldavCredentials, CaldavProvider};
use crate::engine::{sync_calendar, SyncOutcome};
use crate::keychain::Keychain;

/// One calendar's resync result, flattened for the frontend status display.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncResult {
    pub calendar_id: String,
    /// `synced` | `offline` | `reconnectNeeded`.
    pub status: String,
    pub full_resync: bool,
    /// The poll's delta carried items — the scheduler's page-data-changed signal.
    #[serde(skip)]
    pub changed: bool,
}

impl CalendarSyncResult {
    fn new(calendar_id: &str, outcome: SyncOutcome) -> Self {
        let (status, full_resync, changed) = match outcome {
            SyncOutcome::Synced { full_resync, changed } => ("synced", full_resync, changed),
            SyncOutcome::Offline => ("offline", false, false),
            SyncOutcome::ReconnectNeeded => ("reconnectNeeded", false, false),
        };
        Self {
            calendar_id: calendar_id.to_string(),
            status: status.to_string(),
            full_resync,
            changed,
        }
    }
}

/// Connect a CalDAV account: validate the credentials by discovering calendars,
/// then persist the account + its (disabled) calendars and stash the credentials
/// in the keychain. Validation runs **first** so a wrong URL/password fails
/// without leaving a half-built account behind.
pub async fn connect_caldav(
    pool: &SqlitePool,
    keychain: Keychain,
    base_url: String,
    username: String,
    password: String,
    display_name: String,
) -> AppResult<AccountWithCalendars> {
    let creds = CaldavCredentials { base_url, username, password };
    let remote = CaldavProvider::discover_with(&creds).await?;
    let blob = creds
        .to_blob()
        .map_err(|e| AppError::Internal(format!("serialize credentials: {e}")))?;

    let account = insert_sync_account_impl(pool, "caldav", &display_name, "basic").await?;
    keychain
        .store(&account.id, &blob)
        .map_err(|e| AppError::Internal(format!("keychain store: {e}")))?;

    let mut calendars = Vec::with_capacity(remote.len());
    for rc in &remote {
        calendars.push(
            upsert_sync_calendar_impl(
                pool,
                &account.id,
                &rc.calendar_id,
                &rc.display_name,
                rc.color.as_deref(),
            )
            .await?,
        );
    }
    Ok(AccountWithCalendars { account, calendars })
}

/// Disconnect an account: tear down each calendar's folder + pages (detach owned,
/// delete bare mirrors), drop the account row (cascading the rest), and clear the
/// keychain. The credential delete is idempotent and best-effort — a keychain
/// hiccup must not block removing the account from the DB.
pub async fn disconnect_account(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
) -> AppResult<()> {
    for cal in list_sync_calendars_impl(pool, account_id).await? {
        if let Some(folder_id) = &cal.folder_id {
            teardown_calendar(pool, &cal.account_id, &cal.calendar_id, folder_id).await?;
        }
    }
    delete_sync_account_impl(pool, account_id).await?;
    let _ = keychain.delete(account_id);
    Ok(())
}

/// Resync every enabled calendar on an account through the poll engine. Generic
/// over the provider so the caller constructs the right one (CalDAV today) and
/// tests inject a scripted one. Per-calendar transport/credential failures surface
/// as `offline`/`reconnectNeeded` results rather than aborting the whole account.
pub async fn resync_account<P: CalendarProvider>(
    pool: &SqlitePool,
    provider: &P,
    account_id: &str,
) -> AppResult<Vec<CalendarSyncResult>> {
    let account = load_account_row(pool, account_id).await?;
    let calendars = load_enabled_calendar_rows(pool, account_id).await?;

    let mut results = Vec::with_capacity(calendars.len());
    for cal in &calendars {
        let Some(folder_id) = cal.folder_id.clone() else {
            continue;
        };
        let outcome = sync_calendar(pool, provider, &account, cal, &folder_id).await?;
        results.push(CalendarSyncResult::new(&cal.calendar_id, outcome));
    }
    Ok(results)
}

async fn load_account_row(pool: &SqlitePool, account_id: &str) -> AppResult<SyncAccountRow> {
    sqlx::query_as::<_, SyncAccountRow>("SELECT * FROM sync_account WHERE id = ?")
        .bind(account_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("sync account not found: {account_id}")))
}

async fn load_enabled_calendar_rows(
    pool: &SqlitePool,
    account_id: &str,
) -> AppResult<Vec<SyncCalendarRow>> {
    Ok(
        sqlx::query_as::<_, SyncCalendarRow>(
            "SELECT * FROM sync_calendar WHERE account_id = ? AND enabled = 1",
        )
        .bind(account_id)
        .fetch_all(pool)
        .await?,
    )
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod commands_tests;
