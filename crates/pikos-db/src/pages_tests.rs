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

#[tokio::test]
async fn series_advances_when_next_start_provided() {
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

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            next_scheduled_start: Some("2026-05-22".into()),
            next_scheduled_end: None,
            rule_id: None,
            add_exdates: None,
        },
    )
    .await
    .unwrap();

    // Clone snapshots the completed occurrence.
    assert_eq!(result.clone.status, "done");
    assert!(result.clone.completed_at.is_some());
    assert_eq!(result.clone.title, "Morning routine");
    assert_eq!(result.clone.tags, vec!["habits".to_string()]);
    assert_eq!(result.clone.scheduled_start.as_deref(), Some("2026-05-21"));

    // Head stays active but advances to the next occurrence.
    assert_eq!(result.head.status, "not_started");
    assert_eq!(result.head.scheduled_start.as_deref(), Some("2026-05-22"));

    // Exactly one new row was inserted.
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
async fn completion_updates_rule_exdates_in_the_same_transaction() {
    // Regression for the recurring-checkbox "database is locked" (SQLITE_BUSY,
    // code 517) bug: the client used to complete the page AND update the rule's
    // exdates as two concurrent writes, which deadlocked the WAL pool and lost
    // the whole completion. The exdate update is now folded into the completion
    // transaction — one atomic writer. Assert it lands.
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
            // Pre-existing exdate the caller's snapshot may not know about
            // (e.g. a skip persisted between the client's read and this call).
            rrule_exdates: vec!["2026-05-19".into()],
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            next_scheduled_start: Some("2026-05-22".into()),
            next_scheduled_end: None,
            rule_id: Some(rule.id.clone()),
            add_exdates: Some(vec!["2026-05-21".into()]),
        },
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
        exdates_json, r#"["2026-05-19","2026-05-21"]"#,
        "completed date must be MERGED into the current exdates — a blind \
         replacement would erase the pre-existing skip and resurrect it"
    );
    assert_eq!(
        result.rule_exdates,
        Some(vec!["2026-05-19".to_string(), "2026-05-21".to_string()]),
        "result must return the post-merge exdates for client state sync"
    );
    // Clone still created and head still advanced — the folded write didn't
    // disturb the rest of the flow.
    assert_eq!(count_pages(&pool).await, 2);
    assert_eq!(
        fetch_scheduled_start(&pool, "head").await.as_deref(),
        Some("2026-05-22")
    );
}

#[tokio::test]
async fn series_completes_when_next_start_absent() {
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

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            next_scheduled_start: None,
            next_scheduled_end: None,
            rule_id: None,
            add_exdates: None,
        },
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

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            next_scheduled_start: Some("2026-05-28".into()),
            next_scheduled_end: None,
            rule_id: None,
            add_exdates: None,
        },
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
        CompleteRecurringInput {
            page_id: "nope".into(),
            next_scheduled_start: None,
            next_scheduled_end: None,
            rule_id: None,
            add_exdates: None,
        },
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

    soft_delete_page_impl(&pool, "head").await.unwrap();

    let err = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            next_scheduled_start: Some("2026-05-28".into()),
            next_scheduled_end: None,
            rule_id: None,
            add_exdates: None,
        },
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

    // Complete the 05-21 occurrence; head advances to 05-28.
    complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            next_scheduled_start: Some("2026-05-28".into()),
            next_scheduled_end: None,
            rule_id: None,
            add_exdates: None,
        },
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
