//! Google provider (Phase 2): OAuth 2.0 + PKCE over an ephemeral loopback
//! redirect, tokens in the OS keychain, and the Calendar API sync on top.
//!
//! Credentials are keyed by `sync_account` row id, so connecting a second Google
//! account creates its own account row and its own keychain entry rather than
//! replacing the first.

mod auth;
mod config;
mod credentials;
mod error;
mod events;
mod loopback;
mod model;
mod sync;
mod transport;

pub use auth::{access_token, begin_authorization, revoke, store, PendingAuth};
pub use config::is_available;
pub use credentials::GoogleCredentials;
pub use error::GoogleError;

use pikos_db::error::AppResult;
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{CalendarProvider, EventUpsert, RemoteCalendar, SyncDelta, SyncToken};

use crate::keychain::Keychain;
use transport::ReqwestGoogle;

/// Google provider. Tokens are loaded from the keychain per call, never held
/// in memory beyond a sync.
pub struct GoogleProvider {
    keychain: Keychain,
}

impl GoogleProvider {
    pub fn new(keychain: Keychain) -> Self {
        Self { keychain }
    }

    /// Enumerate calendars straight from a fresh grant, before any account row or
    /// keychain entry exists — the Google counterpart to CalDAV's `discover_with`.
    /// Also yields the primary calendar's id, which identifies the account.
    pub async fn list_with(
        credentials: &GoogleCredentials,
    ) -> AppResult<(Vec<RemoteCalendar>, String)> {
        let transport = ReqwestGoogle::new(credentials.access_token.clone());
        Ok(sync::list_calendars_for_connect(&transport).await?)
    }

    /// Resolve a usable access token, refreshing (and re-persisting a rotated
    /// refresh token) if the stored one is near expiry, and hand it to a fresh
    /// [`ReqwestGoogle`] — once per trait call (see its doc for why).
    async fn transport(&self, account_id: &str) -> AppResult<ReqwestGoogle> {
        let token = auth::access_token(&self.keychain, account_id).await?;
        Ok(ReqwestGoogle::new(token))
    }
}

impl CalendarProvider for GoogleProvider {
    async fn list_calendars(&self, account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>> {
        let transport = self.transport(&account.id).await?;
        Ok(sync::list_calendars(&transport).await?)
    }

    async fn sync(
        &self,
        calendar: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        let transport = self.transport(&calendar.account_id).await?;
        Ok(sync::sync_calendar(&transport, &calendar.calendar_id, since.as_ref()).await?)
    }

    async fn fetch_event(
        &self,
        calendar: &SyncCalendarRow,
        event_ref: &str,
    ) -> AppResult<EventUpsert> {
        let transport = self.transport(&calendar.account_id).await?;
        Ok(sync::fetch_one(&transport, &calendar.calendar_id, event_ref).await?)
    }

    /// Google's backfill already carries its own `nextSyncToken`, so there is no
    /// separate cursor to capture afterwards.
    async fn current_sync_token(
        &self,
        _calendar: &SyncCalendarRow,
    ) -> AppResult<Option<SyncToken>> {
        Ok(None)
    }
}
