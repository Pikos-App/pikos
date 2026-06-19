//! Layer-1 ICS-mapping unit tests for shapes a recorded server fixture can't
//! pin: a non-IANA `TZID` resolved through a `VTIMEZONE`, a floating event, a
//! `DURATION`-instead-of-`DTEND` event, an all-day recurring series, and a
//! malformed body. These are hand-authored on purpose — radicale normalizes or
//! rejects them on PUT, so the only faithful way to feed an exact wire shape to
//! the parser is to write it here (the calcard spike took the same tack).

use super::parse_resource;

fn ics(body: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Pikos//Test//EN\r\n{body}END:VCALENDAR\r\n")
}

// ─── TZID → IANA via VTIMEZONE ──────────────────────────────────────────────────

/// An Outlook-style non-IANA `TZID` ("Eastern Standard Time") is resolved to its
/// IANA id through the `VTIMEZONE`'s `X-LIC-LOCATION` — the resolution the spec's
/// "TZID→IANA" assert calls for, which a same-name IANA TZID wouldn't exercise.
#[test]
fn non_iana_tzid_resolves_through_vtimezone() {
    let body = "BEGIN:VTIMEZONE\r\n\
TZID:Eastern Standard Time\r\n\
X-LIC-LOCATION:America/New_York\r\n\
BEGIN:STANDARD\r\n\
DTSTART:16011104T020000\r\n\
TZOFFSETFROM:-0400\r\n\
TZOFFSETTO:-0500\r\n\
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\n\
END:STANDARD\r\n\
BEGIN:DAYLIGHT\r\n\
DTSTART:16010311T020000\r\n\
TZOFFSETFROM:-0500\r\n\
TZOFFSETTO:-0400\r\n\
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\n\
END:DAYLIGHT\r\n\
END:VTIMEZONE\r\n\
BEGIN:VEVENT\r\n\
UID:outlook-1\r\n\
DTSTART;TZID=Eastern Standard Time:20260615T090000\r\n\
DTEND;TZID=Eastern Standard Time:20260615T100000\r\n\
SUMMARY:Outlook meeting\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/o.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.schedule.start, "2026-06-15T09:00:00");
    assert_eq!(
        ev.schedule.timezone.as_deref(),
        Some("America/New_York"),
        "the Windows TZID maps to its IANA id, not the raw label"
    );
}

// ─── floating event ─────────────────────────────────────────────────────────────

/// A DTSTART with neither `TZID` nor `Z` is floating — no zone is invented (the
/// reconciler stamps its sentinel). Instants stay literal wall-clock.
#[test]
fn floating_event_has_no_zone() {
    let body = "BEGIN:VEVENT\r\n\
UID:floating-1\r\n\
DTSTART:20260615T090000\r\n\
DTEND:20260615T100000\r\n\
SUMMARY:Floating\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/f.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.schedule.start, "2026-06-15T09:00:00");
    assert_eq!(ev.schedule.timezone, None, "floating stays zoneless");
}

// ─── UTC DTSTART ────────────────────────────────────────────────────────────────

#[test]
fn utc_dtstart_resolves_to_utc_zone() {
    let body = "BEGIN:VEVENT\r\n\
UID:utc-1\r\n\
DTSTART:20260615T090000Z\r\n\
DTEND:20260615T100000Z\r\n\
SUMMARY:UTC call\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/u.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.schedule.start, "2026-06-15T09:00:00");
    assert_eq!(ev.schedule.timezone.as_deref(), Some("UTC"));
}

// ─── DURATION instead of DTEND ──────────────────────────────────────────────────

#[test]
fn timed_duration_derives_the_end() {
    let body = "BEGIN:VEVENT\r\n\
UID:dur-1\r\n\
DTSTART;TZID=America/New_York:20260615T090000\r\n\
DURATION:PT1H30M\r\n\
SUMMARY:Duration call\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/d.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(
        ev.schedule.end.as_deref(),
        Some("2026-06-15T10:30:00"),
        "DTSTART + PT1H30M, not a zero-length event"
    );
}

#[test]
fn all_day_duration_yields_raw_exclusive_end() {
    let body = "BEGIN:VEVENT\r\n\
UID:dur-allday\r\n\
DTSTART;VALUE=DATE:20260615\r\n\
DURATION:P3D\r\n\
SUMMARY:Three-day span\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/da.ics", Some("v1"), &ics(body)).unwrap();
    // P3D on Jun 15 → exclusive Jun 18 (the reconciler decrements to inclusive 17).
    assert_eq!(ev.schedule.start, "2026-06-15");
    assert_eq!(ev.schedule.end.as_deref(), Some("2026-06-18"));
    assert_eq!(ev.schedule.timezone, None);
}

// ─── all-day recurring series ───────────────────────────────────────────────────

#[test]
fn all_day_recurring_series_carries_no_zone() {
    let body = "BEGIN:VEVENT\r\n\
UID:holiday-series\r\n\
DTSTART;VALUE=DATE:20260101\r\n\
DTEND;VALUE=DATE:20260102\r\n\
RRULE:FREQ=YEARLY\r\n\
SUMMARY:New Year's Day\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/h.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.schedule.start, "2026-01-01");
    assert_eq!(ev.schedule.timezone, None, "all-day recurrence has no meaningful zone");
    let rec = ev.recurrence.as_ref().expect("recurring");
    assert!(rec.rrule.contains("FREQ=YEARLY"));
    assert!(rec.exdates.is_empty());
    assert!(rec.overrides.is_empty());
}

// ─── RECURRENCE-ID in UTC ───────────────────────────────────────────────────────

/// A `RECURRENCE-ID` carried in UTC against a zoned series must normalize to the
/// series' source-zone wall-clock, or the override's `original_date` wouldn't
/// string-match the expansion and would double-render.
#[test]
fn utc_recurrence_id_normalizes_to_source_zone() {
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:s\r\n\
RECURRENCE-ID:20260608T130000Z\r\n\
DTSTART;TZID=America/New_York:20260608T110000\r\n\
DTEND;TZID=America/New_York:20260608T113000\r\n\
SUMMARY:Standup (moved)\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/s.ics", Some("v1"), &ics(body)).unwrap();
    let ov = &ev.recurrence.as_ref().unwrap().overrides[0];
    // 13:00Z on Jun 8 (EDT, UTC-4) → 09:00 wall-clock, matching the series basis.
    assert_eq!(ov.original_date, "2026-06-08T09:00:00");
}

// ─── malformed / non-VEVENT ─────────────────────────────────────────────────────

#[test]
fn resource_without_vevent_errs() {
    // A VTODO-only resource carries no event — parse_resource errs so the caller
    // skips it rather than synthesizing an empty page.
    let body = "BEGIN:VTODO\r\nUID:task-1\r\nSUMMARY:Buy milk\r\nEND:VTODO\r\n";
    assert!(parse_resource("/t.ics", Some("v1"), &ics(body)).is_err());
}

#[test]
fn empty_body_errs() {
    assert!(parse_resource("/e.ics", Some("v1"), "not a calendar at all").is_err());
}
