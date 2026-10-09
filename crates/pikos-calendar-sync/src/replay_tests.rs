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

/// Connect as a person does, turn the named calendars on, and sync them. One keychain store
/// throughout, so the sync reads the credential the connect stored. Returns the account and that
/// store, for a test that syncs again.
async fn connect_and_sync(
    pool: &sqlx::SqlitePool,
    base_url: &str,
    calendars: &[&str],
) -> (String, MemoryStore) {
    connect_and_sync_as(pool, base_url, ("pikos", "replay-password"), calendars).await
}

async fn connect_and_sync_as(
    pool: &sqlx::SqlitePool,
    base_url: &str,
    (username, password): (&str, &str),
    calendars: &[&str],
) -> (String, MemoryStore) {
    let store = MemoryStore::default();
    let connected = connect_caldav(
        pool,
        Keychain::with_store(Box::new(store.clone())),
        base_url.to_string(),
        username.to_string(),
        password.to_string(),
        "Replay".to_string(),
    )
    .await
    .expect("connect");
    for name in calendars {
        let calendar = connected
            .calendars
            .iter()
            .find(|c| c.display_name == *name)
            .unwrap_or_else(|| panic!("{name} was discovered"));
        pikos_db::sync_commands::toggle_sync_calendar_impl(pool, &calendar.id, true, None)
            .await
            .unwrap_or_else(|e| panic!("turn {name} on: {e}"));
    }
    sync(pool, &connected.account.id, &store).await;
    (connected.account.id, store)
}

async fn sync(pool: &sqlx::SqlitePool, account_id: &str, store: &MemoryStore) {
    let results = resync_account_auto(
        pool,
        Keychain::with_store(Box::new(store.clone())),
        account_id,
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

    connect_and_sync(&pool, &replay.url, &["Home"]).await;

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
    connect_and_sync(&pool, &replay.url, &["Home"]).await;
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

    connect_and_sync(&pool, &replay.url, &["Home"]).await;

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

/// Writes a fixture when `scripts/record-sync.sh caldav` runs it against a live server, through the
/// same connect and sync the app uses. The account is `CALDAV_USER` and `CALDAV_PASSWORD`, the
/// calendars turned on are `PIKOS_RECORD_CALENDARS`, and both default to the local Radicale the
/// first fixture came from. With `PIKOS_RECORD_POLL_SECS` it goes on syncing every ten seconds that
/// long, so changes made upstream meanwhile are recorded as the app would see them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "records a live server through the recording proxy; see scripts/record-sync.sh"]
async fn record_a_live_caldav_calendar() {
    let env = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
    let url = std::env::var("PIKOS_CALDAV_URL").expect("PIKOS_CALDAV_URL");
    let (user, password) = (
        env("CALDAV_USER", "pikos"),
        env("CALDAV_PASSWORD", "replay-password"),
    );
    let calendars = env("PIKOS_RECORD_CALENDARS", "Home");
    let calendars: Vec<&str> = calendars.split(',').map(str::trim).collect();
    let poll_secs: u64 = env("PIKOS_RECORD_POLL_SECS", "0")
        .parse()
        .expect("PIKOS_RECORD_POLL_SECS");
    let pool = pikos_db::test_pool().await;

    let (account_id, store) =
        connect_and_sync_as(&pool, &url, (&user, &password), &calendars).await;
    eprintln!(
        "Synced {} pages.",
        scalar::<i64>(&pool, "SELECT COUNT(*) FROM pages").await
    );

    for left in (0..poll_secs / 10).rev() {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        sync(&pool, &account_id, &store).await;
        eprintln!(
            "Synced again: {} pages. {}s left.",
            scalar::<i64>(&pool, "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL").await,
            left * 10
        );
    }
}

/// Every page a sync produced: title, folder, then each schedule row's start, end, zone and the
/// occurrence it overrides, with the page's rule and exclusions. One row per schedule row.
type Synced = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn synced(pool: &sqlx::SqlitePool) -> Vec<Synced> {
    sqlx::query_as(
        "SELECT p.title, f.name, s.scheduled_start, s.scheduled_end, s.timezone, s.original_date,
                r.rrule || ' ' || r.rrule_exdates
         FROM pages p JOIN folders f ON f.id = p.folder_id
         LEFT JOIN page_schedules s ON s.page_id = p.id
         LEFT JOIN page_recurrence_rules r ON r.page_id = p.id
         WHERE p.deleted_at IS NULL ORDER BY p.title, s.scheduled_start",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

fn row(title: &str, folder: &str, [start, end, zone, original, rule]: [Option<&str>; 5]) -> Synced {
    let own = |v: Option<&str>| v.map(str::to_string);
    (
        title.into(),
        folder.into(),
        own(start),
        own(end),
        own(zone),
        own(original),
        own(rule),
    )
}

/// The seed corpus, `S-01` to `S-22`, as Fastmail serves it. Fastmail holds one copy of an event
/// per account, so the shared kickoff is in the second calendar only, and the summer course ended
/// before the sync window, so it never arrives.
fn seeded() -> Vec<Synced> {
    let (la, london, tokyo) = (
        Some("America/Los_Angeles"),
        Some("Europe/London"),
        Some("Asia/Tokyo"),
    );
    let qa = "Pikos QA";
    let series = |rule| [None, None, None, None, Some(rule)];
    vec![
        row(
            "Anniversary",
            qa,
            series("FREQ=YEARLY;BYMONTHDAY=15;BYMONTH=3 []"),
        ),
        row("Book club", qa, series("FREQ=MONTHLY;BYDAY=3TU []")),
        row(
            "Company offsite",
            qa,
            [Some("2026-10-16"), Some("2026-10-16"), None, None, None],
        ),
        row(
            "Dentist",
            qa,
            [
                Some("2026-10-15T14:00:00"),
                Some("2026-10-15T14:45:00"),
                la,
                None,
                None,
            ],
        ),
        row(
            "Design review (London)",
            qa,
            [
                Some("2026-10-14T15:00:00"),
                Some("2026-10-14T16:00:00"),
                london,
                None,
                None,
            ],
        ),
        row(
            "Flight check-in",
            qa,
            [
                Some("2026-10-18T07:00:00"),
                Some("2026-10-18T07:30:00"),
                la,
                None,
                None,
            ],
        ),
        row(
            "Floating wake-up",
            qa,
            [
                Some("2026-10-14T08:00:00"),
                Some("2026-10-14T08:15:00"),
                None,
                None,
                None,
            ],
        ),
        row("Gym", qa, series("FREQ=WEEKLY;BYDAY=MO []")),
        row(
            "On-call rotation",
            qa,
            [
                Some("2026-10-29"),
                Some("2026-10-29"),
                None,
                Some("2026-10-27"),
                Some(r#"FREQ=WEEKLY;BYDAY=TU ["2026-10-20"]"#),
            ],
        ),
        row("Physio", qa, series("FREQ=WEEKLY;COUNT=3;BYDAY=MO []")),
        row(
            "Product summit",
            qa,
            [Some("2026-10-19"), Some("2026-10-21"), None, None, None],
        ),
        row(
            "Recurring review",
            qa,
            [
                Some("2026-10-28T14:00:00"),
                Some("2026-10-28T14:30:00"),
                la,
                Some("2026-10-26T11:00:00"),
                Some(r#"FREQ=WEEKLY;BYDAY=MO ["2026-10-19T11:00:00"]"#),
            ],
        ),
        row(
            "Recurring review",
            qa,
            [
                Some("2026-10-30T11:00:00"),
                Some("2026-10-30T11:30:00"),
                la,
                Some("2026-11-02T11:00:00"),
                Some(r#"FREQ=WEEKLY;BYDAY=MO ["2026-10-19T11:00:00"]"#),
            ],
        ),
        row("Rent due", qa, series("FREQ=MONTHLY;BYMONTHDAY=-1 []")),
        row(
            "Shared kickoff",
            "Pikos QA B",
            [
                Some("2026-10-16T10:00:00"),
                Some("2026-10-16T11:00:00"),
                la,
                None,
                None,
            ],
        ),
        row(
            "Swim class (term ends)",
            qa,
            series("FREQ=WEEKLY;UNTIL=20261114T133000;BYDAY=SA []"),
        ),
        row(
            "Swim practice",
            qa,
            series("FREQ=WEEKLY;COUNT=4;BYDAY=TH []"),
        ),
        row(
            "Team retro",
            qa,
            series("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3 []"),
        ),
        row(
            "Team standup",
            qa,
            [
                Some("2026-10-13T09:30:00"),
                Some("2026-10-13T09:45:00"),
                la,
                None,
                None,
            ],
        ),
        row(
            "Tokyo sync",
            qa,
            [
                Some("2026-10-15T10:00:00"),
                Some("2026-10-15T10:30:00"),
                tokyo,
                None,
                None,
            ],
        ),
        row(
            "Trip notes: Tom & Jerry's <draft>",
            qa,
            [
                Some("2026-10-17T12:00:00"),
                Some("2026-10-17T13:00:00"),
                la,
                None,
                None,
            ],
        ),
        row(
            "Weekly sync",
            qa,
            [
                Some("2026-10-22T13:00:00"),
                Some("2026-10-22T13:30:00"),
                la,
                Some("2026-10-21T13:00:00"),
                Some("FREQ=WEEKLY;BYDAY=WE []"),
            ],
        ),
    ]
}

/// `rows` after the five edits `seed.py cycle` makes upstream: the standup renamed, the London
/// review two hours later, one more weekly review cancelled, and the offsite deleted. The fifth,
/// a line added to the trip notes, is in the body rather than these rows.
fn with_upstream_edits(mut rows: Vec<Synced>) -> Vec<Synced> {
    rows.retain(|r| r.0 != "Company offsite");
    for r in &mut rows {
        match r.0.as_str() {
            "Team standup" => r.0 = "Team standup (new room)".into(),
            "Design review (London)" => {
                r.2 = Some("2026-10-14T17:00:00".into());
                r.3 = Some("2026-10-14T18:00:00".into());
            }
            "Recurring review" => {
                r.6 = Some(
                    r#"FREQ=WEEKLY;BYDAY=MO ["2026-10-19T11:00:00","2026-11-09T11:00:00"]"#.into(),
                )
            }
            _ => {}
        }
    }
    rows
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_fastmail_account_syncs_every_seeded_shape() {
    let replay = Replay::start(&fixture(&recording("fastmail"))).await;
    let pool = pikos_db::test_pool().await;

    connect_and_sync(&pool, &replay.url, &["Pikos QA", "Pikos QA B"]).await;

    assert_eq!(replay.unanswered(), Vec::<String>::new());
    assert_eq!(synced(&pool).await, seeded());
    assert_eq!(
        scalar::<i64>(&pool, "SELECT COUNT(*) FROM page_reminders").await,
        0,
        "a provider alarm never becomes a Pikos reminder"
    );
}

/// What the seed wrote as the trip notes' description, with its trailing newline.
const TRIP_NOTES: &str = "Packing & logistics: don't forget <passport>, 'adapters', snacks.\n\
Itinéraire : Zürich → Kyōto → São Paulo. 東京で会いましょう。Привет! 🧳✈️🌏🍣\n\
Budget 1,200 €; check-in by 7am; seats 14A & 14B.\n";

// qa: SYNC-14
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_long_description_with_markup_characters_reads_back_from_fastmail_intact() {
    let replay = Replay::start(&fixture(&recording("fastmail"))).await;
    let pool = pikos_db::test_pool().await;

    connect_and_sync(&pool, &replay.url, &["Pikos QA", "Pikos QA B"]).await;

    let text: String = scalar(
        &pool,
        "SELECT content_text FROM pages WHERE title = 'Trip notes: Tom & Jerry''s <draft>'",
    )
    .await;
    assert_eq!(text, TRIP_NOTES.repeat(12).trim_end());
}

/// Fastmail's later polls answer an unchanged calendar with an empty change list. Read as a full
/// listing, that would sweep every event away, so two more syncs must leave every page as it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fastmail_polls_that_report_no_change_leave_every_page_untouched() {
    let replay = Replay::start(&fixture(&recording("fastmail"))).await;
    let pool = pikos_db::test_pool().await;
    let (account_id, store) =
        connect_and_sync(&pool, &replay.url, &["Pikos QA", "Pikos QA B"]).await;
    let state = || async {
        let pages: Vec<(String, String, Option<String>)> =
            sqlx::query_as("SELECT id, updated_at, deleted_at FROM pages ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        let tokens: Vec<Option<String>> = sqlx::query_scalar(
            "SELECT sync_token FROM sync_calendar WHERE enabled = 1 ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        (pages, tokens, synced(&pool).await)
    };
    let before = state().await;
    assert!(
        before.1.iter().all(Option::is_some),
        "the first sync stored a sync token"
    );

    sync(&pool, &account_id, &store).await;
    sync(&pool, &account_id, &store).await;

    assert_eq!(replay.unanswered(), Vec::<String>::new());
    assert_eq!(state().await, before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connecting_fastmail_lists_its_calendars_with_every_one_off() {
    let replay = Replay::start(&fixture(&recording("fastmail"))).await;
    let pool = pikos_db::test_pool().await;

    let connected = connect_caldav(
        &pool,
        Keychain::with_store(Box::new(MemoryStore::default())),
        replay.url.clone(),
        "pikos".to_string(),
        "replay-password".to_string(),
        "Replay".to_string(),
    )
    .await
    .expect("connect");

    let mut names: Vec<&str> = connected
        .calendars
        .iter()
        .map(|c| c.display_name.as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["Pikos QA", "Pikos QA B"]);
    assert_eq!(
        scalar::<i64>(
            &pool,
            "SELECT COUNT(*) FROM sync_calendar WHERE enabled = 1"
        )
        .await,
        0
    );
    assert_eq!(scalar::<i64>(&pool, "SELECT COUNT(*) FROM pages").await, 0);
}

/// After the first sync the recording carries the five edits `seed.py cycle` made on Fastmail,
/// then the poll that picked them up. Syncing until the recording is spent must land each one and
/// leave every other shape as seeded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changes_made_on_fastmail_reach_pikos() {
    let replay = Replay::start(&fixture(&recording("fastmail"))).await;
    let pool = pikos_db::test_pool().await;
    let (account_id, store) =
        connect_and_sync(&pool, &replay.url, &["Pikos QA", "Pikos QA B"]).await;

    for _ in 0..20 {
        if replay.spent() {
            break;
        }
        sync(&pool, &account_id, &store).await;
    }

    assert!(replay.spent(), "twenty syncs didn't use up the recording");
    assert_eq!(replay.unanswered(), Vec::<String>::new());
    let expected = with_upstream_edits(seeded());
    assert_eq!(synced(&pool).await, expected);
    let text: String = scalar(
        &pool,
        "SELECT content_text FROM pages WHERE title = 'Trip notes: Tom & Jerry''s <draft>'",
    )
    .await;
    assert_eq!(text, TRIP_NOTES.repeat(12) + "Updated upstream.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_fastmail_password_fails_and_keeps_nothing() {
    let replay = Replay::start(&fixture(&recording("fastmail-wrong-password"))).await;
    let pool = pikos_db::test_pool().await;
    let store = MemoryStore::default();

    let err = connect_caldav(
        &pool,
        Keychain::with_store(Box::new(store.clone())),
        replay.url.clone(),
        "pikos".to_string(),
        "wrong-password".to_string(),
        "Replay".to_string(),
    )
    .await
    .expect_err("a wrong password doesn't connect");

    assert!(
        err.to_string()
            .contains("check the username and app password"),
        "{err}"
    );
    assert_eq!(
        scalar::<i64>(&pool, "SELECT COUNT(*) FROM sync_account").await,
        0
    );
    assert_eq!(
        scalar::<i64>(&pool, "SELECT COUNT(*) FROM sync_calendar").await,
        0
    );
    assert!(store.is_empty(), "nothing reached the keychain");
}

/// Connect a Google account as a person does, from the calendar list a fresh grant reads, then
/// turn its QA calendar on and sync. The OAuth half is skipped: replaying needs no grant.
async fn connect_and_sync_google(
    pool: &sqlx::SqlitePool,
    google: &crate::google::replay_provider::ReplayGoogle,
) -> String {
    let (remote, display_name) = google.list_for_connect().await.expect("list calendars");
    let credentials = crate::google::GoogleCredentials {
        access_token: "replay-token".into(),
        refresh_token: "replay-refresh".into(),
        expires_at: None,
        granted_scopes: vec![],
    };
    let connected = crate::commands::save_google(
        pool,
        &Keychain::with_store(Box::new(MemoryStore::default())),
        &credentials,
        &display_name,
        &remote,
    )
    .await
    .expect("save the account");
    let qa = connected
        .calendars
        .iter()
        .find(|c| c.display_name == "Pikos QA")
        .expect("Pikos QA was listed");
    pikos_db::sync_commands::toggle_sync_calendar_impl(pool, &qa.id, true, None)
        .await
        .expect("turn Pikos QA on");
    sync_google(pool, google, &connected.account.id).await;
    connected.account.id
}

async fn sync_google(
    pool: &sqlx::SqlitePool,
    google: &crate::google::replay_provider::ReplayGoogle,
    account_id: &str,
) {
    let results = crate::commands::resync_account(pool, google, account_id)
        .await
        .expect("sync");
    assert!(
        results.iter().all(|r| r.status == "synced"),
        "a calendar didn't sync: {results:?}"
    );
}

/// The seed as Google holds it: no CalDAV-only shapes, and the yearly rule's parts in Google's
/// own order.
fn seeded_google() -> Vec<Synced> {
    let caldav_only = ["Floating wake-up", "Dentist", "Shared kickoff"];
    let mut rows = seeded();
    rows.retain(|r| !caldav_only.contains(&r.0.as_str()));
    for r in &mut rows {
        if r.0 == "Anniversary" {
            r.6 = Some("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15 []".into());
        }
    }
    rows
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_google_account_syncs_every_seeded_shape() {
    let replay = Replay::start(&fixture(&recording("google"))).await;
    let pool = pikos_db::test_pool().await;
    let google = crate::google::replay_provider::ReplayGoogle::new(&replay.url);

    connect_and_sync_google(&pool, &google).await;

    assert_eq!(replay.unanswered(), Vec::<String>::new());
    assert_eq!(synced(&pool).await, seeded_google());
    let text: String = scalar(
        &pool,
        "SELECT content_text FROM pages WHERE title = 'Trip notes: Tom & Jerry''s <draft>'",
    )
    .await;
    assert_eq!(text, TRIP_NOTES.repeat(12).trim_end());
    assert_eq!(
        scalar::<i64>(&pool, "SELECT COUNT(*) FROM page_reminders").await,
        0,
        "a provider alarm never becomes a Pikos reminder"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changes_made_in_google_calendar_reach_pikos() {
    let replay = Replay::start(&fixture(&recording("google"))).await;
    let pool = pikos_db::test_pool().await;
    let google = crate::google::replay_provider::ReplayGoogle::new(&replay.url);
    let account_id = connect_and_sync_google(&pool, &google).await;

    for _ in 0..20 {
        if replay.spent() {
            break;
        }
        sync_google(&pool, &google, &account_id).await;
    }

    assert!(replay.spent(), "twenty syncs didn't use up the recording");
    assert_eq!(replay.unanswered(), Vec::<String>::new());
    assert_eq!(synced(&pool).await, with_upstream_edits(seeded_google()));
    // Google's editor saved the edit as HTML, having already read `<passport>` as a tag and
    // dropped it, so this is the text Google itself shows, blank lines included.
    let body: String = scalar(
        &pool,
        "SELECT content FROM pages WHERE title = 'Trip notes: Tom & Jerry''s <draft>'",
    )
    .await;
    assert_eq!(
        body,
        pikos_db::build_tiptap_doc(
            &(TRIP_NOTES.replace("<passport>", "").repeat(12) + "\n\nUpdated upstream")
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_icloud_account_syncs_every_seeded_shape() {
    let replay = Replay::start(&fixture(&recording("icloud"))).await;
    let pool = pikos_db::test_pool().await;

    connect_and_sync(&pool, &replay.url, &["Pikos QA", "Pikos QA B"]).await;

    assert_eq!(replay.unanswered(), Vec::<String>::new());
    assert_eq!(synced(&pool).await, seeded());
    let text: String = scalar(
        &pool,
        "SELECT content_text FROM pages WHERE title = 'Trip notes: Tom & Jerry''s <draft>'",
    )
    .await;
    assert_eq!(text, TRIP_NOTES.repeat(12).trim_end());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changes_made_on_icloud_reach_pikos() {
    let replay = Replay::start(&fixture(&recording("icloud"))).await;
    let pool = pikos_db::test_pool().await;
    let (account_id, store) =
        connect_and_sync(&pool, &replay.url, &["Pikos QA", "Pikos QA B"]).await;

    for _ in 0..30 {
        if replay.spent() {
            break;
        }
        sync(&pool, &account_id, &store).await;
    }

    assert!(replay.spent(), "thirty syncs didn't use up the recording");
    assert_eq!(replay.unanswered(), Vec::<String>::new());
    assert_eq!(synced(&pool).await, with_upstream_edits(seeded()));
    let text: String = scalar(
        &pool,
        "SELECT content_text FROM pages WHERE title = 'Trip notes: Tom & Jerry''s <draft>'",
    )
    .await;
    assert_eq!(text, TRIP_NOTES.repeat(12) + "Updated upstream.");
}
