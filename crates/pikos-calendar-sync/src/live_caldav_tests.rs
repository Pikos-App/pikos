//! The connect path against a real CalDAV server and a real Secret Service.
//!
//! Every other test of this path injects both: a scripted provider that never
//! opens a socket, and a keychain that is a `HashMap`. That combination passes
//! with no keychain backend at all, and keeps passing if discovery, credential
//! storage or the poll's credential *load* breaks, because none of them runs.
//!
//! What these ask that the rest cannot: does a connect against a server that
//! answers real CalDAV leave something a **different process** can poll with. The
//! second phase builds a fresh `Keychain` for exactly that reason — a handle this
//! process kept would prove nothing about a relaunch.
//!
//! Ignored by default and driven by `scripts/linux-sync-check.sh`, which supplies
//! the server and the session. Anything needing a desktop session stays manual.

use super::*;
use crate::keychain::Keychain;

struct LiveServer {
    base_url: String,
    username: String,
    password: String,
}

fn live_server() -> Option<LiveServer> {
    Some(LiveServer {
        base_url: std::env::var("PIKOS_CALDAV_URL").ok()?,
        username: std::env::var("PIKOS_CALDAV_USER").ok()?,
        password: std::env::var("PIKOS_CALDAV_PASS").ok()?,
    })
}

/// Fails rather than skips: an ignored test that silently does nothing when its
/// environment is missing is the shape of the problem this file exists to catch.
fn require_live_server() -> LiveServer {
    live_server().expect(
        "PIKOS_CALDAV_URL / _USER / _PASS are unset. Run this through \
         scripts/linux-sync-check.sh, which starts the server and the keyring.",
    )
}

/// Multi-threaded on purpose: the Linux keychain talks D-Bus synchronously, and on a
/// current-thread runtime that blocking call starves the runtime it waits on, failing with
/// "Did not receive a reply" (which reads like a broken keyring). Tauri's runtime is
/// multi-threaded too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a real CalDAV server and Secret Service; see scripts/linux-sync-check.sh"]
async fn a_connect_survives_into_another_process_and_polls() {
    let server = require_live_server();
    let pool = pikos_db::test_pool().await;

    let connected = connect_caldav(
        &pool,
        Keychain::system(),
        server.base_url.clone(),
        server.username.clone(),
        server.password.clone(),
        "Radicale".to_string(),
    )
    .await
    .expect("connect against the live server");

    assert!(
        !connected.calendars.is_empty(),
        "discovery came back with no calendars, so the poll below would prove nothing"
    );

    // Connecting leaves every calendar off, so a poll would touch no credential.
    pikos_db::sync_commands::toggle_sync_calendar_impl(
        &pool,
        &connected.calendars[0].id,
        true,
        None,
    )
    .await
    .expect("enable the discovered calendar");

    let results = resync_account_auto(&pool, Keychain::system(), &connected.account.id)
        .await
        .expect("resync after the credential was stored");

    assert!(!results.is_empty(), "the account polled no calendars");
    let bad: Vec<_> = results.iter().filter(|r| r.status != "synced").collect();
    assert!(
        bad.is_empty(),
        "a calendar came back needing attention rather than synced: {bad:?}"
    );

    Keychain::system()
        .delete(&connected.account.id)
        .expect("clean up the credential this test stored");
}

/// `keep_or_release`'s rollback, reached through a connect: a wrong password is the one
/// refusal a container can produce honestly.
#[tokio::test]
#[ignore = "needs a real CalDAV server; see scripts/linux-sync-check.sh"]
async fn a_refused_password_leaves_no_account_behind() {
    let server = require_live_server();
    let pool = pikos_db::test_pool().await;

    let err = connect_caldav(
        &pool,
        Keychain::system(),
        server.base_url.clone(),
        server.username.clone(),
        "not-the-password".to_string(),
        "Radicale".to_string(),
    )
    .await
    .expect_err("a wrong password must not connect");

    // Straight at the table: the panel's listing hides disconnected accounts and would read empty either way.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_account")
        .fetch_one(&pool)
        .await
        .expect("count accounts");
    assert_eq!(
        rows, 0,
        "a refused connect left an account row behind ({err})"
    );
}
