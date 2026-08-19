//! Tests for the `.ics` export.
//!
//! Two layers, deliberately. Most assertions read the emitted text directly,
//! because the classic iCalendar bugs — a comma that was never escaped, a fold
//! that landed mid-character, an all-day `DTEND` off by one day — are invisible
//! to a tolerant parser and only show up as text. The last group then runs the
//! whole file back through `calcard`, the same parser the CalDAV provider reads
//! real servers with, so nothing here can pass by asserting on a shape no
//! calendar client would accept.

use calcard::icalendar::{
    ICalendar, ICalendarComponent, ICalendarComponentType, ICalendarProperty, ICalendarValue,
};
use calcard::{Entry, Parser};
use pikos_db::{insert_test_page, insert_test_page_sync, now_iso, test_pool, TestPage};
use sqlx::SqlitePool;

use super::*;

const NY: &str = "America/New_York";

// ── Fixtures ─────────────────────────────────────────────────────────────────

async fn add_page(
    pool: &SqlitePool,
    id: &str,
    title: &str,
    start: Option<&str>,
    end: Option<&str>,
) {
    insert_test_page(
        pool,
        TestPage {
            scheduled_start: start,
            scheduled_end: end,
            ..TestPage::new(id, title)
        },
    )
    .await
    .unwrap();
}

async fn set_body(pool: &SqlitePool, id: &str, body: &str) {
    sqlx::query("UPDATE pages SET content_text = ? WHERE id = ?")
        .bind(body)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

/// A plain (non-override) schedule block — the row a one-off page's zone lives on.
async fn add_schedule(
    pool: &SqlitePool,
    id: &str,
    page_id: &str,
    start: &str,
    end: Option<&str>,
    timezone: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(start)
    .bind(end)
    .bind(timezone)
    .bind(now_iso())
    .execute(pool)
    .await
    .unwrap();
}

async fn add_rule(
    pool: &SqlitePool,
    id: &str,
    page_id: &str,
    rrule: &str,
    start: &str,
    end: Option<&str>,
    timezone: &str,
) {
    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone, created_at)
         VALUES (?, ?, ?, '[]', ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(rrule)
    .bind(start)
    .bind(end)
    .bind(timezone)
    .bind(now_iso())
    .execute(pool)
    .await
    .unwrap();
}

async fn set_rule_exdates(pool: &SqlitePool, rule_id: &str, exdates_json: &str) {
    sqlx::query("UPDATE page_recurrence_rules SET rrule_exdates = ? WHERE id = ?")
        .bind(exdates_json)
        .bind(rule_id)
        .execute(pool)
        .await
        .unwrap();
}

/// A materialized occurrence override: a schedule row pointing back at a rule.
async fn add_override(
    pool: &SqlitePool,
    ids: (&str, &str, &str),
    original_date: &str,
    start: &str,
    end: Option<&str>,
    timezone: Option<&str>,
) {
    let (id, page_id, rule_id) = ids;
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date,
          status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(start)
    .bind(end)
    .bind(timezone)
    .bind(rule_id)
    .bind(original_date)
    .bind(now_iso())
    .execute(pool)
    .await
    .unwrap();
}

// ── Reading the emitted text ─────────────────────────────────────────────────

/// Undo the 75-octet folding: a CRLF followed by one space is a continuation,
/// so the assertions below can name a whole property value.
fn unfold(ics: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in ics.split("\r\n") {
        match raw.strip_prefix(' ') {
            Some(rest) => lines
                .last_mut()
                .expect("continuation without a line")
                .push_str(rest),
            None => lines.push(raw.to_string()),
        }
    }
    lines.retain(|l| !l.is_empty());
    lines
}

/// The single VEVENT line starting with `prefix`, panicking if there is not
/// exactly one. Scoped to the events because a `VTIMEZONE`'s observances carry
/// `DTSTART` too, and matching those would make every assertion below ambiguous.
fn line(ics: &str, prefix: &str) -> String {
    let mut found = lines_with(ics, prefix);
    assert_eq!(found.len(), 1, "expected one {prefix} line in:\n{ics}");
    found.pop().unwrap()
}

fn lines_with(ics: &str, prefix: &str) -> Vec<String> {
    vevents(ics)
        .into_iter()
        .flatten()
        .filter(|l| l.starts_with(prefix))
        .collect()
}

/// The properties of one VEVENT, split off at its BEGIN/END markers.
fn vevents(ics: &str) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut current: Option<Vec<String>> = None;
    for l in unfold(ics) {
        if l == "BEGIN:VEVENT" {
            current = Some(Vec::new());
        } else if l == "END:VEVENT" {
            out.push(current.take().expect("END:VEVENT without BEGIN"));
        } else if let Some(cur) = current.as_mut() {
            cur.push(l);
        }
    }
    out
}

fn prop(event: &[String], prefix: &str) -> String {
    event
        .iter()
        .find(|l| l.starts_with(prefix))
        .unwrap_or_else(|| panic!("no {prefix} in {event:?}"))
        .clone()
}

// ── Envelope ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn wraps_the_events_in_one_vcalendar() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-15T09:00:00"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    let lines = unfold(&ics);

    assert_eq!(lines.first().unwrap(), "BEGIN:VCALENDAR");
    assert_eq!(lines.last().unwrap(), "END:VCALENDAR");
    assert!(ics.contains("VERSION:2.0\r\n"));
    assert!(lines
        .iter()
        .any(|l| l.starts_with("PRODID:-//Pikos//Pikos ")));
    assert_eq!(ics.matches("BEGIN:VCALENDAR").count(), 1);
    assert!(line(&ics, "UID:").ends_with("@pikos"));
    assert!(line(&ics, "DTSTAMP:").ends_with('Z'));
}

/// RFC 5545 §3.1: every content line ends CRLF. A bare LF is the single most
/// common way a hand-rolled writer produces a file some clients silently reject.
#[tokio::test]
async fn every_line_ends_with_crlf() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-15T09:00:00"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert!(ics.ends_with("\r\n"));
    assert_eq!(
        ics.matches('\n').count(),
        ics.matches("\r\n").count(),
        "a bare LF escaped into the output"
    );
}

#[tokio::test]
async fn leaves_unscheduled_pages_out() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Someday", None, None).await;
    add_page(&pool, "p2", "Scheduled", Some("2026-06-15"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(vevents(&ics).len(), 1);
    assert!(ics.contains("SUMMARY:Scheduled"));
    assert!(!ics.contains("Someday"));
}

/// The same predicate the Markdown and CSV exports share: a mirror the user
/// never actioned is the calendar's own copy, and shipping it back out would
/// duplicate the event on re-import.
#[tokio::test]
async fn leaves_un_actioned_mirrors_out_unless_asked() {
    let pool = test_pool().await;
    add_page(
        &pool,
        "mirror",
        "Standup",
        Some("2026-06-15T09:00:00"),
        None,
    )
    .await;
    insert_test_page_sync(&pool, "mirror", "active")
        .await
        .unwrap();

    let default = build_export_ics_impl(&pool, false).await.unwrap();
    assert!(vevents(&default).is_empty());

    let with_synced = build_export_ics_impl(&pool, true).await.unwrap();
    assert_eq!(vevents(&with_synced).len(), 1);
    assert!(with_synced.contains("SUMMARY:Standup"));
}

#[tokio::test]
async fn leaves_soft_deleted_pages_out() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Gone", Some("2026-06-15"), None).await;
    sqlx::query("UPDATE pages SET deleted_at = ? WHERE id = 'p1'")
        .bind(now_iso())
        .execute(&pool)
        .await
        .unwrap();

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert!(vevents(&ics).is_empty());
}

// ── All-day: the exclusive-end convention ────────────────────────────────────

/// Pikos stores the **inclusive** last covered day (the reconciler decrements a
/// provider's exclusive `DTEND` on the way in); RFC 5545 wants it back
/// exclusive. A single-day event is the case that catches a missing conversion.
#[tokio::test]
async fn all_day_end_goes_back_out_exclusive() {
    let pool = test_pool().await;
    add_page(
        &pool,
        "p1",
        "Offsite",
        Some("2026-06-15"),
        Some("2026-06-17"),
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(line(&ics, "DTSTART"), "DTSTART;VALUE=DATE:20260615");
    // Jun 15–17 inclusive → the day after the last covered one.
    assert_eq!(line(&ics, "DTEND"), "DTEND;VALUE=DATE:20260618");
}

#[tokio::test]
async fn an_all_day_page_with_no_end_covers_one_day() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Holiday", Some("2026-06-15"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(line(&ics, "DTSTART"), "DTSTART;VALUE=DATE:20260615");
    assert_eq!(line(&ics, "DTEND"), "DTEND;VALUE=DATE:20260616");
}

/// A stored end before its start would otherwise emit `DTEND <= DTSTART`, which
/// makes the event cover no day at all.
#[tokio::test]
async fn an_all_day_end_before_its_start_still_covers_a_day() {
    let pool = test_pool().await;
    add_page(
        &pool,
        "p1",
        "Muddled",
        Some("2026-06-15"),
        Some("2026-06-10"),
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert_eq!(line(&ics, "DTEND"), "DTEND;VALUE=DATE:20260616");
}

#[tokio::test]
async fn an_all_day_export_names_no_timezone() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Holiday", Some("2026-06-15"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert!(!ics.contains("BEGIN:VTIMEZONE"));
    assert!(!ics.contains("TZID"));
}

// ── Timed: TZID + VTIMEZONE ──────────────────────────────────────────────────

#[tokio::test]
async fn a_timed_page_carries_its_own_zone() {
    let pool = test_pool().await;
    add_page(
        &pool,
        "p1",
        "1:1",
        Some("2026-06-15T09:00:00"),
        Some("2026-06-15T09:30:00"),
    )
    .await;
    add_schedule(
        &pool,
        "s1",
        "p1",
        "2026-06-15T09:00:00",
        Some("2026-06-15T09:30:00"),
        Some(NY),
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(
        line(&ics, "DTSTART"),
        format!("DTSTART;TZID={NY}:20260615T090000")
    );
    assert_eq!(
        line(&ics, "DTEND"),
        format!("DTEND;TZID={NY}:20260615T093000")
    );
    assert!(ics.contains(&format!("TZID:{NY}\r\n")));
}

/// The generated `VTIMEZONE` is the price of the TZID spelling, so its numbers
/// are pinned: New York is UTC-5 in winter, UTC-4 in summer, and RFC 5545 wants
/// each observance's `DTSTART` in the *outgoing* offset's local time — 2am for
/// the spring step, 2am (EDT) for the autumn one.
#[tokio::test]
async fn the_generated_vtimezone_states_real_offsets() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "1:1", Some("2026-06-15T09:00:00"), None).await;
    add_schedule(&pool, "s1", "p1", "2026-06-15T09:00:00", None, Some(NY)).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert!(ics.contains("BEGIN:VTIMEZONE"));
    assert!(ics.contains("END:VTIMEZONE"));
    // 2026: forward on Mar 8, back on Nov 1.
    assert!(
        ics.contains("BEGIN:DAYLIGHT\r\nDTSTART:20260308T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT"),
        "{ics}"
    );
    assert!(
        ics.contains("BEGIN:STANDARD\r\nDTSTART:20261101T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD"),
        "{ics}"
    );
    // An anchoring observance opens the window before the event, so nothing the
    // export covers is left without an offset. Its DTSTART is the window's start
    // instant in local time, which for UTC-5 is the previous evening.
    assert!(
        ics.contains(
            "BEGIN:STANDARD\r\nDTSTART:20251231T190000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0500"
        ),
        "{ics}"
    );
}

/// A zone with no transitions at all still needs one observance, or a consumer
/// has no offset to resolve the event's TZID against.
#[tokio::test]
async fn a_zone_without_dst_gets_a_single_observance() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Call", Some("2026-06-15T09:00:00"), None).await;
    add_schedule(
        &pool,
        "s1",
        "p1",
        "2026-06-15T09:00:00",
        None,
        Some("Asia/Kolkata"),
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(ics.matches("BEGIN:STANDARD").count(), 1);
    assert_eq!(ics.matches("BEGIN:DAYLIGHT").count(), 0);
    assert!(ics.contains("TZOFFSETTO:+0530"));
}

/// One VTIMEZONE per zone, however many events name it — a repeated component
/// is both wasteful and ambiguous.
#[tokio::test]
async fn each_zone_is_declared_once() {
    let pool = test_pool().await;
    for (id, sid) in [("p1", "s1"), ("p2", "s2")] {
        add_page(&pool, id, "Sync", Some("2026-06-15T09:00:00"), None).await;
        add_schedule(&pool, sid, id, "2026-06-15T09:00:00", None, Some(NY)).await;
    }
    add_page(&pool, "p3", "London", Some("2026-06-15T14:00:00"), None).await;
    add_schedule(
        &pool,
        "s3",
        "p3",
        "2026-06-15T14:00:00",
        None,
        Some("Europe/London"),
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(ics.matches("BEGIN:VTIMEZONE").count(), 2);
    assert_eq!(ics.matches(&format!("TZID:{NY}\r\n")).count(), 1);
    assert_eq!(ics.matches("TZID:Europe/London\r\n").count(), 1);
}

// ── Recurrence ───────────────────────────────────────────────────────────────

/// The rule row's base occurrence, never the page's denormalized
/// `scheduled_start` — that column holds the *next* occurrence, so anchoring
/// there would silently drop every occurrence already behind the head.
#[tokio::test]
async fn a_series_anchors_on_the_rule_not_the_denormalized_head() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-08-10T09:00:00"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-06-01T09:00:00",
        Some("2026-06-01T09:15:00"),
        NY,
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(
        line(&ics, "DTSTART"),
        format!("DTSTART;TZID={NY}:20260601T090000")
    );
    assert_eq!(line(&ics, "RRULE:"), "RRULE:FREQ=WEEKLY;BYDAY=MO");
}

/// Semicolons and commas inside an RRULE are structural, not text — escaping
/// them would corrupt the rule.
#[tokio::test]
async fn an_rrule_goes_out_unescaped() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-01"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2",
        "2026-06-01",
        None,
        NY,
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert_eq!(
        line(&ics, "RRULE:"),
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2"
    );
}

/// RFC 5545 §3.3.10: `UNTIL` must be UTC when `DTSTART` carries a TZID. Pikos
/// stores it as event-zone wall clock, so it converts on the way out — 23:59:59
/// on Jul 1 in New York (EDT, UTC-4) is 03:59:59Z on Jul 2.
#[tokio::test]
async fn a_timed_until_leaves_as_utc() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-01T09:00:00"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=DAILY;UNTIL=20260701T235959",
        "2026-06-01T09:00:00",
        None,
        NY,
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert_eq!(
        line(&ics, "RRULE:"),
        "RRULE:FREQ=DAILY;UNTIL=20260702T035959Z"
    );
}

/// The same rule requires `UNTIL` to match `DTSTART`'s *value type*, so an
/// all-day series drops the time rather than claiming a date-time bound.
#[tokio::test]
async fn an_all_day_until_stays_a_date() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Chore", Some("2026-06-01"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=DAILY;UNTIL=20260701T235959",
        "2026-06-01",
        None,
        NY,
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert_eq!(line(&ics, "RRULE:"), "RRULE:FREQ=DAILY;UNTIL=20260701");
}

#[tokio::test]
async fn an_untouched_until_in_utc_is_left_alone() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-01T09:00:00"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=DAILY;UNTIL=20260701T035959Z",
        "2026-06-01T09:00:00",
        None,
        NY,
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert_eq!(
        line(&ics, "RRULE:"),
        "RRULE:FREQ=DAILY;UNTIL=20260701T035959Z"
    );
}

/// Skipped and completed occurrences are holes in the series: the skip dismissed
/// it, and a completion moves the occurrence onto its own done clone page, which
/// exports as its own VEVENT. Both must be excluded or the day shows twice.
#[tokio::test]
async fn skips_and_completions_become_exdates() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Chore", Some("2026-06-01"), None).await;
    add_rule(&pool, "r1", "p1", "FREQ=DAILY", "2026-06-01", None, NY).await;
    set_rule_exdates(&pool, "r1", r#"["2026-06-02"]"#).await;
    sqlx::query("INSERT INTO skip_set (page_id, occurrence_date) VALUES ('p1', '2026-06-03')")
        .execute(&pool)
        .await
        .unwrap();
    add_page(&pool, "clone", "Chore", Some("2026-06-04"), None).await;
    sqlx::query(
        "INSERT INTO completed_set (page_id, occurrence_date, clone_id)
         VALUES ('p1', '2026-06-04', 'clone')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    let series = &vevents(&ics)[0];

    assert_eq!(
        prop(series, "EXDATE"),
        "EXDATE;VALUE=DATE:20260602,20260603,20260604"
    );
}

/// An exdate stored as a bare day on a timed series has to be re-expressed as a
/// date-time, or the value type fights `DTSTART` and the exclusion is ignored.
#[tokio::test]
async fn a_timed_series_exdate_takes_the_series_time_of_day() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-01T09:00:00"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=DAILY",
        "2026-06-01T09:00:00",
        None,
        NY,
    )
    .await;
    set_rule_exdates(&pool, "r1", r#"["2026-06-02","2026-06-05T09:00:00"]"#).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(
        line(&ics, "EXDATE"),
        format!("EXDATE;TZID={NY}:20260602T090000,20260605T090000")
    );
}

/// A moved occurrence is a second VEVENT under the same UID, keyed by the rrule
/// date it replaces. It must NOT also be excluded — an EXDATE would delete the
/// very instance the override exists to redefine.
#[tokio::test]
async fn a_moved_occurrence_becomes_a_recurrence_id_event() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-01T09:00:00"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=DAILY",
        "2026-06-01T09:00:00",
        Some("2026-06-01T09:15:00"),
        NY,
    )
    .await;
    add_override(
        &pool,
        ("s1", "p1", "r1"),
        "2026-06-03T09:00:00",
        "2026-06-03T14:00:00",
        Some("2026-06-03T14:30:00"),
        Some(NY),
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    let events = vevents(&ics);

    assert_eq!(events.len(), 2);
    assert_eq!(prop(&events[0], "UID:"), prop(&events[1], "UID:"));
    assert!(events[0].iter().any(|l| l.starts_with("RRULE:")));
    assert!(!events[0].iter().any(|l| l.starts_with("EXDATE")));

    assert_eq!(
        prop(&events[1], "RECURRENCE-ID"),
        format!("RECURRENCE-ID;TZID={NY}:20260603T090000")
    );
    assert_eq!(
        prop(&events[1], "DTSTART"),
        format!("DTSTART;TZID={NY}:20260603T140000")
    );
    assert!(!events[1].iter().any(|l| l.starts_with("RRULE:")));
}

/// `RECURRENCE-ID` names an occurrence of the *master* rule, so it stays in the
/// series' frame even when the moved instance lands in another zone — which it
/// routinely does, since the reschedule writer clears the row's zone to mean
/// "the user just asserted a device-local time". Read it in the moved instance's
/// zone instead and the override attaches to the wrong occurrence, or to none.
#[tokio::test]
async fn a_moved_occurrence_keys_itself_in_the_series_zone() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Standup", Some("2026-06-01T09:00:00"), None).await;
    add_rule(
        &pool,
        "r1",
        "p1",
        "FREQ=DAILY",
        "2026-06-01T09:00:00",
        None,
        NY,
    )
    .await;
    add_override(
        &pool,
        ("s1", "p1", "r1"),
        "2026-06-03",
        "2026-06-03T14:00:00",
        None,
        Some("Europe/Paris"),
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    let moved = &vevents(&ics)[1];

    assert_eq!(
        prop(moved, "RECURRENCE-ID"),
        format!("RECURRENCE-ID;TZID={NY}:20260603T090000")
    );
    assert_eq!(
        prop(moved, "DTSTART"),
        "DTSTART;TZID=Europe/Paris:20260603T140000"
    );
    // Both zones have to be declared, or one of the two TZIDs resolves to nothing.
    assert_eq!(ics.matches("BEGIN:VTIMEZONE").count(), 2);
}

/// A schedule row with no zone is device-local by construction, and a zone
/// chrono-tz cannot resolve must not reach the output — a `TZID` no `VTIMEZONE`
/// declares is worse than a wrong-but-declared one.
#[test]
fn falls_back_through_the_device_zone_to_utc() {
    assert_eq!(resolve_zone(Some(NY), "Europe/Paris"), NY);
    assert_eq!(resolve_zone(None, "Europe/Paris"), "Europe/Paris");
    assert_eq!(resolve_zone(Some(""), "Europe/Paris"), "Europe/Paris");
    assert_eq!(
        resolve_zone(Some("Mars/Olympus"), "Europe/Paris"),
        "Europe/Paris"
    );
    assert_eq!(resolve_zone(Some("Mars/Olympus"), "Mars/Base"), "UTC");
}

/// A `skipped` override row has no instance to redefine, so it excludes rather
/// than replacing — the opposite branch of the rule above.
#[tokio::test]
async fn a_skipped_override_row_excludes_instead_of_replacing() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Chore", Some("2026-06-01"), None).await;
    add_rule(&pool, "r1", "p1", "FREQ=DAILY", "2026-06-01", None, NY).await;
    add_override(
        &pool,
        ("s1", "p1", "r1"),
        "2026-06-03",
        "2026-06-03",
        None,
        None,
    )
    .await;
    sqlx::query("UPDATE page_schedules SET status = 'skipped' WHERE id = 's1'")
        .execute(&pool)
        .await
        .unwrap();

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(vevents(&ics).len(), 1);
    assert_eq!(line(&ics, "EXDATE"), "EXDATE;VALUE=DATE:20260603");
}

// ── Escaping and folding ─────────────────────────────────────────────────────

#[test]
fn escapes_the_four_text_specials() {
    assert_eq!(escape_text("a,b"), "a\\,b");
    assert_eq!(escape_text("a;b"), "a\\;b");
    assert_eq!(escape_text("a\\b"), "a\\\\b");
    assert_eq!(escape_text("a\nb"), "a\\nb");
    // A CRLF is one line break, not a stray carriage return plus one.
    assert_eq!(escape_text("a\r\nb"), "a\\nb");
    // A colon is only special in the name/value split, which already happened.
    assert_eq!(escape_text("9:00"), "9:00");
    // The backslash must be doubled *before* the others, or `\,` re-escapes.
    assert_eq!(escape_text("a\\,b"), "a\\\\\\,b");
}

#[tokio::test]
async fn escapes_a_title_and_body_on_the_way_out() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Lunch, then; review", Some("2026-06-15"), None).await;
    set_body(&pool, "p1", "path C:\\tmp\nsecond line").await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert_eq!(line(&ics, "SUMMARY:"), "SUMMARY:Lunch\\, then\\; review");
    assert_eq!(
        line(&ics, "DESCRIPTION:"),
        "DESCRIPTION:path C:\\\\tmp\\nsecond line"
    );
    // The escaped newline stays inside the one folded property.
    assert_eq!(vevents(&ics).len(), 1);
}

#[test]
fn folds_at_seventy_five_octets_with_a_leading_space() {
    let mut out = String::new();
    let long = format!("SUMMARY:{}", "x".repeat(200));
    push_folded(&mut out, &long);

    let raw: Vec<&str> = out.trim_end_matches("\r\n").split("\r\n").collect();
    assert!(raw.len() > 1, "a 208-octet line must fold");
    assert_eq!(raw[0].len(), 75);
    for cont in &raw[1..] {
        assert!(cont.starts_with(' '), "continuation must open with a space");
        assert!(cont.len() <= 75, "continuation is {} octets", cont.len());
    }
    // Unfolding is lossless.
    assert_eq!(unfold(&out), vec![long]);
}

/// Octets, not characters — but never mid-character, or the consumer gets two
/// invalid byte fragments where one emoji used to be.
#[test]
fn never_folds_inside_a_multibyte_character() {
    let mut out = String::new();
    let long = format!("DESCRIPTION:{}", "é".repeat(120));
    push_folded(&mut out, &long);

    for raw in out.trim_end_matches("\r\n").split("\r\n") {
        assert!(raw.len() <= 75, "{} octets", raw.len());
        assert!(std::str::from_utf8(raw.as_bytes()).is_ok());
    }
    assert_eq!(unfold(&out), vec![long]);
}

#[tokio::test]
async fn folds_a_long_summary_in_the_real_output() {
    let pool = test_pool().await;
    let title = "Quarterly planning review with the whole distributed team and guests";
    add_page(&pool, "p1", title, Some("2026-06-15"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();

    assert!(ics.contains("\r\n "), "nothing folded in:\n{ics}");
    for raw in ics.trim_end_matches("\r\n").split("\r\n") {
        assert!(raw.len() <= 75, "unfolded {} octets: {raw}", raw.len());
    }
    assert_eq!(line(&ics, "SUMMARY:"), format!("SUMMARY:{title}"));
}

#[tokio::test]
async fn clips_an_enormous_body() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Doc", Some("2026-06-15"), None).await;
    set_body(&pool, "p1", &"a".repeat(MAX_DESCRIPTION_CHARS * 3)).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    let description = line(&ics, "DESCRIPTION:");

    assert_eq!(
        description.chars().count(),
        "DESCRIPTION:".len() + MAX_DESCRIPTION_CHARS + 1
    );
    assert!(description.ends_with('…'));
}

#[tokio::test]
async fn leaves_description_out_when_the_page_has_no_body() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "Bare", Some("2026-06-15"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert!(lines_with(&ics, "DESCRIPTION").is_empty());
}

#[tokio::test]
async fn an_untitled_page_still_gets_a_summary() {
    let pool = test_pool().await;
    add_page(&pool, "p1", "", Some("2026-06-15"), None).await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    assert_eq!(line(&ics, "SUMMARY:"), "SUMMARY:Untitled");
}

#[test]
fn renders_utc_offsets_the_way_the_rfc_spells_them() {
    assert_eq!(utc_offset(0), "+0000");
    assert_eq!(utc_offset(-5 * 3600), "-0500");
    assert_eq!(utc_offset(5 * 3600 + 30 * 60), "+0530");
    // Sub-minute offsets exist in tzdb's pre-standardization era.
    assert_eq!(utc_offset(-(4 * 3600 + 30 * 60 + 30)), "-043030");
}

// ── Round trip through the CalDAV provider's own parser ──────────────────────

fn parse_ics(ics: &str) -> ICalendar {
    let mut parser = Parser::new(ics);
    loop {
        match parser.entry() {
            Entry::ICalendar(cal) => return cal,
            Entry::Eof => panic!("no VCALENDAR parsed out of:\n{ics}"),
            _ => {}
        }
    }
}

/// The whole point of the format: a real iCalendar parser reads back the events
/// this export wrote, with their instants, their day, and their rule intact.
#[tokio::test]
async fn calcard_reads_the_export_back() {
    let pool = test_pool().await;
    add_page(
        &pool,
        "holiday",
        "Offsite",
        Some("2026-06-15"),
        Some("2026-06-17"),
    )
    .await;
    add_page(
        &pool,
        "one_to_one",
        "1:1, with Sam",
        Some("2026-06-15T09:00:00"),
        Some("2026-06-15T09:30:00"),
    )
    .await;
    add_schedule(
        &pool,
        "s1",
        "one_to_one",
        "2026-06-15T09:00:00",
        Some("2026-06-15T09:30:00"),
        Some(NY),
    )
    .await;
    add_page(
        &pool,
        "standup",
        "Standup",
        Some("2026-06-01T09:00:00"),
        None,
    )
    .await;
    add_rule(
        &pool,
        "r1",
        "standup",
        "FREQ=WEEKLY;BYDAY=MO,WE",
        "2026-06-01T09:00:00",
        None,
        NY,
    )
    .await;

    let ics = build_export_ics_impl(&pool, false).await.unwrap();
    let cal = parse_ics(&ics);

    let events: Vec<&ICalendarComponent> = cal
        .components
        .iter()
        .filter(|c| c.component_type == ICalendarComponentType::VEvent)
        .collect();
    assert_eq!(events.len(), 3);

    let by_uid = |uid: &str| -> &ICalendarComponent {
        events
            .iter()
            .copied()
            .find(|c| c.uid() == Some(uid))
            .unwrap_or_else(|| panic!("no VEVENT for {uid}"))
    };

    // All-day: a DATE value, and the exclusive end the RFC expects.
    let holiday = by_uid("holiday@pikos");
    let start = holiday
        .property(&ICalendarProperty::Dtstart)
        .and_then(|e| e.values.first())
        .and_then(|v| v.as_partial_date_time())
        .unwrap();
    assert!(!start.has_time());
    assert_eq!(
        (start.year, start.month, start.day),
        (Some(2026), Some(6), Some(15))
    );
    let end = holiday
        .property(&ICalendarProperty::Dtend)
        .and_then(|e| e.values.first())
        .and_then(|v| v.as_partial_date_time())
        .unwrap();
    assert_eq!(
        (end.year, end.month, end.day),
        (Some(2026), Some(6), Some(18))
    );

    // Timed: the wall clock and its zone both survive, comma in the title too.
    let one_to_one = by_uid("one_to_one@pikos");
    let dtstart = one_to_one.property(&ICalendarProperty::Dtstart).unwrap();
    assert_eq!(dtstart.tz_id(), Some(NY));
    let start = dtstart
        .values
        .first()
        .and_then(|v| v.as_partial_date_time())
        .unwrap();
    assert!(start.has_time());
    assert_eq!((start.hour, start.minute), (Some(9), Some(0)));
    assert_eq!(
        one_to_one
            .property(&ICalendarProperty::Summary)
            .and_then(|e| e.values.first()),
        Some(&ICalendarValue::Text("1:1, with Sam".to_string()))
    );

    // The rule survives as a rule, not as escaped text.
    let standup = by_uid("standup@pikos");
    match standup
        .property(&ICalendarProperty::Rrule)
        .and_then(|e| e.values.first())
    {
        Some(ICalendarValue::RecurrenceRule(rule)) => {
            assert_eq!(rule.to_string(), "FREQ=WEEKLY;BYDAY=MO,WE");
        }
        other => panic!("RRULE did not parse as a rule: {other:?}"),
    }

    // And the zone the TZIDs point at is declared in the same calendar, which is
    // what makes those TZIDs resolvable at all.
    let resolver = cal.build_tz_resolver();
    assert_eq!(
        resolver.resolve(NY).and_then(|tz| tz.name()).as_deref(),
        Some(NY)
    );
}
