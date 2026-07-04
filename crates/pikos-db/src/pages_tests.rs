use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

async fn count_pages(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pages")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn fetch_status(pool: &sqlx::SqlitePool, id: &str) -> String {
    sqlx::query_scalar::<_, String>("SELECT status FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn fetch_scheduled_start(pool: &sqlx::SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT scheduled_start FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Adds a FREQ=DAILY rule to `page_id` at `base` (recompute pins the head there).
async fn add_daily_rule(pool: &sqlx::SqlitePool, page_id: &str, base: &str) {
    crate::create_recurrence_rule_impl(
        pool,
        crate::NewRecurrenceRule {
            page_id: page_id.into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: base.into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn series_advances_to_next_open_occurrence() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            content_text: "morning routine body",
            tags_json: r#"["habits"]"#,
            scheduled_start: Some("2026-05-21"),
            ..TestPage::new("head", "Morning routine")
        },
    )
    .await
    .unwrap();
    add_daily_rule(&pool, "head", "2026-05-21").await;

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap();

    // Clone snapshots the completed occurrence.
    assert_eq!(result.clone.status, "done");
    assert!(result.clone.completed_at.is_some());
    assert_eq!(result.clone.title, "Morning routine");
    assert_eq!(result.clone.tags, vec!["habits".to_string()]);
    assert_eq!(result.clone.scheduled_start.as_deref(), Some("2026-05-21"));

    // Head stays active and the recompute advances it to the next open occurrence.
    assert_eq!(result.head.status, "not_started");
    assert_eq!(result.head.scheduled_start.as_deref(), Some("2026-05-22"));

    // The completed occurrence is recorded in the set, keyed by day.
    let clone_for_date: Option<String> = sqlx::query_scalar(
        "SELECT clone_id FROM completed_set WHERE page_id = 'head' AND occurrence_date = '2026-05-21'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(clone_for_date.as_deref(), Some(result.clone.id.as_str()));

    // Exactly one new row was inserted (the clone).
    assert_eq!(count_pages(&pool).await, 2);

    // Regression: the clone's completed_at MUST be local wall-clock (no `Z`),
    // matching scheduled_start / the frontend's nowLocalISO() — NOT the UTC
    // now_iso() used for created_at/updated_at. The Completed view compares
    // `completed_at.slice(0,10)` against the local day, so a UTC stamp hid the
    // clone whenever UTC's date ≠ the local date (≈half of every day off-UTC).
    let completed = result.clone.completed_at.expect("clone has completed_at");
    assert!(
        !completed.ends_with('Z') && !completed.contains('Z'),
        "completed_at must be local wall-clock, got {completed:?}"
    );
    assert_eq!(
        completed.len(),
        19,
        "completed_at must be yyyy-MM-ddTHH:MM:SS, got {completed:?}"
    );
    assert_eq!(
        &completed[..10],
        chrono::Local::now().format("%Y-%m-%d").to_string(),
        "completed_at date must be the local day"
    );
}

#[tokio::test]
async fn completion_records_the_set_and_leaves_rule_exdates_untouched() {
    // Under the occurrence-sets model native completion writes completed_set and
    // recomputes — it never merges the completed date into rrule_exdates. A
    // pre-existing provider/legacy EXDATE must survive unchanged; the completed
    // date lands in the set and is honored by the derivation's exclusion union.
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            scheduled_start: Some("2026-05-21"),
            ..TestPage::new("head", "Daily standup")
        },
    )
    .await
    .unwrap();
    let rule = crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec!["2026-05-19".into()],
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap();

    let exdates_json: String =
        sqlx::query_scalar("SELECT rrule_exdates FROM page_recurrence_rules WHERE id = ?")
            .bind(&rule.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        exdates_json, r#"["2026-05-19"]"#,
        "native completion must not touch rrule_exdates"
    );
    let set_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM completed_set WHERE page_id = 'head' AND occurrence_date = '2026-05-21'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(set_count, 1, "completed date recorded in the set");
    // Head advanced past both the completed date and the legacy exdate.
    assert_eq!(count_pages(&pool).await, 2);
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-05-22")
    );
}

#[tokio::test]
async fn series_marks_head_done_when_exhausted() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            content_text: "last one",
            scheduled_start: Some("2026-05-21"),
            ..TestPage::new("head", "Final occurrence")
        },
    )
    .await
    .unwrap();
    // A single-occurrence series: completing it exhausts the rule, so the
    // recompute yields no next occurrence and marks the head done.
    crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY;COUNT=1".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap();

    // Head is marked done — no next occurrence.
    assert_eq!(fetch_status(&pool, "head").await, "done");
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-05-21"),
        "scheduled_start is not cleared when series ends"
    );

    // Clone is also done.
    assert_eq!(result.clone.status, "done");
    assert_eq!(count_pages(&pool).await, 2);
}

#[tokio::test]
async fn syncs_normalized_tag_tables_on_clone() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            tags_json: r#"["alpha","beta"]"#,
            scheduled_start: Some("2026-05-21"),
            ..TestPage::new("head", "Tagged head")
        },
    )
    .await
    .unwrap();
    add_daily_rule(&pool, "head", "2026-05-21").await;

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap();

    // Clone's tags should be present in the normalized join table.
    let join_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_tags WHERE page_id = ?")
        .bind(&result.clone.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(join_count, 2, "page_tags rows missing for clone");
}

#[tokio::test]
async fn missing_head_returns_not_found() {
    let pool = test_pool().await;
    let err = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "nope".into(), skip_dates: vec![] },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, crate::error::AppError::NotFound(_)));
}

#[tokio::test]
async fn rejects_soft_deleted_head() {
    // Completing a trashed recurring page must not resurrect it as a visible
    // done clone (fetch_page has no deleted_at filter; the guard lives here).
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            scheduled_start: Some("2026-05-21"),
            ..TestPage::new("head", "Trashed recurring")
        },
    )
    .await
    .unwrap();

    add_daily_rule(&pool, "head", "2026-05-21").await;
    soft_delete_page_impl(&pool, "head").await.unwrap();

    let err = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, crate::error::AppError::NotFound(_)));

    // No clone was created.
    assert_eq!(count_pages(&pool).await, 1);
}

#[tokio::test]
async fn advanced_head_survives_later_denorm_refresh() {
    // Completing a recurring page advanced the head's
    // pages.scheduled_start, but the stale non-rule anchor page_schedules row
    // (from the initial scheduleOnce, before the rule was added) lingered. The
    // next unrelated refresh_schedule_denorm re-read that past anchor and
    // clobbered the head back — visible as "completed recurring task pops back
    // to its last date." Denorm now skips rrule-backed pages.
    use crate::schedules::{
        create_page_schedule_impl, create_recurrence_rule_impl, refresh_schedule_denorm,
        NewPageSchedule, NewRecurrenceRule,
    };

    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            scheduled_start: Some("2026-05-21"),
            ..TestPage::new("head", "Weekly review")
        },
    )
    .await
    .unwrap();

    // The one-time schedule the page was created with, before it became
    // recurring — a non-rule (rule_id IS NULL) anchor row at the first date.
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "head".into(),
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    // ...then made recurring.
    create_recurrence_rule_impl(
        &pool,
        NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=WEEKLY;BYDAY=TH".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();

    // Complete the 05-21 occurrence; the recompute advances the head to 05-28.
    complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap();
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-05-28")
    );

    // An unrelated schedule mutation elsewhere triggers a denorm refresh for the
    // head. Before the fix this clobbered the head back to the 05-21 anchor.
    refresh_schedule_denorm(&pool, "head").await.unwrap();

    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-05-28"),
        "completed recurring head must not pop back to its previous occurrence"
    );
}

// ── occurrence-sets reverse flows + ownership handoff ───────────────────

#[tokio::test]
async fn uncomplete_reverses_a_native_completion() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage { scheduled_start: Some("2026-05-21"), ..TestPage::new("head", "Daily") },
    )
    .await
    .unwrap();
    add_daily_rule(&pool, "head", "2026-05-21").await;

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap();
    assert_eq!(fetch_scheduled_start(&pool, "head").await.as_deref(), Some("2026-05-22"));

    uncomplete_recurring_occurrence_impl(
        &pool,
        UncompleteRecurringInput { page_id: "head".into(), occurrence_date: "2026-05-21".into() },
    )
    .await
    .unwrap();

    // Clone deleted via the back-link, set entry dropped, head recomputed back.
    assert!(!page_exists(&pool, &result.clone.id).await, "clone removed");
    let set_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM completed_set WHERE page_id = 'head'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(set_count, 0, "completed-set entry dropped");
    assert_eq!(fetch_scheduled_start(&pool, "head").await.as_deref(), Some("2026-05-21"));
    assert_eq!(fetch_status(&pool, "head").await, "not_started");
}

#[tokio::test]
async fn exhausted_series_uncomplete_unmarks_done() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage { scheduled_start: Some("2026-05-21"), ..TestPage::new("head", "Once") },
    )
    .await
    .unwrap();
    crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY;COUNT=1".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap();
    assert_eq!(fetch_status(&pool, "head").await, "done", "exhausted → done");

    // Uncomplete the only occurrence: it yields again, so the head un-marks done.
    uncomplete_recurring_occurrence_impl(
        &pool,
        UncompleteRecurringInput { page_id: "head".into(), occurrence_date: "2026-05-21".into() },
    )
    .await
    .unwrap();
    assert_eq!(fetch_status(&pool, "head").await, "not_started", "un-marked done");
    assert_eq!(fetch_scheduled_start(&pool, "head").await.as_deref(), Some("2026-05-21"));
}

#[tokio::test]
async fn skip_advances_head_and_undo_restores_it() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage { scheduled_start: Some("2026-05-21"), ..TestPage::new("head", "Daily") },
    )
    .await
    .unwrap();
    add_daily_rule(&pool, "head", "2026-05-21").await;

    // Dismiss the head occurrence → recompute advances past it.
    skip_occurrence_impl(
        &pool,
        SkipOccurrenceInput { page_id: "head".into(), occurrence_date: "2026-05-21".into() },
    )
    .await
    .unwrap();
    assert_eq!(fetch_scheduled_start(&pool, "head").await.as_deref(), Some("2026-05-22"));

    undo_skip_occurrence_impl(
        &pool,
        SkipOccurrenceInput { page_id: "head".into(), occurrence_date: "2026-05-21".into() },
    )
    .await
    .unwrap();
    assert_eq!(fetch_scheduled_start(&pool, "head").await.as_deref(), Some("2026-05-21"));
}

#[tokio::test]
async fn rule_delete_preserves_advanced_head_over_stale_anchor() {
    // Ownership handoff: while the rule exists the derivation owns the head and
    // advances it as occurrences complete; the surviving non-rule anchor row is
    // frozen at the creation date. On delete, the head is carried onto that anchor
    // in the SAME tx BEFORE refresh_schedule_denorm re-derives from it — else
    // removing recurrence from a long-running series rewinds the task months back
    // to the stale anchor.
    use crate::schedules::{
        create_page_schedule_impl, delete_recurrence_rule_impl, NewPageSchedule,
    };
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage { scheduled_start: Some("2026-05-21"), ..TestPage::new("head", "Daily") },
    )
    .await
    .unwrap();
    // The one-off anchor the page carried before becoming recurring, frozen at the
    // creation date — completion never advances it.
    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: "head".into(),
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    let rule = crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    // Complete two occurrences so the head advances well past the frozen anchor.
    for _ in 0..2 {
        complete_recurring_page_impl(
            &pool,
            CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
        )
        .await
        .unwrap();
    }
    assert_eq!(fetch_scheduled_start(&pool, "head").await.as_deref(), Some("2026-05-23"));

    delete_recurrence_rule_impl(&pool, &rule.id).await.unwrap();

    // The advanced head survives — NOT rewound to the 05-21 anchor.
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-05-23"),
        "advanced head preserved, not clobbered by the stale one-off anchor"
    );
}

// ── soft-delete enforcement ────────────────────────────────────────────

#[tokio::test]
async fn update_does_not_mutate_soft_deleted_page() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Original"))
        .await
        .unwrap();
    soft_delete_page_impl(&pool, "p1").await.unwrap();

    update_page_impl(
        &pool,
        "p1".into(),
        PageUpdate {
            title: Some("Changed".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let title: String = sqlx::query_scalar("SELECT title FROM pages WHERE id = 'p1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(title, "Original", "a trashed page must not be mutated");
}

#[tokio::test]
async fn re_delete_preserves_original_trash_timestamp() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Task"))
        .await
        .unwrap();

    // Backdate the trash timestamp, then delete again. The deleted_at IS NULL
    // guard must make the second delete a no-op so the auto-purge clock isn't
    // reset.
    sqlx::query("UPDATE pages SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    soft_delete_page_impl(&pool, "p1").await.unwrap();

    let deleted_at: String = sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = 'p1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(deleted_at, "2020-01-01T00:00:00.000Z");
}

// ── tags stored lowercase (new-insert path) ────────────────────────────

#[tokio::test]
async fn tag_variants_collapse_to_one_lowercase_tag() {
    let pool = test_pool().await;

    // Case/whitespace variants all normalize to the same lowercase tag.
    create_page_impl(
        &pool,
        NewPage {
            tags: vec!["Work".into()],
            ..new_page("A")
        },
    )
    .await
    .unwrap();
    let b = create_page_impl(
        &pool,
        NewPage {
            tags: vec!["work".into(), "  WORK  ".into()],
            ..new_page("B")
        },
    )
    .await
    .unwrap();

    let tag_rows: Vec<String> = sqlx::query_scalar("SELECT name FROM tags")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        tag_rows,
        vec!["work".to_string()],
        "variants must collapse to one lowercase tag"
    );
    assert_eq!(
        count_page_tags(&pool, &b.id).await,
        1,
        "B's variants must dedupe to one association"
    );
    // The denorm is stored lowercase too, so B renders "work" — not the
    // "work"/"  WORK  " the client sent.
    assert_eq!(b.tags, vec!["work".to_string()], "denorm must be lowercase");
}

// ── CRUD round-trips ───────────────────────────────────────────────────

fn new_page(title: &str) -> NewPage {
    NewPage {
        folder_id: None,
        title: title.into(),
        subtitle: None,
        content: "{}".into(),
        content_text: None,
        status: "not_started".into(),
        priority: 0,
        tags: vec![],
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        links: vec![],
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

async fn count_page_tags(pool: &sqlx::SqlitePool, page_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM page_tags WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn fetch_sort_order(pool: &sqlx::SqlitePool, id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT sort_order FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn create_page_persists_fields_and_assigns_sort_order() {
    let pool = test_pool().await;

    let first = create_page_impl(&pool, new_page("First")).await.unwrap();
    let second = create_page_impl(&pool, new_page("Second")).await.unwrap();

    assert_eq!(first.title, "First");
    assert_eq!(second.title, "Second");
    assert_ne!(first.id, second.id, "ids must be unique");
    assert_eq!(first.sort_order, 0);
    assert_eq!(
        second.sort_order, 1,
        "sort_order auto-increments per folder"
    );
    assert_eq!(count_pages(&pool).await, 2);
}

#[tokio::test]
async fn create_page_writes_normalized_tag_rows() {
    let pool = test_pool().await;
    let page = create_page_impl(
        &pool,
        NewPage {
            tags: vec!["alpha".into(), "beta".into()],
            ..new_page("Tagged")
        },
    )
    .await
    .unwrap();

    assert_eq!(count_page_tags(&pool, &page.id).await, 2);
    // pages.tags JSON denorm matches.
    assert_eq!(page.tags, vec!["alpha".to_string(), "beta".to_string()]);
}

#[tokio::test]
async fn update_page_applies_partial_changes_only() {
    let pool = test_pool().await;
    let page = create_page_impl(&pool, new_page("Before")).await.unwrap();

    let updated = update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            status: Some("done".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(updated.status, "done");
    assert_eq!(updated.title, "Before", "untouched fields preserved");
}

#[tokio::test]
async fn update_page_clears_nullable_field_when_passed_null() {
    let pool = test_pool().await;
    let page = create_page_impl(
        &pool,
        NewPage {
            scheduled_start: Some("2026-05-21".into()),
            ..new_page("Scheduled")
        },
    )
    .await
    .unwrap();
    assert_eq!(page.scheduled_start.as_deref(), Some("2026-05-21"));

    let updated = update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            scheduled_start: Some(serde_json::Value::Null),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert!(updated.scheduled_start.is_none());
}

#[tokio::test]
async fn update_page_rewrites_normalized_tags() {
    let pool = test_pool().await;
    let page = create_page_impl(
        &pool,
        NewPage {
            tags: vec!["one".into(), "two".into()],
            ..new_page("Tagged")
        },
    )
    .await
    .unwrap();
    assert_eq!(count_page_tags(&pool, &page.id).await, 2);

    // Replace tag set entirely.
    update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            tags: Some(vec!["three".into()]),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(
        count_page_tags(&pool, &page.id).await,
        1,
        "stale page_tags rows must be cleared on tag replace"
    );
}

#[tokio::test]
async fn delete_page_removes_row_and_cascades_to_page_tags() {
    let pool = test_pool().await;
    let page = create_page_impl(
        &pool,
        NewPage {
            tags: vec!["a".into()],
            ..new_page("Doomed")
        },
    )
    .await
    .unwrap();
    assert_eq!(count_page_tags(&pool, &page.id).await, 1);

    delete_page_impl(&pool, &page.id).await.unwrap();
    assert_eq!(count_pages(&pool).await, 0);
    assert_eq!(
        count_page_tags(&pool, &page.id).await,
        0,
        "page_tags must cascade-delete on hard delete"
    );
}

#[tokio::test]
async fn soft_delete_then_restore_round_trip() {
    let pool = test_pool().await;
    let page = create_page_impl(&pool, new_page("Recoverable"))
        .await
        .unwrap();

    soft_delete_page_impl(&pool, &page.id).await.unwrap();
    let deleted_at: Option<String> =
        sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = ?")
            .bind(&page.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(deleted_at.is_some(), "soft delete sets deleted_at");

    // list_pages hides soft-deleted rows.
    let visible = list_pages_impl(&pool, None).await.unwrap();
    assert!(visible.is_empty());

    restore_page_impl(&pool, &page.id).await.unwrap();
    let restored: Option<String> = sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = ?")
        .bind(&page.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(restored.is_none(), "restore clears deleted_at");
    assert_eq!(list_pages_impl(&pool, None).await.unwrap().len(), 1);
}

#[tokio::test]
async fn list_pages_filters_by_status_and_folder() {
    let pool = test_pool().await;
    // Two pages in inbox; one in a folder.
    insert_test_page(&pool, TestPage::new("inbox-open", "Inbox open"))
        .await
        .unwrap();
    insert_test_page(
        &pool,
        TestPage {
            status: "done",
            ..TestPage::new("inbox-done", "Inbox done")
        },
    )
    .await
    .unwrap();
    // Create a folder so the FK is valid.
    sqlx::query("INSERT INTO folders (id, name, sort_order, created_at, updated_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))")
        .bind("folder-a")
        .bind("A")
        .execute(&pool)
        .await
        .unwrap();
    insert_test_page(
        &pool,
        TestPage {
            folder_id: Some("folder-a"),
            ..TestPage::new("a-open", "A open")
        },
    )
    .await
    .unwrap();

    // Filter: status = not_started → 2 results
    let open = list_pages_impl(
        &pool,
        Some(PageFilter {
            status: Some("not_started".into()),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(open.len(), 2);

    // Filter: folder_id = "folder-a" → 1 result
    let in_a = list_pages_impl(
        &pool,
        Some(PageFilter {
            folder_id: Some(serde_json::Value::String("folder-a".into())),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(in_a.len(), 1);
    assert_eq!(in_a[0].title, "A open");

    // Filter: folder_id = null (inbox) → 2 results (open + done)
    let inbox = list_pages_impl(
        &pool,
        Some(PageFilter {
            folder_id: Some(serde_json::Value::Null),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(inbox.len(), 2);
}

#[tokio::test]
async fn reorder_pages_assigns_positional_indices() {
    let pool = test_pool().await;
    let a = create_page_impl(&pool, new_page("A")).await.unwrap();
    let b = create_page_impl(&pool, new_page("B")).await.unwrap();
    let c = create_page_impl(&pool, new_page("C")).await.unwrap();

    // Reverse the order.
    reorder_pages_impl(&pool, None, &[c.id.clone(), b.id.clone(), a.id.clone()])
        .await
        .unwrap();

    assert_eq!(fetch_sort_order(&pool, &c.id).await, 0);
    assert_eq!(fetch_sort_order(&pool, &b.id).await, 1);
    assert_eq!(fetch_sort_order(&pool, &a.id).await, 2);
}

// ── list_pages_today ───────────────────────────────────────────────────────

async fn insert_schedule(pool: &sqlx::SqlitePool, page_id: &str, scheduled_start: &str) {
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, status, created_at)
         VALUES (?, ?, ?, 'not_started', datetime('now'))",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(page_id)
    .bind(scheduled_start)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn list_pages_today_includes_today_and_overdue() {
    let pool = test_pool().await;

    // today + overdue: should appear
    insert_test_page(&pool, TestPage::new("today", "Today"))
        .await
        .unwrap();
    insert_schedule(&pool, "today", "2024-01-01T09:00:00").await; // past — overdue

    insert_test_page(&pool, TestPage::new("future", "Future"))
        .await
        .unwrap();
    // 5 years in the future — definitely not "today"
    insert_schedule(&pool, "future", "2099-01-01T09:00:00").await;

    // unscheduled: should not appear
    insert_test_page(&pool, TestPage::new("unscheduled", "Unscheduled"))
        .await
        .unwrap();

    let pages = list_pages_today_impl(&pool).await.unwrap();
    let ids: Vec<&str> = pages.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["today"], "only today/overdue page is returned");
}

#[tokio::test]
async fn list_pages_today_excludes_done_and_deleted() {
    let pool = test_pool().await;

    insert_test_page(
        &pool,
        TestPage {
            status: "done",
            ..TestPage::new("done", "Done")
        },
    )
    .await
    .unwrap();
    insert_schedule(&pool, "done", "2024-01-01T09:00:00").await;

    insert_test_page(&pool, TestPage::new("deleted", "Deleted"))
        .await
        .unwrap();
    insert_schedule(&pool, "deleted", "2024-01-01T09:00:00").await;
    sqlx::query("UPDATE pages SET deleted_at = datetime('now') WHERE id = 'deleted'")
        .execute(&pool)
        .await
        .unwrap();

    let pages = list_pages_today_impl(&pool).await.unwrap();
    assert!(
        pages.is_empty(),
        "done + soft-deleted pages must be excluded"
    );
}

#[tokio::test]
async fn list_pages_today_deduplicates_pages_with_multiple_schedules() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("recurring", "Recurring"))
        .await
        .unwrap();
    // Three past schedules — page would appear 3× without DISTINCT.
    insert_schedule(&pool, "recurring", "2024-01-01T09:00:00").await;
    insert_schedule(&pool, "recurring", "2024-02-01T09:00:00").await;
    insert_schedule(&pool, "recurring", "2024-03-01T09:00:00").await;

    let pages = list_pages_today_impl(&pool).await.unwrap();
    assert_eq!(pages.len(), 1, "DISTINCT collapses multi-schedule pages");
    assert_eq!(pages[0].id, "recurring");
}

// ── list_completed_pages ──────────────────────────────────────────────────

async fn insert_completed_page(pool: &sqlx::SqlitePool, id: &str, completed_at: &str) {
    sqlx::query(
        "INSERT INTO pages
         (id, folder_id, title, subtitle, content, content_text, status, priority, tags,
          sort_order, completed_at, created_at, updated_at)
         VALUES (?, NULL, ?, NULL, '{}', '', 'done', 0, '[]', 0, ?, ?, ?)",
    )
    .bind(id)
    .bind(id)
    .bind(completed_at)
    .bind(completed_at)
    .bind(completed_at)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn list_completed_pages_paginates_by_limit_offset() {
    let pool = test_pool().await;
    for i in 0..5 {
        insert_completed_page(
            &pool,
            &format!("done-{i}"),
            &format!("2026-05-{:02}T09:00:00", 10 + i),
        )
        .await;
    }

    let first_page = list_completed_pages_impl(
        &pool,
        CompletedPagesFilter {
            folder_id: None,
            completed_since: None,
            limit: 2,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(first_page.pages.len(), 2);
    assert_eq!(first_page.total, 5, "total ignores limit/offset");
    // Most-recent first.
    assert_eq!(first_page.pages[0].id, "done-4");
    assert_eq!(first_page.pages[1].id, "done-3");

    let second_page = list_completed_pages_impl(
        &pool,
        CompletedPagesFilter {
            folder_id: None,
            completed_since: None,
            limit: 2,
            offset: 2,
        },
    )
    .await
    .unwrap();
    assert_eq!(second_page.pages[0].id, "done-2");
}

#[tokio::test]
async fn list_completed_pages_excludes_open_and_deleted() {
    let pool = test_pool().await;
    insert_completed_page(&pool, "done", "2026-05-21T09:00:00").await;
    // Open page should not appear even with completed_at non-null (defensive: query gates on status).
    insert_test_page(&pool, TestPage::new("open", "Open"))
        .await
        .unwrap();
    // Soft-deleted done page should not appear.
    insert_completed_page(&pool, "deleted", "2026-05-21T09:00:00").await;
    sqlx::query("UPDATE pages SET deleted_at = datetime('now') WHERE id = 'deleted'")
        .execute(&pool)
        .await
        .unwrap();

    let result = list_completed_pages_impl(
        &pool,
        CompletedPagesFilter {
            folder_id: None,
            completed_since: None,
            limit: 50,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.total, 1);
    assert_eq!(result.pages[0].id, "done");
}

#[tokio::test]
async fn list_completed_pages_filters_by_folder() {
    let pool = test_pool().await;
    sqlx::query("INSERT INTO folders (id, name, sort_order, created_at, updated_at) VALUES ('work', 'Work', 0, datetime('now'), datetime('now'))")
        .execute(&pool)
        .await
        .unwrap();
    // Inbox completion
    insert_completed_page(&pool, "inbox-done", "2026-05-21T09:00:00").await;
    // Folder completion — needs explicit folder_id INSERT
    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, subtitle, content, content_text, status, priority, tags, sort_order, completed_at, created_at, updated_at)
         VALUES ('work-done', 'work', 'Work done', NULL, '{}', '', 'done', 0, '[]', 0, '2026-05-21T09:00:00', '2026-05-21T09:00:00', '2026-05-21T09:00:00')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let work = list_completed_pages_impl(
        &pool,
        CompletedPagesFilter {
            folder_id: Some(serde_json::Value::String("work".into())),
            completed_since: None,
            limit: 50,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(work.total, 1);
    assert_eq!(work.pages[0].id, "work-done");

    let inbox = list_completed_pages_impl(
        &pool,
        CompletedPagesFilter {
            folder_id: Some(serde_json::Value::Null),
            completed_since: None,
            limit: 50,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(inbox.total, 1);
    assert_eq!(inbox.pages[0].id, "inbox-done");
}

#[tokio::test]
async fn list_completed_pages_filters_by_completed_since() {
    let pool = test_pool().await;
    insert_completed_page(&pool, "old", "2026-04-01T09:00:00").await;
    insert_completed_page(&pool, "recent", "2026-05-21T09:00:00").await;

    let after = list_completed_pages_impl(
        &pool,
        CompletedPagesFilter {
            folder_id: None,
            completed_since: Some("2026-05-01".into()),
            limit: 50,
            offset: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(after.total, 1);
    assert_eq!(after.pages[0].id, "recent");
}

// ── Edge cases that matter for data integrity ─────────────────────────────

#[tokio::test]
async fn update_page_with_empty_tags_clears_normalized_join_rows() {
    let pool = test_pool().await;
    let page = create_page_impl(
        &pool,
        NewPage {
            tags: vec!["keep".into(), "drop".into()],
            ..new_page("Multi-tag")
        },
    )
    .await
    .unwrap();
    assert_eq!(count_page_tags(&pool, &page.id).await, 2);

    // Explicit empty tags vec must clear all tag associations.
    let updated = update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            tags: Some(vec![]),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert!(updated.tags.is_empty(), "pages.tags denorm cleared");
    assert_eq!(
        count_page_tags(&pool, &page.id).await,
        0,
        "page_tags rows cleared"
    );
}

#[tokio::test]
async fn fts_index_reflects_title_after_update() {
    use crate::search::search_pages_impl;

    let pool = test_pool().await;
    let page = create_page_impl(
        &pool,
        NewPage {
            content_text: Some("body content".into()),
            ..new_page("Original title")
        },
    )
    .await
    .unwrap();

    // Search by old title — hits.
    let before = search_pages_impl(&pool, "Original".into(), None)
        .await
        .unwrap();
    assert_eq!(before.results.len(), 1);

    // Rename.
    update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            title: Some("Renamed thing".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Old title no longer matches; new title does. The FTS triggers must
    // have kept the external-content index in sync without a manual rebuild.
    let stale = search_pages_impl(&pool, "Original".into(), None)
        .await
        .unwrap();
    assert_eq!(stale.results.len(), 0, "stale FTS hit after rename");

    let fresh = search_pages_impl(&pool, "Renamed".into(), None)
        .await
        .unwrap();
    assert_eq!(fresh.results.len(), 1);
}

#[tokio::test]
async fn fts_index_drops_page_after_hard_delete() {
    use crate::search::search_pages_impl;

    let pool = test_pool().await;
    let page = create_page_impl(
        &pool,
        NewPage {
            content_text: Some("findable body".into()),
            ..new_page("Doomed")
        },
    )
    .await
    .unwrap();

    delete_page_impl(&pool, &page.id).await.unwrap();

    let after = search_pages_impl(&pool, "Doomed".into(), None)
        .await
        .unwrap();
    assert_eq!(
        after.results.len(),
        0,
        "FTS DELETE trigger must drop the row"
    );
}

// ─── set_pages_status_impl (bulk complete/uncomplete) ────────────────────────

#[tokio::test]
async fn set_pages_status_completes_all_in_one_call() {
    let pool = test_pool().await;
    for id in ["a", "b", "c"] {
        insert_test_page(&pool, TestPage::new(id, id)).await.unwrap();
    }

    let ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let updated = set_pages_status_impl(&pool, &ids, "done", Some("2026-06-05T10:00:00"))
        .await
        .unwrap();

    // Every page is returned and persisted as done with the given completed_at —
    // no silent drops (the Cmd+A → Space "doesn't reliably complete all" defect).
    assert_eq!(updated.len(), 3);
    for id in ["a", "b", "c"] {
        assert_eq!(fetch_status(&pool, id).await, "done");
        let completed: Option<String> =
            sqlx::query_scalar("SELECT completed_at FROM pages WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(completed.as_deref(), Some("2026-06-05T10:00:00"));
    }
}

#[tokio::test]
async fn set_pages_status_uncomplete_clears_completed_at() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            status: "done",
            ..TestPage::new("a", "A")
        },
    )
    .await
    .unwrap();

    set_pages_status_impl(&pool, &["a".to_string()], "not_started", None)
        .await
        .unwrap();

    assert_eq!(fetch_status(&pool, "a").await, "not_started");
    let completed: Option<String> =
        sqlx::query_scalar("SELECT completed_at FROM pages WHERE id = ?")
            .bind("a")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(completed, None);
}

#[tokio::test]
async fn set_pages_status_skips_soft_deleted_rows() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("a", "A")).await.unwrap();
    insert_test_page(&pool, TestPage::new("b", "B")).await.unwrap();
    soft_delete_page_impl(&pool, "b").await.unwrap();

    let ids = vec!["a".to_string(), "b".to_string()];
    let updated = set_pages_status_impl(&pool, &ids, "done", Some("2026-06-05T10:00:00"))
        .await
        .unwrap();

    // The trashed page is neither mutated nor returned — a stale selection must
    // not resurrect/rewrite a deleted row (mirrors update_page_impl's guard).
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].id, "a");
    assert_eq!(fetch_status(&pool, "a").await, "done");
    assert_eq!(fetch_status(&pool, "b").await, "not_started");
}

#[tokio::test]
async fn set_pages_status_empty_ids_is_noop() {
    let pool = test_pool().await;
    let updated = set_pages_status_impl(&pool, &[], "done", None).await.unwrap();
    assert!(updated.is_empty());
}

#[tokio::test]
async fn reschedule_virtual_clones_schedules_and_exdates_in_one_call() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            content_text: "standup body",
            tags_json: r#"["work"]"#,
            scheduled_start: Some("2026-06-08T09:00:00"),
            ..TestPage::new("head", "Daily standup")
        },
    )
    .await
    .unwrap();
    let rule = crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec!["2026-06-07".into()],
            scheduled_start: "2026-06-08T09:00:00".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    let result = reschedule_virtual_occurrence_impl(
        &pool,
        RescheduleVirtualInput {
            rule_id: rule.id.clone(),
            original_date: "2026-06-10".into(),
            scheduled_start: "2026-06-11T14:00:00".into(),
            scheduled_end: Some("2026-06-11T15:00:00".into()),
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    // Clone is an independent live page at the new time, content copied.
    assert_eq!(result.clone.status, "not_started");
    assert_eq!(result.clone.title, "Daily standup");
    assert_eq!(result.clone.tags, vec!["work".to_string()]);
    assert_eq!(
        result.clone.scheduled_start.as_deref(),
        Some("2026-06-11T14:00:00")
    );
    assert!(result.clone.completed_at.is_none());

    // Original date MERGED into existing exdates, not written as a replacement.
    assert_eq!(
        result.rule_exdates,
        vec!["2026-06-07".to_string(), "2026-06-10".to_string()]
    );

    // The clone got a plain schedule block, detached from the rule.
    let detached: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM page_schedules WHERE page_id = ? AND rule_id IS NULL",
    )
    .bind(&result.clone.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(detached, 1);

    // Head and rule anchor untouched.
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-06-08T09:00:00")
    );
    assert_eq!(count_pages(&pool).await, 2);
}

#[tokio::test]
async fn reschedule_virtual_rejects_trashed_head_with_no_partial_writes() {
    // Atomicity contract: the pre-fix client flow issued clone/schedule/exdate
    // as three separate writes, so a mid-sequence failure left BOTH the clone
    // and the still-unexcluded virtual on the calendar. An error must now
    // leave nothing behind.
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            scheduled_start: Some("2026-06-08"),
            ..TestPage::new("head", "Trashed series")
        },
    )
    .await
    .unwrap();
    let rule = crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-06-08".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE pages SET deleted_at = '2026-06-09T00:00:00Z' WHERE id = 'head'")
        .execute(&pool)
        .await
        .unwrap();

    let err = reschedule_virtual_occurrence_impl(
        &pool,
        RescheduleVirtualInput {
            rule_id: rule.id.clone(),
            original_date: "2026-06-10".into(),
            scheduled_start: "2026-06-11T14:00:00".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)));

    assert_eq!(count_pages(&pool).await, 1, "no clone row leaked");
    let schedules: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(schedules, 0, "no schedule row leaked");
    let exdates_json: String =
        sqlx::query_scalar("SELECT rrule_exdates FROM page_recurrence_rules WHERE id = ?")
            .bind(&rule.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(exdates_json, "[]", "exdate not written for a failed reschedule");
}

// ─── schedule_locked / user_modified / placement-lock ────────────────────────

async fn mark_synced(pool: &sqlx::SqlitePool, page_id: &str, sync_state: &str) {
    crate::pool::insert_test_page_sync(pool, page_id, sync_state)
        .await
        .unwrap();
}

async fn sync_state(pool: &sqlx::SqlitePool, page_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT sync_state FROM page_sync WHERE page_id = ?")
        .bind(page_id)
        .fetch_optional(pool)
        .await
        .unwrap()
}

async fn page_exists(pool: &sqlx::SqlitePool, id: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?)")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn user_modified(pool: &sqlx::SqlitePool, page_id: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT user_modified FROM page_sync WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn schedule_locked_true_only_for_active_synced_pages() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("native", "Native")).await.unwrap();
    insert_test_page(&pool, TestPage::new("active", "Active")).await.unwrap();
    insert_test_page(&pool, TestPage::new("detached", "Detached")).await.unwrap();
    insert_test_page(&pool, TestPage::new("tombstoned", "Tombstoned")).await.unwrap();
    mark_synced(&pool, "active", "active").await;
    mark_synced(&pool, "detached", "detached").await;
    mark_synced(&pool, "tombstoned", "tombstoned").await;

    // get_page (full Page) and list_pages (PageSummary) must agree.
    let locked = |id: &'static str| {
        let pool = pool.clone();
        async move { get_page(&pool, id).await.unwrap().unwrap().schedule_locked }
    };
    assert!(!locked("native").await, "native page is never locked");
    assert!(locked("active").await, "active synced page is locked");
    assert!(!locked("detached").await, "detached page unlocks");
    assert!(!locked("tombstoned").await, "tombstoned page unlocks");

    let summaries = list_pages_impl(&pool, None).await.unwrap();
    let by_id = |id: &str| summaries.iter().find(|p| p.id == id).unwrap().schedule_locked;
    assert!(by_id("active"), "PageSummary mirrors get_page for the active page");
    assert!(!by_id("native"));
}

#[tokio::test]
async fn editing_a_synced_page_marks_it_user_modified() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Event")).await.unwrap();
    mark_synced(&pool, "p", "active").await;
    assert!(!user_modified(&pool, "p").await, "starts clean");

    update_page_impl(
        &pool,
        "p".into(),
        PageUpdate {
            content: Some(r#"{"type":"doc"}"#.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(user_modified(&pool, "p").await, "editing the body sets ownership");
}

#[tokio::test]
async fn opening_a_synced_page_does_not_mark_it_user_modified() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Event")).await.unwrap();
    mark_synced(&pool, "p", "active").await;

    // A lone last_opened_at write is "open", not "author" — reading ≠ ownership.
    update_page_impl(
        &pool,
        "p".into(),
        PageUpdate {
            last_opened_at: Some(serde_json::json!("2026-06-20T10:00:00Z")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!user_modified(&pool, "p").await, "opening must not set ownership");
}

#[tokio::test]
async fn updating_a_native_page_never_touches_page_sync() {
    // No page_sync row exists — the user_modified write must be a harmless no-op.
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Native")).await.unwrap();
    let updated = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { title: Some("Renamed".into()), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(updated.title, "Renamed");
    assert!(!updated.schedule_locked);
}

async fn flag_external(pool: &sqlx::SqlitePool, folder_id: &str) {
    sqlx::query("UPDATE folders SET is_external_calendar = 1 WHERE id = ?")
        .bind(folder_id)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn moving_a_page_into_an_external_folder_is_rejected() {
    let pool = test_pool().await;
    crate::pool::insert_test_folder(&pool, "ext", "Synced").await.unwrap();
    flag_external(&pool, "ext").await;
    insert_test_page(&pool, TestPage::new("p", "Native")).await.unwrap();

    let err = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { folder_id: Some(serde_json::json!("ext")), ..Default::default() },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

#[tokio::test]
async fn moving_a_page_out_of_an_external_folder_is_rejected() {
    let pool = test_pool().await;
    crate::pool::insert_test_folder(&pool, "ext", "Synced").await.unwrap();
    crate::pool::insert_test_folder(&pool, "regular", "Regular").await.unwrap();
    flag_external(&pool, "ext").await;
    insert_test_page(
        &pool,
        TestPage { folder_id: Some("ext"), ..TestPage::new("p", "Synced event") },
    )
    .await
    .unwrap();

    // Move to a regular folder — rejected.
    let to_regular = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { folder_id: Some(serde_json::json!("regular")), ..Default::default() },
    )
    .await
    .unwrap_err();
    assert!(matches!(to_regular, AppError::Conflict(_)));

    // Move to inbox (folder_id = null) — also rejected (still leaving the folder).
    let to_inbox = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { folder_id: Some(serde_json::Value::Null), ..Default::default() },
    )
    .await
    .unwrap_err();
    assert!(matches!(to_inbox, AppError::Conflict(_)));
}

#[tokio::test]
async fn moving_a_page_between_regular_folders_is_allowed() {
    let pool = test_pool().await;
    crate::pool::insert_test_folder(&pool, "a", "A").await.unwrap();
    crate::pool::insert_test_folder(&pool, "b", "B").await.unwrap();
    insert_test_page(
        &pool,
        TestPage { folder_id: Some("a"), ..TestPage::new("p", "Note") },
    )
    .await
    .unwrap();

    let moved = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { folder_id: Some(serde_json::json!("b")), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(moved.folder_id.as_deref(), Some("b"));
}

// ─── title/schedule reject · create guard · sync-aware delete/restore ─────────

#[tokio::test]
async fn editing_title_or_schedule_of_a_synced_page_is_rejected() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Synced event")).await.unwrap();
    mark_synced(&pool, "p", "active").await;

    let title = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { title: Some("Renamed".into()), ..Default::default() },
    )
    .await
    .unwrap_err();
    assert!(matches!(title, AppError::Conflict(_)), "title is locked");

    let start = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { scheduled_start: Some(serde_json::json!("2026-07-01T09:00:00")), ..Default::default() },
    )
    .await
    .unwrap_err();
    assert!(matches!(start, AppError::Conflict(_)), "schedule is locked");
}

#[tokio::test]
async fn editing_body_or_status_of_a_synced_page_is_allowed() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Synced event")).await.unwrap();
    mark_synced(&pool, "p", "active").await;

    // Body + completion are user-layer / ownership actions, never locked.
    update_page_impl(
        &pool,
        "p".into(),
        PageUpdate {
            content: Some(r#"{"type":"doc"}"#.into()),
            status: Some("done".into()),
            completed_at: Some(serde_json::json!("2026-06-20T10:00:00")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(user_modified(&pool, "p").await);
}

#[tokio::test]
async fn detached_page_title_and_schedule_unlock() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Was synced")).await.unwrap();
    mark_synced(&pool, "p", "detached").await;

    // Detach unlocks the mirror — the page is now a normal local record.
    let updated = update_page_impl(
        &pool,
        "p".into(),
        PageUpdate { title: Some("Edited after detach".into()), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(updated.title, "Edited after detach");
}

#[tokio::test]
async fn creating_a_page_in_an_external_folder_is_rejected() {
    let pool = test_pool().await;
    crate::pool::insert_test_folder(&pool, "ext", "Synced").await.unwrap();
    flag_external(&pool, "ext").await;

    let err = create_page_impl(
        &pool,
        crate::NewPage {
            folder_id: Some("ext".into()),
            title: "Sneaky".into(),
            subtitle: None,
            content: "{}".into(),
            content_text: None,
            status: "not_started".into(),
            priority: 0,
            tags: vec![],
            scheduled_start: None,
            scheduled_end: None,
            completed_at: None,
            links: vec![],
            parent_id: None,
            last_opened_at: None,
            created_at: None,
            updated_at: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

#[tokio::test]
async fn deleting_a_synced_page_soft_deletes_and_tombstones() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Synced event")).await.unwrap();
    mark_synced(&pool, "p", "active").await;

    // Hard-delete path (calendar block delete / CLI rm) must NOT cascade the row
    // away — it would resurrect on the next poll. Soft-delete + tombstone instead.
    delete_page_impl(&pool, "p").await.unwrap();
    assert!(page_exists(&pool, "p").await, "row kept (recoverable from trash)");
    assert_eq!(sync_state(&pool, "p").await.as_deref(), Some("tombstoned"));

    // Restore resumes syncing.
    restore_page_impl(&pool, "p").await.unwrap();
    assert_eq!(sync_state(&pool, "p").await.as_deref(), Some("active"));
}

#[tokio::test]
async fn deleting_a_native_page_still_hard_deletes() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Native")).await.unwrap();
    delete_page_impl(&pool, "p").await.unwrap();
    assert!(!page_exists(&pool, "p").await, "native page is hard-deleted");
}

#[tokio::test]
async fn restore_only_reactivates_a_tombstone_not_a_detached_link() {
    // Restore flips only the tombstone its own delete set; a detached link (sync
    // deliberately severed) must stay detached. Set deleted_at directly to isolate
    // the restore query's `sync_state = 'tombstoned'` filter — the normal soft
    // delete would tombstone first, masking the guard.
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Detached synced")).await.unwrap();
    mark_synced(&pool, "p", "detached").await;
    sqlx::query("UPDATE pages SET deleted_at = ? WHERE id = 'p'")
        .bind(now_iso())
        .execute(&pool)
        .await
        .unwrap();

    restore_page_impl(&pool, "p").await.unwrap();

    assert_eq!(sync_state(&pool, "p").await.as_deref(), Some("detached"), "stays severed");
}

#[tokio::test]
async fn trashing_and_restoring_a_detached_page_keeps_it_detached() {
    // A detached link must not be tombstoned on trash, or restore reactivates it
    // (schedule re-locks, the broken-sync notice vanishes) with no upstream event.
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Detached synced")).await.unwrap();
    mark_synced(&pool, "p", "detached").await;

    soft_delete_page_impl(&pool, "p").await.unwrap();
    assert_eq!(sync_state(&pool, "p").await.as_deref(), Some("detached"), "trash leaves it severed");

    restore_page_impl(&pool, "p").await.unwrap();
    assert_eq!(sync_state(&pool, "p").await.as_deref(), Some("detached"), "restore keeps it severed");
}

#[tokio::test]
async fn rescheduling_an_occurrence_of_a_synced_series_is_rejected() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Recurring synced")).await.unwrap();
    let rule = crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "p".into(),
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-07-06T09:00:00".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();
    mark_synced(&pool, "p", "active").await;

    // Dragging a virtual occurrence to a new time rewrites the rule's exdates —
    // locked on a synced series.
    let err = reschedule_virtual_occurrence_impl(
        &pool,
        RescheduleVirtualInput {
            rule_id: rule.id,
            original_date: "2026-07-13".into(),
            scheduled_start: "2026-07-13T11:00:00".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

#[tokio::test]
async fn today_view_carries_schedule_locked() {
    // list_pages_today builds its SELECT with per-column `pages.` prefixing, a
    // different path than list_pages — confirm the derived flag is wired there too.
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Synced standup")).await.unwrap();
    mark_synced(&pool, "p", "active").await;
    // Schedule it for today via raw SQL — the command-layer writer is now locked.
    let now = now_iso();
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
         VALUES ('s1', 'p', date('now'), NULL, 'UTC', NULL, NULL, 'not_started', ?)",
    )
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    let today = list_pages_today_impl(&pool).await.unwrap();
    let p = today.iter().find(|p| p.id == "p").expect("synced page in Today");
    assert!(p.schedule_locked, "Today view must carry schedule_locked");
}

#[tokio::test]
async fn complete_synced_occurrence_rejects_non_recurring() {
    // Occurrence completion only applies to a recurring synced series. A synced
    // ONE-OFF has no rule, so the writer must reject rather than mint a clone the
    // expansion can never suppress (symmetric with the native head-advance guard).
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p", "Synced one-off"))
        .await
        .unwrap();
    mark_synced(&pool, "p", "active").await;

    let err = complete_synced_occurrence_impl(
        &pool,
        CompleteSyncedOccurrenceInput {
            page_id: "p".into(),
            occurrence_date: "2026-06-01".into(),
            scheduled_start: "2026-06-01T09:00:00".into(),
            scheduled_end: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)), "non-recurring synced page rejected");
}

/// Build an active synced recurring series ("head") for the occurrence tests.
async fn synced_recurring_series(pool: &sqlx::SqlitePool) {
    insert_test_page(
        pool,
        TestPage {
            scheduled_start: Some("2026-06-01T09:00:00"),
            scheduled_end: Some("2026-06-01T09:30:00"),
            ..TestPage::new("head", "Weekly 1:1")
        },
    )
    .await
    .unwrap();
    crate::create_recurrence_rule_impl(
        pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=WEEKLY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-06-01T09:00:00".into(),
            scheduled_end: Some("2026-06-01T09:30:00".into()),
            timezone: "Europe/London".into(),
        },
    )
    .await
    .unwrap();
    mark_synced(pool, "head", "active").await;
}

#[tokio::test]
async fn complete_synced_occurrence_inserts_clone_and_records_map() {
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;

    let clone = complete_synced_occurrence_impl(
        &pool,
        CompleteSyncedOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-08".into(),
            scheduled_start: "2026-06-08T09:00:00".into(),
            scheduled_end: Some("2026-06-08T09:30:00".into()),
        },
    )
    .await
    .unwrap();

    // The clone is a durable native done page at the occurrence — no sync link.
    assert_eq!(clone.status, "done");
    assert_eq!(clone.scheduled_start.as_deref(), Some("2026-06-08T09:00:00"));
    assert!(!clone.schedule_locked, "clone is native, not sync-locked");
    assert!(clone.sync_state.is_none());

    // The set records (date → clone id); the reconciler-owned head is untouched.
    let recorded: String = sqlx::query_scalar(
        "SELECT clone_id FROM completed_set WHERE page_id = 'head' AND occurrence_date = '2026-06-08'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(recorded, clone.id);
}

#[tokio::test]
async fn complete_synced_occurrence_twice_is_idempotent() {
    // Second call for the same page/date returns the same clone — no orphaned ghost.
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;

    let input = || CompleteSyncedOccurrenceInput {
        page_id: "head".into(),
        occurrence_date: "2026-06-08".into(),
        scheduled_start: "2026-06-08T09:00:00".into(),
        scheduled_end: Some("2026-06-08T09:30:00".into()),
    };

    let first = complete_synced_occurrence_impl(&pool, input()).await.unwrap();
    let second = complete_synced_occurrence_impl(&pool, input()).await.unwrap();

    assert_eq!(second.id, first.id, "second completion returns the same clone");

    let clone_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE status = 'done' AND deleted_at IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(clone_count, 1, "exactly one done clone — no orphan");

    let set_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM completed_set WHERE page_id = 'head'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(set_count, 1);
}

#[tokio::test]
async fn uncomplete_synced_occurrence_deletes_clone_and_drops_date() {
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;
    let clone = complete_synced_occurrence_impl(
        &pool,
        CompleteSyncedOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-08".into(),
            scheduled_start: "2026-06-08T09:00:00".into(),
            scheduled_end: None,
        },
    )
    .await
    .unwrap();

    uncomplete_synced_occurrence_impl(
        &pool,
        UncompleteSyncedOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-08".into(),
        },
    )
    .await
    .unwrap();

    assert!(!page_exists(&pool, &clone.id).await, "clone deleted");
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM completed_set WHERE page_id = 'head' AND occurrence_date = '2026-06-08'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0, "date dropped from set");
}

#[tokio::test]
async fn native_recurring_completion_rejects_an_active_synced_series() {
    // The native head-advance path would clone the head AND advance its
    // schedule + merge an EXDATE — all reconciler-owned for a synced series, so
    // it gets clobbered on the next sync. A CLI/non-UI caller must be rejected
    // and routed to complete_synced_occurrence_impl instead.
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;

    let err = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput { page_id: "head".into(), skip_dates: vec![] },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AppError::Conflict(_)), "synced series rejects native completion");
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-06-01T09:00:00"),
        "head schedule not advanced"
    );
    assert_eq!(count_pages(&pool).await, 1, "no clone minted");
}

#[tokio::test]
async fn native_uncomplete_and_undo_skip_reject_an_active_synced_series() {
    // The native reverse commands recompute a reconciler-owned head — a non-UI
    // caller (CLI) must be rejected, mirroring skip/complete. The synced reverse
    // path is uncomplete_synced_occurrence_impl.
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;

    let uncomplete = uncomplete_recurring_occurrence_impl(
        &pool,
        UncompleteRecurringInput { page_id: "head".into(), occurrence_date: "2026-06-01".into() },
    )
    .await
    .unwrap_err();
    assert!(matches!(uncomplete, AppError::Conflict(_)), "synced uncomplete rejected");

    let undo_skip = undo_skip_occurrence_impl(
        &pool,
        SkipOccurrenceInput { page_id: "head".into(), occurrence_date: "2026-06-01".into() },
    )
    .await
    .unwrap_err();
    assert!(matches!(undo_skip, AppError::Conflict(_)), "synced undo-skip rejected");
}

#[tokio::test]
async fn restore_skips_recompute_for_an_active_synced_series() {
    // Restore reactivates the sync link, so its recompute must stay excluded like
    // the foreground heal — else it advances the reconciler-pinned head off a
    // completed-set entry the provider still owns.
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;
    // A completed occurrence at the head's own date: a native recompute would
    // advance the head to the next week; the reconciler keeps it pinned.
    complete_synced_occurrence_impl(
        &pool,
        CompleteSyncedOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-01".into(),
            scheduled_start: "2026-06-01T09:00:00".into(),
            scheduled_end: Some("2026-06-01T09:30:00".into()),
        },
    )
    .await
    .unwrap();

    soft_delete_page_impl(&pool, "head").await.unwrap();
    restore_page_impl(&pool, "head").await.unwrap();

    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-06-01T09:00:00"),
        "reconciler-pinned head not advanced by restore's recompute"
    );
}

#[tokio::test]
async fn complete_synced_occurrence_leaves_head_and_rule_untouched() {
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;
    let exdates_before: String =
        sqlx::query_scalar("SELECT rrule_exdates FROM page_recurrence_rules WHERE page_id = 'head'")
            .fetch_one(&pool)
            .await
            .unwrap();

    let clone = complete_synced_occurrence_impl(
        &pool,
        CompleteSyncedOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-08".into(),
            scheduled_start: "2026-06-08T09:00:00".into(),
            scheduled_end: None,
        },
    )
    .await
    .unwrap();

    // The reconciler-owned head must not advance and the rule's EXDATEs must not
    // gain the completed date — completion lives only in completed_set.
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-06-01T09:00:00"),
        "head schedule unchanged"
    );
    let exdates_after: String =
        sqlx::query_scalar("SELECT rrule_exdates FROM page_recurrence_rules WHERE page_id = 'head'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(exdates_before, exdates_after, "rule EXDATEs untouched");
    let clone_link: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_sync WHERE page_id = ?")
            .bind(&clone.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(clone_link, 0, "clone is a free native page, no sync link");
}

#[tokio::test]
async fn uncomplete_synced_occurrence_is_a_noop_for_a_different_date() {
    let pool = test_pool().await;
    synced_recurring_series(&pool).await;
    let clone = complete_synced_occurrence_impl(
        &pool,
        CompleteSyncedOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-08".into(),
            scheduled_start: "2026-06-08T09:00:00".into(),
            scheduled_end: None,
        },
    )
    .await
    .unwrap();

    // Uncompleting an occurrence that was never completed must not delete the
    // existing clone or disturb the map.
    uncomplete_synced_occurrence_impl(
        &pool,
        UncompleteSyncedOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-15".into(),
        },
    )
    .await
    .unwrap();

    assert!(page_exists(&pool, &clone.id).await, "unrelated clone survives");
    let kept: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM completed_set WHERE page_id = 'head' AND occurrence_date = '2026-06-08'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kept, 1, "original completion kept");
}
