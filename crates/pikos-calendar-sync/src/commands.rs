//! The networked half of the Calendar Sync panel's commands: `pikos-db`'s account and calendar
//! writers paired with the keychain, autodiscovery and the poll engine. Desktop-only.

use serde::Serialize;
use sqlx::SqlitePool;

use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{PROVIDER_CALDAV, PROVIDER_GOOGLE};
use pikos_db::sync_commands::{
    account_provider_impl, all_account_identities_impl, clear_sync_cursors_impl,
    enabled_calendar_rows_impl, find_account_by_identity_impl, get_sync_account_impl,
    insert_sync_account_impl, list_sync_calendars_impl, mark_account_disconnected_impl,
    reactivate_account_impl, set_reconnect_needed_impl, sync_account_row_impl,
    toggle_sync_calendar_impl, upsert_sync_calendar_impl, AccountWithCalendars,
};
use pikos_db::sync_delta::CalendarProvider;

use crate::caldav::{CaldavCredentials, CaldavProvider};
use crate::engine::{sync_calendar, SyncOutcome};
use crate::keychain::Keychain;
use crate::provider::AnyProvider;

/// One calendar's resync result, for the frontend status display.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncResult {
    pub calendar_id: String,
    /// `synced` | `offline` | `reconnectNeeded`.
    pub status: String,
    pub full_resync: bool,
    /// `SyncOutcome::Synced`'s `changed`: the scheduler's page-data-changed signal.
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

/// Connect a CalDAV account. Discovery runs first, so a bad URL or password fails before
/// anything is persisted; then the account and its (disabled) calendars are saved and the
/// credentials go in the keychain.
///
/// An account already known by (provider, display_name), dormant or active, reuses its row:
/// dormant re-links detached pages, active avoids syncing every event twice. Each calendar's
/// enabled/folder/cursor is left untouched.
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
    save_caldav(pool, &keychain, &creds, &display_name, &remote).await
}

/// The half of [`connect_caldav`] after discovery, so a test can reach it without a server.
async fn save_caldav(
    pool: &SqlitePool,
    keychain: &Keychain,
    creds: &CaldavCredentials,
    display_name: &str,
    remote: &[pikos_db::sync_delta::RemoteCalendar],
) -> AppResult<AccountWithCalendars> {
    let blob = creds
        .to_blob()
        .map_err(|e| AppError::Internal(format!("serialize credentials: {e}")))?;

    let identity = caldav_stored_identity(pool, display_name).await?;
    let claimed = claim_account(pool, PROVIDER_CALDAV, &identity, "basic").await?;
    let stored = keychain
        .store(&claimed.account.id, &blob)
        .map_err(|e| AppError::Internal(e.user_message()));
    let account = keep_or_release(pool, claimed, stored).await?;

    let calendars = upsert_calendars(pool, &account.id, remote).await?;
    Ok(AccountWithCalendars { account, calendars })
}

/// Repair a CalDAV account whose password stopped working: swap the stored password, prove it
/// by discovery, then clear the flag that has the scheduler skipping the account.
///
/// Takes the password alone because the base URL and username already live in the keychain
/// blob; re-collecting them would let a typo land a second account, and identity is
/// `provider + display_name`. A wrong password leaves the existing credential in place.
pub async fn reconnect_caldav(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
    password: String,
) -> AppResult<AccountWithCalendars> {
    let row = sync_account_row_impl(pool, account_id).await?;
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
        .map_err(|e| AppError::Internal(e.user_message()))?;
    reactivate_account_impl(pool, account_id).await?;

    let calendars = upsert_calendars(pool, account_id, &remote).await?;
    let account = get_sync_account_impl(pool, account_id).await?;
    Ok(AccountWithCalendars { account, calendars })
}

/// Connect a Google account: run the OAuth grant, label the account with the primary
/// calendar's id (the signed-in email), then persist it and its (disabled) calendars.
/// `open_browser` gets the consent URL between binding the loopback listener and waiting on
/// it, because Google's Desktop client type requires a real browser.
///
/// Reuses a known account's row like [`connect_caldav`].
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

    // Prove the grant reads calendars before persisting anything.
    let (remote, display_name) = crate::google::GoogleProvider::list_with(&credentials).await?;
    save_google(pool, &keychain, &credentials, &display_name, &remote).await
}

/// The half of [`connect_google`] after the grant and the calendar list, so a test can reach
/// it without Google.
pub(crate) async fn save_google(
    pool: &SqlitePool,
    keychain: &Keychain,
    credentials: &crate::google::GoogleCredentials,
    display_name: &str,
    remote: &[pikos_db::sync_delta::RemoteCalendar],
) -> AppResult<AccountWithCalendars> {
    let claimed = claim_account(pool, PROVIDER_GOOGLE, display_name, "oauth").await?;
    let stored = crate::google::store(keychain, &claimed.account.id, credentials);
    let account = keep_or_release(pool, claimed, stored.map_err(AppError::from)).await?;

    let calendars = upsert_calendars(pool, &account.id, remote).await?;
    Ok(AccountWithCalendars { account, calendars })
}

/// An account row a connect has taken, and whether this connect is what created it.
struct Claimed {
    account: pikos_db::sync_commands::SyncAccount,
    /// Only a row this connect created may be taken back out when the credential can't be
    /// stored; an existing account still has its own working one.
    created: bool,
}

/// The spelling an existing CalDAV account is stored under, when this identity is
/// the same user and server written a different way.
///
/// Identity is matched as a string, and the lookup's `COLLATE NOCASE` absorbs a difference in
/// case but not a trailing slash. Accounts stored before the connect dialog reduced the typed
/// URL carry `https://caldav.fastmail.com` where a fresh connect builds
/// `https://caldav.fastmail.com/`. Missing that row adds a second account for one server and
/// leaves the first one's pages detached.
///
/// Resolved on connect rather than by rewriting stored identities, so no migration is owed
/// and a workspace stays readable by the build that wrote it. The narrower reductions `URL`
/// also applies (a default port, a dot segment) are deliberately not matched: reaching them
/// would mean splitting an identity into username and URL and agreeing with the frontend on
/// where the seam is.
async fn caldav_stored_identity(pool: &SqlitePool, identity: &str) -> AppResult<String> {
    if find_account_by_identity_impl(pool, PROVIDER_CALDAV, identity)
        .await?
        .is_some()
    {
        return Ok(identity.to_string());
    }
    let Some(without_slash) = identity.strip_suffix('/') else {
        return Ok(identity.to_string());
    };
    Ok(
        match find_account_by_identity_impl(pool, PROVIDER_CALDAV, without_slash).await? {
            Some(existing) => existing.display_name,
            None => identity.to_string(),
        },
    )
}

/// Reuses an existing account row on (re)connect, else creates one, so both connect paths
/// share reconnect semantics.
async fn claim_account(
    pool: &SqlitePool,
    provider: &str,
    display_name: &str,
    auth_kind: &str,
) -> AppResult<Claimed> {
    match find_account_by_identity_impl(pool, provider, display_name).await? {
        Some(existing) => {
            reactivate_account_impl(pool, &existing.id).await?;
            Ok(Claimed {
                account: existing,
                created: false,
            })
        }
        None => Ok(Claimed {
            account: insert_sync_account_impl(pool, provider, display_name, auth_kind).await?,
            created: true,
        }),
    }
}

/// Keep the claimed row when the credential landed, and put it back when it did not.
///
/// The row is written before the credential because the keychain key *is* the account id. An
/// account left active with nothing in the keychain polls for ever and reports "reconnect needed"
/// on every pass, with no way back except deleting it, so a store that fails takes its own row
/// dormant again.
async fn keep_or_release(
    pool: &SqlitePool,
    claimed: Claimed,
    stored: AppResult<()>,
) -> AppResult<pikos_db::sync_commands::SyncAccount> {
    match stored {
        Ok(()) => Ok(claimed.account),
        Err(e) => {
            if claimed.created {
                mark_account_disconnected_impl(pool, &claimed.account.id).await?;
            }
            Err(e)
        }
    }
}

pub async fn upsert_calendars(
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

/// Disconnect an account: unsync its calendars, mark it dormant, release its credential. The
/// row, its calendars and detached `page_sync` identities stay, so a reconnect re-links by
/// `ical_uid`.
pub async fn disconnect_account(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
) -> AppResult<()> {
    go_dormant(pool, account_id).await?;
    let provider = account_provider_impl(pool, account_id)
        .await?
        .unwrap_or_default();
    release_credential(&keychain, account_id, &provider).await;
    Ok(())
}

/// Disconnect every account, for a caller about to wipe the workspace. Active accounts go
/// dormant first, because clearing `enabled` keeps a poll from writing pages back over the
/// wipe; then every credential is released, dormant rows included.
pub async fn disconnect_all_accounts(pool: &SqlitePool, keychain: Keychain) -> AppResult<()> {
    for (id, _, disconnected) in all_account_identities_impl(pool).await? {
        // Best-effort: a calendar that won't tear down must not block the wipe.
        if !disconnected {
            if let Err(e) = go_dormant(pool, &id).await {
                log::warn!("sync: could not disconnect {id} before the wipe: {e}");
            }
        }
    }
    release_all_credentials(pool, keychain).await
}

/// The local half of a disconnect: unsync each calendar, then hide the account from the panel.
async fn go_dormant(pool: &SqlitePool, account_id: &str) -> AppResult<()> {
    for cal in list_sync_calendars_impl(pool, account_id).await? {
        if cal.enabled {
            toggle_sync_calendar_impl(pool, &cal.id, false, None).await?;
        }
    }
    mark_account_disconnected_impl(pool, account_id).await
}

/// Revoke every OAuth grant and clear every keychain entry, for a caller about to delete the
/// workspace wholesale. Writes nothing to the database.
///
/// The keychain lives outside `app_data_dir`, so a wipe alone would strand a usable refresh
/// token. The rows are walked for the Google revokes, then the whole service is swept,
/// because a database replaced outside a disconnect leaves credentials no row names.
pub async fn release_all_credentials(pool: &SqlitePool, keychain: Keychain) -> AppResult<()> {
    for (id, provider, _) in all_account_identities_impl(pool).await? {
        release_credential(&keychain, &id, &provider).await;
    }

    if let Err(e) = keychain.delete_all() {
        log::warn!("sync: could not sweep the keychain: {e}");
    }

    Ok(())
}

/// Drop one account's stored secret. The OAuth grant is revoked first so the account leaves
/// the user's connected-apps list. Both steps are best-effort: neither may block a disconnect.
async fn release_credential(keychain: &Keychain, account_id: &str, provider: &str) {
    if provider == PROVIDER_GOOGLE {
        if let Err(e) = crate::google::revoke(keychain, account_id).await {
            log::warn!("sync: could not revoke the Google grant for {account_id}: {e}");
        }
    }
    let _ = keychain.delete(account_id);
}

/// Resync an account through the provider its `provider` column names. The scheduler resolves
/// the provider itself so it can reuse one per pass.
pub async fn resync_account_auto(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
) -> AppResult<Vec<CalendarSyncResult>> {
    let account = sync_account_row_impl(pool, account_id).await?;
    let provider = AnyProvider::for_account(&account, keychain);
    resync_account(pool, &provider, account_id).await
}

/// Resync every enabled calendar on an account through the poll engine. A calendar's
/// transport or credential failure surfaces as an `offline`/`reconnectNeeded` result and
/// doesn't abort the account.
pub async fn resync_account<P: CalendarProvider>(
    pool: &SqlitePool,
    provider: &P,
    account_id: &str,
) -> AppResult<Vec<CalendarSyncResult>> {
    let account = sync_account_row_impl(pool, account_id).await?;
    let calendars = enabled_calendar_rows_impl(pool, account_id).await?;

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

    // Account-wide like the credentials: any rejection sets it, any clean sync clears it.
    let next = if any_reconnect {
        true
    } else if any_synced {
        false
    } else {
        account.reconnect_needed
    };
    if next != account.reconnect_needed {
        set_reconnect_needed_impl(pool, account_id, next).await?;
        // A flagged account stops polling, so without this line sync just goes quiet in the log.
        if next {
            log::info!("calendar_sync_reconnect_needed account={account_id}");
        } else {
            log::info!("calendar_sync_reconnected account={account_id}");
        }
    }
    Ok(results)
}

/// Refresh an account through the provider its `provider` column names. Pairs with
/// [`resync_account_auto`].
pub async fn refresh_account_auto(
    pool: &SqlitePool,
    keychain: Keychain,
    account_id: &str,
) -> AppResult<Vec<CalendarSyncResult>> {
    let account = sync_account_row_impl(pool, account_id).await?;
    let provider = AnyProvider::for_account(&account, keychain);
    refresh_account(pool, &provider, account_id).await
}

/// Re-read an account's calendars in full: discard every enabled calendar's
/// cursor so the poll that follows enumerates the whole backfill window.
///
/// The repair path for a mirror that has drifted: a change the cursor advanced past (see the
/// engine's backfill/bootstrap race), or an upstream deletion made while nothing was polling.
/// Not a teardown: the reconciler no-ops on an unchanged etag, so pages, folders and
/// `updated_at` stay put. The disable and enable toggle would also force a re-read, but it
/// deletes un-actioned mirrors and detaches owned pages first.
///
/// Only a full enumerate marks its upserts authoritative, so for CalDAV this also re-arms the
/// deletion sweep, which catches a deletion no incremental delta reported. A Google backfill
/// leaves the sweep disarmed by design, so a refresh there re-reads without sweeping.
pub async fn refresh_account<P: CalendarProvider>(
    pool: &SqlitePool,
    provider: &P,
    account_id: &str,
) -> AppResult<Vec<CalendarSyncResult>> {
    clear_sync_cursors_impl(pool, account_id).await?;
    resync_account(pool, provider, account_id).await
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod commands_tests;

#[cfg(test)]
#[path = "live_caldav_tests.rs"]
mod live_caldav_tests;
