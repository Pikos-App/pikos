//! Sync-settings orchestration — the networked half of the Calendar Sync panel's
//! commands. Pairs `pikos-db`'s pure account/calendar writers with the keychain,
//! the provider's autodiscovery, and the poll engine. The desktop command shims
//! are thin wrappers over these; the CLI never calls them (sync is desktop-only).

use serde::Serialize;
use sqlx::SqlitePool;

use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow, PROVIDER_CALDAV, PROVIDER_GOOGLE};
use pikos_db::sync_commands::{
    find_account_by_identity_impl, insert_sync_account_impl, list_sync_calendars_impl,
    mark_account_disconnected_impl, reactivate_account_impl, toggle_sync_calendar_impl,
    upsert_sync_calendar_impl, AccountWithCalendars,
};
use pikos_db::sync_delta::CalendarProvider;

use crate::caldav::{CaldavCredentials, CaldavProvider};
use crate::engine::{sync_calendar, SyncOutcome};
use crate::keychain::Keychain;
use crate::provider::AnyProvider;

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
            SyncOutcome::Synced {
                full_resync,
                changed,
            } => ("synced", full_resync, changed),
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
///
/// Reconnecting an account already known by (provider, display_name) — whether it
/// went dormant via `disconnect_account` or is still active — reuses its row rather
/// than inserting a duplicate: the dormant case re-links detached pages, the active
/// case avoids re-syncing every event twice. The idempotent calendar upsert refreshes
/// each calendar in place, leaving its enabled/folder/cursor untouched.
pub async fn connect_caldav(
    pool: &SqlitePool,
    keychain: Keychain,
    base_url: String,
    username: String,
    password: String,
    display_name: String,
) -> AppResult<AccountWithCalendars> {
    let creds = CaldavCredentials {
        base_url,
        username,
        password,
    };
    let remote = CaldavProvider::discover_with(&creds).await?;
    let blob = creds
        .to_blob()
        .map_err(|e| AppError::Internal(format!("serialize credentials: {e}")))?;

    let account = claim_account(pool, PROVIDER_CALDAV, &display_name, "basic").await?;
    keychain
        .store(&account.id, &blob)
        .map_err(|e| AppError::Internal(format!("keychain store: {e}")))?;

    let calendars = upsert_calendars(pool, &account.id, &remote).await?;
    Ok(AccountWithCalendars { account, calendars })
}

/// Connect a Google account: run the OAuth grant, label the account with the
/// primary calendar's id (the signed-in email), then persist it and its
/// (disabled) calendars. `open_browser` is handed the consent URL between binding
/// the loopback listener and waiting on it — Google's Desktop client type
/// requires a real browser, and opening one is the caller's concern.
///
/// Same reuse-by-identity as [`connect_caldav`]: reconnecting a known account —
/// dormant or active — refreshes its row instead of duplicating it.
pub async fn connect_google<F>(
    pool: &SqlitePool,
    keychain: Keychain,
    open_browser: F,
) -> AppResult<AccountWithCalendars>
where
    F: FnOnce(&str) -> AppResult<()>,
{
    let pending = crate::google::begin_authorization().await?;
    open_browser(pending.authorize_url())?;
    let credentials = pending.complete().await?;

    // Proves the grant actually reads calendars before anything is persisted —
    // the same validate-first order connect_caldav uses.
    let (remote, primary) = crate::google::GoogleProvider::list_with(&credentials).await?;
    let display_name = primary.unwrap_or_else(|| "Google Calendar".to_string());

    let account = claim_account(pool, PROVIDER_GOOGLE, &display_name, "oauth").await?;
    crate::google::store(&keychain, &account.id, &credentials)?;

    let calendars = upsert_calendars(pool, &account.id, &remote).await?;
    Ok(AccountWithCalendars { account, calendars })
}

/// Reuse an existing account row on (re)connect, else create one. Shared by both
/// connect paths so reconnect semantics can't drift between providers (see
/// [`connect_caldav`] for why reuse matters). Reactivate is idempotent, so it's a
/// no-op cost on an already-active row.
async fn claim_account(
    pool: &SqlitePool,
    provider: &str,
    display_name: &str,
    auth_kind: &str,
) -> AppResult<pikos_db::sync_commands::SyncAccount> {
    match find_account_by_identity_impl(pool, provider, display_name).await? {
        Some(existing) => {
            reactivate_account_impl(pool, &existing.id).await?;
            Ok(existing)
        }
        None => insert_sync_account_impl(pool, provider, display_name, auth_kind).await,
    }
}

async fn upsert_calendars(
    pool: &SqlitePool,
    account_id: &str,
    remote: &[pikos_db::sync_delta::RemoteCalendar],
) -> AppResult<Vec<pikos_db::sync_commands::SyncCalendar>> {
    let mut calendars = Vec::with_capacity(remote.len());
    for rc in remote {
        calendars.push(
            upsert_sync_calendar_impl(
                pool,
                account_id,
                &rc.calendar_id,
                &rc.display_name,
                rc.color.as_deref(),
            )
            .await?,
        );
    }
    Ok(calendars)
}

/// Disconnect an account: unsync each calendar (detach owned pages, delete bare
/// mirrors, disable + clear its cursor), then mark the account dormant and clear
/// the keychain. The row, its calendars, and the detached `page_sync` identities
/// are **kept** — a reconnect (`connect_caldav`) reuses them and re-links by
/// `ical_uid` with no duplicate, the same path a calendar unsync already uses.
/// An OAuth grant is handed back to the provider first, so the account also
/// disappears from the user's connected-apps list rather than lingering there
/// with a token Pikos has thrown away. Both the revoke and the credential delete
/// are best-effort and idempotent — neither may block going dormant.
pub async fn disconnect_account(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
) -> AppResult<()> {
    for cal in list_sync_calendars_impl(pool, account_id).await? {
        if cal.enabled {
            toggle_sync_calendar_impl(pool, &cal.id, false, None).await?;
        }
    }
    mark_account_disconnected_impl(pool, account_id).await?;
    if provider_of(pool, account_id).await?.as_deref() == Some(PROVIDER_GOOGLE) {
        if let Err(e) = crate::google::revoke(&keychain, account_id).await {
            log::warn!("sync: could not revoke the Google grant for {account_id}: {e}");
        }
    }
    let _ = keychain.delete(account_id);
    Ok(())
}

async fn provider_of(pool: &SqlitePool, account_id: &str) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT provider FROM sync_account WHERE id = ?")
            .bind(account_id)
            .fetch_optional(pool)
            .await?,
    )
}

/// Resync an account through whichever provider its `provider` column names.
/// The manual-resync entry point; the scheduler resolves the provider itself so
/// it can reuse one per pass.
pub async fn resync_account_auto(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
) -> AppResult<Vec<CalendarSyncResult>> {
    let account = load_account_row(pool, account_id).await?;
    let provider = AnyProvider::for_account(&account, keychain);
    resync_account(pool, &provider, account_id).await
}

/// Resync every enabled calendar on an account through the poll engine. Generic
/// over the provider so the caller constructs the right one and tests inject a
/// scripted one. Per-calendar transport/credential failures surface as
/// `offline`/`reconnectNeeded` results rather than aborting the whole account.
pub async fn resync_account<P: CalendarProvider>(
    pool: &SqlitePool,
    provider: &P,
    account_id: &str,
) -> AppResult<Vec<CalendarSyncResult>> {
    let account = load_account_row(pool, account_id).await?;
    let calendars = load_enabled_calendar_rows(pool, account_id).await?;

    let mut results = Vec::with_capacity(calendars.len());
    let mut any_reconnect = false;
    let mut any_synced = false;
    for cal in &calendars {
        let Some(folder_id) = cal.folder_id.clone() else {
            continue;
        };
        let outcome = sync_calendar(pool, provider, &account, cal, &folder_id).await?;
        match outcome {
            SyncOutcome::ReconnectNeeded => any_reconnect = true,
            SyncOutcome::Synced { .. } => any_synced = true,
            SyncOutcome::Offline => {}
        }
        results.push(CalendarSyncResult::new(&cal.calendar_id, outcome));
    }

    // The flag is account-wide (credentials are), so any rejection sets it and any
    // clean sync clears it. Write only on a transition to avoid churning updated_at.
    let next = if any_reconnect {
        true
    } else if any_synced {
        false
    } else {
        account.reconnect_needed
    };
    if next != account.reconnect_needed {
        set_reconnect_needed(pool, account_id, next).await?;
    }
    Ok(results)
}

async fn set_reconnect_needed(pool: &SqlitePool, account_id: &str, needed: bool) -> AppResult<()> {
    sqlx::query("UPDATE sync_account SET reconnect_needed = ?, updated_at = ? WHERE id = ?")
        .bind(needed)
        .bind(pikos_db::now_iso())
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(())
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
    Ok(sqlx::query_as::<_, SyncCalendarRow>(
        "SELECT * FROM sync_calendar WHERE account_id = ? AND enabled = 1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?)
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod commands_tests;
