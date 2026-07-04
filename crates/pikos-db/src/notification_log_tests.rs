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

async fn insert_schedule_tz(
    pool: &sqlx::SqlitePool,
    id: &str,
    page_id: &str,
    scheduled_start: &str,
    timezone: &str,
) {
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, timezone, status, created_at)
         VALUES (?, ?, ?, ?, 'not_started', '2026-05-01T00:00:00')",
    )
    .bind(id)
    .bind(page_id)
    .bind(scheduled_start)
    .bind(timezone)
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

#[tokio::test]
async fn floating_synced_oneoff_explicit_reminder_fires_on_native_path() {
    // A synced one-off with NO timezone (floating CalDAV DTSTART) is device-local,
    // so the native explicit path must still fire it — the synced path only
    // handles zoned events. Regression guard for the over-broad synced exclusion.
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule(&pool, "s1", "p1", "2026-05-25T09:10:00", "not_started").await; // tz NULL
    insert_reminder(&pool, "p1", 10).await;
    crate::pool::insert_test_page_sync(&pool, "p1", "active")
        .await
        .unwrap();

    let due = due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap();
    assert_eq!(due.len(), 1, "floating synced one-off should fire on native path");
    assert_eq!(due[0].schedule_id, "s1");
}

#[tokio::test]
async fn zoned_synced_oneoff_is_excluded_from_native_path() {
    // A synced one-off WITH a timezone is absolute — it belongs on the synced
    // (zone-aware) path, so the native explicit query must exclude it.
    let pool = test_pool().await;
    insert_page(&pool, "p1", "not_started", "2026-05-01T00:00:00").await;
    insert_schedule_tz(&pool, "s1", "p1", "2026-05-25T09:10:00", "America/New_York").await;
    insert_reminder(&pool, "p1", 10).await;
    crate::pool::insert_test_page_sync(&pool, "p1", "active")
        .await
        .unwrap();

    assert!(
        due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
            .await
            .unwrap()
            .is_empty(),
        "zoned synced one-off must not fire on the native path"
    );
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

// ─── recurring occurrence reminders (native path guards) ─────────────────────
//
// Per-occurrence firing (native + synced, DST, dedup, completed-silent) lives in
// `recurrence_derive_tests`. These pin the two things that stay in this module:
// the `due_recurring_reminders` seam threads through to the enumeration, and the
// one-off page_schedules queries partition occurrences correctly with a recurring
// page's rows (skip the stale anchor, still fire a materialized override).

fn naive(s: &str) -> chrono::NaiveDateTime {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").unwrap()
}

#[tokio::test]
async fn due_recurring_reminders_fires_a_native_occurrence() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    insert_rule(&pool, "rec", "2026-05-25T09:00:00").await; // daily, timed base
    insert_reminder(&pool, "rec", 30).await;
    // 09:00 with a 30-min lead fires at 08:30 (device-local; native series).
    let now = naive("2026-05-25T08:30:00");

    let due = due_recurring_reminders(&pool, now, now.and_utc(), 15)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].schedule_id, "rec@2026-05-25T09:00:00#30");
}

#[tokio::test]
async fn native_reminder_paths_skip_a_recurring_pages_anchor_row() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;
    // The original scheduleOnce anchor (rule_id IS NULL) lingers at the head time.
    // The enumeration owns that occurrence, so firing off the anchor would double it.
    insert_schedule(&pool, "anchor", "rec", "2026-05-25T09:10:00", "not_started").await;

    assert!(due_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
    insert_reminder(&pool, "rec", 10).await;
    assert!(due_explicit_reminders(&pool, WINDOW_START, NOW_TS)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn native_default_path_fires_a_recurring_override_row() {
    let pool = test_pool().await;
    insert_page(&pool, "rec", "not_started", "2026-05-01T00:00:00").await;
    set_page_start(&pool, "rec", "2026-05-25T09:10:00").await;
    insert_rule(&pool, "rec", "2026-05-25T09:10:00").await;
    // A moved/edited occurrence materialized as a real page_schedules row fires via
    // the page_schedules query; the enumeration excludes its original_date, so the
    // two paths partition the series' occurrences rather than double-firing one.
    insert_override(&pool, "ov", "rec", "2026-05-25T09:10:00", "not_started").await;

    let via_schedule = due_default_reminders(&pool, 10, WINDOW_START, NOW_TS)
        .await
        .unwrap();
    assert_eq!(via_schedule.len(), 1);
    assert_eq!(via_schedule[0].schedule_id, "ov");
}

// ─── synced recurring per-instance override reminders ────────────────────────
//
// A moved/single-edited synced occurrence (RECURRENCE-ID) is a materialized
// page_schedules row that no other reminder path fires: the enumeration excludes
// its original_date, and the native `due_*` paths drop rule-backed active-synced
// rows. `due_synced_override_reminders` fires it at its own moved absolute instant.

/// Zoned materialized override row for the page's rule.
async fn insert_override_tz(
    pool: &sqlx::SqlitePool,
    id: &str,
    page_id: &str,
    scheduled_start: &str,
    original_date: &str,
    timezone: &str,
    status: &str,
) {
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, timezone, rule_id, original_date, status, created_at)
         VALUES (?, ?, ?, ?, (SELECT id FROM page_recurrence_rules WHERE page_id = ?), ?, ?,
                 '2026-05-01T00:00:00')",
    )
    .bind(id)
    .bind(page_id)
    .bind(scheduled_start)
    .bind(timezone)
    .bind(page_id)
    .bind(original_date)
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
}

async fn mark_synced_override(pool: &sqlx::SqlitePool, page_id: &str) {
    insert_page(pool, page_id, "not_started", "2026-05-01T00:00:00").await;
    insert_rule(pool, page_id, "2026-05-25T09:00:00").await;
    crate::pool::insert_test_page_sync(pool, page_id, "active")
        .await
        .unwrap();
}

async fn set_completed(pool: &sqlx::SqlitePool, page_id: &str, occurrence_date: &str) {
    sqlx::query("INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, ?, 'c')")
        .bind(page_id)
        .bind(occurrence_date)
        .execute(pool)
        .await
        .unwrap();
}

async fn set_skipped(pool: &sqlx::SqlitePool, page_id: &str, occurrence_date: &str) {
    sqlx::query("INSERT INTO skip_set (page_id, occurrence_date) VALUES (?, ?)")
        .bind(page_id)
        .bind(occurrence_date)
        .execute(pool)
        .await
        .unwrap();
}

// 09:00 America/New_York (EDT, UTC−4) − 10 min lead = 08:50 EDT = 12:50 UTC.
fn override_now() -> chrono::DateTime<chrono::Utc> {
    naive("2026-05-25T12:50:00").and_utc()
}

#[tokio::test]
async fn synced_override_fires_at_moved_absolute_instant_with_default_lead() {
    let pool = test_pool().await;
    mark_synced_override(&pool, "rec").await;
    insert_override_tz(
        &pool,
        "ov",
        "rec",
        "2026-05-25T09:00:00",
        "2026-05-25T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;

    let due = due_synced_override_reminders(&pool, override_now(), 10)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].schedule_id, "ov");
    assert_eq!(due[0].minutes_before, 10);
}

#[tokio::test]
async fn synced_override_uses_explicit_reminder_over_default() {
    let pool = test_pool().await;
    mark_synced_override(&pool, "rec").await;
    insert_override_tz(
        &pool,
        "ov",
        "rec",
        "2026-05-25T09:00:00",
        "2026-05-25T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;
    insert_reminder(&pool, "rec", 30).await; // 09:00 EDT − 30 = 12:30 UTC

    // The default-lead instant (12:50) must NOT fire once an explicit lead exists.
    assert!(due_synced_override_reminders(&pool, override_now(), 10)
        .await
        .unwrap()
        .is_empty());
    let due = due_synced_override_reminders(&pool, naive("2026-05-25T12:30:00").and_utc(), 10)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].minutes_before, 30);
}

#[tokio::test]
async fn completed_or_skipped_synced_override_is_silent() {
    let pool = test_pool().await;
    mark_synced_override(&pool, "done_ov").await;
    insert_override_tz(
        &pool,
        "ov_done",
        "done_ov",
        "2026-05-25T09:00:00",
        "2026-05-25T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;
    set_completed(&pool, "done_ov", "2026-05-25").await;

    mark_synced_override(&pool, "skip_ov").await;
    insert_override_tz(
        &pool,
        "ov_skip",
        "skip_ov",
        "2026-05-25T09:00:00",
        "2026-05-25T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;
    set_skipped(&pool, "skip_ov", "2026-05-25").await;

    assert!(due_synced_override_reminders(&pool, override_now(), 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn already_fired_synced_override_is_silent() {
    let pool = test_pool().await;
    mark_synced_override(&pool, "rec").await;
    insert_override_tz(
        &pool,
        "ov",
        "rec",
        "2026-05-25T09:00:00",
        "2026-05-25T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;
    log_reminder_fired(&pool, "rec", "ov", "2026-05-25T12:50:00").await.unwrap();

    assert!(due_synced_override_reminders(&pool, override_now(), 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn synced_override_path_ignores_floating_and_unsynced_rows() {
    let pool = test_pool().await;
    // Floating (tz NULL) override on a synced series → device-local, served by
    // the native path, not this one.
    mark_synced_override(&pool, "float").await;
    insert_override(&pool, "ov_float", "float", "2026-05-25T09:00:00", "not_started").await;

    // Zoned override but the page isn't actively synced → native path owns it.
    insert_page(&pool, "native", "not_started", "2026-05-01T00:00:00").await;
    insert_rule(&pool, "native", "2026-05-25T09:00:00").await;
    insert_override_tz(
        &pool,
        "ov_native",
        "native",
        "2026-05-25T09:00:00",
        "2026-05-25T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;

    assert!(due_synced_override_reminders(&pool, override_now(), 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn synced_override_fires_only_the_in_window_sibling() {
    let pool = test_pool().await;
    mark_synced_override(&pool, "rec").await;
    // Two moved instances of the same series; only the 09:00 one is in-window.
    insert_override_tz(
        &pool,
        "ov_early",
        "rec",
        "2026-05-25T09:00:00",
        "2026-05-25T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;
    insert_override_tz(
        &pool,
        "ov_late",
        "rec",
        "2026-05-25T20:00:00",
        "2026-05-26T09:00:00",
        "America/New_York",
        "not_started",
    )
    .await;

    let due = due_synced_override_reminders(&pool, override_now(), 10)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].schedule_id, "ov_early");
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

// Active synced recurring series now FIRE (they no longer leak-vs-suppress on the
// native path): the enumeration resolves each occurrence's source-zone → absolute
// instant. Covered in `recurrence_derive_tests`
// (`synced_series_fires_at_the_absolute_instant_*`, detached + default-suppression).

// ─── synced_fire_instant DST edges (doc-comment contract, previously untested) ──

#[test]
fn synced_fire_instant_spring_forward_gap_never_fires() {
    // 2026-03-08 02:30 America/New_York doesn't exist (02:00 EST jumps to 03:00
    // EDT). `earliest()` is None in the gap → the reminder silently never fires.
    assert_eq!(
        synced_fire_instant("2026-03-08T02:30:00", "America/New_York", 0),
        None
    );
}

#[test]
fn synced_fire_instant_fall_back_ambiguous_picks_the_earlier_offset() {
    // 2026-11-01 01:30 America/New_York happens twice (02:00 EDT falls back to
    // 01:00 EST). `earliest()` fires once at the first (EDT, UTC-4) instant —
    // 05:30Z, not the later 06:30Z EST one, and never both.
    let fire = synced_fire_instant("2026-11-01T01:30:00", "America/New_York", 0);
    assert_eq!(
        fire,
        Some("2026-11-01T05:30:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap())
    );
}
