//! Layer-2 reconciler corpus: hand-written `SyncDelta` → expected page writes,
//! provider-independent. Pins the shared reconciler's correctness before any
//! real provider exists.

use super::*;
use crate::pool::test_pool;
use crate::sync_delta::{
    EventCore, EventSchedule, EventUpsert, OccurrenceDelta, OccurrenceKind, OccurrenceOverride,
    Recurrence, SyncDelta, UpsertItem,
};

// ─── builders ─────────────────────────────────────────────────────────────────

const ACCOUNT: &str = "a1";

async fn setup() -> sqlx::SqlitePool {
    let pool = test_pool().await;
    crate::insert_test_folder(&pool, "f1", "Cal").await.unwrap();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, 'caldav', 'Fastmail', 'basic', ?, ?)",
    )
    .bind(ACCOUNT)
    .bind(&now)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    pool
}

fn ctx_for(calendar_id: &str) -> ReconcileContext {
    ReconcileContext {
        account_id: ACCOUNT.into(),
        calendar_id: calendar_id.into(),
        provider: "caldav".into(),
        folder_id: "f1".into(),
    }
}

fn ctx() -> ReconcileContext {
    ctx_for("cal")
}

fn core(external_id: &str, uid: &str, etag: &str, title: &str) -> EventCore {
    EventCore {
        external_id: external_id.into(),
        ical_uid: uid.into(),
        etag: Some(etag.into()),
        title: title.into(),
        description: None,
        location: None,
        attendees: vec![],
    }
}

fn timed(start: &str, end: Option<&str>, tz: &str) -> EventSchedule {
    EventSchedule {
        start: start.into(),
        end: end.map(Into::into),
        timezone: Some(tz.into()),
    }
}

fn all_day(start: &str, end: Option<&str>) -> EventSchedule {
    EventSchedule {
        start: start.into(),
        end: end.map(Into::into),
        timezone: None,
    }
}

fn single(core: EventCore, schedule: EventSchedule) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core,
        schedule,
        recurrence: None,
    })
}

fn delta(upserts: Vec<UpsertItem>) -> SyncDelta {
    SyncDelta {
        upserts,
        removals: vec![],
        next_token: None,
    }
}

// ─── query helpers ────────────────────────────────────────────────────────────

async fn page_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn page_title(pool: &sqlx::SqlitePool, page_id: &str) -> String {
    sqlx::query_scalar("SELECT title FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// (page_id, external_id, etag) for the single synced page, when there's one.
async fn only_page_sync(pool: &sqlx::SqlitePool) -> (String, String, Option<String>) {
    sqlx::query_as("SELECT page_id, external_id, etag FROM page_sync")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// (start, end) of the single non-override schedule row for a page.
async fn base_schedule(pool: &sqlx::SqlitePool, page_id: &str) -> (String, Option<String>) {
    sqlx::query_as(
        "SELECT scheduled_start, scheduled_end FROM page_schedules
         WHERE page_id = ? AND rule_id IS NULL",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn rule_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM page_recurrence_rules")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn override_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules WHERE original_date IS NOT NULL")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn sync_state(pool: &sqlx::SqlitePool, page_id: &str) -> String {
    sqlx::query_scalar("SELECT sync_state FROM page_sync WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn rule_exdates(pool: &sqlx::SqlitePool, page_id: &str) -> Vec<String> {
    let json: String =
        sqlx::query_scalar("SELECT rrule_exdates FROM page_recurrence_rules WHERE page_id = ?")
            .bind(page_id)
            .fetch_one(pool)
            .await
            .unwrap();
    serde_json::from_str(&json).unwrap()
}

/// (start, end, timezone) of the override row for a rule + original_date.
async fn override_row(
    pool: &sqlx::SqlitePool,
    page_id: &str,
    original_date: &str,
) -> Option<(String, Option<String>, Option<String>)> {
    sqlx::query_as(
        "SELECT scheduled_start, scheduled_end, timezone FROM page_schedules
         WHERE page_id = ? AND original_date = ?",
    )
    .bind(page_id)
    .bind(original_date)
    .fetch_optional(pool)
    .await
    .unwrap()
}

// ─── identity / dedup ─────────────────────────────────────────────────────────

#[tokio::test]
async fn single_event_creates_one_page() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev1.ics", "uid-1", "v1", "Standup"),
            timed("2026-06-15T09:00:00", Some("2026-06-15T09:30:00"), "America/New_York"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(page_count(&pool).await, 1);
    let (page_id, external_id, etag) = only_page_sync(&pool).await;
    assert_eq!(external_id, "/ev1.ics");
    assert_eq!(etag.as_deref(), Some("v1"));
    assert_eq!(page_title(&pool, &page_id).await, "Standup");
    assert_eq!(
        base_schedule(&pool, &page_id).await,
        ("2026-06-15T09:00:00".into(), Some("2026-06-15T09:30:00".into()))
    );
}

#[tokio::test]
async fn same_external_id_updates_not_duplicates() {
    let pool = setup().await;
    let mk = |etag: &str, title: &str| {
        delta(vec![single(
            core("/ev1.ics", "uid-1", etag, title),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )])
    };
    reconcile(&pool, &ctx(), &mk("v1", "First")).await.unwrap();
    reconcile(&pool, &ctx(), &mk("v2", "Second")).await.unwrap();

    assert_eq!(page_count(&pool).await, 1);
    let (page_id, _, etag) = only_page_sync(&pool).await;
    assert_eq!(etag.as_deref(), Some("v2"));
    assert_eq!(page_title(&pool, &page_id).await, "Second");
}

#[tokio::test]
async fn unchanged_etag_is_a_no_op() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev1.ics", "uid-1", "v1", "Original"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();
    let updated_before: String = sqlx::query_scalar("SELECT updated_at FROM pages")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Same etag but a changed title — must be ignored wholesale.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev1.ics", "uid-1", "v1", "Changed"),
            timed("2026-06-15T10:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(page_title(&pool, &page_id).await, "Original");
    let updated_after: String = sqlx::query_scalar("SELECT updated_at FROM pages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(updated_before, updated_after, "no-op must not churn updated_at");
}

#[tokio::test]
async fn same_uid_across_calendars_is_two_pages() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx_for("cal-A"),
        &delta(vec![single(
            core("/A/ev.ics", "uid-shared", "v1", "On A"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();
    reconcile(
        &pool,
        &ctx_for("cal-B"),
        &delta(vec![single(
            core("/B/ev.ics", "uid-shared", "v1", "On B"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(page_count(&pool).await, 2, "same meeting on two calendars = two pages");
}

#[tokio::test]
async fn changed_href_relinks_by_uid() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/old.ics", "uid-1", "v1", "Meeting"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();
    // Same UID, new href (resource moved) — re-link, don't duplicate.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/new.ics", "uid-1", "v2", "Meeting"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(page_count(&pool).await, 1);
    let (_, external_id, etag) = only_page_sync(&pool).await;
    assert_eq!(external_id, "/new.ics");
    assert_eq!(etag.as_deref(), Some("v2"));
}

// ─── recurrence shapes ────────────────────────────────────────────────────────

fn weekly_series() -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Weekly sync"),
        schedule: timed("2026-06-01T09:00:00", Some("2026-06-01T09:30:00"), "America/New_York"),
        recurrence: Some(Recurrence {
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            exdates: vec!["2026-06-15T09:00:00".into()],
            overrides: vec![OccurrenceOverride {
                original_date: "2026-06-08T09:00:00".into(),
                schedule: timed(
                    "2026-06-08T11:00:00",
                    Some("2026-06-08T11:30:00"),
                    "America/New_York",
                ),
            }],
        }),
    })
}

#[tokio::test]
async fn series_bundle_writes_rule_exdate_and_override() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()])).await.unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(rule_exdates(&pool, &page_id).await, vec!["2026-06-15T09:00:00"]);
    let ov = override_row(&pool, &page_id, "2026-06-08T09:00:00").await;
    assert_eq!(
        ov,
        Some((
            "2026-06-08T11:00:00".into(),
            Some("2026-06-08T11:30:00".into()),
            Some("America/New_York".into())
        ))
    );
}

#[tokio::test]
async fn occurrence_modify_against_stored_rule() {
    let pool = setup().await;
    let master = UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            rrule: "FREQ=WEEKLY".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    });
    reconcile(&pool, &ctx(), &delta(vec![master])).await.unwrap();

    // A lone override arrives later, master absent from this delta.
    let occ = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: "2026-06-08T09:00:00".into(),
        kind: OccurrenceKind::Modify(timed("2026-06-08T14:00:00", None, "UTC")),
    });
    let outcome = reconcile(&pool, &ctx(), &delta(vec![occ])).await.unwrap();

    assert!(outcome.missing_masters.is_empty());
    let (page_id, _, _) = only_page_sync(&pool).await;
    let ov = override_row(&pool, &page_id, "2026-06-08T09:00:00").await;
    assert_eq!(ov.unwrap().0, "2026-06-08T14:00:00");
}

#[tokio::test]
async fn occurrence_cancel_adds_exdate() {
    let pool = setup().await;
    let master = UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            rrule: "FREQ=WEEKLY".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    });
    reconcile(&pool, &ctx(), &delta(vec![master])).await.unwrap();

    let occ = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: "2026-06-15T09:00:00".into(),
        kind: OccurrenceKind::Cancel,
    });
    reconcile(&pool, &ctx(), &delta(vec![occ])).await.unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(rule_exdates(&pool, &page_id).await, vec!["2026-06-15T09:00:00"]);
}

// ─── two-pass / orphan handling ───────────────────────────────────────────────

#[tokio::test]
async fn occurrence_before_master_in_same_batch_resolves() {
    let pool = setup().await;
    let occ = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: "2026-06-08T09:00:00".into(),
        kind: OccurrenceKind::Modify(timed("2026-06-08T14:00:00", None, "UTC")),
    });
    let master = UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            rrule: "FREQ=WEEKLY".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    });

    // Occurrence ordered BEFORE its master — two-pass must still resolve it.
    let outcome = reconcile(&pool, &ctx(), &delta(vec![occ, master])).await.unwrap();

    assert!(outcome.missing_masters.is_empty());
    let (page_id, _, _) = only_page_sync(&pool).await;
    assert!(override_row(&pool, &page_id, "2026-06-08T09:00:00").await.is_some());
}

#[tokio::test]
async fn orphan_occurrence_emits_missing_master_signal() {
    let pool = setup().await;
    let occ = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-orphan".into(),
        series_ref: "recurring-event-id-99".into(),
        original_date: "2026-06-08T09:00:00".into(),
        kind: OccurrenceKind::Modify(timed("2026-06-08T14:00:00", None, "UTC")),
    });
    let outcome = reconcile(&pool, &ctx(), &delta(vec![occ])).await.unwrap();

    // Signal emitted; nothing buffered, dropped, or synthesized.
    assert_eq!(
        outcome.missing_masters,
        vec![MissingMaster {
            ical_uid: "uid-orphan".into(),
            series_ref: "recurring-event-id-99".into(),
        }]
    );
    assert_eq!(page_count(&pool).await, 0, "orphan must not synthesize a page");
}

// ─── all-day exclusive-end decrement ──────────────────────────────────────────

#[tokio::test]
async fn single_all_day_end_decrements_to_inclusive() {
    let pool = setup().await;
    // Provider sends a single Jun 15 all-day event as end = Jun 16 (exclusive).
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/allday.ics", "uid-1", "v1", "Holiday"),
            all_day("2026-06-15", Some("2026-06-16")),
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        base_schedule(&pool, &page_id).await,
        ("2026-06-15".into(), Some("2026-06-15".into())),
        "single all-day collapses to one inclusive day"
    );
}

#[tokio::test]
async fn multi_day_all_day_span_decrements_by_one() {
    let pool = setup().await;
    // Jun 15–17 inclusive arrives as end = Jun 18 (exclusive).
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/trip.ics", "uid-1", "v1", "Trip"),
            all_day("2026-06-15", Some("2026-06-18")),
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        base_schedule(&pool, &page_id).await,
        ("2026-06-15".into(), Some("2026-06-17".into())),
        "multi-day span ends on the last inclusive day, not overshooting"
    );
}

#[tokio::test]
async fn timed_end_is_not_decremented() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/timed.ics", "uid-1", "v1", "Call"),
            timed("2026-06-15T09:00:00", Some("2026-06-15T10:00:00"), "UTC"),
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        base_schedule(&pool, &page_id).await.1,
        Some("2026-06-15T10:00:00".into()),
        "timed ends pass through untouched"
    );
}

// ─── idempotency / wholesale-replace ──────────────────────────────────────────

fn series(etag: &str, exdates: Vec<String>, overrides: Vec<OccurrenceOverride>) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", etag, "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            rrule: "FREQ=WEEKLY".into(),
            exdates,
            overrides,
        }),
    })
}

fn ov(original_date: &str, start: &str) -> OccurrenceOverride {
    OccurrenceOverride {
        original_date: original_date.into(),
        schedule: timed(start, None, "UTC"),
    }
}

#[tokio::test]
async fn reapplying_a_series_does_not_accumulate_rows() {
    let pool = setup().await;
    let exdate = vec!["2026-06-15T09:00:00".to_string()];
    let mk = |etag: &str| {
        delta(vec![series(
            etag,
            exdate.clone(),
            vec![ov("2026-06-08T09:00:00", "2026-06-08T11:00:00")],
        )])
    };
    // New etag each time forces a real rewrite — must converge, not stack rows.
    reconcile(&pool, &ctx(), &mk("v1")).await.unwrap();
    reconcile(&pool, &ctx(), &mk("v2")).await.unwrap();

    assert_eq!(page_count(&pool).await, 1);
    assert_eq!(rule_count(&pool).await, 1);
    assert_eq!(override_count(&pool).await, 1);
    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(rule_exdates(&pool, &page_id).await, vec!["2026-06-15T09:00:00"]);
}

#[tokio::test]
async fn series_update_drops_a_stale_override() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series("v1", vec![], vec![ov("2026-06-08T09:00:00", "2026-06-08T11:00:00")])]),
    )
    .await
    .unwrap();
    // The override moves to a different occurrence on the next sync.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series("v2", vec![], vec![ov("2026-06-15T09:00:00", "2026-06-15T11:00:00")])]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(override_count(&pool).await, 1, "stale override must not linger");
    assert!(override_row(&pool, &page_id, "2026-06-08T09:00:00").await.is_none());
    assert!(override_row(&pool, &page_id, "2026-06-15T09:00:00").await.is_some());
}

#[tokio::test]
async fn relink_reactivates_a_detached_page() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/old.ics", "uid-1", "v1", "Meeting"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    // Simulate a prior detach (its full lifecycle is a later pass).
    sqlx::query("UPDATE page_sync SET sync_state = 'detached' WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    // Same UID returns under a new href — re-link in place and reactivate.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/new.ics", "uid-1", "v2", "Meeting"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(page_count(&pool).await, 1);
    assert_eq!(sync_state(&pool, &page_id).await, "active");
    let (_, external_id, _) = only_page_sync(&pool).await;
    assert_eq!(external_id, "/new.ics");
}

#[tokio::test]
async fn occurrence_modify_replaces_a_prior_override() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![series("v1", vec![], vec![])])).await.unwrap();

    let modify = |start: &str| {
        delta(vec![UpsertItem::Occurrence(OccurrenceDelta {
            ical_uid: "uid-series".into(),
            series_ref: "uid-series".into(),
            original_date: "2026-06-08T09:00:00".into(),
            kind: OccurrenceKind::Modify(timed(start, None, "UTC")),
        })])
    };
    reconcile(&pool, &ctx(), &modify("2026-06-08T12:00:00")).await.unwrap();
    reconcile(&pool, &ctx(), &modify("2026-06-08T15:00:00")).await.unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(override_count(&pool).await, 1, "one override per original_date");
    assert_eq!(
        override_row(&pool, &page_id, "2026-06-08T09:00:00").await.unwrap().0,
        "2026-06-08T15:00:00"
    );
}
