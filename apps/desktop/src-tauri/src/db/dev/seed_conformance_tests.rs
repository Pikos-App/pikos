//! Mock calendar-sync seed conformance — the writer half of a table both seeders run.
//!
//! The seed exists to make behaviours reachable by hand that no unit test covers, so
//! what it *contains* is its contract — and it is written twice: here as SQL through
//! [`dev_seed_synced_calendar_impl`], and again in TypeScript
//! (`apps/desktop/seeds/syncedCalendar.ts`) against `MockStorageAdapter`, which is what test
//! mode, the `VITE_SEED` harness and Playwright plant. The two halves drifted apart
//! unnoticed once, and the manual QA pass runs against both, so a drift corrupts QA
//! itself rather than failing a test.
//!
//! `tests/fixtures/synced-seed-lifecycle.json` is the contract: this runner asserts the
//! SQL writer satisfies it, `syncedCalendar.conformance.test.ts` asserts the mock
//! satisfies the same rows, and the fixture's `scope` says what is deliberately left
//! out (display names, sort-order numbers, the mock's missing ownership seam).
//!
//! Rows are described as an outcome — title, placement, schedule, zone, flags — never
//! as the calls that produce them, and dates are offsets from the run's own local
//! today, so the table says nothing about the day it is run on.

use chrono::{Datelike, Duration, NaiveDate};
use serde::Deserialize;
use sqlx::{Row, SqlitePool};

use super::seed::dev_seed_synced_calendar_impl;

// The cross-language fixture directory; the TS runner reads the same file.
const TABLE: &str =
    include_str!("../../../../../../crates/pikos-db/tests/fixtures/synced-seed-lifecycle.json");

/// The zone a detached row's rule carries, spelled in the fixture as a sentinel
/// because it is whatever machine the seed ran on.
const DEVICE_ZONE: &str = "$device";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    #[allow(dead_code)]
    scope: Scope,
    scenarios: Vec<Scenario>,
}

/// The fixture's header: what it pins, and what it deliberately leaves alone.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scope {
    #[allow(dead_code)]
    what: Vec<String>,
    #[allow(dead_code)]
    excludes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
    expect: Expect,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Step {
    /// Plant the mock calendar-sync scenario. The mock has no other way in either.
    Seed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expect {
    account: Option<AccountExpect>,
    calendars: Option<Vec<CalendarExpect>>,
    counts: Option<Counts>,
    page_order: Option<Vec<OrderExpect>>,
    pages: Option<Vec<PageExpect>>,
    series: Option<Vec<SeriesExpect>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountExpect {
    display_name: String,
    provider: String,
    auth_kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CalendarExpect {
    /// Matched as a substring of the display name — see the fixture's `excludes`.
    name: String,
    color: String,
    enabled: bool,
    external_folder: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Counts {
    accounts: i64,
    calendars: i64,
    calendar_folders: i64,
    synced_pages: i64,
    series: i64,
    overrides: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrderExpect {
    calendar: String,
    titles: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageExpect {
    title: String,
    calendar: String,
    start: Instant,
    end: Option<Instant>,
    zone: Option<String>,
    sync_state: String,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    attendees: Vec<String>,
    #[serde(default)]
    pending_description: Option<String>,
    /// The page's indexed plain text (`pages.content_text`) — the user's own notes on
    /// a mirror, which is what a search has to be able to find.
    #[serde(default)]
    body_text: String,
    /// `page_sync.user_modified` — whether the mirror reads as the user's. Teardown
    /// keeps an owned page and destroys a bare one, so a seeder that drops the flag
    /// loses the row the manual QA pass is meant to find still standing.
    #[serde(default)]
    user_modified: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeriesExpect {
    title: String,
    calendar: String,
    sync_state: String,
    rrule: String,
    /// A provider `UNTIL`, kept structural: the day offset and the raw time the rule
    /// ends on. Mid-day is what makes the recurrence chip lock.
    #[serde(default)]
    until_day: Option<i64>,
    #[serde(default)]
    until_time: Option<String>,
    rule_zone: String,
    base: Span,
    /// Where the head sits once the series exists. The writer stamps it; the mock
    /// derives it — the two agreeing is the point.
    head: Span,
    #[serde(default)]
    exdates: Vec<Instant>,
    #[serde(default)]
    moved: Option<MovedExpect>,
    /// Local day the series reads as connected on, as an offset from today.
    #[serde(default)]
    connected_day: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Span {
    start: Instant,
    end: Option<Instant>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MovedExpect {
    original: Instant,
    start: Instant,
    end: Instant,
    zone: Option<String>,
}

/// A wall-clock the runners resolve rather than the fixture spelling out: `day` days
/// from the run's local today (or the last day of its month), at `time`. A date-only
/// instant is an all-day row.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Instant {
    #[serde(default)]
    day: i64,
    #[serde(default)]
    month_end: bool,
    #[serde(default)]
    time: Option<String>,
}

impl Instant {
    fn date(&self) -> NaiveDate {
        let today = chrono::Local::now().date_naive();
        if self.month_end {
            last_day_of_month(today)
        } else {
            today + Duration::days(self.day)
        }
    }

    fn resolve(&self) -> String {
        let date = self.date().format("%Y-%m-%d").to_string();
        match &self.time {
            Some(time) => format!("{date}T{time}:00"),
            None => date,
        }
    }
}

fn last_day_of_month(day: NaiveDate) -> NaiveDate {
    let first_next = if day.month() == 12 {
        NaiveDate::from_ymd_opt(day.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(day.year(), day.month() + 1, 1)
    };
    first_next.and_then(|d| d.pred_opt()).unwrap_or(day)
}

fn day_offset(offset: i64) -> String {
    (chrono::Local::now().date_naive() + Duration::days(offset))
        .format("%Y-%m-%d")
        .to_string()
}

/// The zone the fixture asks for, with the device sentinel resolved.
fn expected_zone(zone: &str) -> String {
    if zone == DEVICE_ZONE {
        pikos_db::device_zone().name().to_string()
    } else {
        zone.to_string()
    }
}

/// The calendar folder whose name *contains* the fixture's name — the dev command
/// suffixes "(synced)" onto it, the mock's canned discovery does not.
async fn calendar_folder(pool: &SqlitePool, name: &str) -> String {
    let folders: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM folders WHERE is_external_calendar = 1")
            .fetch_all(pool)
            .await
            .unwrap();
    folders
        .into_iter()
        .find(|(_, folder)| folder.contains(name))
        .unwrap_or_else(|| panic!("no calendar folder named like {name}"))
        .0
}

#[tokio::test]
async fn the_seeded_workspace_matches_the_shared_table() {
    let table: Table = serde_json::from_str(TABLE).expect("parse synced-seed-lifecycle.json");
    assert!(!table.scenarios.is_empty());

    for scenario in &table.scenarios {
        let pool = pikos_db::test_pool().await;
        for step in &scenario.steps {
            match step {
                Step::Seed => dev_seed_synced_calendar_impl(&pool).await.unwrap(),
            }
        }
        check(&pool, &scenario.expect, &scenario.name).await;
    }
}

/// One check per expectation key. The TS twin holds the same set in a
/// `Record<keyof Expect, …>`, which is what stops a key being asserted on one side
/// only — here `deny_unknown_fields` on [`Expect`] does that job.
async fn check(pool: &SqlitePool, want: &Expect, scenario: &str) {
    if let Some(account) = &want.account {
        check_account(pool, account, scenario).await;
    }
    if let Some(calendars) = &want.calendars {
        check_calendars(pool, calendars, scenario).await;
    }
    if let Some(counts) = &want.counts {
        check_counts(pool, counts, scenario).await;
    }
    if let Some(order) = &want.page_order {
        check_page_order(pool, order, scenario).await;
    }
    if let Some(pages) = &want.pages {
        check_pages(pool, pages, scenario).await;
    }
    if let Some(series) = &want.series {
        check_series(pool, series, scenario).await;
    }
}

async fn check_account(pool: &SqlitePool, want: &AccountExpect, scenario: &str) {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT display_name, provider, auth_kind FROM sync_account")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1, "{scenario}: one seeded account");
    assert_eq!(rows[0].0, want.display_name, "{scenario}: account name");
    assert_eq!(rows[0].1, want.provider, "{scenario}: account provider");
    assert_eq!(rows[0].2, want.auth_kind, "{scenario}: account auth kind");
}

async fn check_calendars(pool: &SqlitePool, want: &[CalendarExpect], scenario: &str) {
    for cal in want {
        let row = sqlx::query(
            "SELECT c.display_name, c.color, c.enabled, f.name AS folder_name,
                    f.color AS folder_color, f.is_external_calendar
             FROM sync_calendar c JOIN folders f ON f.id = c.folder_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.get::<String, _>("display_name").contains(&cal.name))
        .unwrap_or_else(|| panic!("{scenario}: no calendar named like {}", cal.name));

        assert_eq!(
            row.get::<Option<String>, _>("color"),
            Some(cal.color.clone()),
            "{scenario}: {} colour",
            cal.name
        );
        assert_eq!(
            row.get::<Option<String>, _>("folder_color"),
            Some(cal.color.clone()),
            "{scenario}: {} folder colour",
            cal.name
        );
        assert_eq!(
            row.get::<bool, _>("enabled"),
            cal.enabled,
            "{scenario}: {} enabled",
            cal.name
        );
        assert!(
            row.get::<String, _>("folder_name").contains(&cal.name),
            "{scenario}: {} folder name",
            cal.name
        );
        assert_eq!(
            row.get::<bool, _>("is_external_calendar"),
            cal.external_folder,
            "{scenario}: {} folder is a calendar folder",
            cal.name
        );
    }
}

async fn check_counts(pool: &SqlitePool, want: &Counts, scenario: &str) {
    let count = |sql: &'static str| async move {
        sqlx::query_scalar::<_, i64>(sql)
            .fetch_one(pool)
            .await
            .unwrap()
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM sync_account").await,
        want.accounts,
        "{scenario}: accounts"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM sync_calendar").await,
        want.calendars,
        "{scenario}: calendars"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM folders WHERE is_external_calendar = 1").await,
        want.calendar_folders,
        "{scenario}: calendar folders"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM page_sync").await,
        want.synced_pages,
        "{scenario}: synced pages"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM page_recurrence_rules").await,
        want.series,
        "{scenario}: series"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM page_schedules WHERE original_date IS NOT NULL").await,
        want.overrides,
        "{scenario}: provider-moved instances"
    );
}

async fn check_page_order(pool: &SqlitePool, want: &[OrderExpect], scenario: &str) {
    for calendar in want {
        let folder_id = calendar_folder(pool, &calendar.calendar).await;
        let titles: Vec<String> = sqlx::query_scalar(
            "SELECT p.title FROM pages p
             JOIN page_sync ps ON ps.page_id = p.id
             WHERE p.folder_id = ? ORDER BY p.sort_order",
        )
        .bind(&folder_id)
        .fetch_all(pool)
        .await
        .unwrap();
        assert_eq!(
            titles, calendar.titles,
            "{scenario}: {} contents, in order",
            calendar.calendar
        );
    }
}

async fn check_pages(pool: &SqlitePool, want: &[PageExpect], scenario: &str) {
    for page in want {
        // The one-off's own schedule row, not a series override (`rule_id IS NULL`).
        let row = sqlx::query(
            "SELECT p.scheduled_start, p.scheduled_end, p.content_text, p.folder_id,
                    s.timezone, ps.sync_state, ps.mirror_location, ps.mirror_attendees,
                    ps.pending_description, ps.user_modified
             FROM pages p
             JOIN page_sync ps ON ps.page_id = p.id
             LEFT JOIN page_schedules s ON s.page_id = p.id AND s.rule_id IS NULL
             WHERE p.title = ?",
        )
        .bind(&page.title)
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("{scenario}: the seed dropped {}", page.title));

        let at = &page.title;
        assert_eq!(
            row.get::<Option<String>, _>("folder_id"),
            Some(calendar_folder(pool, &page.calendar).await),
            "{scenario}: {at} is filed in {}",
            page.calendar
        );
        assert_eq!(
            row.get::<Option<String>, _>("scheduled_start"),
            Some(page.start.resolve()),
            "{scenario}: {at} start"
        );
        assert_eq!(
            row.get::<Option<String>, _>("scheduled_end"),
            page.end.as_ref().map(Instant::resolve),
            "{scenario}: {at} end"
        );
        assert_eq!(
            row.get::<Option<String>, _>("timezone"),
            page.zone,
            "{scenario}: {at} stored zone"
        );
        assert_eq!(
            row.get::<String, _>("sync_state"),
            page.sync_state,
            "{scenario}: {at} sync state"
        );
        assert_eq!(
            row.get::<Option<String>, _>("mirror_location"),
            page.location,
            "{scenario}: {at} mirror location"
        );
        let attendees: Vec<String> = row
            .get::<Option<String>, _>("mirror_attendees")
            .map(|json| serde_json::from_str(&json).expect("attendees JSON"))
            .unwrap_or_default();
        assert_eq!(
            attendees, page.attendees,
            "{scenario}: {at} mirror attendees"
        );
        assert_eq!(
            row.get::<Option<String>, _>("pending_description"),
            page.pending_description,
            "{scenario}: {at} withheld description"
        );
        assert_eq!(
            row.get::<Option<String>, _>("content_text")
                .unwrap_or_default(),
            page.body_text,
            "{scenario}: {at} indexed body text"
        );
        assert_eq!(
            row.get::<bool, _>("user_modified"),
            page.user_modified,
            "{scenario}: {at} ownership"
        );
    }
}

async fn check_series(pool: &SqlitePool, want: &[SeriesExpect], scenario: &str) {
    for series in want {
        let row = sqlx::query(
            "SELECT p.scheduled_start AS head_start, p.scheduled_end AS head_end, p.folder_id,
                    r.id AS rule_id, r.rrule, r.rrule_exdates, r.scheduled_start AS base_start,
                    r.scheduled_end AS base_end, r.timezone AS rule_zone,
                    ps.sync_state, ps.created_at
             FROM page_recurrence_rules r
             JOIN pages p ON p.id = r.page_id
             JOIN page_sync ps ON ps.page_id = r.page_id
             WHERE p.title = ?",
        )
        .bind(&series.title)
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("{scenario}: the seed dropped the {} series", series.title));

        let at = &series.title;
        assert_eq!(
            row.get::<Option<String>, _>("folder_id"),
            Some(calendar_folder(pool, &series.calendar).await),
            "{scenario}: {at} is filed in {}",
            series.calendar
        );
        assert_eq!(
            row.get::<String, _>("sync_state"),
            series.sync_state,
            "{scenario}: {at} sync state"
        );
        assert_eq!(
            row.get::<String, _>("rrule"),
            expected_rrule(series),
            "{scenario}: {at} rule"
        );
        assert_eq!(
            row.get::<String, _>("rule_zone"),
            expected_zone(&series.rule_zone),
            "{scenario}: {at} rule zone"
        );
        assert_eq!(
            row.get::<String, _>("base_start"),
            series.base.start.resolve(),
            "{scenario}: {at} base start"
        );
        assert_eq!(
            row.get::<Option<String>, _>("base_end"),
            series.base.end.as_ref().map(Instant::resolve),
            "{scenario}: {at} base end"
        );
        assert_eq!(
            row.get::<Option<String>, _>("head_start"),
            Some(series.head.start.resolve()),
            "{scenario}: {at} head start"
        );
        assert_eq!(
            row.get::<Option<String>, _>("head_end"),
            series.head.end.as_ref().map(Instant::resolve),
            "{scenario}: {at} head end"
        );

        let exdates: Vec<String> =
            serde_json::from_str(&row.get::<String, _>("rrule_exdates")).expect("exdates JSON");
        let want_exdates: Vec<String> = series.exdates.iter().map(Instant::resolve).collect();
        assert_eq!(
            exdates, want_exdates,
            "{scenario}: {at} cancelled occurrences"
        );

        let moved = sqlx::query(
            "SELECT scheduled_start, scheduled_end, original_date, timezone
             FROM page_schedules WHERE rule_id = ?",
        )
        .bind(row.get::<String, _>("rule_id"))
        .fetch_all(pool)
        .await
        .unwrap();
        match &series.moved {
            None => assert!(moved.is_empty(), "{scenario}: {at} has no moved instance"),
            Some(want_moved) => {
                assert_eq!(moved.len(), 1, "{scenario}: {at} moved instances");
                let override_row = &moved[0];
                assert_eq!(
                    override_row.get::<String, _>("scheduled_start"),
                    want_moved.start.resolve(),
                    "{scenario}: {at} moved to"
                );
                assert_eq!(
                    override_row.get::<Option<String>, _>("scheduled_end"),
                    Some(want_moved.end.resolve()),
                    "{scenario}: {at} moved end"
                );
                assert_eq!(
                    override_row.get::<Option<String>, _>("original_date"),
                    Some(want_moved.original.resolve()),
                    "{scenario}: {at} moved occurrence key"
                );
                assert_eq!(
                    override_row.get::<Option<String>, _>("timezone"),
                    want_moved.zone,
                    "{scenario}: {at} moved row zone"
                );
            }
        }

        let connected = pikos_db::sync::local_day_of(&row.get::<String, _>("created_at"))
            .expect("UTC-parseable connect day");
        assert_eq!(
            connected,
            day_offset(series.connected_day),
            "{scenario}: {at} connect day"
        );
    }
}

/// The rule the fixture describes: a bare `FREQ=…`, plus the provider `UNTIL` where
/// the shape is the point (a mid-day one is what locks the recurrence chip).
fn expected_rrule(series: &SeriesExpect) -> String {
    match (series.until_day, &series.until_time) {
        (Some(day), Some(time)) => {
            let until = (chrono::Local::now().date_naive() + Duration::days(day))
                .format("%Y%m%d")
                .to_string();
            format!("{};UNTIL={until}T{time}", series.rrule)
        }
        _ => series.rrule.clone(),
    }
}
