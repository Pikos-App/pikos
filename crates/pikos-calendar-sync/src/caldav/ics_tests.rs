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

// ─── malformed override doesn't sink the series ─────────────────────────────────

/// A non-cancelled override VEVENT missing `DTSTART` must drop only that instance,
/// not the whole resource. Regression for the `?`-propagation in `build_recurrence`
/// that returned Err for the entire series (master + all valid overrides lost).
#[test]
fn override_missing_dtstart_skips_the_instance_not_the_series() {
    let body = "BEGIN:VEVENT\r\n\
UID:series-1\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:series-1\r\n\
RECURRENCE-ID;TZID=America/New_York:20260608T090000\r\n\
SUMMARY:Standup (no start)\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:series-1\r\n\
RECURRENCE-ID;TZID=America/New_York:20260615T090000\r\n\
DTSTART;TZID=America/New_York:20260615T110000\r\n\
DTEND;TZID=America/New_York:20260615T113000\r\n\
SUMMARY:Standup (moved)\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/s.ics", Some("v1"), &ics(body)).unwrap();
    let rec = ev.recurrence.as_ref().expect("recurring");
    // The master + the well-formed override survive; the DTSTART-less one is dropped.
    assert_eq!(rec.overrides.len(), 1, "only the valid override is kept");
    assert_eq!(rec.overrides[0].schedule.start, "2026-06-15T11:00:00");
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

/// A `RECURRENCE-ID` carried as a NUMERIC UTC offset (`+0530`/`-0800`, iCloud /
/// Fastmail exports) must resolve with the correct sign and normalize to the
/// series' source-zone wall-clock — `convert_to_zone`'s offset arithmetic is
/// otherwise only exercised via `Z` (offset 0) and named TZIDs.
#[test]
fn numeric_utc_offset_recurrence_id_normalizes_to_source_zone() {
    // Both overrides resolve to 13:00Z = 09:00 EDT (the series basis): +0530 from
    // 18:30 local, -0800 from 05:00 local. A sign flip would shift either off-day.
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:s\r\n\
RECURRENCE-ID:20260608T183000+0530\r\n\
DTSTART;TZID=America/New_York:20260608T110000\r\n\
DTEND;TZID=America/New_York:20260608T113000\r\n\
SUMMARY:moved (+0530)\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:s\r\n\
RECURRENCE-ID:20260615T050000-0800\r\n\
DTSTART;TZID=America/New_York:20260615T110000\r\n\
DTEND;TZID=America/New_York:20260615T113000\r\n\
SUMMARY:moved (-0800)\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/n.ics", Some("v1"), &ics(body)).unwrap();
    let mut dates: Vec<&str> = ev
        .recurrence
        .as_ref()
        .unwrap()
        .overrides
        .iter()
        .map(|o| o.original_date.as_str())
        .collect();
    dates.sort_unstable();
    assert_eq!(dates, vec!["2026-06-08T09:00:00", "2026-06-15T09:00:00"]);
}

// ─── cross-zone degradation (pins the current silent fallbacks) ─────────────────

/// A non-IANA `TZID` with no `VTIMEZONE` to resolve it is genuinely unresolvable,
/// so `source_zone` yields nothing and the event degrades to a zoneless, literal
/// wall-clock. Acceptable fallback — a cross-zone viewer sees the time unshifted
/// with no badge — but `source_zone` now logs a warning so it isn't traceless.
#[test]
fn unresolvable_tzid_without_vtimezone_degrades_to_zoneless() {
    let body = "BEGIN:VEVENT\r\n\
UID:bad-tz\r\n\
DTSTART;TZID=Middle-earth/Shire:20260615T090000\r\n\
DTEND;TZID=Middle-earth/Shire:20260615T100000\r\n\
SUMMARY:Unresolvable zone\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/bad.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.schedule.start, "2026-06-15T09:00:00", "literal wall-clock, unshifted");
    assert_eq!(ev.schedule.timezone, None, "the zone is silently dropped");
}

/// An `EXDATE` in a foreign zone whose local time is nonexistent there (a
/// spring-forward gap) can't resolve to an instant — `convert_to_zone` returns
/// None and `instant_wall_clock` falls back to the literal, UNCONVERTED value.
/// Pinned: the stored EXDATE stays in the foreign basis, so it silently won't
/// string-match the source-zone expansion.
#[test]
fn exdate_in_a_foreign_dst_gap_falls_back_to_the_unconverted_literal() {
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
DTSTART;TZID=America/Los_Angeles:20260601T090000\r\n\
DTEND;TZID=America/Los_Angeles:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
EXDATE;TZID=America/New_York:20260308T023000\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/s.ics", Some("v1"), &ics(body)).unwrap();
    // 02:30 America/New_York on 2026-03-08 doesn't exist (02:00 EST → 03:00 EDT);
    // the conversion bails and the raw NY wall-clock is stored as-is, unconverted.
    assert_eq!(ev.recurrence.unwrap().exdates, vec!["2026-03-08T02:30:00"]);
}

/// An override whose `RECURRENCE-ID` is in a DIFFERENT zone than its master must
/// still normalize its `original_date` to the master's source zone, or it won't
/// string-match the expansion (double-render / orphan).
#[test]
fn override_recurrence_id_in_a_foreign_tzid_normalizes_to_the_master_zone() {
    // Master weekly Mon 09:00 NY. Override RECURRENCE-ID 06:00 LA = 09:00 NY — the
    // Jun 8 occurrence. The override's own moved DTSTART stays in its LA basis.
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:s\r\n\
RECURRENCE-ID;TZID=America/Los_Angeles:20260608T060000\r\n\
DTSTART;TZID=America/Los_Angeles:20260608T080000\r\n\
DTEND;TZID=America/Los_Angeles:20260608T083000\r\n\
SUMMARY:Standup (moved)\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/s.ics", Some("v1"), &ics(body)).unwrap();
    let ov = &ev.recurrence.as_ref().unwrap().overrides[0];
    assert_eq!(ov.original_date, "2026-06-08T09:00:00", "RECURRENCE-ID normalizes to the master zone");
}

/// iCloud / Fastmail split exclusions across multiple `EXDATE` lines rather than one
/// comma-joined line. All of them must land in the series' exdate set.
#[test]
fn multiple_exdate_lines_all_land_in_the_set() {
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
EXDATE;TZID=America/New_York:20260608T090000\r\n\
EXDATE;TZID=America/New_York:20260615T090000\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/s.ics", Some("v1"), &ics(body)).unwrap();
    let mut exdates = ev.recurrence.unwrap().exdates;
    exdates.sort();
    assert_eq!(exdates, vec!["2026-06-08T09:00:00", "2026-06-15T09:00:00"]);
}

/// A VEVENT with no `UID` doesn't panic — `ical_uid` degrades to empty (per-calendar
/// dedup still keys on the href/external_id). Some exporters omit it on one-offs.
#[test]
fn vevent_without_uid_yields_empty_ical_uid() {
    let body = "BEGIN:VEVENT\r\n\
DTSTART;TZID=America/New_York:20260615T090000\r\n\
DTEND;TZID=America/New_York:20260615T100000\r\n\
SUMMARY:No UID\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/no-uid.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.core.ical_uid, "");
    assert_eq!(ev.core.external_id, "/no-uid.ics", "identity falls back to the href");
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

/// Two VEVENTs share a UID and neither carries a RECURRENCE-ID (malformed). Pins the
/// deterministic first-wins pick; the why lives at `parse_resource`.
#[test]
fn multiple_masters_sharing_a_uid_keep_the_first() {
    let body = "BEGIN:VEVENT\r\n\
UID:dup\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T100000\r\n\
SUMMARY:First\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:dup\r\n\
DTSTART;TZID=America/New_York:20260602T090000\r\n\
DTEND;TZID=America/New_York:20260602T100000\r\n\
SUMMARY:Second\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/dup.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.core.title, "First", "the first VEVENT wins");
    assert_eq!(ev.schedule.start, "2026-06-01T09:00:00");
    assert!(ev.recurrence.is_none(), "neither VEVENT carries an RRULE");
}

// ─── EXDATE normalization ─────────────────────────────────────────────────────────

/// An `EXDATE` carried in a DIFFERENT zone than the series must normalize to the
/// series' source-zone wall-clock, or it won't string-match the expansion and the
/// cancelled occurrence keeps rendering.
#[test]
fn foreign_tzid_exdate_normalizes_to_source_zone() {
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
EXDATE;TZID=Europe/London:20260615T140000\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/s.ics", Some("v1"), &ics(body)).unwrap();
    // 14:00 London (BST, UTC+1) = 13:00Z = 09:00 New York (EDT) — the series basis.
    assert_eq!(ev.recurrence.unwrap().exdates, vec!["2026-06-15T09:00:00"]);
}

/// One `EXDATE` property can list several comma-separated dates (RFC 5545);
/// iCloud/Fastmail emit these. Every value must be captured, not just the first.
#[test]
fn comma_separated_exdate_captures_every_value() {
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
DTSTART;TZID=America/New_York:20260601T090000\r\n\
DTEND;TZID=America/New_York:20260601T093000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO\r\n\
EXDATE;TZID=America/New_York:20260615T090000,20260622T090000,20260629T090000\r\n\
SUMMARY:Standup\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/s.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(
        ev.recurrence.unwrap().exdates,
        vec!["2026-06-15T09:00:00", "2026-06-22T09:00:00", "2026-06-29T09:00:00"]
    );
}

/// A resource whose only VEVENT carries a `RECURRENCE-ID` (a detached override
/// with no master in the same body — malformed for CalDAV but seen in exports)
/// falls back to that lone VEVENT rather than erroring the whole resource away.
#[test]
fn override_only_resource_falls_back_to_the_single_vevent() {
    let body = "BEGIN:VEVENT\r\n\
UID:s\r\n\
RECURRENCE-ID;TZID=America/New_York:20260608T090000\r\n\
DTSTART;TZID=America/New_York:20260608T110000\r\n\
DTEND;TZID=America/New_York:20260608T113000\r\n\
SUMMARY:Standup (moved)\r\n\
END:VEVENT\r\n";
    let ev = parse_resource("/o.ics", Some("v1"), &ics(body)).unwrap();
    assert_eq!(ev.core.ical_uid, "s");
    assert_eq!(ev.schedule.start, "2026-06-08T11:00:00");
}
