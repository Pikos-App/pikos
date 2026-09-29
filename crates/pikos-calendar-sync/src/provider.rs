//! Provider dispatch: one account's `provider` string → the impl that speaks it.
//!
//! Static enum rather than `dyn CalendarProvider` — the trait uses `async fn`, so
//! a trait object would need boxing plus a `Send` bound the providers don't carry
//! (both hold a `Keychain` and run on one task). Adding a third provider is a
//! variant plus its arms; nothing else moves.

use pikos_db::error::AppResult;
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow, PROVIDER_GOOGLE};
use pikos_db::sync_delta::{CalendarProvider, EventUpsert, RemoteCalendar, SyncDelta, SyncToken};

use crate::caldav::CaldavProvider;
use crate::google::GoogleProvider;
use crate::keychain::Keychain;

pub enum AnyProvider {
    Caldav(CaldavProvider),
    Google(GoogleProvider),
}

impl AnyProvider {
    /// The provider for an account. An unrecognized `provider` string falls back
    /// to CalDAV: the column is written only by our own connect paths, so a
    /// mismatch means a downgrade reading a newer DB, and CalDAV's keychain blob
    /// simply fails to deserialize into a "reconnect needed" rather than a panic.
    pub fn for_account(account: &SyncAccountRow, keychain: Keychain) -> Self {
        match account.provider.as_str() {
            PROVIDER_GOOGLE => Self::Google(GoogleProvider::new(keychain)),
            _ => Self::Caldav(CaldavProvider::new(keychain)),
        }
    }
}

impl CalendarProvider for AnyProvider {
    async fn list_calendars(&self, account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>> {
        match self {
            Self::Caldav(p) => p.list_calendars(account).await,
            Self::Google(p) => p.list_calendars(account).await,
        }
    }

    async fn sync(
        &self,
        calendar: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        match self {
            Self::Caldav(p) => p.sync(calendar, since).await,
            Self::Google(p) => p.sync(calendar, since).await,
        }
    }

    async fn fetch_event(
        &self,
        calendar: &SyncCalendarRow,
        event_ref: &str,
    ) -> AppResult<EventUpsert> {
        match self {
            Self::Caldav(p) => p.fetch_event(calendar, event_ref).await,
            Self::Google(p) => p.fetch_event(calendar, event_ref).await,
        }
    }

    async fn current_sync_token(&self, calendar: &SyncCalendarRow) -> AppResult<Option<SyncToken>> {
        match self {
            Self::Caldav(p) => p.current_sync_token(calendar).await,
            Self::Google(p) => p.current_sync_token(calendar).await,
        }
    }

    async fn current_ctag(&self, calendar: &SyncCalendarRow) -> AppResult<Option<String>> {
        match self {
            Self::Caldav(p) => p.current_ctag(calendar).await,
            Self::Google(p) => p.current_ctag(calendar).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pikos_db::now_iso;
    use pikos_db::sync::PROVIDER_CALDAV;

    fn account(provider: &str) -> SyncAccountRow {
        SyncAccountRow {
            id: "a1".into(),
            provider: provider.into(),
            display_name: "Test".into(),
            auth_kind: "basic".into(),
            reconnect_needed: false,
            created_at: now_iso(),
            updated_at: now_iso(),
        }
    }

    // Getting this backwards speaks CalDAV at Google (and vice versa) — every poll
    // fails in a way that reads as a credential problem rather than a wiring bug.
    #[test]
    fn each_provider_tag_selects_its_impl() {
        let k = || crate::test_support::memory_keychain();
        assert!(matches!(
            AnyProvider::for_account(&account(PROVIDER_CALDAV), k()),
            AnyProvider::Caldav(_)
        ));
        assert!(matches!(
            AnyProvider::for_account(&account(PROVIDER_GOOGLE), k()),
            AnyProvider::Google(_)
        ));
    }

    #[test]
    fn an_unknown_provider_falls_back_rather_than_panicking() {
        assert!(matches!(
            AnyProvider::for_account(&account("exchange"), crate::test_support::memory_keychain()),
            AnyProvider::Caldav(_)
        ));
    }
}
