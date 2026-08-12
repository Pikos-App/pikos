//! Sync-settings orchestration — the networked half of the Calendar Sync panel's
//! commands. Pairs `pikos-db`'s pure account/calendar writers with the keychain,
//! the provider's autodiscovery, and the poll engine. The desktop command shims
//! are thin wrappers over these; the CLI never calls them (sync is desktop-only).

use serde::Serialize;
use sqlx::SqlitePool;

use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow, PROVIDER_CALDAV, PROVIDER_GOOGLE};
use pikos_db::sync_commands::{
    find_account_by_identity_impl, get_sync_account_impl, insert_sync_account_impl,
    list_sync_calendars_impl, mark_account_disconnected_impl, reactivate_account_impl,
    toggle_sync_calendar_impl, upsert_sync_calendar_impl, AccountWithCalendars,
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
    /// Mirrors `SyncOutcome::Synced`'s `changed` — the scheduler's page-data-changed signal.
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

/// Connect a CalDAV account: validate credentials by discovering calendars first
/// — so a bad URL/password fails before anything is persisted — then persist the
/// account + its (disabled) calendars and stash the credentials in the keychain.
///
/// Reconnecting an account already known by (provider, display_name) — dormant
/// via `disconnect_account`, or still active — reuses its row instead of
/// duplicating: dormant re-links detached pages, active avoids re-syncing every
/// event twice. The calendar upsert is idempotent and leaves each calendar's
/// enabled/folder/cursor untouched.
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

/// Repair a CalDAV account whose password stopped working: swap the stored
/// password, prove it by discovery, then clear the flag that has the scheduler
/// skipping this account.
///
/// Takes the password alone because the base URL and username already live in the
/// keychain blob. Re-collecting them would let a typo land a *second* account
/// instead of repairing this one, which is the outcome the flow exists to avoid —
/// identity is `provider + display_name`, and a reconnect must not change it.
/// Nothing is persisted until discovery succeeds, so a wrong password leaves the
/// existing credential in place.
pub async fn reconnect_caldav(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
    password: String,
) -> AppResult<AccountWithCalendars> {
    let row = load_account_row(pool, account_id).await?;
    if row.provider != PROVIDER_CALDAV {
        return Err(AppError::Invalid(
            "only a CalDAV account reconnects with a password".into(),
        ));
    }

    let mut creds = crate::caldav::stored_credentials(&keychain, account_id)?;
    creds.password = password;
    let remote = CaldavProvider::discover_with(&creds).await?;

    let blob = creds
        .to_blob()
        .map_err(|e| AppError::Internal(format!("serialize credentials: {e}")))?;
    keychain
        .store(account_id, &blob)
        .map_err(|e| AppError::Internal(format!("keychain store: {e}")))?;
    reactivate_account_impl(pool, account_id).await?;

    let calendars = upsert_calendars(pool, account_id, &remote).await?;
    let account = get_sync_account_impl(pool, account_id).await?;
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
    let (remote, display_name) = crate::google::GoogleProvider::list_with(&credentials).await?;

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
                rc.color
                    .as_deref()
                    .and_then(crate::palette::nearest_palette_color),
            )
            .await?,
        );
    }
    Ok(calendars)
}

/// Disconnect an account: unsync its calendars, mark it dormant, release its
/// credential. The row, its calendars, and detached `page_sync` identities stay —
/// a reconnect reuses them and re-links by `ical_uid`, the same path a calendar
/// unsync already uses.
pub async fn disconnect_account(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
) -> AppResult<()> {
    go_dormant(pool, account_id).await?;
    let provider = provider_of(pool, account_id).await?.unwrap_or_default();
    release_credential(&keychain, account_id, &provider).await;
    Ok(())
}

/// Disconnect every account, for a caller about to wipe the workspace. Active
/// accounts go dormant through the normal path first — clearing `enabled` is what
/// keeps a poll from writing pages back over the wipe — and then every credential
/// is released, dormant rows included.
pub async fn disconnect_all_accounts(pool: &SqlitePool, keychain: Keychain) -> AppResult<()> {
    for (id, _, disconnected) in all_accounts(pool).await? {
        // Best-effort: a calendar that won't tear down must not block the wipe.
        if !disconnected {
            if let Err(e) = go_dormant(pool, &id).await {
                log::warn!("sync: could not disconnect {id} before the wipe: {e}");
            }
        }
    }
    release_all_credentials(pool, keychain).await
}

/// The local half of a disconnect: unsync each calendar (detach owned pages, delete
/// bare mirrors, disable + clear its cursor), then hide the account from the panel.
async fn go_dormant(pool: &SqlitePool, account_id: &str) -> AppResult<()> {
    for cal in list_sync_calendars_impl(pool, account_id).await? {
        if cal.enabled {
            toggle_sync_calendar_impl(pool, &cal.id, false, None).await?;
        }
    }
    mark_account_disconnected_impl(pool, account_id).await
}

/// Revoke every OAuth grant and clear every keychain entry, for a caller about to
/// delete the workspace wholesale. No DB writes — the rows are going away anyway.
///
/// The keychain lives outside `app_data_dir`, so a wipe on its own would strand a
/// usable refresh token keyed to an account id nothing references any more.
pub async fn release_all_credentials(pool: &SqlitePool, keychain: Keychain) -> AppResult<()> {
    for (id, provider, _) in all_accounts(pool).await? {
        release_credential(&keychain, &id, &provider).await;
    }
    Ok(())
}

/// Drop one account's stored secret. The OAuth grant is revoked first so the
/// account also drops off the user's connected-apps list, instead of lingering
/// there with a token Pikos has thrown away. Both steps are best-effort and
/// idempotent — neither may block a disconnect the user has already asked for.
async fn release_credential(keychain: &Keychain, account_id: &str, provider: &str) {
    if provider == PROVIDER_GOOGLE {
        if let Err(e) = crate::google::revoke(keychain, account_id).await {
            log::warn!("sync: could not revoke the Google grant for {account_id}: {e}");
        }
    }
    let _ = keychain.delete(account_id);
}

/// Every account, dormant ones included — a dormant row's credential should
/// already be gone, but a wipe is the last chance to be sure.
async fn all_accounts(pool: &SqlitePool) -> AppResult<Vec<(String, String, bool)>> {
    Ok(sqlx::query_as::<_, (String, String, bool)>(
        "SELECT id, provider, disconnected FROM sync_account",
    )
    .fetch_all(pool)
    .await?)
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
