use super::*;
use crate::pool::test_pool;

/// The horizon runs from this instant. Chosen on a Monday so a weekly series
/// has occurrences at predictable offsets, and mid-morning so a same-day
/// reminder can sit on either side of it.
fn now() -> DateTime<Utc> {
    "2026-05-25T09:00:00Z".parse().expect("valid instant")
}

const DEFAULT_LEAD: i64 = 10;

fn utc() -> chrono_tz::Tz {
    chrono_tz::UTC
}

async fn horizon(pool: &SqlitePool, zone: chrono_tz::Tz, days: i64) -> Vec<UpcomingReminder> {
    upcoming_reminders(pool, now(), zone, Duration::days(days), DEFAULT_LEAD)
        .await
        .unwrap()
}

async fn insert_page(pool: &SqlitePool, id: &str, status: &str) {
    sqlx::query(
        "INSERT INTO pages
         (id, title, content, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES (?, ?, '{}', '', ?, 0, '[]', 0, '2026-05-01T00:00:00', '2026-05-01T00:00:00')",
    )
    .bind(id)
    .bind(id)
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_schedule(pool: &SqlitePool, id: &str, page_id: &str, start: &str) {
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, status, created_at)
         VALUES (?, ?, ?, 'not_started', '2026-05-01T00:00:00')",
    )
    .bind(id)
    .bind(page_id)
    .bind(start)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_reminder(pool: &SqlitePool, page_id: &str, minutes_before: i64) {
    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES (?, ?, ?, '2026-05-01T00:00:00')",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(page_id)
    .bind(minutes_before)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn a_timed_reminder_days_out_is_placed_at_start_minus_lead() {
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started").await;
    insert_schedule(&pool, "s1", "p1", "2026-05-27T14:00:00").await;
    insert_reminder(&pool, "p1", 30).await;

    let upcoming = horizon(&pool, utc(), 14).await;
    assert_eq!(upcoming.len(), 1);
    assert_eq!(upcoming[0].key, "s1#30");
    assert_eq!(upcoming[0].page_id, "p1");
    assert_eq!(upcoming[0].fire_at, "2026-05-27T13:30:00");
    assert_eq!(upcoming[0].scheduled_start, "2026-05-27T14:00:00");
}

#[tokio::test]
async fn the_horizon_is_a_hard_edge_on_both_sides() {
    let pool = test_pool().await;
    insert_page(&pool, "past", "not_started").await;
    insert_schedule(&pool, "s-past", "past", "2026-05-25T08:00:00").await;
    insert_page(&pool, "far", "not_started").await;
    insert_schedule(&pool, "s-far", "far", "2026-06-20T08:00:00").await;
    insert_page(&pool, "inside", "not_started").await;
    insert_schedule(&pool, "s-in", "inside", "2026-05-30T08:00:00").await;

    let keys: Vec<String> = horizon(&pool, utc(), 14)
        .await
        .into_iter()
        .map(|r| r.key)
        .collect();
    // No explicit rows, so the global default lead applies and the key is the
    // bare schedule id, as the desktop's default arm logs it.
    assert_eq!(keys, vec!["s-in"]);
}

#[tokio::test]
async fn a_page_without_reminders_uses_the_default_lead_and_a_sentinel_means_never() {
    let pool = test_pool().await;
    insert_page(&pool, "quiet", "not_started").await;
    insert_schedule(&pool, "s-quiet", "quiet", "2026-05-26T10:00:00").await;
    insert_reminder(&pool, "quiet", -1).await;
    insert_page(&pool, "plain", "not_started").await;
    insert_schedule(&pool, "s-plain", "plain", "2026-05-26T10:00:00").await;

    let upcoming = horizon(&pool, utc(), 7).await;
    assert_eq!(upcoming.len(), 1);
    assert_eq!(upcoming[0].key, "s-plain");
    assert_eq!(upcoming[0].minutes_before, DEFAULT_LEAD);
    assert_eq!(upcoming[0].fire_at, "2026-05-26T09:50:00");
}

#[tokio::test]
async fn done_pages_do_not_remind() {
    let pool = test_pool().await;
    insert_page(&pool, "done", "done").await;
    insert_schedule(&pool, "s-done", "done", "2026-05-26T10:00:00").await;
    assert!(horizon(&pool, utc(), 7).await.is_empty());
}

#[tokio::test]
async fn an_all_day_page_reminds_at_nine_the_day_before() {
    let pool = test_pool().await;
    insert_page(&pool, "trip", "not_started").await;
    insert_schedule(&pool, "s-trip", "trip", "2026-05-30").await;
    insert_reminder(&pool, "trip", DAY_BEFORE_MINUTES).await;
    // Without the sentinel an all-day page has no reminder at all: there is
    // no start time for a lead to count back from.
    insert_page(&pool, "other", "not_started").await;
    insert_schedule(&pool, "s-other", "other", "2026-05-31").await;

    let upcoming = horizon(&pool, utc(), 14).await;
    assert_eq!(upcoming.len(), 1);
    assert_eq!(upcoming[0].key, format!("s-trip#{DAY_BEFORE_MINUTES}"));
    assert_eq!(upcoming[0].fire_at, "2026-05-29T09:00:00");
}

#[tokio::test]
async fn two_leads_on_one_page_are_two_fires_soonest_first() {
    let pool = test_pool().await;
    insert_page(&pool, "p", "not_started").await;
    insert_schedule(&pool, "s", "p", "2026-05-26T12:00:00").await;
    insert_reminder(&pool, "p", 60).await;
    insert_reminder(&pool, "p", 5).await;

    let fires: Vec<(String, String)> = horizon(&pool, utc(), 7)
        .await
        .into_iter()
        .map(|r| (r.key, r.fire_at))
        .collect();
    assert_eq!(
        fires,
        vec![
            ("s#60".to_string(), "2026-05-26T11:00:00".to_string()),
            ("s#5".to_string(), "2026-05-26T11:55:00".to_string()),
        ]
    );
}

#[tokio::test]
async fn a_recurring_series_yields_one_fire_per_occurrence_in_the_horizon() {
    let pool = test_pool().await;
    insert_page(&pool, "standup", "not_started").await;
    sqlx::query(
        "INSERT INTO page_recurrence_rules (id, page_id, rrule, scheduled_start, timezone, created_at)
         VALUES ('r', 'standup', 'FREQ=WEEKLY;BYDAY=TU', '2026-05-19T09:30:00', 'UTC', '2026-05-01T00:00:00')",
    )
    .execute(&pool)
    .await
    .unwrap();
    insert_reminder(&pool, "standup", 15).await;

    let fires: Vec<(String, String)> = horizon(&pool, utc(), 14)
        .await
        .into_iter()
        .map(|r| (r.key, r.fire_at))
        .collect();
    // Tuesday the 26th and Tuesday the 2nd; the 9th is past the edge.
    assert_eq!(
        fires,
        vec![
            (
                "standup@2026-05-26T09:30:00#15".to_string(),
                "2026-05-26T09:15:00".to_string()
            ),
            (
                "standup@2026-06-02T09:30:00#15".to_string(),
                "2026-06-02T09:15:00".to_string()
            ),
        ]
    );
}

#[tokio::test]
async fn a_synced_page_is_placed_on_the_device_clock_from_its_source_zone() {
    let pool = test_pool().await;
    insert_page(&pool, "berlin", "not_started").await;
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, timezone, status, created_at)
         VALUES ('s-b', 'berlin', '2026-05-27T15:00:00', 'Europe/Berlin', 'not_started', '2026-05-01T00:00:00')",
    )
    .execute(&pool)
    .await
    .unwrap();
    crate::pool::insert_test_page_sync(&pool, "berlin", "active")
        .await
        .unwrap();
    insert_reminder(&pool, "berlin", 30).await;

    // 15:00 in Berlin (CEST, UTC+2) is 09:00 in New York (EDT, UTC-4); the
    // reminder is half an hour before that, on the phone's own clock.
    let upcoming = horizon(&pool, "America/New_York".parse().unwrap(), 7).await;
    assert_eq!(upcoming.len(), 1);
    assert_eq!(upcoming[0].key, "s-b#30");
    assert_eq!(upcoming[0].fire_at, "2026-05-27T08:30:00");
    // The wording keeps the source-zone start; only the placement moved.
    assert_eq!(upcoming[0].scheduled_start, "2026-05-27T15:00:00");
}

#[tokio::test]
async fn a_native_page_is_read_in_the_device_zone_not_utc() {
    let pool = test_pool().await;
    insert_page(&pool, "p", "not_started").await;
    // 09:05 wall clock on the 25th, so the reminder fires at 08:55. From
    // 09:00 UTC that is five minutes gone for a UTC phone, and four hours
    // ahead for one in New York, whose clock reads 05:00.
    insert_schedule(&pool, "s", "p", "2026-05-25T09:05:00").await;

    assert!(horizon(&pool, utc(), 7).await.is_empty());
    let new_york = horizon(&pool, "America/New_York".parse().unwrap(), 7).await;
    assert_eq!(new_york.len(), 1);
    assert_eq!(new_york[0].fire_at, "2026-05-25T08:55:00");
}
