//! Layer-2 reconciler corpus: hand-written `SyncDelta` → expected page writes,
//! provider-independent. Pins the shared reconciler's correctness before any
//! real provider exists.

use super::*;
use crate::pool::test_pool;
use crate::sync_delta::{
    EventCore, EventSchedule, EventUpsert, OccurrenceDelta, OccurrenceFidelity, OccurrenceKind,
    OccurrenceOverride, Recurrence, Removal, SyncDelta, UpsertItem,
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

/// A single event carrying the mirror metadata + description the reconciler applies.
#[allow(clippy::too_many_arguments)]
fn single_full(
    external_id: &str,
    uid: &str,
    etag: &str,
    title: &str,
    description: Option<&str>,
    location: Option<&str>,
    attendees: &[&str],
) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: EventCore {
            external_id: external_id.into(),
            ical_uid: uid.into(),
            etag: Some(etag.into()),
            title: title.into(),
            description: description.map(Into::into),
            location: location.map(Into::into),
            attendees: attendees.iter().map(|s| s.to_string()).collect(),
        },
        schedule: timed("2026-06-15T09:00:00", None, "UTC"),
        recurrence: None,
    })
}

fn delta(upserts: Vec<UpsertItem>) -> SyncDelta {
    SyncDelta {
        upserts,
        ..Default::default()
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

async fn page_content_text(pool: &sqlx::SqlitePool, page_id: &str) -> String {
    sqlx::query_scalar("SELECT content_text FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn page_content(pool: &sqlx::SqlitePool, page_id: &str) -> String {
    sqlx::query_scalar("SELECT content FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// (seeded_description_hash, seeded_description_hash_version, pending_description).
async fn seed_meta(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> (Option<String>, Option<i64>, Option<String>) {
    sqlx::query_as(
        "SELECT seeded_description_hash, seeded_description_hash_version, pending_description
         FROM page_sync WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// (mirror_location, mirror_attendees).
async fn mirror_meta(pool: &sqlx::SqlitePool, page_id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT mirror_location, mirror_attendees FROM page_sync WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Simulate the editor command path: the user rewrites the body and any edit
/// flips `user_modified`. (Sync never sets that flag — only this path does.)
async fn simulate_user_body_edit(pool: &sqlx::SqlitePool, page_id: &str, body: &str) {
    sqlx::query("UPDATE pages SET content_text = ? WHERE id = ?")
        .bind(body)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE page_sync SET user_modified = 1 WHERE page_id = ?")
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
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

/// (rrule, scheduled_start, timezone) of the single stored recurrence rule.
async fn rule_row(pool: &sqlx::SqlitePool, page_id: &str) -> (String, String, String) {
    sqlx::query_as(
        "SELECT rrule, scheduled_start, timezone FROM page_recurrence_rules WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await
    .unwrap()
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
            timed(
                "2026-06-15T09:00:00",
                Some("2026-06-15T09:30:00"),
                "America/New_York",
            ),
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
        (
            "2026-06-15T09:00:00".into(),
            Some("2026-06-15T09:30:00".into())
        )
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
    assert_eq!(
        updated_before, updated_after,
        "no-op must not churn updated_at"
    );
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

    assert_eq!(
        page_count(&pool).await,
        2,
        "same meeting on two calendars = two pages"
    );
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
        schedule: timed(
            "2026-06-01T09:00:00",
            Some("2026-06-01T09:30:00"),
            "America/New_York",
        ),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
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
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()]))
        .await
        .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00"]
    );
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

async fn page_status(pool: &sqlx::SqlitePool, page_id: &str) -> (String, Option<String>) {
    sqlx::query_as("SELECT status, completed_at FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn force_terminal_done(pool: &sqlx::SqlitePool, page_id: &str) {
    sqlx::query(
        "UPDATE pages SET status = 'done', completed_at = '2026-06-30T00:00:00' WHERE id = ?",
    )
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
}

fn series_v(etag: &str, rrule: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", etag, "Series"),
        schedule: timed(
            "2026-06-01T09:00:00",
            Some("2026-06-01T09:30:00"),
            "America/New_York",
        ),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: rrule.into(),
            exdates: vec![],
            overrides: vec![],
        }),
    })
}

#[tokio::test]
async fn exhausted_done_series_rewritten_to_unsupported_rule_unmarks_done() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_v("v1", "FREQ=WEEKLY;BYDAY=MO")]),
    )
    .await
    .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    // Simulate the finite series having exhausted to a terminal-done head.
    force_terminal_done(&pool, &page_id).await;

    // The provider rewrites the rule into a shape the engine rejects (BYSETPOS), so
    // recompute_recurring_schedule skips it. Without the up-front terminal clear the
    // page would stay `done` → invisible on the calendar and reminder-excluded.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_v("v2", "FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO")]),
    )
    .await
    .unwrap();

    let (status, completed_at) = page_status(&pool, &page_id).await;
    assert_eq!(status, "not_started");
    assert!(completed_at.is_none());
    // Storage still takes the rewrite — the rejection is only in derivation.
    assert_eq!(
        rule_row(&pool, &page_id).await.0,
        "FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO"
    );
}

#[tokio::test]
async fn occurrence_modify_against_stored_rule() {
    let pool = setup().await;
    let master = UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: "FREQ=WEEKLY".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    });
    reconcile(&pool, &ctx(), &delta(vec![master]))
        .await
        .unwrap();

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

// ─── single ⇄ recurring transitions ─────────────────────────────────────────────

async fn page_scheduled_start(pool: &sqlx::SqlitePool, page_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT scheduled_start FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Standalone (non-rule) schedule rows for a page — the shape a single event
/// leaves behind, which the transition to recurring must clear.
async fn standalone_schedule_count(pool: &sqlx::SqlitePool, page_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules WHERE page_id = ? AND rule_id IS NULL")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn single_1x1(etag: &str) -> UpsertItem {
    single(
        core("/e.ics", "uid-1", etag, "1:1"),
        timed(
            "2026-06-01T09:00:00",
            Some("2026-06-01T09:30:00"),
            "America/New_York",
        ),
    )
}

fn recurring_1x1(etag: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/e.ics", "uid-1", etag, "1:1"),
        schedule: timed(
            "2026-06-01T09:00:00",
            Some("2026-06-01T09:30:00"),
            "America/New_York",
        ),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    })
}

#[tokio::test]
async fn single_synced_page_gaining_an_rrule_transitions_cleanly() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![single_1x1("v1")]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(rule_count(&pool).await, 0);
    assert_eq!(
        standalone_schedule_count(&pool, &page_id).await,
        1,
        "single leaves a standalone row"
    );

    reconcile(&pool, &ctx(), &delta(vec![recurring_1x1("v2")]))
        .await
        .unwrap();

    assert_eq!(page_count(&pool).await, 1, "no duplicate page");
    assert_eq!(rule_count(&pool).await, 1, "exactly one rule");
    assert_eq!(
        standalone_schedule_count(&pool, &page_id).await,
        0,
        "the old standalone row is gone, not left beside the rule"
    );
    assert_eq!(
        page_scheduled_start(&pool, &page_id).await.as_deref(),
        Some("2026-06-01T09:00:00"),
        "head recomputes to the oldest open occurrence"
    );
    assert_eq!(page_status(&pool, &page_id).await.0, "not_started");
}

#[tokio::test]
async fn completed_single_gaining_an_rrule_unmarks_done() {
    // A completed single that turns recurring upstream must not stay stuck `done`
    // (invisible + reminder-excluded). The recompute un-marks it once the new series
    // yields an open occurrence.
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![single_1x1("v1")]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    force_terminal_done(&pool, &page_id).await;

    reconcile(&pool, &ctx(), &delta(vec![recurring_1x1("v2")]))
        .await
        .unwrap();

    let (status, completed_at) = page_status(&pool, &page_id).await;
    assert_eq!(
        status, "not_started",
        "the completed single is un-done once it yields occurrences"
    );
    assert!(completed_at.is_none());
}

#[tokio::test]
async fn occurrence_cancel_adds_exdate() {
    let pool = setup().await;
    let master = UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: "FREQ=WEEKLY".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    });
    reconcile(&pool, &ctx(), &delta(vec![master]))
        .await
        .unwrap();

    let occ = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: "2026-06-15T09:00:00".into(),
        kind: OccurrenceKind::Cancel,
    });
    reconcile(&pool, &ctx(), &delta(vec![occ])).await.unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00"]
    );
}

// ─── timezone normalization ──────────────────────────────────────────────────

/// Build a timed series with a given RRULE and source zone, no exdates/overrides.
fn series_with_rrule(rrule: &str, tz: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Standup"),
        schedule: timed("2026-06-01T09:00:00", Some("2026-06-01T09:30:00"), tz),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: rrule.into(),
            exdates: vec![],
            overrides: vec![],
        }),
    })
}

#[tokio::test]
async fn until_z_rewritten_to_source_wall_clock_in_dst() {
    let pool = setup().await;
    // 2026-03-15 is EDT (DST began Mar 8), so UTC-4: 10:00Z → 06:00 wall-clock.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_with_rrule(
            "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260315T100000Z",
            "America/New_York",
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    let (rrule, _, _) = rule_row(&pool, &page_id).await;
    assert_eq!(rrule, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260315T060000");
}

#[tokio::test]
async fn until_z_rewrite_is_dst_aware() {
    let pool = setup().await;
    // 2026-01-15 is EST (no DST), so UTC-5: 10:00Z → 05:00 — proving the rewrite
    // reads the IANA database per-instant, not a fixed offset.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_with_rrule(
            "FREQ=WEEKLY;UNTIL=20260115T100000Z",
            "America/New_York",
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    let (rrule, _, _) = rule_row(&pool, &page_id).await;
    assert_eq!(rrule, "FREQ=WEEKLY;UNTIL=20260115T050000");
}

#[tokio::test]
async fn floating_and_date_only_until_pass_through() {
    let pool = setup().await;
    // A floating UNTIL (no Z) is already wall-clock — must not be touched.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_with_rrule(
            "FREQ=DAILY;UNTIL=20260315T100000",
            "America/New_York",
        )]),
    )
    .await
    .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        rule_row(&pool, &page_id).await.0,
        "FREQ=DAILY;UNTIL=20260315T100000"
    );

    // A date-only UNTIL on an all-day series (no zone) passes through; the rule
    // still gets the sentinel zone, never a panic.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![UpsertItem::Event(EventUpsert {
            core: core("/allday.ics", "uid-allday", "v1", "Allday"),
            schedule: all_day("2026-06-01", Some("2026-06-02")),
            recurrence: Some(Recurrence {
                fidelity: OccurrenceFidelity::Complete,
                rrule: "FREQ=WEEKLY;UNTIL=20260315".into(),
                exdates: vec![],
                overrides: vec![],
            }),
        })]),
    )
    .await
    .unwrap();
    let allday_page = sqlx::query_scalar::<_, String>(
        "SELECT page_id FROM page_sync WHERE ical_uid = 'uid-allday'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let (rrule, _, tz) = rule_row(&pool, &allday_page).await;
    assert_eq!(rrule, "FREQ=WEEKLY;UNTIL=20260315");
    assert_eq!(tz, "UTC", "all-day series gets the sentinel zone");
}

/// Every recurrence instant lands as bare source-zone wall-clock — no trailing
/// `Z`, no offset — so the pure-wall-clock expansion matches each field by string.
/// T2 pins `TZ=UTC`, so this asserts per field rather than leaning on the runner.
#[tokio::test]
async fn every_recurrence_instant_is_wall_clock() {
    let pool = setup().await;
    let series = UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Weekly sync"),
        schedule: timed(
            "2026-06-01T09:00:00",
            Some("2026-06-01T09:30:00"),
            "America/New_York",
        ),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260831T130000Z".into(),
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
    });
    reconcile(&pool, &ctx(), &delta(vec![series]))
        .await
        .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    let (rrule, scheduled_start, tz) = rule_row(&pool, &page_id).await;

    // dtstart: bare wall-clock.
    assert_eq!(scheduled_start, "2026-06-01T09:00:00");
    assert_eq!(
        tz, "America/New_York",
        "resolved IANA id kept alongside wall-clock"
    );
    // UNTIL: 13:00Z on 2026-08-31 (EDT, UTC-4) → 09:00 wall-clock, no Z.
    assert_eq!(rrule, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260831T090000");
    // EXDATE: bare wall-clock, no zone suffix.
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00"]
    );
    // RECURRENCE-ID → original_date, and the override start: both bare wall-clock.
    let ov = override_row(&pool, &page_id, "2026-06-08T09:00:00")
        .await
        .unwrap();
    assert_eq!(ov.0, "2026-06-08T11:00:00");
}

/// The EXDATE-vs-removal split, the destructive ambiguity: a cancel-*occurrence*
/// adds an EXDATE and leaves the series page intact; a whole-event *removal* takes
/// the whole series page through the lifecycle rule. Get these backwards and one
/// skipped instance would delete the entire series.
#[tokio::test]
async fn removal_takes_the_whole_series_not_one_occurrence() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;

    // A cancel-occurrence only EXDATEs — the series page survives.
    let cancel = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: "2026-06-22T09:00:00".into(),
        kind: OccurrenceKind::Cancel,
    });
    reconcile(&pool, &ctx(), &delta(vec![cancel]))
        .await
        .unwrap();
    assert_eq!(
        page_count(&pool).await,
        1,
        "cancel-occurrence leaves the series intact"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "active");

    // A whole-event removal of this bare series deletes the page outright.
    reconcile(
        &pool,
        &ctx(),
        &SyncDelta {
            removals: vec![Removal {
                external_id: "/series.ics".into(),
            }],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        page_count(&pool).await,
        0,
        "removal takes the whole series page"
    );
    assert_eq!(rule_count(&pool).await, 0);
}

// ─── three field layers: mirror / seeded / user ───────────────────────────────

#[tokio::test]
async fn mirror_metadata_is_written_read_only() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            "v1",
            "Lunch",
            None,
            Some("Cafe Rio"),
            &["a@x.com", "b@y.com"],
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    let (loc, att) = mirror_meta(&pool, &page_id).await;
    assert_eq!(loc.as_deref(), Some("Cafe Rio"));
    assert_eq!(att.as_deref(), Some(r#"["a@x.com","b@y.com"]"#));
}

#[tokio::test]
async fn empty_attendees_store_null_not_empty_array() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            "v1",
            "Solo",
            None,
            None,
            &[],
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    let (loc, att) = mirror_meta(&pool, &page_id).await;
    assert_eq!(loc, None);
    assert_eq!(att, None, "no attendees reads as NULL, not []");
}

#[tokio::test]
async fn first_sync_seeds_description_into_body() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            "v1",
            "Q3 Planning",
            Some("Bring the roadmap drafts."),
            None,
            &[],
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        page_content_text(&pool, &page_id).await,
        "Bring the roadmap drafts."
    );
    // The rendered body, not just the search projection, must get the seed —
    // setting content_text alone would render an empty editor.
    assert_ne!(page_content(&pool, &page_id).await, "{}");
    let (hash, version, pending) = seed_meta(&pool, &page_id).await;
    assert!(hash.is_some(), "seed hash recorded");
    assert_eq!(version, Some(1));
    assert_eq!(pending, None);
}

#[tokio::test]
async fn no_description_leaves_body_empty_and_unseeded() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            "v1",
            "No notes",
            None,
            None,
            &[],
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(page_content_text(&pool, &page_id).await, "");
    let (hash, version, pending) = seed_meta(&pool, &page_id).await;
    assert_eq!((hash, version, pending), (None, None, None));
}

#[tokio::test]
async fn description_change_silently_refreshes_an_untouched_body() {
    let pool = setup().await;
    let mk = |etag: &str, desc: &str| {
        delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            etag,
            "Event",
            Some(desc),
            None,
            &[],
        )])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Original notes"))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    let (first_hash, _, _) = seed_meta(&pool, &page_id).await;

    reconcile(&pool, &ctx(), &mk("v2", "Updated notes"))
        .await
        .unwrap();

    assert_eq!(page_content_text(&pool, &page_id).await, "Updated notes");
    let (second_hash, version, pending) = seed_meta(&pool, &page_id).await;
    assert_ne!(first_hash, second_hash, "hash tracks the refreshed body");
    assert_eq!(version, Some(1));
    assert_eq!(
        pending, None,
        "untouched body refreshes silently — nothing parked"
    );
}

#[tokio::test]
async fn description_change_is_withheld_when_user_edited_the_body() {
    let pool = setup().await;
    let mk = |etag: &str, desc: &str| {
        delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            etag,
            "Event",
            Some(desc),
            None,
            &[],
        )])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed text"))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    simulate_user_body_edit(&pool, &page_id, "my own notes").await;

    reconcile(&pool, &ctx(), &mk("v2", "New upstream text"))
        .await
        .unwrap();

    assert_eq!(
        page_content_text(&pool, &page_id).await,
        "my own notes",
        "the user's body must never be clobbered"
    );
    let (_, _, pending) = seed_meta(&pool, &page_id).await;
    assert_eq!(
        pending.as_deref(),
        Some("New upstream text"),
        "the withheld change is parked for a passive notice"
    );
}

#[tokio::test]
async fn projection_version_bump_reseeds_a_pristine_body() {
    let pool = setup().await;
    let mk = |etag: &str, desc: &str| {
        delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            etag,
            "Event",
            Some(desc),
            None,
            &[],
        )])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed text"))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    // Stored hash is from an older projection version — no longer comparable.
    sqlx::query("UPDATE page_sync SET seeded_description_hash_version = 0 WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(&pool, &ctx(), &mk("v2", "Refreshed text"))
        .await
        .unwrap();

    assert_eq!(
        page_content_text(&pool, &page_id).await,
        "Refreshed text",
        "version bump re-seeds the pristine body instead of mis-classifying it"
    );
    let (_, version, pending) = seed_meta(&pool, &page_id).await;
    assert_eq!(version, Some(1), "hash re-stamped at the current version");
    assert_eq!(pending, None);
}

#[tokio::test]
async fn projection_version_bump_still_holds_an_edited_body() {
    let pool = setup().await;
    let mk = |etag: &str, desc: &str| {
        delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            etag,
            "Event",
            Some(desc),
            None,
            &[],
        )])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed text"))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    simulate_user_body_edit(&pool, &page_id, "user notes").await;
    sqlx::query("UPDATE page_sync SET seeded_description_hash_version = 0 WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(&pool, &ctx(), &mk("v2", "New text"))
        .await
        .unwrap();

    // With the hash incomparable, the ownership flag is the fallback — edited stays.
    assert_eq!(page_content_text(&pool, &page_id).await, "user notes");
    let (_, _, pending) = seed_meta(&pool, &page_id).await;
    assert_eq!(pending.as_deref(), Some("New text"));
}

#[tokio::test]
async fn parked_notice_clears_when_upstream_matches_the_body_again() {
    let pool = setup().await;
    let mk = |etag: &str, desc: &str| {
        delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            etag,
            "Event",
            Some(desc),
            None,
            &[],
        )])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed")).await.unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    simulate_user_body_edit(&pool, &page_id, "B").await;
    reconcile(&pool, &ctx(), &mk("v2", "C")).await.unwrap();
    assert_eq!(
        seed_meta(&pool, &page_id).await.2.as_deref(),
        Some("C"),
        "parked first"
    );

    // Upstream later edits down to exactly what the user's body already says.
    reconcile(&pool, &ctx(), &mk("v3", "B")).await.unwrap();

    assert_eq!(page_content_text(&pool, &page_id).await, "B");
    assert_eq!(
        seed_meta(&pool, &page_id).await.2,
        None,
        "no divergence → notice cleared"
    );
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
            fidelity: OccurrenceFidelity::Complete,
            rrule: "FREQ=WEEKLY".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    });

    // Occurrence ordered BEFORE its master — two-pass must still resolve it.
    let outcome = reconcile(&pool, &ctx(), &delta(vec![occ, master]))
        .await
        .unwrap();

    assert!(outcome.missing_masters.is_empty());
    let (page_id, _, _) = only_page_sync(&pool).await;
    assert!(override_row(&pool, &page_id, "2026-06-08T09:00:00")
        .await
        .is_some());
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
    assert_eq!(
        page_count(&pool).await,
        0,
        "orphan must not synthesize a page"
    );
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
            fidelity: OccurrenceFidelity::Complete,
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
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00"]
    );
}

#[tokio::test]
async fn series_update_drops_a_stale_override() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series(
            "v1",
            vec![],
            vec![ov("2026-06-08T09:00:00", "2026-06-08T11:00:00")],
        )]),
    )
    .await
    .unwrap();
    // The override moves to a different occurrence on the next sync.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series(
            "v2",
            vec![],
            vec![ov("2026-06-15T09:00:00", "2026-06-15T11:00:00")],
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        override_count(&pool).await,
        1,
        "stale override must not linger"
    );
    assert!(override_row(&pool, &page_id, "2026-06-08T09:00:00")
        .await
        .is_none());
    assert!(override_row(&pool, &page_id, "2026-06-15T09:00:00")
        .await
        .is_some());
}

// ─── bundle rewrite after an occurrence delta (Google's master-only view) ──────

/// The same series as [`series`], delivered as a master-only bundle
/// (see [`OccurrenceFidelity::MasterOnly`]).
fn master_only(etag: &str, exdates: Vec<String>, overrides: Vec<OccurrenceOverride>) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", etag, "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::MasterOnly,
            rrule: "FREQ=WEEKLY".into(),
            exdates,
            overrides,
        }),
    })
}

/// A master-only bundle at an explicit pattern, for the carry-forward guard.
fn master_only_at(etag: &str, rrule: &str, start: &str, tz: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", etag, "Weekly"),
        schedule: timed(start, None, tz),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::MasterOnly,
            rrule: rrule.into(),
            exdates: vec![],
            overrides: vec![],
        }),
    })
}

fn cancel_occurrence(original_date: &str) -> UpsertItem {
    UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: original_date.into(),
        kind: OccurrenceKind::Cancel,
    })
}

fn modify_occurrence(original_date: &str, start: &str) -> UpsertItem {
    UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: original_date.into(),
        kind: OccurrenceKind::Modify(timed(start, None, "UTC")),
    })
}

#[tokio::test]
async fn master_only_rewrite_preserves_applied_occurrence_deltas() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![master_only("v1", vec![], vec![])]),
    )
    .await
    .unwrap();
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![
            cancel_occurrence("2026-06-15T09:00:00"),
            modify_occurrence("2026-06-08T09:00:00", "2026-06-08T11:00:00"),
        ]),
    )
    .await
    .unwrap();

    // A later master-only change (the title edit case) carries neither the exdate
    // nor the override. A wholesale rewrite here resurrects every cancellation.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![master_only("v2", vec![], vec![])]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00"],
        "cancelled occurrence must not resurrect"
    );
    assert_eq!(
        override_row(&pool, &page_id, "2026-06-08T09:00:00").await,
        Some(("2026-06-08T11:00:00".into(), None, Some("UTC".into()))),
        "moved occurrence must survive the rewrite"
    );
}

#[tokio::test]
async fn master_only_rewrite_takes_incoming_over_carried() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![master_only("v1", vec![], vec![])]),
    )
    .await
    .unwrap();
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![
            cancel_occurrence("2026-06-15T09:00:00"),
            modify_occurrence("2026-06-08T09:00:00", "2026-06-08T11:00:00"),
        ]),
    )
    .await
    .unwrap();

    // The bundle carries its own view of the same two occurrences — one already
    // known exdate plus a new one, and the same override at a different time.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![master_only(
            "v2",
            vec!["2026-06-15T09:00:00".into(), "2026-06-22T09:00:00".into()],
            vec![ov("2026-06-08T09:00:00", "2026-06-08T14:00:00")],
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00", "2026-06-22T09:00:00"],
        "union, deduped"
    );
    assert_eq!(override_count(&pool).await, 1, "one row per original_date");
    assert_eq!(
        override_row(&pool, &page_id, "2026-06-08T09:00:00").await,
        Some(("2026-06-08T14:00:00".into(), None, Some("UTC".into())))
    );
}

/// Seeds the series then applies one cancellation and one moved occurrence,
/// leaving exactly the state a later master-only rewrite has to decide about.
async fn seed_series_with_occurrence_deltas(pool: &sqlx::SqlitePool, seed: UpsertItem) {
    reconcile(pool, &ctx(), &delta(vec![seed])).await.unwrap();
    reconcile(
        pool,
        &ctx(),
        &delta(vec![
            cancel_occurrence("2026-06-15T09:00:00"),
            modify_occurrence("2026-06-08T09:00:00", "2026-06-08T11:00:00"),
        ]),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn master_only_rewrite_drops_carried_when_the_rrule_changes() {
    let pool = setup().await;
    seed_series_with_occurrence_deltas(&pool, master_only("v1", vec![], vec![])).await;

    reconcile(
        &pool,
        &ctx(),
        &delta(vec![master_only_at(
            "v2",
            "FREQ=WEEKLY;BYDAY=TU",
            "2026-06-01T09:00:00",
            "UTC",
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert!(rule_exdates(&pool, &page_id).await.is_empty());
    assert_eq!(override_count(&pool).await, 0);
}

#[tokio::test]
async fn master_only_rewrite_drops_carried_when_the_base_start_moves() {
    let pool = setup().await;
    seed_series_with_occurrence_deltas(&pool, master_only("v1", vec![], vec![])).await;

    reconcile(
        &pool,
        &ctx(),
        &delta(vec![master_only_at(
            "v2",
            "FREQ=WEEKLY",
            "2026-06-01T14:00:00",
            "UTC",
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert!(rule_exdates(&pool, &page_id).await.is_empty());
    assert_eq!(override_count(&pool).await, 0);
}

#[tokio::test]
async fn master_only_rewrite_carries_across_an_until_rewrite() {
    let pool = setup().await;
    let rule = "FREQ=WEEKLY;UNTIL=20261231T235959Z";
    let unchanged =
        |etag: &str| master_only_at(etag, rule, "2026-06-01T09:00:00", "America/New_York");
    seed_series_with_occurrence_deltas(&pool, unchanged("v1")).await;

    reconcile(&pool, &ctx(), &delta(vec![unchanged("v2")]))
        .await
        .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00"]
    );
    assert_eq!(override_count(&pool).await, 1);
}

#[tokio::test]
async fn complete_rewrite_still_clears_a_dropped_exdate() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series(
            "v1",
            vec!["2026-06-15T09:00:00".into()],
            vec![],
        )]),
    )
    .await
    .unwrap();
    // CalDAV's bundle is the whole truth, so an EXDATE it no longer carries was
    // genuinely un-cancelled upstream — the merge must not leak into this branch.
    reconcile(&pool, &ctx(), &delta(vec![series("v2", vec![], vec![])]))
        .await
        .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert!(rule_exdates(&pool, &page_id).await.is_empty());
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
    reconcile(&pool, &ctx(), &delta(vec![series("v1", vec![], vec![])]))
        .await
        .unwrap();

    let modify = |start: &str| {
        delta(vec![UpsertItem::Occurrence(OccurrenceDelta {
            ical_uid: "uid-series".into(),
            series_ref: "uid-series".into(),
            original_date: "2026-06-08T09:00:00".into(),
            kind: OccurrenceKind::Modify(timed(start, None, "UTC")),
        })])
    };
    reconcile(&pool, &ctx(), &modify("2026-06-08T12:00:00"))
        .await
        .unwrap();
    reconcile(&pool, &ctx(), &modify("2026-06-08T15:00:00"))
        .await
        .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        override_count(&pool).await,
        1,
        "one override per original_date"
    );
    assert_eq!(
        override_row(&pool, &page_id, "2026-06-08T09:00:00")
            .await
            .unwrap()
            .0,
        "2026-06-08T15:00:00"
    );
}

// ─── lifecycle: removals, ownership, teardown ─────────────────────────────────

fn removal(external_id: &str) -> SyncDelta {
    SyncDelta {
        removals: vec![Removal {
            external_id: external_id.into(),
        }],
        ..Default::default()
    }
}

/// Sync one bare single event and return its page_id — the starting point for the
/// ownership tests, which then layer on whatever makes it owned.
async fn synced_page(pool: &sqlx::SqlitePool, href: &str, uid: &str) -> String {
    reconcile(
        pool,
        &ctx(),
        &delta(vec![single(
            core(href, uid, "v1", "Event"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();
    sqlx::query_scalar("SELECT page_id FROM page_sync WHERE ical_uid = ?")
        .bind(uid)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn mark_completed(pool: &sqlx::SqlitePool, page_id: &str) {
    sqlx::query("UPDATE pages SET completed_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn add_user_tag(pool: &sqlx::SqlitePool, page_id: &str) {
    sqlx::query(r#"UPDATE pages SET tags = '["work"]' WHERE id = ?"#)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn add_user_reminder(pool: &sqlx::SqlitePool, page_id: &str) {
    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at) VALUES (?, ?, 10, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(page_id)
    .bind(now_iso())
    .execute(pool)
    .await
    .unwrap();
}

/// Simulate the local-delete command path: soft-delete the page and tombstone its
/// sync link (so the reconciler won't resurrect it).
async fn tombstone(pool: &sqlx::SqlitePool, page_id: &str) {
    sqlx::query("UPDATE pages SET deleted_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE page_sync SET sync_state = 'tombstoned' WHERE page_id = ?")
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn flag_external(pool: &sqlx::SqlitePool, folder_id: &str) {
    sqlx::query("UPDATE folders SET is_external_calendar = 1 WHERE id = ?")
        .bind(folder_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn page_exists(pool: &sqlx::SqlitePool, page_id: &str) -> bool {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap();
    n == 1
}

async fn is_trashed(pool: &sqlx::SqlitePool, page_id: &str) -> bool {
    sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn has_page_sync(pool: &sqlx::SqlitePool, page_id: &str) -> bool {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_sync WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap();
    n == 1
}

async fn page_sync_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM page_sync")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn folder_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM folders")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn folder_is_external(pool: &sqlx::SqlitePool, folder_id: &str) -> bool {
    let v: i64 = sqlx::query_scalar("SELECT is_external_calendar FROM folders WHERE id = ?")
        .bind(folder_id)
        .fetch_one(pool)
        .await
        .unwrap();
    v == 1
}

async fn ical_uid_of(pool: &sqlx::SqlitePool, page_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT ical_uid FROM page_sync WHERE page_id = ?")
        .bind(page_id)
        .fetch_optional(pool)
        .await
        .unwrap()
}

async fn deleted_at_of(pool: &sqlx::SqlitePool, page_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn removal_of_bare_mirror_hard_deletes() {
    let pool = setup().await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;

    reconcile(&pool, &ctx(), &removal("/ev.ics")).await.unwrap();

    assert!(
        !page_exists(&pool, &page_id).await,
        "a bare mirror just disappears"
    );
    assert_eq!(
        page_sync_count(&pool).await,
        0,
        "FK cascade removes the link"
    );
}

#[tokio::test]
async fn removal_of_completed_page_detaches() {
    let pool = setup().await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    mark_completed(&pool, &page_id).await;

    reconcile(&pool, &ctx(), &removal("/ev.ics")).await.unwrap();

    assert!(
        page_exists(&pool, &page_id).await,
        "completed = historical record, kept"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "detached");
}

#[tokio::test]
async fn removal_of_completed_occurrence_series_detaches() {
    // A synced RECURRING series with a user-completed occurrence is owned even with
    // no other signal — the completed-set entry alone must force a detach, not the
    // bare-mirror hard delete that would erase the completion history.
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    sqlx::query(
        "INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, '2026-06-22', 'clone-xyz')",
    )
    .bind(&page_id)
    .execute(&pool)
    .await
    .unwrap();

    reconcile(&pool, &ctx(), &removal("/series.ics"))
        .await
        .unwrap();

    assert!(
        page_exists(&pool, &page_id).await,
        "completed occurrence = owned, kept"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "detached");
}

#[tokio::test]
async fn removal_of_skipped_occurrence_series_detaches() {
    // Skip-set entry alone makes the series owned → detach, not the hard delete that
    // would cascade the skip_set away and resurrect dismissed occurrences on resync.
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    sqlx::query("INSERT INTO skip_set (page_id, occurrence_date) VALUES (?, '2026-06-22')")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(&pool, &ctx(), &removal("/series.ics"))
        .await
        .unwrap();

    assert!(
        page_exists(&pool, &page_id).await,
        "skipped occurrence = owned, kept"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "detached");
}

#[tokio::test]
async fn removal_of_user_modified_page_detaches() {
    let pool = setup().await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    simulate_user_body_edit(&pool, &page_id, "my notes").await;

    reconcile(&pool, &ctx(), &removal("/ev.ics")).await.unwrap();

    assert_eq!(sync_state(&pool, &page_id).await, "detached");
}

#[tokio::test]
async fn removal_with_user_tag_or_reminder_detaches() {
    let pool = setup().await;
    let tagged = synced_page(&pool, "/tag.ics", "uid-tag").await;
    add_user_tag(&pool, &tagged).await;
    let reminded = synced_page(&pool, "/rem.ics", "uid-rem").await;
    add_user_reminder(&pool, &reminded).await;

    reconcile(&pool, &ctx(), &removal("/tag.ics"))
        .await
        .unwrap();
    reconcile(&pool, &ctx(), &removal("/rem.ics"))
        .await
        .unwrap();

    assert_eq!(
        sync_state(&pool, &tagged).await,
        "detached",
        "user tag = owned"
    );
    assert_eq!(
        sync_state(&pool, &reminded).await,
        "detached",
        "user reminder = owned"
    );
}

#[tokio::test]
async fn last_opened_alone_is_not_owned() {
    let pool = setup().await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    sqlx::query("UPDATE pages SET last_opened_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(&pool, &ctx(), &removal("/ev.ics")).await.unwrap();

    assert!(
        !page_exists(&pool, &page_id).await,
        "reading is not authoring — hard delete"
    );
}

/// The full-enumerate sweep's recurring carve-out: a finite series whose `UNTIL`
/// predates the window is legitimately absent (spared); an unbounded series always
/// reaches into the window, so its absence is a genuine deletion (swept).
#[tokio::test]
async fn sweep_spares_expired_until_series_but_removes_unbounded() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_recurring(
            "/finite.ics",
            "uid-finite",
            "FREQ=WEEKLY;UNTIL=20260201T100000Z",
        )]),
    )
    .await
    .unwrap();
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_recurring(
            "/infinite.ics",
            "uid-infinite",
            "FREQ=WEEKLY",
        )]),
    )
    .await
    .unwrap();

    // A re-enumerate returning neither: the window is well after the finite series
    // ended, but the unbounded one should still have been present.
    sweep_absent(
        &pool,
        &ctx(),
        &std::collections::HashSet::new(),
        "2026-06-24",
    )
    .await
    .unwrap();

    assert!(
        page_exists_by_uid(&pool, "uid-finite").await,
        "pre-window finite series spared"
    );
    assert!(
        !page_exists_by_uid(&pool, "uid-infinite").await,
        "live unbounded series swept"
    );
}

/// Window-edge timezone skew: storage is source-zone wall-clock but the server's
/// time-range bound is UTC, so an ahead-of-UTC event whose UTC instant falls just
/// before the window is server-excluded while its local date lands on the window
/// day. The one-day sweep slack spares it — sweeping would drop a live event.
#[tokio::test]
async fn sweep_spares_an_ahead_of_utc_window_edge_event() {
    let pool = setup().await;
    // Wall-clock 2026-06-24T05:00 in Tokyo (UTC+9) = 2026-06-23T20:00Z, so the
    // UTC-bounded backfill (window start 2026-06-24) legitimately omits it.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/edge.ics", "uid-edge", "v1", "Standup"),
            timed(
                "2026-06-24T05:00:00",
                Some("2026-06-24T05:30:00"),
                "Asia/Tokyo",
            ),
        )]),
    )
    .await
    .unwrap();

    sweep_absent(
        &pool,
        &ctx(),
        &std::collections::HashSet::new(),
        "2026-06-24",
    )
    .await
    .unwrap();

    assert!(
        page_exists_by_uid(&pool, "uid-edge").await,
        "window-edge event spared, not swept"
    );
}

fn series_recurring(href: &str, uid: &str, rrule: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core(href, uid, "v1", "Standup"),
        schedule: timed(
            "2026-01-01T09:00:00",
            Some("2026-01-01T09:30:00"),
            "America/New_York",
        ),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: rrule.into(),
            exdates: vec![],
            overrides: vec![],
        }),
    })
}

async fn page_exists_by_uid(pool: &sqlx::SqlitePool, uid: &str) -> bool {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM page_sync ps JOIN pages p ON p.id = ps.page_id WHERE ps.ical_uid = ?",
    )
    .bind(uid)
    .fetch_one(pool)
    .await
    .unwrap();
    n > 0
}

#[tokio::test]
async fn removal_is_idempotent() {
    let pool = setup().await;
    let owned = synced_page(&pool, "/owned.ics", "uid-owned").await;
    mark_completed(&pool, &owned).await;
    let bare = synced_page(&pool, "/bare.ics", "uid-bare").await;

    for _ in 0..2 {
        reconcile(&pool, &ctx(), &removal("/owned.ics"))
            .await
            .unwrap();
        reconcile(&pool, &ctx(), &removal("/bare.ics"))
            .await
            .unwrap();
    }

    assert_eq!(
        sync_state(&pool, &owned).await,
        "detached",
        "re-removal of detached is a no-op"
    );
    assert!(!page_exists(&pool, &bare).await);
    assert_eq!(page_count(&pool).await, 1);
}

#[tokio::test]
async fn tombstoned_external_id_skipped_on_upsert() {
    let pool = setup().await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    tombstone(&pool, &page_id).await;

    // Upstream sends an update for the same resource — must not resurrect it.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev.ics", "uid-1", "v2", "Resurrected"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(
        sync_state(&pool, &page_id).await,
        "tombstoned",
        "still hidden"
    );
    assert_eq!(
        page_title(&pool, &page_id).await,
        "Event",
        "no upsert applied"
    );
    assert!(
        deleted_at_of(&pool, &page_id).await.is_some(),
        "stays in trash"
    );
}

#[tokio::test]
async fn tombstoned_page_not_relinked_by_uid() {
    let pool = setup().await;
    let page_id = synced_page(&pool, "/old.ics", "uid-1").await;
    tombstone(&pool, &page_id).await;

    // Same UID returns under a new href: the tombstoned page must not be re-linked.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/new.ics", "uid-1", "v2", "Event"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(
        sync_state(&pool, &page_id).await,
        "tombstoned",
        "trashed page left alone"
    );
    assert_eq!(
        page_count(&pool).await,
        2,
        "new href creates a fresh page, not a resurrect"
    );
}

/// Teardown: owned pages detach and keep their dormant identity, bare mirrors are
/// deleted, the folder is kept but de-flagged to a regular folder.
#[tokio::test]
async fn teardown_keeps_owned_deletes_bare_and_deflags_folder() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    let owned = synced_page(&pool, "/owned.ics", "uid-owned").await;
    mark_completed(&pool, &owned).await;
    let bare = synced_page(&pool, "/bare.ics", "uid-bare").await;

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();

    assert_eq!(sync_state(&pool, &owned).await, "detached");
    assert_eq!(
        ical_uid_of(&pool, &owned).await.as_deref(),
        Some("uid-owned"),
        "dormant identity kept"
    );
    assert!(!page_exists(&pool, &bare).await, "bare mirror deleted");
    assert_eq!(
        folder_count(&pool).await,
        1,
        "folder kept for the surviving owned page"
    );
    assert!(
        !folder_is_external(&pool, "f1").await,
        "becomes a regular folder"
    );
}

#[tokio::test]
async fn teardown_removes_an_empty_folder() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    synced_page(&pool, "/a.ics", "uid-a").await;
    synced_page(&pool, "/b.ics", "uid-b").await;

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();

    assert_eq!(page_count(&pool).await, 0, "all bare mirrors deleted");
    assert_eq!(
        folder_count(&pool).await,
        0,
        "nothing owned survived → folder removed"
    );
}

#[tokio::test]
async fn teardown_clears_tombstones_but_keeps_trashed_page() {
    let pool = setup().await;
    let owned = synced_page(&pool, "/owned.ics", "uid-owned").await;
    mark_completed(&pool, &owned).await; // keeps the folder alive
    let dead = synced_page(&pool, "/dead.ics", "uid-dead").await;
    tombstone(&pool, &dead).await;

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();

    assert!(
        ical_uid_of(&pool, &dead).await.is_none(),
        "tombstone link cleared for a fresh resync"
    );
    assert!(
        page_exists(&pool, &dead).await,
        "the page itself stays in trash"
    );
    assert!(deleted_at_of(&pool, &dead).await.is_some());
}

#[tokio::test]
async fn resync_after_teardown_makes_a_fresh_page_and_leaves_the_trashed_one_untouched() {
    // Teardown clears a trashed page's tombstone by design, so a later resync of the
    // same UID has nothing suppressing it — the reconciler mints a NEW page. The safe
    // outcome: the trashed original keeps its content and stays in trash, and the
    // resynced copy is a distinct live page (an accepted duplicate, not a resurrection
    // that clobbers the user's trashed notes).
    let pool = setup().await;
    let owned = synced_page(&pool, "/owned.ics", "uid-owned").await;
    mark_completed(&pool, &owned).await; // keeps the folder alive through teardown

    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/dead.ics",
            "uid-dead",
            "v1",
            "Team sync",
            Some("Original agenda"),
            None,
            &[],
        )]),
    )
    .await
    .unwrap();
    let dead = sqlx::query_scalar::<_, String>(
        "SELECT page_id FROM page_sync WHERE ical_uid = 'uid-dead'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    tombstone(&pool, &dead).await;

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();
    flag_external(&pool, "f1").await; // re-enable re-flags the folder external

    // Resync: the same UID returns from the provider with a changed description.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/dead.ics",
            "uid-dead",
            "v2",
            "Team sync",
            Some("Fresh agenda"),
            None,
            &[],
        )]),
    )
    .await
    .unwrap();

    assert!(
        deleted_at_of(&pool, &dead).await.is_some(),
        "original stays in trash"
    );
    assert_eq!(
        page_content_text(&pool, &dead).await,
        "Original agenda",
        "trashed content untouched"
    );

    let fresh = sqlx::query_scalar::<_, String>(
        "SELECT page_id FROM page_sync WHERE ical_uid = 'uid-dead' AND sync_state = 'active'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(fresh, dead, "a new page, not the trashed one resurrected");
    assert!(
        deleted_at_of(&pool, &fresh).await.is_none(),
        "the resynced copy is live"
    );
}

#[tokio::test]
async fn teardown_is_idempotent() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    let owned = synced_page(&pool, "/owned.ics", "uid-owned").await;
    mark_completed(&pool, &owned).await;
    let bare = synced_page(&pool, "/bare.ics", "uid-bare").await;

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();
    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();

    assert_eq!(sync_state(&pool, &owned).await, "detached");
    assert!(!page_exists(&pool, &bare).await);
    assert_eq!(folder_count(&pool).await, 1);
}

/// teardown_calendar's deferred read-then-write can lose the WAL snapshot (517)
/// when the editor commits mid-teardown; retry_on_busy must heal it so neither
/// write surfaces BUSY and the owned page still detaches. Needs a real on-disk WAL
/// pool and both writers on real threads (`tokio::spawn` + `worker_threads ≥ 2`) —
/// a cooperative single task can't overlap them tightly enough to reproduce the
/// 517. The editor uses the real `update_page_impl` (write-first, busy-safe).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_heals_a_racing_editor_write() {
    let db = crate::pool::wal_test_pool().await;
    let pool = db.pool.clone();
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
    flag_external(&pool, "f1").await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    simulate_user_body_edit(&pool, &page_id, "my notes").await; // owned → teardown detaches

    let td_pool = pool.clone();
    let teardown =
        tokio::spawn(async move { teardown_calendar(&td_pool, ACCOUNT, "cal", "f1").await });
    let edit_pool = pool.clone();
    let edit_page = page_id.clone();
    let edit = tokio::spawn(async move {
        crate::update_page_impl(
            &edit_pool,
            edit_page,
            crate::PageUpdate {
                content_text: Some("edited".into()),
                ..Default::default()
            },
        )
        .await
    });

    let (td_res, edit_res) = tokio::join!(teardown, edit);
    td_res
        .unwrap()
        .expect("teardown must not surface SQLITE_BUSY");
    edit_res
        .unwrap()
        .expect("editor write must not surface SQLITE_BUSY");

    assert_eq!(
        sync_state(&pool, &page_id).await,
        "detached",
        "owned page survives the race"
    );
}

/// The unsync → resync round-trip: an owned page detaches on teardown, then a
/// fresh sync re-links it in place (no duplicate) and reactivates it.
#[tokio::test]
async fn unsync_then_resync_relinks_in_place() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    simulate_user_body_edit(&pool, &page_id, "my notes").await;

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();
    assert_eq!(sync_state(&pool, &page_id).await, "detached");

    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev.ics", "uid-1", "v2", "Event"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(
        page_count(&pool).await,
        1,
        "re-linked in place, no duplicate"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "active", "reactivated");
    assert_eq!(
        page_content_text(&pool, &page_id).await,
        "my notes",
        "user layer preserved"
    );
}

/// Re-enable path: teardown clears the cursor, so backfill re-delivers the same
/// events with unchanged etags — the detached row must still reactivate.
#[tokio::test]
async fn resync_with_unchanged_etag_reactivates_detached_page() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    let page_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    simulate_user_body_edit(&pool, &page_id, "my notes").await;

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();
    assert_eq!(sync_state(&pool, &page_id).await, "detached");

    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev.ics", "uid-1", "v1", "Event"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(
        page_count(&pool).await,
        1,
        "re-linked in place, no duplicate"
    );
    assert_eq!(
        sync_state(&pool, &page_id).await,
        "active",
        "reactivated despite unchanged etag"
    );
    assert_eq!(
        page_content_text(&pool, &page_id).await,
        "my notes",
        "user layer preserved"
    );
}

/// R2: a synced page detached (calendar disabled), then trashed, then the calendar
/// re-enabled and the still-live event re-enumerated. The trashed copy must stay
/// severed in the trash — reactivating it would rewrite an invisible (`deleted_at`)
/// row and re-lock it on restore. Instead the live event mirrors in as a fresh,
/// visible page and the trashed copy loses its dormant sync link.
#[tokio::test]
async fn re_enable_after_trashing_a_detached_page_mirrors_fresh_and_leaves_trash_severed() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    let trashed_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    simulate_user_body_edit(&pool, &trashed_id, "my notes").await; // owned → detaches, not deleted

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();
    assert_eq!(sync_state(&pool, &trashed_id).await, "detached");

    crate::soft_delete_page_impl(&pool, &trashed_id)
        .await
        .unwrap();
    assert_eq!(
        sync_state(&pool, &trashed_id).await,
        "detached",
        "trash keeps it severed"
    );
    assert!(is_trashed(&pool, &trashed_id).await);

    // Re-enable: the backfill re-enumerates the still-live event (same etag).
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev.ics", "uid-1", "v1", "Event"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    // The live event now mirrors to a fresh, visible page — separate from the trashed one.
    let fresh_id: String =
        sqlx::query_scalar("SELECT page_id FROM page_sync WHERE external_id = '/ev.ics'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(
        fresh_id, trashed_id,
        "mirrored to a new page, not the trashed row"
    );
    assert_eq!(
        sync_state(&pool, &fresh_id).await,
        "active",
        "fresh mirror is live"
    );
    assert!(!is_trashed(&pool, &fresh_id).await, "fresh mirror renders");

    // The trashed copy stays in the trash, keeps the user's content, and is severed.
    assert!(
        is_trashed(&pool, &trashed_id).await,
        "original stays trashed"
    );
    assert_eq!(
        page_content_text(&pool, &trashed_id).await,
        "my notes",
        "user content preserved"
    );
    assert!(
        !has_page_sync(&pool, &trashed_id).await,
        "trashed copy severed from sync"
    );

    // Restoring it leaves it severed — there is no sync link to re-lock.
    crate::restore_page_impl(&pool, &trashed_id).await.unwrap();
    assert!(
        !has_page_sync(&pool, &trashed_id).await,
        "restored copy stays severed"
    );
    assert_eq!(page_count(&pool).await, 2, "trashed copy + fresh mirror");
}

/// R15: same as above, but the re-enumerated event returns under a *changed href*
/// (same UID) — the exact case re-link exists for. The external_id guard at the
/// match site can't fire (href differs), so without excluding trashed pages from
/// `find_relink` the UID match would reactivate the invisible trashed row and
/// re-lock it on restore. The fix mirrors fresh and leaves the trash severed.
#[tokio::test]
async fn re_enable_under_changed_href_mirrors_fresh_and_leaves_trash_severed() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    let trashed_id = synced_page(&pool, "/ev.ics", "uid-1").await;
    simulate_user_body_edit(&pool, &trashed_id, "my notes").await; // owned → detaches, not deleted

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();
    crate::soft_delete_page_impl(&pool, &trashed_id)
        .await
        .unwrap();
    assert!(is_trashed(&pool, &trashed_id).await);

    // Re-enable: the same live event re-enumerates under a new href, same UID.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/ev-2.ics", "uid-1", "v1", "Event"),
            timed("2026-06-15T09:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    // The live event mirrors to a fresh, visible page under the new href.
    let fresh_id: String =
        sqlx::query_scalar("SELECT page_id FROM page_sync WHERE external_id = '/ev-2.ics'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(
        fresh_id, trashed_id,
        "mirrored to a new page, not the trashed row"
    );
    assert_eq!(
        sync_state(&pool, &fresh_id).await,
        "active",
        "fresh mirror is live"
    );
    assert!(!is_trashed(&pool, &fresh_id).await, "fresh mirror renders");

    // The trashed copy stays trashed, keeps the user's content, and is NOT
    // reactivated. Its stale link (the old href) survives severed-in-place —
    // harmless, since that external_id no longer collides with the live event.
    assert!(
        is_trashed(&pool, &trashed_id).await,
        "original stays trashed"
    );
    assert_eq!(
        page_content_text(&pool, &trashed_id).await,
        "my notes",
        "user content preserved"
    );
    assert_eq!(
        sync_state(&pool, &trashed_id).await,
        "detached",
        "trashed copy not reactivated"
    );

    crate::restore_page_impl(&pool, &trashed_id).await.unwrap();
    assert_eq!(
        sync_state(&pool, &trashed_id).await,
        "detached",
        "restored copy stays severed"
    );
    assert_eq!(page_count(&pool).await, 2, "trashed copy + fresh mirror");
}

// ─── occurrence deltas only touch an ACTIVE series ────────────────────────────

#[tokio::test]
async fn occurrence_cancel_against_a_tombstoned_series_is_skipped() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![series("v1", vec![], vec![])]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    tombstone(&pool, &page_id).await;

    // A cancellation arrives upstream for a series the user trashed locally.
    let occ = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: "2026-06-08T09:00:00".into(),
        kind: OccurrenceKind::Cancel,
    });
    let outcome = reconcile(&pool, &ctx(), &delta(vec![occ])).await.unwrap();

    assert!(
        outcome.missing_masters.is_empty(),
        "a tombstoned series is handled, not missing"
    );
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        Vec::<String>::new(),
        "trashed series' rule untouched"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "tombstoned");
}

#[tokio::test]
async fn occurrence_modify_against_a_detached_series_is_skipped() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![series("v1", vec![], vec![])]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    sqlx::query("UPDATE page_sync SET sync_state = 'detached' WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    let occ = UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: "uid-series".into(),
        series_ref: "uid-series".into(),
        original_date: "2026-06-08T09:00:00".into(),
        kind: OccurrenceKind::Modify(timed("2026-06-08T14:00:00", None, "UTC")),
    });
    reconcile(&pool, &ctx(), &delta(vec![occ])).await.unwrap();

    assert_eq!(
        override_count(&pool).await,
        0,
        "detached series gets no override written"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "detached");
}

// ─── a series rewrite must not disturb user-owned completion state ─────────────

#[tokio::test]
async fn series_rewrite_preserves_user_completed_occurrences() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;

    // completed_set is user-owned (set by the completion command, never by the
    // reconciler). A full rule rewrite below must leave it intact — the set is keyed
    // by page_id, independent of the page_sync bundle the rewrite replaces.
    sqlx::query("INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, '2026-06-22', 'clone-abc')")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    let mut bumped = weekly_series();
    if let UpsertItem::Event(e) = &mut bumped {
        e.core.etag = Some("v2".into());
        e.core.title = "Weekly sync (renamed)".into();
    }
    reconcile(&pool, &ctx(), &delta(vec![bumped]))
        .await
        .unwrap();

    assert_eq!(
        page_title(&pool, &page_id).await,
        "Weekly sync (renamed)",
        "rewrite actually ran"
    );
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT clone_id FROM completed_set WHERE page_id = ? AND occurrence_date = '2026-06-22'",
    )
    .bind(&page_id)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(
        stored.as_deref(),
        Some("clone-abc"),
        "completion survives the rewrite"
    );
}

// ─── head recompute over the sets (reconciler repoint) ─────────────────────────

/// A plain weekly series (no exdate/override), etag-tagged so a re-sync forces a
/// real rewrite. Occurrences step 7 days from the 2026-06-01 base.
fn weekly(etag: &str, rrule: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", etag, "Weekly"),
        schedule: timed("2026-06-01T09:00:00", None, "UTC"),
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: rrule.into(),
            exdates: vec![],
            overrides: vec![],
        }),
    })
}

/// (scheduled_start, status, completed_at) of the page denorm — the cache the
/// recompute owns for a recurring page.
async fn page_denorm(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> (Option<String>, String, Option<String>) {
    sqlx::query_as("SELECT scheduled_start, status, completed_at FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The reconciler head is the oldest-open occurrence, not the raw base: a rule
/// rewrite carries the completed + skip sets (keyed by page_id) through, and the
/// recompute honours both when re-pinning the denorm.
#[tokio::test]
async fn series_rewrite_recomputes_head_over_both_sets() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly("v1", "FREQ=WEEKLY")]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        page_denorm(&pool, &page_id).await.0.as_deref(),
        Some("2026-06-01T09:00:00")
    );

    // Complete the base, dismiss the next — the head should skip past both.
    sqlx::query("INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, '2026-06-01', 'c1')")
        .bind(&page_id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO skip_set (page_id, occurrence_date) VALUES (?, '2026-06-08')")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(&pool, &ctx(), &delta(vec![weekly("v2", "FREQ=WEEKLY")]))
        .await
        .unwrap();

    let completed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM completed_set WHERE page_id = ?")
        .bind(&page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let skipped: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM skip_set WHERE page_id = ?")
        .bind(&page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (completed, skipped),
        (1, 1),
        "both sets survive the wholesale rewrite"
    );
    assert_eq!(
        page_denorm(&pool, &page_id).await.0.as_deref(),
        Some("2026-06-15T09:00:00"),
        "head recomputes past the completed base and the skipped next occurrence",
    );
}

/// A finite series exhausted by exclusion recomputes to `done`; the provider
/// extending it (a later UNTIL) must un-mark the head both times the recompute runs.
#[tokio::test]
async fn provider_re_extension_unmarks_exhausted_head() {
    let pool = setup().await;
    // Only 2026-06-01 exists (floating UNTIL passes through untouched).
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![weekly("v1", "FREQ=WEEKLY;UNTIL=20260601T090000")]),
    )
    .await
    .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;

    sqlx::query("INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, '2026-06-01', 'c1')")
        .bind(&page_id).execute(&pool).await.unwrap();
    // Re-sync the same one-shot rule → sole occurrence excluded → exhausted → done.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![weekly("v2", "FREQ=WEEKLY;UNTIL=20260601T090000")]),
    )
    .await
    .unwrap();
    let (_, status, completed_at) = page_denorm(&pool, &page_id).await;
    assert_eq!(status, "done", "exhausted series marks the head done");
    assert!(completed_at.is_some());

    // Provider extends the series → the next occurrence opens → head un-marked.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![weekly("v3", "FREQ=WEEKLY;UNTIL=20260701T090000")]),
    )
    .await
    .unwrap();
    let (start, status, completed_at) = page_denorm(&pool, &page_id).await;
    assert_eq!(status, "not_started", "re-extension un-marks the head");
    assert_eq!(completed_at, None);
    assert_eq!(start.as_deref(), Some("2026-06-08T09:00:00"));
}

/// The provider converting an exhausted recurring series into a single event drops
/// the rule but never writes `status`; the transition must clear the stale terminal
/// `done` or the event stays done and vanishes from the calendar.
#[tokio::test]
async fn recurring_to_single_transition_clears_terminal_done() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly("v1", "FREQ=WEEKLY")]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    // Simulate the terminal state a prior exhausted recompute left.
    sqlx::query("UPDATE pages SET status = 'done', completed_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/series.ics", "uid-series", "v2", "Weekly"),
            timed("2026-07-01T10:00:00", None, "UTC"),
        )]),
    )
    .await
    .unwrap();

    assert_eq!(
        rule_count(&pool).await,
        0,
        "rule dropped — now a single event"
    );
    let (start, status, completed_at) = page_denorm(&pool, &page_id).await;
    assert_eq!(
        status, "not_started",
        "recurring→single un-marks the stale terminal done"
    );
    assert_eq!(completed_at, None);
    assert_eq!(start.as_deref(), Some("2026-07-01T10:00:00"));
}

/// Detaching an owned series (upstream removal) recomputes its head: once detached
/// the page unlocks and the frontend's completed-base suppression stops, so a head
/// still pinned to a completed base would double-render beside its done clone.
#[tokio::test]
async fn detach_recomputes_head_off_completed_base() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly("v1", "FREQ=WEEKLY")]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    // Completed base makes the series owned (→ detach, not hard delete) and moves
    // the recomputed head forward.
    sqlx::query("INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, '2026-06-01', 'c1')")
        .bind(&page_id).execute(&pool).await.unwrap();

    reconcile(&pool, &ctx(), &removal("/series.ics"))
        .await
        .unwrap();

    assert_eq!(sync_state(&pool, &page_id).await, "detached");
    assert_eq!(
        page_denorm(&pool, &page_id).await.0.as_deref(),
        Some("2026-06-08T09:00:00"),
        "detach moves the head off the completed base",
    );
}

// ─── relink + teardown of a RECURRING series (singles-only before) ─────────────

#[tokio::test]
async fn relink_reactivates_a_detached_series_in_place() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    sqlx::query("UPDATE page_sync SET sync_state = 'detached' WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    // Same uid returns under a new href, still recurring with its exdate + override.
    let mut moved = weekly_series();
    if let UpsertItem::Event(e) = &mut moved {
        e.core.external_id = "/series-new.ics".into();
        e.core.etag = Some("v2".into());
    }
    reconcile(&pool, &ctx(), &delta(vec![moved])).await.unwrap();

    assert_eq!(page_count(&pool).await, 1, "re-linked, not duplicated");
    assert_eq!(
        rule_count(&pool).await,
        1,
        "one rule after relink, not stacked"
    );
    assert_eq!(
        override_count(&pool).await,
        1,
        "override carried, not duplicated"
    );
    assert_eq!(sync_state(&pool, &page_id).await, "active");
    let (_, external_id, _) = only_page_sync(&pool).await;
    assert_eq!(external_id, "/series-new.ics");
    assert_eq!(
        rule_exdates(&pool, &page_id).await,
        vec!["2026-06-15T09:00:00"]
    );
}

#[tokio::test]
async fn teardown_keeps_an_owned_recurring_series_rule_and_override() {
    let pool = setup().await;
    flag_external(&pool, "f1").await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()]))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    mark_completed(&pool, &page_id).await; // owned → detaches, kept

    teardown_calendar(&pool, ACCOUNT, "cal", "f1")
        .await
        .unwrap();

    assert_eq!(sync_state(&pool, &page_id).await, "detached");
    assert_eq!(
        rule_count(&pool).await,
        1,
        "detach severs sync only — rule survives"
    );
    assert_eq!(override_count(&pool).await, 1);
    assert!(override_row(&pool, &page_id, "2026-06-08T09:00:00")
        .await
        .is_some());
}

// ─── all-day exclusive-end decrement: month/year boundary + unparseable ────────

#[tokio::test]
async fn all_day_end_decrement_crosses_month_and_year_boundaries() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![
            single(
                core("/m.ics", "uid-m", "v1", "MonthEnd"),
                all_day("2026-06-30", Some("2026-07-01")),
            ),
            single(
                core("/y.ics", "uid-y", "v1", "YearEnd"),
                all_day("2025-12-31", Some("2026-01-01")),
            ),
        ]),
    )
    .await
    .unwrap();

    async fn inclusive_end(pool: &sqlx::SqlitePool, external: &str) -> String {
        sqlx::query_scalar(
            "SELECT ps.scheduled_end FROM page_schedules ps
             JOIN page_sync s ON s.page_id = ps.page_id
             WHERE s.external_id = ? AND ps.rule_id IS NULL",
        )
        .bind(external)
        .fetch_one(pool)
        .await
        .unwrap()
    }
    assert_eq!(
        inclusive_end(&pool, "/m.ics").await,
        "2026-06-30",
        "exclusive Jul 1 → inclusive Jun 30"
    );
    assert_eq!(
        inclusive_end(&pool, "/y.ics").await,
        "2025-12-31",
        "exclusive Jan 1 → inclusive Dec 31"
    );
}

#[tokio::test]
async fn all_day_end_that_is_not_a_real_date_passes_through() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single(
            core("/bad.ics", "uid-bad", "v1", "Garbage"),
            all_day("2026-06-15", Some("2026-13-99")),
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(
        base_schedule(&pool, &page_id).await.1,
        Some("2026-13-99".into()),
        "an unparseable 10-char end is left untouched, not shifted or dropped"
    );
}

// ─── UNTIL rewrite: unknown source zone ───────────────────────────────────────

#[tokio::test]
async fn until_with_an_unknown_zone_passes_the_rrule_through_unchanged() {
    let pool = setup().await;
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![series_with_rrule(
            "FREQ=WEEKLY;UNTIL=20260630T120000Z",
            "Mars/Phobos",
        )]),
    )
    .await
    .unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    let (rrule, _, _) = rule_row(&pool, &page_id).await;
    assert_eq!(
        rrule, "FREQ=WEEKLY;UNTIL=20260630T120000Z",
        "an unparseable zone leaves the rrule raw — no panic, no dropped rule"
    );
}

// ─── seeded description: edge inputs that must not clobber a body ──────────────

#[tokio::test]
async fn whitespace_only_description_leaves_the_body_untouched() {
    let pool = setup().await;
    let mk = |etag: &str, desc: Option<&str>| {
        delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            etag,
            "Event",
            desc,
            None,
            &[],
        )])
    };
    reconcile(&pool, &ctx(), &mk("v1", Some("Real notes")))
        .await
        .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;

    // A blank-after-trim upstream description must never blank a body the user may own.
    reconcile(&pool, &ctx(), &mk("v2", Some("   ")))
        .await
        .unwrap();

    assert_eq!(page_content_text(&pool, &page_id).await, "Real notes");
}

#[tokio::test]
async fn nonempty_body_with_no_seed_hash_parks_the_incoming_description() {
    let pool = setup().await;
    // First sync carries no description → empty body, no seed hash recorded.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            "v1",
            "Event",
            None,
            None,
            &[],
        )]),
    )
    .await
    .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    // A body with no comparable seed hash and no user_modified flag — e.g. content
    // that predates seed-hash versioning. It is NOT pristine, so it must be held.
    sqlx::query("UPDATE pages SET content_text = 'migrated body' WHERE id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(
        &pool,
        &ctx(),
        &delta(vec![single_full(
            "/ev.ics",
            "uid-1",
            "v2",
            "Event",
            Some("Upstream notes"),
            None,
            &[],
        )]),
    )
    .await
    .unwrap();

    assert_eq!(
        page_content_text(&pool, &page_id).await,
        "migrated body",
        "not overwritten"
    );
    let (_, _, pending) = seed_meta(&pool, &page_id).await;
    assert_eq!(
        pending.as_deref(),
        Some("Upstream notes"),
        "withheld description parked"
    );
}
