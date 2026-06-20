//! CalDAV provider (Phase 1): basic auth over HTTPS with an app password,
//! `.well-known` autodiscovery, then incremental `sync-collection` and a targeted
//! single-resource fetch (both still to come). Everything CalDAV-specific lives
//! here, behind the shared `CalendarProvider` trait.

mod credentials;
mod discovery;
mod error;
mod ics;
mod report_xml;
mod sync;
mod transport;
mod xml;

pub use credentials::CaldavCredentials;
pub use error::CaldavError;

use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{
    CalendarProvider, EventUpsert, RemoteCalendar, SyncDelta, SyncToken,
};

use crate::keychain::Keychain;
use transport::ReqwestDav;

/// CalDAV provider. Credentials are loaded from the keychain per call (keyed by
/// the `sync_account` row id), never held in memory beyond a sync.
pub struct CaldavProvider {
    keychain: Keychain,
}

impl CaldavProvider {
    pub fn new(keychain: Keychain) -> Self {
        Self { keychain }
    }

    /// Validate credentials by discovering calendars directly from them, before any
    /// account or keychain entry exists — proves the URL + password before anything
    /// is persisted.
    pub async fn discover_with(creds: &CaldavCredentials) -> AppResult<Vec<RemoteCalendar>> {
        let transport = ReqwestDav::new(creds.username.clone(), creds.password.clone());
        Ok(discovery::discover_calendars(&transport, &creds.base_url).await?)
    }

    fn credentials(&self, account: &SyncAccountRow) -> AppResult<CaldavCredentials> {
        self.credentials_by_id(&account.id)
    }

    /// Load + deserialize the account's keychain blob. A keychain miss maps to a
    /// user-actionable "reconnect needed", not a transient network error.
    fn credentials_by_id(&self, account_id: &str) -> AppResult<CaldavCredentials> {
        let blob = self.keychain.load(account_id).map_err(|e| {
            if e.is_reconnect_needed() {
                AppError::Invalid("CalDAV credentials missing — reconnect the account".into())
            } else {
                AppError::Network(e.to_string())
            }
        })?;
        Ok(CaldavCredentials::from_blob(&blob)?)
    }
}

impl CalendarProvider for CaldavProvider {
    async fn list_calendars(&self, account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>> {
        let creds = self.credentials(account)?;
        let transport = ReqwestDav::new(creds.username, creds.password);
        Ok(discovery::discover_calendars(&transport, &creds.base_url).await?)
    }

    async fn sync(
        &self,
        calendar: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        let creds = self.credentials_by_id(&calendar.account_id)?;
        let transport = ReqwestDav::new(creds.username, creds.password);
        Ok(sync::sync_calendar(&transport, &calendar.calendar_id, since.as_ref()).await?)
    }

    async fn fetch_event(
        &self,
        calendar: &SyncCalendarRow,
        event_ref: &str,
    ) -> AppResult<EventUpsert> {
        let creds = self.credentials_by_id(&calendar.account_id)?;
        let transport = ReqwestDav::new(creds.username, creds.password);
        Ok(sync::fetch_one(&transport, &calendar.calendar_id, event_ref).await?)
    }

    async fn current_sync_token(
        &self,
        calendar: &SyncCalendarRow,
    ) -> AppResult<Option<SyncToken>> {
        let creds = self.credentials_by_id(&calendar.account_id)?;
        let transport = ReqwestDav::new(creds.username, creds.password);
        Ok(sync::current_sync_token(&transport, &calendar.calendar_id).await?)
    }
}
