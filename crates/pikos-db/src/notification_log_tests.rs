use super::*;
use crate::pool::test_pool;

// Scheduler tick window used across tests: a reminder is "due" if its fire time
// (scheduled_start − minutes_before) lands in (WINDOW_START, NOW_TS].
const NOW_TS: &str = "2026-05-25 09:00:00";
const WINDOW_START: &str = "2026-05-25 08:59:00";

async fn insert_page(pool: &sqlx::SqlitePool, id: &str, status: &str, created_at: &str) {
    sqlx::query(
        "INSERT INTO pages
         (id, title, content, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES (?, ?, '{}', '', ?, 0, '[]', 0, ?, ?)",
    )
    .bind(id)
    .bind(id)
    .bind(status)
    .bind(created_at)
    .bind(created_at)
    .execute(pool)
    .await
    .unwrap();
}

async fn soft_delete_page(pool: &sqlx::SqlitePool, id: &str) {
    sqlx::query("UPDATE pages SET deleted_at = '2026-05-24T00:00:00' WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn insert_schedule(
    pool: &sqlx::SqlitePool,
    id: &str,
    page_id: &str,
    scheduled_start: &str,
    status: &str,
) {
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, status, created_at)
         VALUES (?, ?, ?, ?, '2026-05-01T00:00:00')",
    )
    .bind(id)
    .bind(page_id)
    .bind(scheduled_start)
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_reminder(pool: &sqlx::SqlitePool, page_id: &str, minutes_before: i64) {
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

async fn log_count(pool: &sqlx::SqlitePool, kind: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM notification_log WHERE type = ?")
        .bind(kind)
        .fetch_one(pool)
        .await
        .unwrap()
}

// ─── due_explicit_reminders ──────────────────────────────────────────────────

#[tokio::test]
async fn explicit_reminder_due_in_window_is_returned() {
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    // 09:10 start, fires 10 min before = 09:00 → inside the tick window.
    insert_schedule(&pool, "s1", "p1", "2026-05-25T09:10:00", "not_started").await;
    insert_reminder(&pool, "p1", 10).await;

    let due = due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].schedule_id, "s1");
    assert_eq!(due[0].page_id, "p1");
    assert_eq!(due[0].title, "p1");
    assert_eq!(due[0].minutes_before, 10);
}

#[tokio::test]
async fn explicit_reminder_outside_window_is_skipped() {
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    // 10:00 start, fires 09:50 → after NOW_TS, not yet due.
    insert_schedule(&pool, "s1", "p1", "2026-05-25T10:00:00", "not_started").await;
    insert_reminder(&pool, "p1", 10).await;

    assert!(due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn all_day_event_has_no_explicit_reminder() {
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    // All-day = date-only scheduled_start (no 'T').
    insert_schedule(&pool, "s1", "p1", "2026-05-25", "not_started").await;
    insert_reminder(&pool, "p1", 0).await;

    assert!(due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn explicit_reminder_excludes_done_and_deleted_and_already_fired() {
    let pool = test_pool().await;
    // done page
    insert_page(&pool, "done", "done", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "sd", "done", "2026-05-25T09:10:00", "not_started").await;
    insert_reminder(&pool, "done", 10).await;
    // deleted page
    insert_page(&pool, "del", "not_started", "2026-05-01T00:00:00").await;
    soft_delete_page(&pool, "del").await;
    insert_schedule(&pool, "sx", "del", "2026-05-25T09:10:00", "not_started").await;
    insert_reminder(&pool, "del", 10).await;
    // done schedule occurrence
    insert_page(&pool, "skip", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "ss", "skip", "2026-05-25T09:10:00", "done").await;
    insert_reminder(&pool, "skip", 10).await;
    // already fired
    insert_page(&pool, "fired", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "sf", "fired", "2026-05-25T09:10:00", "not_started").await;
    insert_reminder(&pool, "fired", 10).await;
    log_reminder_fired(&pool, "fired", "sf", NOW_TS)
        .await
        .unwrap();

    assert!(due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn none_sentinel_reminder_never_fires() {
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "s1", "p1", "2026-05-25T09:00:00", "not_started").await;
    // -1 = "no reminders for this page" sentinel; filtered by minutes_before >= 0.
    insert_reminder(&pool, "p1", -1).await;

    assert!(due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

// ─── due_default_reminders ───────────────────────────────────────────────────

#[tokio::test]
async fn default_reminder_uses_global_lead_time() {
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "s1", "p1", "2026-05-25T09:10:00", "not_started").await;
    // No page_reminders row → falls to the default path.

    let due = due_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].schedule_id, "s1");
    assert_eq!(due[0].minutes_before, 10);
}

#[tokio::test]
async fn default_reminder_skips_pages_with_explicit_reminders() {
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "s1", "p1", "2026-05-25T09:10:00", "not_started").await;
    insert_reminder(&pool, "p1", 10).await; // has explicit config

    assert!(due_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

// ─── daily summary dedup + logging ───────────────────────────────────────────

#[tokio::test]
async fn daily_summary_marker_dedups_per_day() {
    let pool = test_pool().await;
    assert!(!daily_summary_fired_on(&pool, "2026-05-25").await.unwrap());

    log_daily_summary(&pool, NOW_TS).await.unwrap();

    assert!(daily_summary_fired_on(&pool, "2026-05-25").await.unwrap());
    // Different day is unaffected.
    assert!(!daily_summary_fired_on(&pool, "2026-05-26").await.unwrap());
}

// ─── today_scheduled_count ───────────────────────────────────────────────────

#[tokio::test]
async fn today_count_dedups_pages_and_includes_all_day() {
    let pool = test_pool().await;
    insert_page(&pool, "timed", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "t1", "timed", "2026-05-25T09:00:00", "not_started").await;
    insert_schedule(&pool, "t2", "timed", "2026-05-25T14:00:00", "not_started").await; // same page twice
    insert_page(&pool, "allday", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "a1", "allday", "2026-05-25", "not_started").await;
    // Excluded: done page, deleted page, and a different day.
    insert_page(&pool, "done", "done", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "d1", "done", "2026-05-25T10:00:00", "not_started").await;
    insert_page(&pool, "other", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "o1", "other", "2026-05-26T10:00:00", "not_started").await;

    // 2 distinct pages today (timed + allday).
    assert_eq!(today_scheduled_count(&pool, "2026-05-25").await.unwrap(), 2);
}

// ─── overdue_count ───────────────────────────────────────────────────────────

#[tokio::test]
async fn overdue_count_window_and_recency() {
    let pool = test_pool().await;
    let stale_cutoff = "2026-05-24 09:00:00"; // now - 24h
    let recent_cutoff = "2026-05-25 08:55:00"; // now - 5m

    // Overdue: timed, started 2h ago, page created long ago.
    insert_page(&pool, "od", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "s_od", "od", "2026-05-25T07:00:00", "not_started").await;
    // Excluded — just imported (created after recent_cutoff).
    insert_page(&pool, "fresh", "not_started", "2026-05-25T08:59:00").await;
    insert_schedule(
        &pool,
        "s_fresh",
        "fresh",
        "2026-05-25T07:00:00",
        "not_started",
    )
    .await;
    // Excluded — all-day.
    insert_page(&pool, "ad", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "s_ad", "ad", "2026-05-25", "not_started").await;
    // Excluded — older than the 24h stale window.
    insert_page(&pool, "ancient", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(
        &pool,
        "s_anc",
        "ancient",
        "2026-05-23T07:00:00",
        "not_started",
    )
    .await;

    let n = overdue_count(&pool, NOW_TS, stale_cutoff, recent_cutoff)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

// ─── reminder_fire_diagnostics ───────────────────────────────────────────────

async fn set_page_start(pool: &sqlx::SqlitePool, page_id: &str, start: &str) {
    sqlx::query("UPDATE pages SET scheduled_start = ? WHERE id = ?")
        .bind(start)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn insert_rule(pool: &sqlx::SqlitePool, page_id: &str, scheduled_start: &str) {
    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, scheduled_start, timezone, created_at)
         VALUES (?, ?, 'FREQ=DAILY', ?, 'UTC', '2026-05-01T00:00:00')",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(page_id)
    .bind(scheduled_start)
    .execute(pool)
    .await
    .unwrap();
}

/// Materialized override row (`rule_id` set) for the page's recurrence rule —
/// represents a moved/edited occurrence, distinct from the lingering anchor.
async fn insert_override(
    pool: &sqlx::SqlitePool,
    id: &str,
    page_id: &str,
    scheduled_start: &str,
    status: &str,
) {
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, rule_id, original_date, status, created_at)
         VALUES (?, ?, ?, (SELECT id FROM page_recurrence_rules WHERE page_id = ?), ?, ?,
                 '2026-05-01T00:00:00')",
    )
    .bind(id)
    .bind(page_id)
    .bind(scheduled_start)
    .bind(page_id)
    .bind(scheduled_start)
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn diagnostics_flag_recurring_drift() {
    let pool = test_pool().await;
    // Recurring page whose head has advanced to the next occurrence (page denorm
    // start) while a stale page_schedules row still points at the original date.
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-26T09:00:00").await; // advanced head
    insert_rule(&pool, "rec", "2026-05-25T09:00:00").await;

    let diag = reminder_fire_diagnostics(&pool, "rec")
        .await
        .unwrap()
        .expect("page exists");
    assert_eq!(diag.has_rule, 1);
    assert_eq!(diag.status, "not_started");
    assert_eq!(
        diag.page_scheduled_start.as_deref(),
        Some("2026-05-26T09:00:00")
    );
    assert!(diag.completed_at.is_none());
    // The firing row (the original 09:00 occurrence) differs from the advanced
    // page start — this is the drift signal the scheduler logs.
    assert_ne!(
        diag.page_scheduled_start.as_deref(),
        Some("2026-05-25T09:00:00")
    );
}

#[tokio::test]
async fn diagnostics_for_one_off_page_have_no_rule() {
    let pool = test_pool().await;
    insert_page(&pool, "once", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "once", "2026-05-25T09:00:00").await;

    let diag = reminder_fire_diagnostics(&pool, "once")
        .await
        .unwrap()
        .expect("page exists");
    assert_eq!(diag.has_rule, 0);
    assert_eq!(
        diag.page_scheduled_start.as_deref(),
        Some("2026-05-25T09:00:00")
    );
}

#[tokio::test]
async fn diagnostics_none_for_missing_page() {
    let pool = test_pool().await;
    assert!(reminder_fire_diagnostics(&pool, "ghost")
        .await
        .unwrap()
        .is_none());
}

// ─── recurring head reminders ────────────────────────────────────────────────

#[tokio::test]
async fn recurring_default_reminder_fires_off_the_head() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    // Head occurrence is 09:10; default 10-min lead fires at 09:00 → in window.
    set_page_start(&pool, "rec", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;

    let due = due_recurring_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].page_id, "rec");
    assert_eq!(due[0].minutes_before, 10);
    // Synthetic dedup id keys on the occurrence start so each occurrence is distinct.
    assert_eq!(due[0].schedule_id, "rec@2026-05-25T09:10:00");
}

#[tokio::test]
async fn recurring_explicit_reminder_uses_page_reminder_lead() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;
    insert_reminder(&pool, "rec", 10).await;

    let explicit = due_recurring_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap();
    assert_eq!(explicit.len(), 1);
    assert_eq!(explicit[0].minutes_before, 10);
    // Explicit id encodes the lead so multiple reminders on one occurrence differ.
    assert_eq!(explicit[0].schedule_id, "rec@2026-05-25T09:10:00#10");

    // A page with explicit reminders must not also hit the default path.
    assert!(due_recurring_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn recurring_lingering_anchor_row_is_not_a_reminder_source() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-25T09:10:00").await; // head
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;
    // The original scheduleOnce anchor (rule_id IS NULL) lingers at the same time.
    insert_schedule(&pool, "anchor", "rec", "2026-05-25T09:10:00", "not_started").await;

    // The page_schedules default query must skip the stale anchor (page has a rule)…
    assert!(due_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
    // …and the head-based query fires exactly once — no double reminder.
    assert_eq!(
        due_recurring_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn completing_before_the_reminder_suppresses_it() {
    let pool = test_pool().await;
    // Reproduces the reported bug: complete the occurrence (head advances to the
    // next day) seconds before the original occurrence's reminder would fire.
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-26T09:10:00").await; // advanced by completion
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;
    // Anchor still points at the just-completed 05-25 occurrence.
    insert_schedule(&pool, "anchor", "rec", "2026-05-25T09:10:00", "not_started").await;

    // Neither path fires: anchor is excluded, and the advanced head is out of window.
    assert!(due_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
    assert!(due_recurring_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn recurring_head_reminder_dedups_per_occurrence() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;

    // First tick fires; record it under the synthetic id.
    log_reminder_fired(&pool, "rec", "rec@2026-05-25T09:10:00", NOW_TS)
        .await
        .unwrap();

    assert!(due_recurring_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn recurring_all_day_head_has_no_reminder() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-25").await; // date-only = all-day
    insert_rule(&pool, "rec", "2026-05-25").await;

    assert!(due_recurring_default_reminders(&pool, 0, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn recurring_head_skips_when_a_materialized_override_covers_it() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;
    // A moved/edited occurrence materialized at the same start as the head.
    insert_override(&pool, "ov", "rec", "2026-05-25T09:10:00", "not_started").await;

    // The head query defers — the override row owns this occurrence's reminder…
    assert!(due_recurring_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
    // …and the override (rule_id IS NOT NULL) still fires via page_schedules.
    let via_schedule = due_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap();
    assert_eq!(via_schedule.len(), 1);
    assert_eq!(via_schedule[0].schedule_id, "ov");
}

#[tokio::test]
async fn recurring_head_excludes_done_and_deleted_pages() {
    let pool = test_pool().await;
    insert_page(&pool, "done", "done", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "done", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "done", "2026-05-25T09:10:00").await;

    insert_page(&pool, "del", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "del", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "del", "2026-05-25T09:10:00").await;
    soft_delete_page(&pool, "del").await;

    assert!(due_recurring_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

// ─── prune ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn prune_removes_only_rows_before_cutoff() {
    let pool = test_pool().await;
    // Old reminder row + recent summary row.
    log_reminder_fired(&pool, "p1", "s1", "2026-01-01 00:00:00")
        .await
        .unwrap();
    log_daily_summary(&pool, "2026-05-25 07:00:00")
        .await
        .unwrap();
    assert_eq!(log_count(&pool, "reminder").await, 1);
    assert_eq!(log_count(&pool, "overdue").await, 1);

    prune_notification_log(&pool, "2026-04-25 00:00:00")
        .await
        .unwrap();

    assert_eq!(log_count(&pool, "reminder").await, 0); // pruned
    assert_eq!(log_count(&pool, "overdue").await, 1); // kept
}
