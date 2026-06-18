//! Layer-2 reconciler corpus: hand-written `SyncDelta` → expected page writes,
//! provider-independent. Pins the shared reconciler's correctness before any
//! real provider exists.

use super::*;
use crate::pool::test_pool;
use crate::sync_delta::{
    EventCore, EventSchedule, EventUpsert, OccurrenceDelta, OccurrenceKind, OccurrenceOverride,
    Recurrence, Removal, SyncDelta, UpsertItem,
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

/// A single event carrying the mirror metadata + description that S4 reconciles.
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
async fn mirror_meta(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> (Option<String>, Option<String>) {
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

// ─── timezone normalization (S3) ──────────────────────────────────────────────

/// Build a timed series with a given RRULE and source zone, no exdates/overrides.
fn series_with_rrule(rrule: &str, tz: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: core("/series.ics", "uid-series", "v1", "Standup"),
        schedule: timed("2026-06-01T09:00:00", Some("2026-06-01T09:30:00"), tz),
        recurrence: Some(Recurrence {
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
        &delta(vec![series_with_rrule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260315T100000Z", "America/New_York")]),
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
        &delta(vec![series_with_rrule("FREQ=WEEKLY;UNTIL=20260115T100000Z", "America/New_York")]),
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
        &delta(vec![series_with_rrule("FREQ=DAILY;UNTIL=20260315T100000", "America/New_York")]),
    )
    .await
    .unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    assert_eq!(rule_row(&pool, &page_id).await.0, "FREQ=DAILY;UNTIL=20260315T100000");

    // A date-only UNTIL on an all-day series (no zone) passes through; the rule
    // still gets the sentinel zone, never a panic.
    reconcile(
        &pool,
        &ctx(),
        &delta(vec![UpsertItem::Event(EventUpsert {
            core: core("/allday.ics", "uid-allday", "v1", "Allday"),
            schedule: all_day("2026-06-01", Some("2026-06-02")),
            recurrence: Some(Recurrence {
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
        schedule: timed("2026-06-01T09:00:00", Some("2026-06-01T09:30:00"), "America/New_York"),
        recurrence: Some(Recurrence {
            rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260831T130000Z".into(),
            exdates: vec!["2026-06-15T09:00:00".into()],
            overrides: vec![OccurrenceOverride {
                original_date: "2026-06-08T09:00:00".into(),
                schedule: timed("2026-06-08T11:00:00", Some("2026-06-08T11:30:00"), "America/New_York"),
            }],
        }),
    });
    reconcile(&pool, &ctx(), &delta(vec![series])).await.unwrap();

    let (page_id, _, _) = only_page_sync(&pool).await;
    let (rrule, scheduled_start, tz) = rule_row(&pool, &page_id).await;

    // dtstart: bare wall-clock.
    assert_eq!(scheduled_start, "2026-06-01T09:00:00");
    assert_eq!(tz, "America/New_York", "resolved IANA id kept alongside wall-clock");
    // UNTIL: 13:00Z on 2026-08-31 (EDT, UTC-4) → 09:00 wall-clock, no Z.
    assert_eq!(rrule, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260831T090000");
    // EXDATE: bare wall-clock, no zone suffix.
    assert_eq!(rule_exdates(&pool, &page_id).await, vec!["2026-06-15T09:00:00"]);
    // RECURRENCE-ID → original_date, and the override start: both bare wall-clock.
    let ov = override_row(&pool, &page_id, "2026-06-08T09:00:00").await.unwrap();
    assert_eq!(ov.0, "2026-06-08T11:00:00");
}

/// The EXDATE-vs-removal split: a cancel-*occurrence* adds an EXDATE and leaves
/// the series page intact; a whole-event *removal* is the lifecycle pass's job
/// (S5) — this core must not touch it. Get these backwards and one skipped
/// instance would delete the entire series page.
#[tokio::test]
async fn removal_is_left_for_the_lifecycle_pass() {
    let pool = setup().await;
    reconcile(&pool, &ctx(), &delta(vec![weekly_series()])).await.unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;

    let with_removal = SyncDelta {
        upserts: vec![],
        removals: vec![Removal { external_id: "/series.ics".into() }],
        next_token: None,
    };
    reconcile(&pool, &ctx(), &with_removal).await.unwrap();

    // Untouched: page, rule, and the sync link all survive a removal in core.
    assert_eq!(page_count(&pool).await, 1);
    assert_eq!(rule_count(&pool).await, 1);
    assert_eq!(sync_state(&pool, &page_id).await, "active");
}

// ─── three field layers: mirror / seeded / user (S4) ──────────────────────────

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
        &delta(vec![single_full("/ev.ics", "uid-1", "v1", "Solo", None, None, &[])]),
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
    assert_eq!(page_content_text(&pool, &page_id).await, "Bring the roadmap drafts.");
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
        &delta(vec![single_full("/ev.ics", "uid-1", "v1", "No notes", None, None, &[])]),
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
        delta(vec![single_full("/ev.ics", "uid-1", etag, "Event", Some(desc), None, &[])])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Original notes")).await.unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    let (first_hash, _, _) = seed_meta(&pool, &page_id).await;

    reconcile(&pool, &ctx(), &mk("v2", "Updated notes")).await.unwrap();

    assert_eq!(page_content_text(&pool, &page_id).await, "Updated notes");
    let (second_hash, version, pending) = seed_meta(&pool, &page_id).await;
    assert_ne!(first_hash, second_hash, "hash tracks the refreshed body");
    assert_eq!(version, Some(1));
    assert_eq!(pending, None, "untouched body refreshes silently — nothing parked");
}

#[tokio::test]
async fn description_change_is_withheld_when_user_edited_the_body() {
    let pool = setup().await;
    let mk = |etag: &str, desc: &str| {
        delta(vec![single_full("/ev.ics", "uid-1", etag, "Event", Some(desc), None, &[])])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed text")).await.unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    simulate_user_body_edit(&pool, &page_id, "my own notes").await;

    reconcile(&pool, &ctx(), &mk("v2", "New upstream text")).await.unwrap();

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
        delta(vec![single_full("/ev.ics", "uid-1", etag, "Event", Some(desc), None, &[])])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed text")).await.unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    // Stored hash is from an older projection version — no longer comparable.
    sqlx::query("UPDATE page_sync SET seeded_description_hash_version = 0 WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(&pool, &ctx(), &mk("v2", "Refreshed text")).await.unwrap();

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
        delta(vec![single_full("/ev.ics", "uid-1", etag, "Event", Some(desc), None, &[])])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed text")).await.unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    simulate_user_body_edit(&pool, &page_id, "user notes").await;
    sqlx::query("UPDATE page_sync SET seeded_description_hash_version = 0 WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();

    reconcile(&pool, &ctx(), &mk("v2", "New text")).await.unwrap();

    // With the hash incomparable, the ownership flag is the fallback — edited stays.
    assert_eq!(page_content_text(&pool, &page_id).await, "user notes");
    let (_, _, pending) = seed_meta(&pool, &page_id).await;
    assert_eq!(pending.as_deref(), Some("New text"));
}

#[tokio::test]
async fn parked_notice_clears_when_upstream_matches_the_body_again() {
    let pool = setup().await;
    let mk = |etag: &str, desc: &str| {
        delta(vec![single_full("/ev.ics", "uid-1", etag, "Event", Some(desc), None, &[])])
    };
    reconcile(&pool, &ctx(), &mk("v1", "Seed")).await.unwrap();
    let (page_id, _, _) = only_page_sync(&pool).await;
    simulate_user_body_edit(&pool, &page_id, "B").await;
    reconcile(&pool, &ctx(), &mk("v2", "C")).await.unwrap();
    assert_eq!(seed_meta(&pool, &page_id).await.2.as_deref(), Some("C"), "parked first");

    // Upstream later edits down to exactly what the user's body already says.
    reconcile(&pool, &ctx(), &mk("v3", "B")).await.unwrap();

    assert_eq!(page_content_text(&pool, &page_id).await, "B");
    assert_eq!(seed_meta(&pool, &page_id).await.2, None, "no divergence → notice cleared");
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
