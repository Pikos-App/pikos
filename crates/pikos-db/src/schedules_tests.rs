use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

/// Acquire a connection and run the (connection-form) denorm refresh, dropping
/// the connection before returning so the single-connection test pool stays
/// free for follow-up reads.
async fn refresh_denorm_at(pool: &sqlx::SqlitePool, page_id: &str, now: &str) {
    let mut conn = pool.acquire().await.unwrap();
    refresh_schedule_denorm_at(&mut conn, page_id, now)
        .await
        .unwrap();
}

async fn page_denorm(pool: &sqlx::SqlitePool, id: &str) -> (Option<String>, Option<String>) {
    let row: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT scheduled_start, scheduled_end FROM pages WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
    row
}

fn future_start() -> String {
    // 30 days ahead — comfortably "upcoming" regardless of test clock skew.
    let dt = chrono::Utc::now() + chrono::Duration::days(30);
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn past_start() -> String {
    let dt = chrono::Utc::now() - chrono::Duration::days(30);
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[tokio::test]
async fn create_schedule_sets_page_denorm() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();

    let start = future_start();
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: start.clone(),
            scheduled_end: Some(format!("{start}+01:00")),
            timezone: Some("UTC".into()),
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    let (denorm_start, _) = page_denorm(&pool, "p1").await;
    assert_eq!(denorm_start.as_deref(), Some(start.as_str()));
}

#[tokio::test]
async fn earliest_upcoming_wins_denorm() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();

    let later = {
        let dt = chrono::Utc::now() + chrono::Duration::days(60);
        dt.format("%Y-%m-%dT%H:%M:%S").to_string()
    };
    let sooner = future_start();

    // Insert later first to prove ordering, not insert-order, drives denorm.
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: later.clone(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: sooner.clone(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    let (denorm_start, _) = page_denorm(&pool, "p1").await;
    assert_eq!(denorm_start.as_deref(), Some(sooner.as_str()));
}

#[tokio::test]
async fn falls_back_to_past_when_no_upcoming() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();

    let past = past_start();
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: past.clone(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    let (denorm_start, _) = page_denorm(&pool, "p1").await;
    assert_eq!(
        denorm_start.as_deref(),
        Some(past.as_str()),
        "with no upcoming schedule, denorm should fall back to most-recent past"
    );
}

#[tokio::test]
async fn rule_id_rows_are_excluded_from_denorm() {
    // Materialized-override rows (rule_id IS NOT NULL) must not feed the denorm —
    // the head's pages.scheduled_start tracks explicit schedules only.
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Recurring head"))
        .await
        .unwrap();

    // Need a parent rule for FK integrity.
    let now = now_iso();
    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, rrule_exdates, scheduled_start, timezone, created_at)
         VALUES ('rule1', 'p1', 'FREQ=DAILY', '[]', ?, 'UTC', ?)",
    )
    .bind(future_start())
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: future_start(),
            scheduled_end: None,
            timezone: Some("UTC".into()),
            rule_id: Some("rule1".into()),
            original_date: Some(future_start()),
        },
    )
    .await
    .unwrap();

    let (denorm_start, _) = page_denorm(&pool, "p1").await;
    assert!(
        denorm_start.is_none(),
        "rule_id-tagged row should not feed denorm, got {denorm_start:?}"
    );
}

// ── timezone-correct, all-day-aware denorm bucketing ──────────────────

#[tokio::test]
async fn all_day_today_outranks_future_timed_in_denorm() {
    // The old comparator lex-compared a bare date against a timed "now", so an
    // all-day event dated today classified as "past" and a future timed event
    // wrongly won the denorm.
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();
    for start in ["2026-05-28", "2026-05-29T09:00:00"] {
        create_page_schedule_impl(
            &pool,
            NewPageSchedule {
                page_id: "p1".into(),
                scheduled_start: start.into(),
                scheduled_end: None,
                timezone: None,
                rule_id: None,
                original_date: None,
            },
        )
        .await
        .unwrap();
    }

    // Midday on the all-day's date.
    refresh_denorm_at(&pool, "p1", "2026-05-28T12:00:00").await;
    assert_eq!(
        page_denorm(&pool, "p1").await.0.as_deref(),
        Some("2026-05-28"),
        "today's all-day event should win over tomorrow's timed event"
    );
}

#[tokio::test]
async fn denorm_split_follows_the_passed_local_now() {
    // Classification must track the (local) comparator we pass, not SQLite's UTC
    // strftime('now'). Two timed rows on one day; moving "now" moves the winner.
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();
    for start in ["2026-05-28T09:00:00", "2026-05-28T17:00:00"] {
        create_page_schedule_impl(
            &pool,
            NewPageSchedule {
                page_id: "p1".into(),
                scheduled_start: start.into(),
                scheduled_end: None,
                timezone: None,
                rule_id: None,
                original_date: None,
            },
        )
        .await
        .unwrap();
    }

    // Noon: 09:00 past, 17:00 upcoming → upcoming wins → 17:00.
    refresh_denorm_at(&pool, "p1", "2026-05-28T12:00:00").await;
    assert_eq!(
        page_denorm(&pool, "p1").await.0.as_deref(),
        Some("2026-05-28T17:00:00")
    );

    // 08:00: both upcoming → earliest = 09:00.
    refresh_denorm_at(&pool, "p1", "2026-05-28T08:00:00").await;
    assert_eq!(
        page_denorm(&pool, "p1").await.0.as_deref(),
        Some("2026-05-28T09:00:00")
    );

    // 20:00: both past → earliest scheduled_start within the past bucket = 09:00
    // (denorm tiebreak is ASC; unchanged from prior behavior).
    refresh_denorm_at(&pool, "p1", "2026-05-28T20:00:00").await;
    assert_eq!(
        page_denorm(&pool, "p1").await.0.as_deref(),
        Some("2026-05-28T09:00:00")
    );
}

// ── per-page schedule list filters trashed pages ──────────────────────

#[tokio::test]
async fn list_page_schedules_excludes_trashed_page() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: future_start(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        list_page_schedules_impl(&pool, "p1").await.unwrap().len(),
        1
    );

    crate::pages::soft_delete_page_impl(&pool, "p1")
        .await
        .unwrap();
    assert!(
        list_page_schedules_impl(&pool, "p1")
            .await
            .unwrap()
            .is_empty(),
        "a trashed page's schedules must not leak via the per-page list"
    );
}

#[tokio::test]
async fn delete_schedule_clears_or_falls_back() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();

    let first = future_start();
    let s1 = create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: first.clone(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    let later = {
        let dt = chrono::Utc::now() + chrono::Duration::days(60);
        dt.format("%Y-%m-%dT%H:%M:%S").to_string()
    };
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: later.clone(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    // Sanity: earliest is denormed.
    assert_eq!(
        page_denorm(&pool, "p1").await.0.as_deref(),
        Some(first.as_str())
    );

    // Deleting the earliest should fall back to the remaining one.
    delete_page_schedule_impl(&pool, s1.id.clone())
        .await
        .unwrap();
    assert_eq!(
        page_denorm(&pool, "p1").await.0.as_deref(),
        Some(later.as_str())
    );

    // Find the remaining schedule id and delete it — denorm should clear.
    let remaining_id: String =
        sqlx::query_scalar("SELECT id FROM page_schedules WHERE page_id = 'p1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    delete_page_schedule_impl(&pool, remaining_id)
        .await
        .unwrap();
    let (denorm_start, denorm_end) = page_denorm(&pool, "p1").await;
    assert!(denorm_start.is_none() && denorm_end.is_none());
}

#[tokio::test]
async fn update_start_refreshes_denorm() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();

    let original = future_start();
    let s = create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: original,
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    let moved = {
        let dt = chrono::Utc::now() + chrono::Duration::days(90);
        dt.format("%Y-%m-%dT%H:%M:%S").to_string()
    };
    update_page_schedule_impl(
        &pool,
        s.id.clone(),
        PageScheduleUpdate {
            scheduled_start: Some(moved.clone()),
            scheduled_end: None,
            status: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(
        page_denorm(&pool, "p1").await.0.as_deref(),
        Some(moved.as_str())
    );
}

#[tokio::test]
async fn update_clears_reminder_log_when_start_changes() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();
    let s = create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: future_start(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    // Seed a reminder log entry — must be cleared when scheduled_start moves.
    let now = now_iso();
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES ('n1', 'p1', ?, 'reminder', ?)",
    )
    .bind(&s.id)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    // Also seed an unrelated overdue entry — must NOT be cleared.
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES ('n2', 'p1', ?, 'overdue', ?)",
    )
    .bind(&s.id)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    update_page_schedule_impl(
        &pool,
        s.id.clone(),
        PageScheduleUpdate {
            scheduled_start: Some(future_start()),
            scheduled_end: None,
            status: None,
        },
    )
    .await
    .unwrap();

    let reminders: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_log WHERE schedule_id = ? AND type = 'reminder'",
    )
    .bind(&s.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let overdues: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_log WHERE schedule_id = ? AND type = 'overdue'",
    )
    .bind(&s.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reminders, 0, "reminder log not cleared");
    assert_eq!(overdues, 1, "overdue log incorrectly cleared");
}

// ── list_page_schedules / range / recurrence rules ─────────────────────

fn new_rule(page_id: &str, scheduled_start: &str) -> NewRecurrenceRule {
    NewRecurrenceRule {
        page_id: page_id.into(),
        rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
        rrule_exdates: vec![],
        scheduled_start: scheduled_start.into(),
        scheduled_end: None,
        timezone: "UTC".into(),
    }
}

#[tokio::test]
async fn list_page_schedules_returns_in_chronological_order() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "P1"))
        .await
        .unwrap();

    // Insert in non-chronological order.
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: "2026-05-22T09:00:00".into(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: "2026-05-20T09:00:00".into(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    let schedules = list_page_schedules_impl(&pool, "p1").await.unwrap();
    assert_eq!(schedules.len(), 2);
    assert_eq!(schedules[0].scheduled_start, "2026-05-20T09:00:00");
    assert_eq!(schedules[1].scheduled_start, "2026-05-22T09:00:00");
}

#[tokio::test]
async fn list_page_schedules_range_excludes_soft_deleted_pages() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("alive", "Alive"))
        .await
        .unwrap();
    insert_test_page(&pool, TestPage::new("dead", "Dead"))
        .await
        .unwrap();

    for id in ["alive", "dead"] {
        create_page_schedule_impl(
            &pool,
            NewPageSchedule {
                page_id: id.into(),
                scheduled_start: "2026-05-21T10:00:00".into(),
                scheduled_end: None,
                timezone: None,
                rule_id: None,
                original_date: None,
            },
        )
        .await
        .unwrap();
    }

    // Soft-delete the second page.
    sqlx::query("UPDATE pages SET deleted_at = datetime('now') WHERE id = 'dead'")
        .execute(&pool)
        .await
        .unwrap();

    let in_range = list_page_schedules_range_impl(&pool, "2026-05-21", "2026-05-21")
        .await
        .unwrap();
    assert_eq!(in_range.len(), 1, "soft-deleted page must be filtered out");
    assert_eq!(in_range[0].page_id, "alive");
}

#[tokio::test]
async fn list_page_schedules_range_filters_window() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "P1"))
        .await
        .unwrap();

    for date in ["2026-05-01", "2026-05-15", "2026-05-30"] {
        create_page_schedule_impl(
            &pool,
            NewPageSchedule {
                page_id: "p1".into(),
                scheduled_start: format!("{date}T09:00:00"),
                scheduled_end: None,
                timezone: None,
                rule_id: None,
                original_date: None,
            },
        )
        .await
        .unwrap();
    }

    let window = list_page_schedules_range_impl(&pool, "2026-05-10", "2026-05-20")
        .await
        .unwrap();
    assert_eq!(window.len(), 1, "only the 2026-05-15 schedule overlaps");
    assert_eq!(window[0].scheduled_start, "2026-05-15T09:00:00");
}

#[tokio::test]
async fn update_page_schedule_clears_end_when_null_passed() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "P1"))
        .await
        .unwrap();

    let s = create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "p1".into(),
            scheduled_start: "2026-05-21T09:00:00".into(),
            scheduled_end: Some("2026-05-21T10:00:00".into()),
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(s.scheduled_end.as_deref(), Some("2026-05-21T10:00:00"));

    let updated = update_page_schedule_impl(
        &pool,
        s.id.clone(),
        PageScheduleUpdate {
            scheduled_end: Some(serde_json::Value::Null),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(
        updated.scheduled_end.is_none(),
        "Value::Null clears scheduled_end"
    );
}

#[tokio::test]
async fn create_and_get_recurrence_rule_round_trip() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Habit"))
        .await
        .unwrap();

    let created = create_recurrence_rule_impl(&pool, new_rule("p1", "2026-05-21"))
        .await
        .unwrap();
    assert_eq!(created.page_id, "p1");
    assert_eq!(created.rrule, "FREQ=WEEKLY;BYDAY=MO");
    assert_eq!(created.scheduled_start, "2026-05-21");

    let fetched = get_recurrence_rule_impl(&pool, "p1").await.unwrap();
    assert!(fetched.is_some());
    assert_eq!(fetched.unwrap().id, created.id);
}

#[tokio::test]
async fn update_recurrence_rule_applies_partial_changes() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Habit"))
        .await
        .unwrap();
    let rule = create_recurrence_rule_impl(&pool, new_rule("p1", "2026-05-21"))
        .await
        .unwrap();

    let updated = update_recurrence_rule_impl(
        &pool,
        rule.id.clone(),
        RecurrenceRuleUpdate {
            rrule: Some("FREQ=DAILY".into()),
            rrule_exdates: Some(vec!["2026-05-25".into()]),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(updated.rrule, "FREQ=DAILY");
    assert_eq!(updated.rrule_exdates, vec!["2026-05-25".to_string()]);
    assert_eq!(updated.scheduled_start, "2026-05-21", "unchanged field");
}

#[tokio::test]
async fn delete_recurrence_rule_cascades_to_generated_schedules() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Habit"))
        .await
        .unwrap();
    let rule = create_recurrence_rule_impl(&pool, new_rule("p1", "2026-05-21"))
        .await
        .unwrap();
    // Two expanded occurrences pinned to this rule.
    for date in ["2026-05-21", "2026-05-28"] {
        create_page_schedule_impl(
            &pool,
            NewPageSchedule {
                page_id: "p1".into(),
                scheduled_start: format!("{date}T09:00:00"),
                scheduled_end: None,
                timezone: None,
                rule_id: Some(rule.id.clone()),
                original_date: Some(date.into()),
            },
        )
        .await
        .unwrap();
    }

    delete_recurrence_rule_impl(&pool, &rule.id).await.unwrap();

    let remaining_rules = list_recurrence_rules_impl(&pool).await.unwrap();
    assert_eq!(remaining_rules.len(), 0);

    let remaining_schedules: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules WHERE rule_id = ?")
            .bind(&rule.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        remaining_schedules, 0,
        "page_schedules with this rule_id must cascade-delete"
    );
}

#[tokio::test]
async fn list_recurrence_rules_skips_soft_deleted_pages() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("alive", "Alive"))
        .await
        .unwrap();
    insert_test_page(&pool, TestPage::new("dead", "Dead"))
        .await
        .unwrap();
    create_recurrence_rule_impl(&pool, new_rule("alive", "2026-05-21"))
        .await
        .unwrap();
    create_recurrence_rule_impl(&pool, new_rule("dead", "2026-05-21"))
        .await
        .unwrap();

    sqlx::query("UPDATE pages SET deleted_at = datetime('now') WHERE id = 'dead'")
        .execute(&pool)
        .await
        .unwrap();

    let rules = list_recurrence_rules_impl(&pool).await.unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].page_id, "alive");
}

#[tokio::test]
async fn exdate_merge_ops_preserve_interleaved_writes() {
    // Mirrors the client skip/undo flow: skip A, another writer lands B inside
    // the undo-toast window, undo A. The undo must remove ONLY A — restoring
    // the array captured at skip time would erase B and resurrect its
    // occurrence next to whatever produced it (e.g. a completion's done clone).
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("head", "Series"))
        .await
        .unwrap();
    let rule = create_recurrence_rule_impl(
        &pool,
        NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-06-10".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    let after_skip =
        add_rule_exdates_impl(&pool, rule.id.clone(), vec!["2026-06-10".into(), "2026-06-10".into()])
            .await
            .unwrap();
    assert_eq!(
        after_skip.rrule_exdates,
        vec!["2026-06-10".to_string()],
        "duplicate adds dedup"
    );

    // The interleaved writer.
    add_rule_exdates_impl(&pool, rule.id.clone(), vec!["2026-06-11".into()])
        .await
        .unwrap();

    let after_undo = remove_rule_exdate_impl(&pool, rule.id.clone(), "2026-06-10".into())
        .await
        .unwrap();
    assert_eq!(
        after_undo.rrule_exdates,
        vec!["2026-06-11".to_string()],
        "undo removes only its own date — the interleaved exdate survives"
    );
}

#[tokio::test]
async fn exdate_ops_error_on_missing_rule() {
    let pool = test_pool().await;
    let add_err = add_rule_exdates_impl(&pool, "missing".into(), vec!["2026-06-10".into()])
        .await
        .unwrap_err();
    assert!(matches!(add_err, AppError::NotFound(_)));
    let remove_err = remove_rule_exdate_impl(&pool, "missing".into(), "2026-06-10".into())
        .await
        .unwrap_err();
    assert!(matches!(remove_err, AppError::NotFound(_)));
}
