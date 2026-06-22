//! Tests for the sync orchestration that needs no network: `disconnect_account`
//! (DB teardown + keychain delete) and `resync_account` (loops only enabled
//! calendars through the engine, driven by a scripted provider). `connect_caldav`
//! is a live discovery seam, exercised manually.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_commands::{
    insert_sync_account_impl, toggle_sync_calendar_impl, upsert_sync_calendar_impl,
};
use pikos_db::sync_delta::{
    CalendarProvider, EventUpsert, RemoteCalendar, SyncDelta, SyncToken,
};
use pikos_db::test_pool;

use super::*;
use crate::keychain::{CredentialStore, Keychain, KeychainError};

// ─── in-memory keychain ─────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct MemStore(Arc<Mutex<HashMap<String, String>>>);

impl CredentialStore for MemStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), KeychainError> {
        self.0.lock().unwrap().insert(key.into(), secret.into());
        Ok(())
    }
    fn get(&self, key: &str) -> Result<String, KeychainError> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(KeychainError::NotFound)
    }
    fn delete(&self, key: &str) -> Result<(), KeychainError> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

// ─── scripted provider (sync returns a trivial backfill) ────────────────────────

struct OneShot {
    token: String,
}

impl CalendarProvider for OneShot {
    async fn list_calendars(&self, _a: &SyncAccountRow) -> pikos_db::AppResult<Vec<RemoteCalendar>> {
        unreachable!("resync never discovers")
    }
    async fn sync(
        &self,
        _c: &SyncCalendarRow,
        _since: Option<SyncToken>,
    ) -> pikos_db::AppResult<SyncDelta> {
        Ok(SyncDelta::default())
    }
    async fn fetch_event(&self, _c: &SyncCalendarRow, _r: &str) -> pikos_db::AppResult<EventUpsert> {
        unreachable!("no orphans in an empty delta")
    }
    async fn current_sync_token(
        &self,
        _c: &SyncCalendarRow,
    ) -> pikos_db::AppResult<Option<SyncToken>> {
        Ok(Some(SyncToken(self.token.clone())))
    }
}

// ─── tests ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn disconnect_tears_down_and_clears_the_keychain() {
    let pool = test_pool().await;
    let acc = insert_sync_account_impl(&pool, "caldav", "Fastmail", "basic")
        .await
        .unwrap();
    let cal = upsert_sync_calendar_impl(&pool, &acc.id, "cal-a", "Work", None)
        .await
        .unwrap();
    toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();

    let backing = MemStore::default();
    backing.set(&acc.id, "secret-blob").unwrap();
    let keychain = Keychain::with_store(Box::new(backing.clone()));

    disconnect_account(&pool, keychain, &acc.id).await.unwrap();

    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_account")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(accounts, 0, "account + cascade removed");
    let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(folders, 0, "bare external folder torn down");
    assert!(
        backing.get(&acc.id).is_err(),
        "credential removed from the keychain"
    );
}

#[tokio::test]
async fn resync_syncs_only_enabled_calendars() {
    let pool = test_pool().await;
    let acc = insert_sync_account_impl(&pool, "caldav", "Fastmail", "basic")
        .await
        .unwrap();
    let enabled = upsert_sync_calendar_impl(&pool, &acc.id, "cal-on", "Work", None)
        .await
        .unwrap();
    toggle_sync_calendar_impl(&pool, &enabled.id, true, None)
        .await
        .unwrap();
    upsert_sync_calendar_impl(&pool, &acc.id, "cal-off", "Personal", None)
        .await
        .unwrap();

    let provider = OneShot { token: "tok-1".into() };
    let results = resync_account(&pool, &provider, &acc.id).await.unwrap();

    assert_eq!(results.len(), 1, "only the enabled calendar synced");
    assert_eq!(results[0].calendar_id, "cal-on");
    assert_eq!(results[0].status, "synced");

    // The engine bootstrapped + stored the cursor on the enabled calendar.
    let token: Option<String> =
        sqlx::query_scalar("SELECT sync_token FROM sync_calendar WHERE id = ?")
            .bind(&enabled.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(token.as_deref(), Some("tok-1"));
}

#[tokio::test]
async fn connect_caldav_persists_nothing_when_discovery_fails() {
    // connect_caldav validates by discovering FIRST, so a failure must leave no
    // half-built account or keychain entry. A malformed URL fails discovery at the
    // parse step (no network), exercising that ordering without a live server.
    let pool = test_pool().await;
    let keychain = Keychain::with_store(Box::new(MemStore::default()));

    let err = connect_caldav(
        &pool,
        keychain,
        "not a valid url".into(),
        "user".into(),
        "pw".into(),
        "My Calendar".into(),
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AppError::Invalid(_)), "bad URL surfaces as user-actionable");
    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_account")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(accounts, 0, "no account row written before discovery succeeds");
}
