use super::*;
use crate::now_iso;
use crate::pool::{insert_test_folder, insert_test_page, test_pool, TestPage};

// ─── helpers — raw inserts (no writers exist yet) ─────────────────────────────

async fn insert_account(pool: &sqlx::SqlitePool, id: &str, provider: &str, auth_kind: &str) {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(provider)
    .bind(format!("{id} account"))
    .bind(auth_kind)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_calendar(pool: &sqlx::SqlitePool, id: &str, account_id: &str, calendar_id: &str) {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_calendar
         (id, account_id, calendar_id, display_name, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(id)
    .bind(account_id)
    .bind(calendar_id)
    .bind(format!("{calendar_id} cal"))
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
}

#[allow(clippy::too_many_arguments)]
async fn insert_page_sync(
    pool: &sqlx::SqlitePool,
    id: &str,
    page_id: &str,
    account_id: &str,
    calendar_id: &str,
    external_id: &str,
    ical_uid: &str,
) -> Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO page_sync
         (id, page_id, account_id, provider, calendar_id, external_id, ical_uid, created_at)
         VALUES (?, ?, ?, 'caldav', ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(account_id)
    .bind(calendar_id)
    .bind(external_id)
    .bind(ical_uid)
    .bind(&now)
    .execute(pool)
    .await
}

// ─── tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn row_structs_round_trip() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Cal").await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Event"))
        .await
        .unwrap();
    insert_account(&pool, "a1", "caldav", "basic").await;
    insert_calendar(&pool, "c1", "a1", "calhref").await;
    insert_page_sync(&pool, "ps1", "p1", "a1", "calhref", "/dav/ev1.ics", "uid-1")
        .await
        .unwrap();

    let account = sqlx::query_as::<_, SyncAccountRow>("SELECT * FROM sync_account WHERE id = ?")
        .bind("a1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(account.provider, "caldav");
    assert_eq!(account.auth_kind, "basic");

    let calendar = sqlx::query_as::<_, SyncCalendarRow>("SELECT * FROM sync_calendar WHERE id = ?")
        .bind("c1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(calendar.enabled);
    assert_eq!(calendar.calendar_id, "calhref");
    assert!(calendar.sync_token.is_none());

    let ps = sqlx::query_as::<_, PageSyncRow>("SELECT * FROM page_sync WHERE id = ?")
        .bind("ps1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ps.sync_state, "active"); // default
    assert!(!ps.user_modified); // default 0
    assert_eq!(ps.external_id, "/dav/ev1.ics");
    assert_eq!(ps.ical_uid, "uid-1");
    assert!(ps.seeded_description_hash_version.is_none());
}

#[tokio::test]
async fn folders_default_to_non_external() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Regular").await.unwrap();
    let flag: bool = sqlx::query_scalar("SELECT is_external_calendar FROM folders WHERE id = ?")
        .bind("f1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!flag, "existing/new folders must default to non-external");
}

#[tokio::test]
async fn per_calendar_dedup_unique_holds() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "A"))
        .await
        .unwrap();
    insert_test_page(&pool, TestPage::new("p2", "B"))
        .await
        .unwrap();
    insert_account(&pool, "a1", "caldav", "basic").await;

    insert_page_sync(&pool, "ps1", "p1", "a1", "cal", "/ev.ics", "uid-1")
        .await
        .unwrap();
    // Same (account, calendar, external_id) → UNIQUE rejects (TickTick dup gripe).
    let dup = insert_page_sync(&pool, "ps2", "p2", "a1", "cal", "/ev.ics", "uid-1").await;
    assert!(dup.is_err(), "duplicate sync identity must be rejected");
}

#[tokio::test]
async fn same_uid_across_calendars_is_allowed() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "A"))
        .await
        .unwrap();
    insert_test_page(&pool, TestPage::new("p2", "B"))
        .await
        .unwrap();
    insert_account(&pool, "a1", "caldav", "basic").await;

    // Same meeting (same ical_uid) on two calendars = two pages, not merged.
    insert_page_sync(&pool, "ps1", "p1", "a1", "cal-A", "/A/ev.ics", "uid-shared")
        .await
        .unwrap();
    insert_page_sync(&pool, "ps2", "p2", "a1", "cal-B", "/B/ev.ics", "uid-shared")
        .await
        .unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_sync WHERE ical_uid = ?")
        .bind("uid-shared")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn page_hard_delete_cascades_link() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "A"))
        .await
        .unwrap();
    insert_account(&pool, "a1", "caldav", "basic").await;
    insert_page_sync(&pool, "ps1", "p1", "a1", "cal", "/ev.ics", "uid-1")
        .await
        .unwrap();

    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind("p1")
        .execute(&pool)
        .await
        .unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_sync")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "hard-deleting a page must clear its page_sync row"
    );
}

/// The migration must apply cleanly on a database that already holds recurrence
/// data, without rebuilding `page_recurrence_rules`. This asserts the new sync
/// tables coexist with a real recurrence rule and that the existing recurrence
/// row is intact — a table rebuild would have been needed to relax its NOT NULL
/// timezone, which we avoid by stamping a sentinel zone instead.
#[tokio::test]
async fn coexists_with_populated_recurrence_data() {
    let pool = test_pool().await;
    let now = now_iso();
    insert_test_folder(&pool, "f1", "Cal").await.unwrap();
    insert_test_page(
        &pool,
        TestPage {
            folder_id: Some("f1"),
            ..TestPage::new("p1", "Weekly standup")
        },
    )
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, scheduled_start, timezone, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind("r1")
    .bind("p1")
    .bind("FREQ=WEEKLY;BYDAY=MO")
    .bind("2026-06-15T09:00:00")
    .bind("UTC") // sentinel — NOT NULL satisfied, no constraint relaxation
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    insert_account(&pool, "a1", "caldav", "basic").await;
    insert_calendar(&pool, "c1", "a1", "cal").await;
    insert_page_sync(&pool, "ps1", "p1", "a1", "cal", "/ev.ics", "uid-1")
        .await
        .unwrap();

    let rule_tz: String =
        sqlx::query_scalar("SELECT timezone FROM page_recurrence_rules WHERE id = ?")
            .bind("r1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rule_tz, "UTC");
}

#[tokio::test]
async fn account_removal_cascades_sync_rows() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "A"))
        .await
        .unwrap();
    insert_account(&pool, "a1", "caldav", "basic").await;
    insert_calendar(&pool, "c1", "a1", "cal").await;
    insert_page_sync(&pool, "ps1", "p1", "a1", "cal", "/ev.ics", "uid-1")
        .await
        .unwrap();

    sqlx::query("DELETE FROM sync_account WHERE id = ?")
        .bind("a1")
        .execute(&pool)
        .await
        .unwrap();

    let cal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_calendar")
        .fetch_one(&pool)
        .await
        .unwrap();
    let ps_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_sync")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cal_count, 0);
    assert_eq!(ps_count, 0);
}
