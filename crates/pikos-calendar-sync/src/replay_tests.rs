//! Sync against recorded provider exchanges: the real CalDAV client, the real reconciler, a
//! server that only replays. See `replay.rs` for how requests are matched.

use chrono::NaiveDate;

use crate::keychain::Keychain;
use crate::replay::{Fixture, Replay};
use crate::test_support::MemoryStore;
use crate::{connect_caldav, resync_account_auto};

/// Read when the test runs, so the recording test still builds before its fixture exists.
fn recording(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/sync-replay/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}
/// Past this, a recording fails rather than passes: a provider changes, and a stale exchange would
/// go on proving behaviour it no longer has. Re-record with `scripts/record-sync.sh`.
const FRESH_FOR_DAYS: i64 = 180;

/// Connect as a person does, turn the calendar on, and sync it. One keychain store throughout, so
/// the sync reads the credential the connect stored.
async fn connect_and_sync(pool: &sqlx::SqlitePool, base_url: &str) {
    let store = MemoryStore::default();
    let connected = connect_caldav(
        pool,
        Keychain::with_store(Box::new(store.clone())),
        base_url.to_string(),
        "pikos".to_string(),
        "replay-password".to_string(),
        "Replay".to_string(),
    )
    .await
    .expect("connect");
    let home = connected
        .calendars
        .iter()
        .find(|c| c.display_name == "Home")
        .expect("the Home calendar was discovered");
    pikos_db::sync_commands::toggle_sync_calendar_impl(pool, &home.id, true, None)
        .await
        .expect("turn Home on");
    let results = resync_account_auto(
        pool,
        Keychain::with_store(Box::new(store)),
        &connected.account.id,
    )
    .await
    .expect("sync");
    assert!(
        results.iter().all(|r| r.status == "synced"),
        "a calendar didn't sync: {results:?}"
    );
}

fn fixture(json: &str) -> Fixture {
    let fixture: Fixture = serde_json::from_str(json).expect("parse the fixture");
    let recorded = NaiveDate::parse_from_str(&fixture.recorded, "%Y-%m-%d").expect("recorded date");
    let age = (chrono::Local::now().date_naive() - recorded).num_days();
    assert!(
        age <= FRESH_FOR_DAYS,
        "this recording is {age} days old; re-record it with scripts/record-sync.sh"
    );
    fixture
}

async fn scalar<T>(pool: &sqlx::SqlitePool, sql: &str) -> T
where
    T: for<'r> sqlx::Decode<'r, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite> + Send + Unpin,
{
    sqlx::query_scalar(sql).fetch_one(pool).await.expect(sql)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_radicale_calendar_syncs_to_its_three_shapes() {
    let replay = Replay::start(&fixture(&recording("radicale"))).await;
    let pool = pikos_db::test_pool().await;

    connect_and_sync(&pool, &replay.url).await;

    assert_eq!(replay.unanswered(), Vec::<String>::new());
    let titles: Vec<String> =
        sqlx::query_scalar("SELECT title FROM pages WHERE deleted_at IS NULL ORDER BY title")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(titles, ["Company offsite", "Design review", "Team standup"]);

    // A timed one-off keeps its own zone's wall clock.
    let review: (String, String) = sqlx::query_as(
        "SELECT s.scheduled_start, s.timezone FROM page_schedules s
         JOIN pages p ON p.id = s.page_id WHERE p.title = 'Design review'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        review,
        ("2026-10-07T10:00:00".into(), "America/Los_Angeles".into())
    );

    // An all-day day is a date, with no zone.
    let offsite: String = scalar(
        &pool,
        "SELECT s.scheduled_start FROM page_schedules s
         JOIN pages p ON p.id = s.page_id WHERE p.title = 'Company offsite'",
    )
    .await;
    assert_eq!(offsite, "2026-10-09");

    // The series: its rule, the cancelled week, and the moved instance at its new time.
    let (rrule, exdates): (String, String) = sqlx::query_as(
        "SELECT r.rrule, r.rrule_exdates FROM page_recurrence_rules r
         JOIN pages p ON p.id = r.page_id WHERE p.title = 'Team standup'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(rrule.contains("FREQ=WEEKLY"), "{rrule}");
    assert!(exdates.contains("2026-10-12"), "{exdates}");
    let moved: String = scalar(
        &pool,
        "SELECT scheduled_start FROM page_schedules
         WHERE original_date LIKE '2026-10-19%' AND rule_id IS NOT NULL",
    )
    .await;
    assert_eq!(moved, "2026-10-19T11:00:00");
}

// qa: SYNC-08:4
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_right_password_resumes_a_flagged_account_on_the_same_row_with_its_pages() {
    let replay = Replay::start(&fixture(&recording("radicale"))).await;
    let pool = pikos_db::test_pool().await;
    connect_and_sync(&pool, &replay.url).await;
    let account_id: String = scalar(&pool, "SELECT id FROM sync_account").await;
    let pages_before: Vec<String> = sqlx::query_scalar("SELECT id FROM pages ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    pikos_db::sync_commands::set_reconnect_needed_impl(&pool, &account_id, true)
        .await
        .unwrap();

    // Discovery asks `/pikos/` twice for different answers, and a spent replay repeats only the
    // last one, so the reconnect discovers against a fresh replay.
    let rediscover = Replay::start(&fixture(&recording("radicale"))).await;
    let store = MemoryStore::default();
    let seed = Keychain::with_store(Box::new(store.clone()));
    seed.store(
        &account_id,
        &crate::caldav::CaldavCredentials {
            base_url: rediscover.url.clone(),
            username: "pikos".into(),
            password: "a-rotated-out-password".into(),
        }
        .to_blob()
        .unwrap(),
    )
    .unwrap();
    let resumed = crate::reconnect_caldav(
        &pool,
        Keychain::with_store(Box::new(store)),
        &account_id,
        "replay-password".into(),
    )
    .await
    .expect("reconnect");

    assert_eq!(resumed.account.id, account_id);
    assert!(!resumed.account.reconnect_needed);
    assert_eq!(
        scalar::<i64>(&pool, "SELECT COUNT(*) FROM sync_account").await,
        1
    );
    assert_eq!(
        scalar::<i64>(&pool, "SELECT reconnect_needed FROM sync_account").await,
        0
    );
    let pages_after: Vec<String> =
        sqlx::query_scalar("SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(pages_after, pages_before);
}

// qa: PRIV-03
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connected_accounts_password_is_nowhere_in_the_workspace_files() {
    let replay = Replay::start(&fixture(&recording("radicale"))).await;
    let dir = std::env::temp_dir().join(format!("pikos-priv03-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("workspace.sqlite");
    let pool = pikos_db::open_pool(path.to_str().unwrap()).await.unwrap();

    connect_and_sync(&pool, &replay.url).await;

    // Read while the pool is open, so the write-ahead log still holds what it has.
    for suffix in ["", "-wal", "-shm"] {
        let file = dir.join(format!("workspace.sqlite{suffix}"));
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        assert!(
            !bytes
                .windows(b"replay-password".len())
                .any(|w| w == b"replay-password"),
            "the password is in {}",
            file.display()
        );
    }
    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Writes the fixture above when `scripts/record-sync.sh` runs it against a live server.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "records a live server through the recording proxy; see scripts/record-sync.sh"]
async fn record_a_live_caldav_calendar() {
    let url = std::env::var("PIKOS_CALDAV_URL").expect("PIKOS_CALDAV_URL");
    let pool = pikos_db::test_pool().await;
    connect_and_sync(&pool, &url).await;
}
