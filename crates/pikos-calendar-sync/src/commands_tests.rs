//! Tests for the sync orchestration that needs no network — `disconnect_account`,
//! `resync_account`, `refresh_account` — driven by scripted providers.
//! `connect_caldav` is a live discovery seam, exercised manually.

use std::cell::RefCell;

use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_commands::{
    find_account_by_identity_impl, get_sync_status_impl, insert_sync_account_impl,
    reactivate_account_impl, toggle_sync_calendar_impl, upsert_sync_calendar_impl,
};
use pikos_db::sync_delta::{
    CalendarProvider, EventCore, EventSchedule, EventUpsert, ExclusiveEnd, RemoteCalendar,
    SyncDelta, SyncToken, UpsertItem,
};
use pikos_db::test_pool;

use super::*;
use crate::keychain::{CredentialStore, Keychain};
use crate::test_support::{memory_keychain, page_count, MemoryStore};

// ─── scripted provider (sync returns a trivial backfill) ────────────────────────

struct OneShot {
    token: String,
}

impl CalendarProvider for OneShot {
    async fn list_calendars(
        &self,
        _a: &SyncAccountRow,
    ) -> pikos_db::AppResult<Vec<RemoteCalendar>> {
        unreachable!("resync never discovers")
    }
    async fn sync(
        &self,
        _c: &SyncCalendarRow,
        _since: Option<SyncToken>,
    ) -> pikos_db::AppResult<SyncDelta> {
        Ok(SyncDelta::default())
    }
    async fn fetch_event(
        &self,
        _c: &SyncCalendarRow,
        _r: &str,
    ) -> pikos_db::AppResult<EventUpsert> {
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
async fn disconnect_goes_dormant_and_hides_the_account() {
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

    let backing = MemoryStore::default();
    backing.set(&acc.id, "secret-blob").unwrap();
    let keychain = Keychain::with_store(Box::new(backing.clone()));

    disconnect_account(&pool, keychain, &acc.id).await.unwrap();

    // The row survives (dormant) so a reconnect can re-link, but is hidden from the panel.
    let disconnected: bool =
        sqlx::query_scalar("SELECT disconnected FROM sync_account WHERE id = ?")
            .bind(&acc.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(disconnected, "account goes dormant, not deleted");
    assert!(
        get_sync_status_impl(&pool).await.unwrap().is_empty(),
        "dormant account hidden from the panel"
    );

    let enabled: bool = sqlx::query_scalar("SELECT enabled FROM sync_calendar WHERE id = ?")
        .bind(&cal.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!enabled, "calendar disabled on disconnect");
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

// Revoking a Google grant is a network call that can fail — unreachable, already
// revoked, or (here) no OAuth client in a test build. The account must still go
// dormant and lose its credential, or a user who can't reach Google could never
// disconnect.
#[tokio::test]
async fn a_google_disconnect_completes_even_when_the_revoke_fails() {
    let pool = test_pool().await;
    let acc = insert_sync_account_impl(&pool, PROVIDER_GOOGLE, "me@gmail.com", "oauth")
        .await
        .unwrap();

    let backing = MemoryStore::default();
    backing.set(&acc.id, "token-blob").unwrap();

    disconnect_account(
        &pool,
        Keychain::with_store(Box::new(backing.clone())),
        &acc.id,
    )
    .await
    .unwrap();

    let disconnected: bool =
        sqlx::query_scalar("SELECT disconnected FROM sync_account WHERE id = ?")
            .bind(&acc.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(disconnected);
    assert!(backing.get(&acc.id).is_err());
}

// The wipe deletes the DB, and the account ids in it are the keychain keys — a
// credential missed here can never be found again, only used. Dormant accounts are
// swept too: their credential is usually already gone, but this is the last pass.
#[tokio::test]
async fn releasing_credentials_clears_every_account_including_dormant_ones() {
    let pool = test_pool().await;
    let caldav = insert_sync_account_impl(&pool, PROVIDER_CALDAV, "you · https://x", "basic")
        .await
        .unwrap();
    let google = insert_sync_account_impl(&pool, PROVIDER_GOOGLE, "me@gmail.com", "oauth")
        .await
        .unwrap();
    let dormant = insert_sync_account_impl(&pool, PROVIDER_CALDAV, "old · https://y", "basic")
        .await
        .unwrap();
    mark_account_disconnected_impl(&pool, &dormant.id)
        .await
        .unwrap();

    let backing = MemoryStore::default();
    for acc in [&caldav, &google, &dormant] {
        backing.set(&acc.id, "secret-blob").unwrap();
    }

    // The Google revoke fails here (no OAuth client in a test build) and must not
    // stop the sweep — the same best-effort contract disconnect_account has.
    release_all_credentials(&pool, Keychain::with_store(Box::new(backing.clone())))
        .await
        .unwrap();

    for acc in [&caldav, &google, &dormant] {
        assert!(
            backing.get(&acc.id).is_err(),
            "credential left behind for {}",
            acc.display_name
        );
    }
}

// A reset deletes every account row, so it has the same one-last-chance property as
// the wipe: a dormant account never reaches the panel's disconnect path, and once its
// row is gone nothing holds the id its blob is keyed to.
#[tokio::test]
async fn disconnecting_all_accounts_sweeps_dormant_credentials_too() {
    let pool = test_pool().await;
    let active = insert_sync_account_impl(&pool, PROVIDER_CALDAV, "you · https://x", "basic")
        .await
        .unwrap();
    let cal = upsert_sync_calendar_impl(&pool, &active.id, "cal-a", "Work", None)
        .await
        .unwrap();
    toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();
    let dormant = insert_sync_account_impl(&pool, PROVIDER_CALDAV, "old · https://y", "basic")
        .await
        .unwrap();
    mark_account_disconnected_impl(&pool, &dormant.id)
        .await
        .unwrap();

    let backing = MemoryStore::default();
    for acc in [&active, &dormant] {
        backing.set(&acc.id, "secret-blob").unwrap();
    }

    disconnect_all_accounts(&pool, Keychain::with_store(Box::new(backing.clone())))
        .await
        .unwrap();

    for acc in [&active, &dormant] {
        assert!(
            backing.get(&acc.id).is_err(),
            "credential left behind for {}",
            acc.display_name
        );
    }
    let enabled: bool = sqlx::query_scalar("SELECT enabled FROM sync_calendar WHERE id = ?")
        .bind(&cal.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        !enabled,
        "the live account went dormant, so no poll follows"
    );
}

/// Scripted provider that answers a sync from the cursor it was handed, the way a
/// real one does — enough to create then re-link a mirror page across a
/// disconnect/reconnect, and to tell a cursor-less re-enumerate from an
/// incremental poll. Single-task by construction, so the interior `RefCell` never
/// crosses threads.
struct Scripted {
    full: SyncDelta,
    incremental: SyncDelta,
    /// The `since` cursor each `sync` call received, for assertions.
    seen_since: RefCell<Vec<Option<SyncToken>>>,
}

impl Scripted {
    /// One answer whichever cursor arrives — for tests that only need a mirror page.
    fn new(delta: SyncDelta) -> Self {
        Self::per_cursor(delta.clone(), delta)
    }

    fn per_cursor(full: SyncDelta, incremental: SyncDelta) -> Self {
        Self {
            full,
            incremental,
            seen_since: RefCell::new(vec![]),
        }
    }
}

impl CalendarProvider for Scripted {
    async fn list_calendars(
        &self,
        _a: &SyncAccountRow,
    ) -> pikos_db::AppResult<Vec<RemoteCalendar>> {
        unreachable!("resync never discovers")
    }
    async fn sync(
        &self,
        _c: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> pikos_db::AppResult<SyncDelta> {
        let delta = if since.is_some() {
            self.incremental.clone()
        } else {
            self.full.clone()
        };
        self.seen_since.borrow_mut().push(since);
        Ok(delta)
    }
    async fn fetch_event(
        &self,
        _c: &SyncCalendarRow,
        _r: &str,
    ) -> pikos_db::AppResult<EventUpsert> {
        unreachable!("no orphans in this delta")
    }
    async fn current_sync_token(
        &self,
        _c: &SyncCalendarRow,
    ) -> pikos_db::AppResult<Option<SyncToken>> {
        Ok(None)
    }
}

fn one_event(href: &str, uid: &str, title: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: EventCore {
            external_id: href.into(),
            ical_uid: uid.into(),
            etag: Some("e1".into()),
            title: title.into(),
            description: None,
            location: None,
            attendees: vec![],
        },
        schedule: EventSchedule {
            start: "2026-06-15T09:00:00".into(),
            end: ExclusiveEnd::new(None),
            timezone: Some("UTC".into()),
        },
        recurrence: None,
    })
}

fn one_event_delta(href: &str, uid: &str, title: &str, token: &str) -> SyncDelta {
    SyncDelta {
        upserts: vec![one_event(href, uid, title)],
        next_token: Some(SyncToken(token.into())),
        ..Default::default()
    }
}

/// A cursor-less CalDAV backfill: `full_enumerate` set, and its upserts marked the
/// complete set from `window_start` — the only shape that arms the deletion sweep.
fn backfill(upserts: Vec<UpsertItem>, window_start: &str, token: &str) -> SyncDelta {
    SyncDelta {
        upserts,
        authoritative_from: Some(window_start.into()),
        full_enumerate: true,
        next_token: Some(SyncToken(token.into())),
        ..Default::default()
    }
}

#[tokio::test]
async fn disconnect_reconnect_relinks_owned_page_without_duplicating() {
    let pool = test_pool().await;
    let acc = insert_sync_account_impl(&pool, "caldav", "you · https://x", "basic")
        .await
        .unwrap();
    let cal = upsert_sync_calendar_impl(&pool, &acc.id, "cal-a", "Work", None)
        .await
        .unwrap();
    toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();

    let provider = Scripted::new(one_event_delta("href-1", "uid-1", "Standup", "tok-1"));
    resync_account(&pool, &provider, &acc.id).await.unwrap();
    let page_id: String =
        sqlx::query_scalar("SELECT page_id FROM page_sync WHERE ical_uid = 'uid-1'")
            .fetch_one(&pool)
            .await
            .unwrap();

    // User edits the body → the page is owned, so disconnect detaches (not deletes) it.
    sqlx::query("UPDATE page_sync SET user_modified = 1 WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE pages SET content = '{\"edited\":true}' WHERE id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    let backing = MemoryStore::default();
    backing.set(&acc.id, "blob").unwrap();
    disconnect_account(
        &pool,
        Keychain::with_store(Box::new(backing.clone())),
        &acc.id,
    )
    .await
    .unwrap();
    let state: String = sqlx::query_scalar("SELECT sync_state FROM page_sync WHERE page_id = ?")
        .bind(&page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "detached", "owned page keeps its dormant identity");

    // Reconnect = connect_caldav's reuse branch (minus the live discovery): match the
    // dormant row, reactivate, re-enable the calendar, resync the same UID (new href).
    let dormant = find_account_by_identity_impl(&pool, "caldav", "you · https://x")
        .await
        .unwrap()
        .expect("dormant account found by provider+display_name");
    assert_eq!(dormant.id, acc.id, "reconnect reuses the dormant row");
    reactivate_account_impl(&pool, &dormant.id).await.unwrap();
    toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();
    let provider2 = Scripted::new(one_event_delta("href-2", "uid-1", "Standup", "tok-2"));
    resync_account(&pool, &provider2, &acc.id).await.unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_sync WHERE ical_uid = 'uid-1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "re-linked, no duplicate page_sync row");
    let (state2, user_modified): (String, bool) =
        sqlx::query_as("SELECT sync_state, user_modified FROM page_sync WHERE page_id = ?")
            .bind(&page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(state2, "active", "re-link reactivates the same row");
    assert!(user_modified, "ownership preserved across reconnect");
    let content: String = sqlx::query_scalar("SELECT content FROM pages WHERE id = ?")
        .bind(&page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        content, "{\"edited\":true}",
        "user body preserved across reconnect"
    );
}

// Reconnecting an account that's still active (never disconnected) must refresh
// its row, not insert a second one — a duplicate account gives every event a second
// folder and page (dedup is per-account). Drives `claim_account` + the idempotent
// calendar upsert the connect paths use, skipping only live discovery.
#[tokio::test]
async fn reconnecting_an_active_account_refreshes_it_without_duplicating() {
    let pool = test_pool().await;

    // Establishes a live account: account + calendar, enabled (materializes a
    // folder), one sync so a mirror page exists.
    let acc = claim_account(&pool, PROVIDER_CALDAV, "you · https://x", "basic")
        .await
        .unwrap();
    let cal = upsert_sync_calendar_impl(&pool, &acc.id, "cal-a", "Work", None)
        .await
        .unwrap();
    toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();
    let provider = Scripted::new(one_event_delta("href-1", "uid-1", "Standup", "tok-1"));
    resync_account(&pool, &provider, &acc.id).await.unwrap();

    let acc2 = claim_account(&pool, PROVIDER_CALDAV, "you · https://x", "basic")
        .await
        .unwrap();
    assert_eq!(
        acc2.id, acc.id,
        "reconnect reuses the active row, no new account"
    );
    upsert_sync_calendar_impl(&pool, &acc2.id, "cal-a", "Work", None)
        .await
        .unwrap();

    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_account")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(accounts, 1, "no duplicate account");
    let cals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_calendar")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cals, 1, "no duplicate calendar");
    let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(folders, 1, "no duplicate folder");

    let provider2 = Scripted::new(one_event_delta("href-1", "uid-1", "Standup", "tok-2"));
    resync_account(&pool, &provider2, &acc.id).await.unwrap();
    let pages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_sync WHERE ical_uid = 'uid-1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pages, 1, "event not duplicated across reconnect");
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

    let provider = OneShot {
        token: "tok-1".into(),
    };
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

// ─── refresh (full re-read) ─────────────────────────────────────────────────────

/// One account with one enabled calendar, already backfilled — the state a refresh
/// starts from. Returns the account id and the sync_calendar row id.
async fn synced_account(pool: &sqlx::SqlitePool) -> (String, String) {
    let acc = insert_sync_account_impl(pool, PROVIDER_CALDAV, "you · https://x", "basic")
        .await
        .unwrap();
    let cal = upsert_sync_calendar_impl(pool, &acc.id, "cal-a", "Work", None)
        .await
        .unwrap();
    toggle_sync_calendar_impl(pool, &cal.id, true, None)
        .await
        .unwrap();
    let provider = Scripted::new(backfill(
        vec![one_event("href-1", "uid-1", "Standup")],
        "2026-06-01",
        "tok-1",
    ));
    resync_account(pool, &provider, &acc.id).await.unwrap();
    (acc.id, cal.id)
}

/// A refresh re-reads everything, so it has to cost nothing for the events that
/// didn't change. If the reconciler's etag no-op failed to hold across the
/// re-delivery, every refresh would restamp the whole calendar and float it to the
/// top of any recently-edited view (invariant 5) — which would make the action
/// itself the reason not to use it.
#[tokio::test]
async fn a_refresh_re_enumerates_without_churning_unchanged_pages() {
    let pool = test_pool().await;
    let (account_id, cal_row_id) = synced_account(&pool).await;

    // A sentinel makes the churn assertion sharp: any write at all moves it, even
    // one landing in the same millisecond the refresh would have stamped.
    sqlx::query("UPDATE pages SET updated_at = '2000-01-01T00:00:00.000Z'")
        .execute(&pool)
        .await
        .unwrap();

    let provider = Scripted::new(backfill(
        vec![one_event("href-1", "uid-1", "Standup")],
        "2026-06-01",
        "tok-2",
    ));
    refresh_account(&pool, &provider, &account_id).await.unwrap();

    assert_eq!(
        provider.seen_since.borrow().as_slice(),
        &[None],
        "the stored cursor is dropped, so the provider re-enumerates"
    );
    let updated_at: String = sqlx::query_scalar("SELECT updated_at FROM pages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        updated_at, "2000-01-01T00:00:00.000Z",
        "unchanged event re-delivered, not rewritten"
    );
    let (token, ctag): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT sync_token, ctag FROM sync_calendar WHERE id = ?")
            .bind(&cal_row_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(token.as_deref(), Some("tok-2"), "cursor re-established");
    assert_eq!(ctag, None, "no ctag offered by this provider");
}

/// The hole C65 exists to close: an upstream deletion that never reached an
/// incremental delta — nothing was polling when it happened — leaves a mirror the
/// cursor will never revisit. Only a cursor-less enumerate is authoritative enough
/// to sweep it, and until this action the sole way to force one was the
/// disable→enable toggle, which tears down the pages it is meant to repair.
#[tokio::test]
async fn a_refresh_sweeps_an_upstream_deletion_a_resync_cannot_see() {
    let pool = test_pool().await;
    let (account_id, _) = synced_account(&pool).await;

    // Upstream the event is gone: a cursor-less enumerate returns nothing and says
    // so authoritatively, while a poll from the stored cursor carries no removal —
    // the deletion happened behind it. One provider, so the only thing separating
    // the two calls below is whether the cursor survived.
    let provider = Scripted::per_cursor(
        backfill(vec![], "2026-06-01", "tok-3"),
        SyncDelta {
            next_token: Some(SyncToken("tok-2".into())),
            ..Default::default()
        },
    );

    resync_account(&pool, &provider, &account_id).await.unwrap();
    assert_eq!(
        page_count(&pool).await,
        1,
        "an incremental poll can't know the event is gone"
    );

    refresh_account(&pool, &provider, &account_id)
        .await
        .unwrap();
    assert_eq!(page_count(&pool).await, 0, "ghost mirror swept");
}

#[tokio::test]
async fn connect_caldav_persists_nothing_when_discovery_fails() {
    // connect_caldav validates by discovering first, so a failure must leave no
    // half-built account or keychain entry. A malformed URL fails at the parse step
    // (no network), exercising that ordering without a live server.
    let pool = test_pool().await;
    let keychain = Keychain::with_store(Box::new(MemoryStore::default()));

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

    assert!(
        matches!(err, AppError::Invalid(_)),
        "bad URL surfaces as user-actionable"
    );
    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_account")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        accounts, 0,
        "no account row written before discovery succeeds"
    );
}

#[tokio::test]
async fn reconnect_caldav_keeps_the_working_credential_when_the_new_password_fails() {
    let pool = test_pool().await;
    let store = MemoryStore::default();
    let account = insert_sync_account_impl(&pool, PROVIDER_CALDAV, "you · https://x", "basic")
        .await
        .unwrap();
    set_reconnect_needed(&pool, &account.id, true)
        .await
        .unwrap();
    // A malformed stored URL fails discovery at the parse step, no network — and
    // proves the server/username come from the blob, since the caller passes neither.
    let stored = CaldavCredentials {
        base_url: "not a valid url".into(),
        username: "you".into(),
        password: "old".into(),
    };
    store.set(&account.id, &stored.to_blob().unwrap()).unwrap();

    let err = reconnect_caldav(
        &pool,
        Keychain::with_store(Box::new(store.clone())),
        &account.id,
        "new".into(),
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AppError::Invalid(_)));
    let kept = CaldavCredentials::from_blob(&store.get(&account.id).unwrap()).unwrap();
    assert_eq!(kept.password, "old", "a rejected password is not stored");
    let still_flagged = get_sync_account_impl(&pool, &account.id)
        .await
        .unwrap()
        .reconnect_needed;
    assert!(still_flagged, "the account stays out of the poll loop");
}

#[tokio::test]
async fn reconnect_caldav_refuses_a_google_account() {
    let pool = test_pool().await;
    let account = insert_sync_account_impl(&pool, PROVIDER_GOOGLE, "you@gmail.com", "oauth")
        .await
        .unwrap();

    let err = reconnect_caldav(&pool, memory_keychain(), &account.id, "pw".into())
        .await
        .unwrap_err();

    assert!(matches!(err, AppError::Invalid(_)));
}
