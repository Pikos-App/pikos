//! Tests for the two backend derivations: the display recompute (cache ==
//! f(truth), terminal flips) and the reminder-window enumeration (per occurrence
//! × lead, native + synced, cache-free).

use chrono::{DateTime, NaiveDateTime, Utc};

use super::*;
use crate::pool::{insert_test_page, insert_test_page_sync, test_pool, wal_test_pool, TestPage};
use crate::{
    complete_recurring_page_impl, create_recurrence_rule_impl, CompleteRecurringInput,
    NewRecurrenceRule,
};

fn local(s: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").unwrap()
}

fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

async fn seed_series(
    pool: &sqlx::SqlitePool,
    page_id: &str,
    rrule: &str,
    base_start: &str,
    base_end: Option<&str>,
) -> String {
    insert_test_page(
        pool,
        TestPage { scheduled_start: Some(base_start), ..TestPage::new(page_id, "S") },
    )
    .await
    .unwrap();
    let rule = create_recurrence_rule_impl(
        pool,
        NewRecurrenceRule {
            page_id: page_id.into(),
            rrule: rrule.into(),
            rrule_exdates: vec![],
            scheduled_start: base_start.into(),
            scheduled_end: base_end.map(str::to_string),
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();
    rule.id
}

async fn complete_via_set(pool: &sqlx::SqlitePool, page_id: &str, occurrence_date: &str) {
    sqlx::query("INSERT OR REPLACE INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, ?, ?)")
        .bind(page_id)
        .bind(occurrence_date)
        .bind(format!("clone-{page_id}-{occurrence_date}"))
        .execute(pool)
        .await
        .unwrap();
}

async fn add_reminder(pool: &sqlx::SqlitePool, page_id: &str, minutes: i64) {
    sqlx::query("INSERT INTO page_reminders (id, page_id, minutes_before, created_at) VALUES (?, ?, ?, ?)")
        .bind(format!("rem-{page_id}-{minutes}"))
        .bind(page_id)
        .bind(minutes)
        .bind(now_iso())
        .execute(pool)
        .await
        .unwrap();
}

async fn head(pool: &sqlx::SqlitePool, id: &str) -> (Option<String>, String) {
    sqlx::query_as("SELECT scheduled_start, status FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn recompute(pool: &sqlx::SqlitePool, page_id: &str) {
    let mut tx = pool.begin().await.unwrap();
    recompute_recurring_schedule(&mut tx, page_id).await.unwrap();
    tx.commit().await.unwrap();
}

// ─── cache == f(truth): the permanent CI invariant ───────────────────────────

#[tokio::test]
async fn recompute_materialises_oldest_open_after_each_completion() {
    let pool = test_pool().await;
    seed_series(&pool, "head", "FREQ=DAILY", "2026-05-21T09:00:00", Some("2026-05-21T09:30:00"))
        .await;

    for date in ["2026-05-21", "2026-05-22", "2026-05-23"] {
        complete_via_set(&pool, "head", date).await;
        recompute(&pool, "head").await;

        let derived = oldest_open_for_page(&pool, "head").await.unwrap();
        let (cached, _) = head(&pool, "head").await;
        assert_eq!(
            cached.as_deref(),
            derived.as_ref().map(|o| o.scheduled_start.as_str()),
            "cache must equal f(truth) after completing {date}"
        );
    }
    // Three days excluded from a daily series → head on the 24th.
    let (cached, _) = head(&pool, "head").await;
    assert_eq!(cached.as_deref(), Some("2026-05-24T09:00:00"));
}

// ─── terminal flips, both directions ─────────────────────────────────────────

#[tokio::test]
async fn recompute_flips_head_done_on_exhaustion_and_back_on_reyield() {
    let pool = test_pool().await;
    seed_series(&pool, "head", "FREQ=DAILY;COUNT=2", "2026-05-21T09:00:00", None).await;

    complete_via_set(&pool, "head", "2026-05-21").await;
    complete_via_set(&pool, "head", "2026-05-22").await;
    recompute(&pool, "head").await;
    let (_, status) = head(&pool, "head").await;
    assert_eq!(status, "done", "exhausted finite series → head done");

    // The 22nd re-opens (uncomplete / provider re-extension) → head un-marks done.
    sqlx::query("DELETE FROM completed_set WHERE page_id = 'head' AND occurrence_date = '2026-05-22'")
        .execute(&pool)
        .await
        .unwrap();
    recompute(&pool, "head").await;
    let (cached, status) = head(&pool, "head").await;
    assert_eq!(status, "not_started", "re-yield must un-mark done");
    assert_eq!(cached.as_deref(), Some("2026-05-22T09:00:00"));
    let completed_at: Option<String> =
        sqlx::query_scalar("SELECT completed_at FROM pages WHERE id = 'head'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(completed_at, None, "un-mark must clear completed_at");
}

// ─── reminder derivation ─────────────────────────────────────────────────────

#[tokio::test]
async fn two_occurrences_in_window_both_fire() {
    let pool = test_pool().await;
    seed_series(&pool, "head", "FREQ=DAILY", "2026-05-21T09:00:00", Some("2026-05-21T10:00:00"))
        .await;
    // 30-min lead catches today's 09:00; a 24h30m lead catches tomorrow's — both
    // resolve to the same fire instant (now), the case a scalar head misses.
    add_reminder(&pool, "head", 30).await;
    add_reminder(&pool, "head", 24 * 60 + 30).await;
    let now = local("2026-05-25T08:30:00");

    let due = occurrences_with_open_reminder_window(&pool, now, now.and_utc(), 15, 24 * 60 + 30)
        .await
        .unwrap();

    let mut ids: Vec<_> = due.iter().map(|d| d.schedule_id.clone()).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![
            "head@2026-05-25T09:00:00#30".to_string(),
            "head@2026-05-26T09:00:00#1470".to_string(),
        ]
    );
}

#[tokio::test]
async fn dedup_across_ticks_fires_each_occurrence_once() {
    let pool = test_pool().await;
    seed_series(&pool, "head", "FREQ=DAILY", "2026-05-21T09:00:00", None).await;
    add_reminder(&pool, "head", 30).await;
    let now = local("2026-05-25T08:30:00");

    let first = occurrences_with_open_reminder_window(&pool, now, now.and_utc(), 15, 60)
        .await
        .unwrap();
    assert_eq!(first.len(), 1);

    // The scheduler records the fire; the same tick again must not re-fire it.
    sqlx::query("INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at) VALUES ('n1', 'head', ?, 'reminder', ?)")
        .bind(&first[0].schedule_id)
        .bind(now_iso())
        .execute(&pool)
        .await
        .unwrap();
    let second = occurrences_with_open_reminder_window(&pool, now, now.and_utc(), 15, 60)
        .await
        .unwrap();
    assert!(second.is_empty(), "already-logged occurrence must not re-fire");
}

#[tokio::test]
async fn past_occurrence_does_not_fire() {
    let pool = test_pool().await;
    seed_series(&pool, "head", "FREQ=DAILY", "2026-05-21T09:00:00", None).await;
    add_reminder(&pool, "head", 30).await;
    // 09:00 fires at 08:30; by 10:00 it's an hour past the window — no backfill.
    let now = local("2026-05-25T10:00:00");

    let due = occurrences_with_open_reminder_window(&pool, now, now.and_utc(), 15, 60)
        .await
        .unwrap();
    assert!(due.is_empty(), "forward-only: a past occurrence must not fire");
}

#[tokio::test]
async fn completed_occurrence_is_silent() {
    let pool = test_pool().await;
    seed_series(&pool, "head", "FREQ=DAILY", "2026-05-21T09:00:00", None).await;
    add_reminder(&pool, "head", 30).await;
    complete_via_set(&pool, "head", "2026-05-25").await;
    let now = local("2026-05-25T08:30:00");

    let due = occurrences_with_open_reminder_window(&pool, now, now.and_utc(), 15, 60)
        .await
        .unwrap();
    assert!(due.is_empty(), "a completed occurrence must not fire a reminder");
}

#[tokio::test]
async fn synced_series_fires_at_the_absolute_instant_seeking_from_a_far_base() {
    let pool = test_pool().await;
    // Base six years before "now" — enumeration must seek to now, not scan from
    // the pinned base. Zone ≠ device zone; the fire is the resolved UTC instant.
    seed_series(&pool, "head", "FREQ=DAILY", "2020-01-01T09:00:00", None).await;
    insert_test_page_sync(&pool, "head", "active").await.unwrap();
    sqlx::query("UPDATE page_recurrence_rules SET timezone = 'America/New_York' WHERE page_id = 'head'")
        .execute(&pool)
        .await
        .unwrap();
    add_reminder(&pool, "head", 15).await;

    // 2026-05-25 09:00 America/New_York (EDT, UTC-4) = 13:00Z; lead 15 → 12:45Z.
    let now_utc = utc("2026-05-25T12:45:00Z");
    let due = occurrences_with_open_reminder_window(&pool, local("2026-05-25T05:45:00"), now_utc, 15, 60)
        .await
        .unwrap();

    assert_eq!(due.len(), 1);
    assert_eq!(due[0].scheduled_start, "2026-05-25T09:00:00");
    assert_eq!(due[0].schedule_id, "head@2026-05-25T09:00:00#15");
}

#[tokio::test]
async fn reminders_ignore_a_corrupted_display_cache() {
    let pool = test_pool().await;
    seed_series(&pool, "head", "FREQ=DAILY", "2026-05-21T09:00:00", None).await;
    add_reminder(&pool, "head", 30).await;
    // The reminder derivation must read truth (rule base), never the cache.
    sqlx::query("UPDATE pages SET scheduled_start = 'garbage-not-a-date' WHERE id = 'head'")
        .execute(&pool)
        .await
        .unwrap();
    let now = local("2026-05-25T08:30:00");

    let due = occurrences_with_open_reminder_window(&pool, now, now.and_utc(), 15, 60)
        .await
        .unwrap();
    assert_eq!(due.len(), 1, "a corrupted cache must not affect reminders");
    assert_eq!(due[0].scheduled_start, "2026-05-25T09:00:00");
}

// ─── contention: a 200-recompute batch vs completion's retry budget ──────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recompute_batch_does_not_starve_a_racing_completion() {
    let db = wal_test_pool().await;
    let pool = db.pool.clone();

    // 200 recurring pages the reconciler recomputes in one lock-holding batch tx.
    for i in 0..200 {
        seed_series(&pool, &format!("r{i}"), "FREQ=DAILY", "2026-05-21T09:00:00", None).await;
    }
    // A separate recurring page a user completes concurrently.
    insert_test_page(
        &pool,
        TestPage { scheduled_start: Some("2026-05-21T09:00:00"), ..TestPage::new("target", "T") },
    )
    .await
    .unwrap();
    let target_rule = create_recurrence_rule_impl(
        &pool,
        NewRecurrenceRule {
            page_id: "target".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-05-21T09:00:00".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    let batch = tokio::spawn({
        let pool = pool.clone();
        async move {
            let mut tx = pool.begin().await.unwrap();
            for i in 0..200 {
                recompute_recurring_schedule(&mut tx, &format!("r{i}")).await.unwrap();
            }
            tx.commit().await.unwrap();
        }
    });
    let completion = tokio::spawn({
        let pool = pool.clone();
        async move {
            complete_recurring_page_impl(
                &pool,
                CompleteRecurringInput {
                    page_id: "target".into(),
                    next_scheduled_start: Some("2026-05-22T09:00:00".into()),
                    next_scheduled_end: None,
                    rule_id: Some(target_rule.id.clone()),
                    add_exdates: Some(vec!["2026-05-21".into()]),
                },
            )
            .await
        }
    });

    let (batch_res, completion_res) = tokio::join!(batch, completion);
    batch_res.expect("batch task panicked");
    completion_res
        .expect("completion task panicked")
        .expect("completion must survive the recompute batch within its retry budget");

    let (cached, _) = head(&pool, "target").await;
    assert_eq!(cached.as_deref(), Some("2026-05-22T09:00:00"), "completion advanced the head");
}
