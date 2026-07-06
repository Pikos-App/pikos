//! One CalDAV resource (one href) → one normalized [`EventUpsert`].
//!
//! href ≠ UID: a single resource can carry a recurring **master VEVENT plus its
//! `RECURRENCE-ID` override VEVENTs**, all sharing one UID. We fold them into one
//! series — master → the rule, normal overrides → `page_schedules` rows, a
//! `STATUS:CANCELLED` override → an `EXDATE`. Because one resource is always the
//! whole series, CalDAV never produces a lone occurrence delta (the Google-only
//! orphan path); this only ever emits a single event or a full series bundle.
//!
//! Every recurrence instant is normalized to the **source-zone wall-clock** the
//! client expansion matches against: a `RECURRENCE-ID`/`EXDATE` carried in UTC or
//! a foreign `TZID` is converted into the event's own zone, while the raw `RRULE`
//! (incl. a `UNTIL=…Z`) is preserved verbatim for the reconciler to rewrite.

use calcard::common::PartialDateTime;
use calcard::icalendar::{
    ICalendar, ICalendarComponent, ICalendarComponentType, ICalendarProperty, ICalendarStatus,
    ICalendarValue, Uri,
};
use calcard::icalendar::timezone::TzResolver;
use calcard::{Entry, Parser};
use chrono::{FixedOffset, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz as ChronoTz;

use pikos_db::sync_delta::{
    EventCore, EventSchedule, EventUpsert, OccurrenceOverride, Recurrence,
};

use super::error::CaldavError;

/// Parse one resource body into a normalized upsert. `href` is the resource
/// identity (`external_id`); `etag` its change tag. Errs on a body with no
/// VEVENT — the caller skips that resource rather than sinking the batch.
pub(crate) fn parse_resource(
    href: &str,
    etag: Option<&str>,
    ics: &str,
) -> Result<EventUpsert, CaldavError> {
    let ical = parse_calendar(ics)?;
    let resolver = ical.build_tz_resolver();

    let events: Vec<&ICalendarComponent> = ical
        .components
        .iter()
        .filter(|c| c.component_type == ICalendarComponentType::VEvent)
        .collect();

    // The master is the VEVENT without a RECURRENCE-ID; the rest are overrides.
    // A resource with only overrides (no master) is malformed for CalDAV — fall
    // back to the first VEVENT so we still surface something rather than drop it.
    let master = events
        .iter()
        .copied()
        .find(|c| c.property(&ICalendarProperty::RecurrenceId).is_none())
        .or_else(|| events.first().copied())
        .ok_or_else(|| CaldavError::Protocol("resource has no VEVENT".into()))?;

    let source = source_zone(master, &resolver);
    let schedule = schedule_of(master, &resolver, source.as_ref())?;
    let core = core_of(master, href, etag);

    let has_rrule = master.property(&ICalendarProperty::Rrule).is_some();
    let recurrence = if has_rrule {
        Some(build_recurrence(master, &events, &resolver, source.as_ref())?)
    } else {
        None
    };

    Ok(EventUpsert { core, schedule, recurrence })
}

fn parse_calendar(ics: &str) -> Result<ICalendar, CaldavError> {
    let mut parser = Parser::new(ics);
    loop {
        match parser.entry() {
            Entry::ICalendar(ical) => return Ok(ical),
            Entry::Eof => return Err(CaldavError::Protocol("no VCALENDAR in resource".into())),
            _ => {}
        }
    }
}

// ─── identity + mirror fields ───────────────────────────────────────────────────

fn core_of(comp: &ICalendarComponent, href: &str, etag: Option<&str>) -> EventCore {
    EventCore {
        external_id: href.to_string(),
        ical_uid: comp.uid().unwrap_or_default().to_string(),
        etag: etag.map(str::to_owned),
        title: text_prop(comp, &ICalendarProperty::Summary).unwrap_or_default(),
        description: text_prop(comp, &ICalendarProperty::Description),
        location: text_prop(comp, &ICalendarProperty::Location),
        attendees: comp
            .properties(&ICalendarProperty::Attendee)
            .filter_map(|e| e.values.first().and_then(value_text))
            .map(|a| strip_mailto(&a).to_string())
            .collect(),
    }
}

fn text_prop(comp: &ICalendarComponent, prop: &ICalendarProperty) -> Option<String> {
    comp.property(prop)
        .and_then(|e| e.values.first())
        .and_then(value_text)
}

fn value_text(v: &ICalendarValue) -> Option<String> {
    match v {
        ICalendarValue::Text(s) => Some(s.clone()),
        ICalendarValue::Uri(Uri::Location(s)) => Some(s.clone()),
        _ => None,
    }
}

fn strip_mailto(s: &str) -> &str {
    s.strip_prefix("mailto:")
        .or_else(|| s.strip_prefix("MAILTO:"))
        .unwrap_or(s)
}

// ─── schedule + zone ────────────────────────────────────────────────────────────

/// The event's source zone, taken from `DTSTART`: its `TZID` (resolved through
/// any inline `VTIMEZONE`), or UTC for a `Z`-stamped start. `None` for a date-only
/// (all-day) or floating start — neither carries a meaningful zone.
struct SourceZone {
    /// Resolved IANA id, stored alongside the wall-clock as provenance.
    iana: String,
    chrono: ChronoTz,
}

fn source_zone(master: &ICalendarComponent, resolver: &TzResolver<&str>) -> Option<SourceZone> {
    let dtstart = master.property(&ICalendarProperty::Dtstart)?;
    let pdt = dtstart.values.first()?.as_partial_date_time()?;
    if !pdt.has_time() {
        return None; // all-day
    }
    let iana = if let Some(tzid) = dtstart.tz_id() {
        resolver.resolve(tzid).and_then(|t| t.name())?.into_owned()
    } else if pdt.has_zone() {
        "UTC".to_string() // DTSTART…Z
    } else {
        return None; // floating
    };
    let chrono = iana.parse().ok()?;
    Some(SourceZone { iana, chrono })
}

/// `DTSTART`/`DTEND` → a normalized [`EventSchedule`]. The all-day end is carried
/// **raw exclusive** — the reconciler is the single owner that decrements it.
fn schedule_of(
    comp: &ICalendarComponent,
    resolver: &TzResolver<&str>,
    source: Option<&SourceZone>,
) -> Result<EventSchedule, CaldavError> {
    let dtstart = comp
        .property(&ICalendarProperty::Dtstart)
        .and_then(|e| e.values.first().and_then(|v| v.as_partial_date_time()).map(|p| (e, p)))
        .ok_or_else(|| CaldavError::Protocol("VEVENT without DTSTART".into()))?;
    let all_day = !dtstart.1.has_time();

    let start = instant_wall_clock(dtstart.1, dtstart.0.tz_id(), resolver, source);
    let end = comp
        .property(&ICalendarProperty::Dtend)
        .and_then(|e| e.values.first().and_then(|v| v.as_partial_date_time()).map(|p| (e, p)))
        .map(|(e, p)| instant_wall_clock(p, e.tz_id(), resolver, source))
        // No DTEND → derive the end from a DURATION (start + nominal length), so an
        // event written `DTSTART`+`DURATION` keeps its span instead of collapsing to
        // a point. All-day DURATION (`P1D`) yields the same raw-exclusive date a
        // DTEND would.
        .or_else(|| duration_end(comp, dtstart.1, all_day));

    Ok(EventSchedule {
        start,
        end,
        timezone: if all_day { None } else { source.map(|s| s.iana.clone()) },
    })
}

// ─── recurrence ─────────────────────────────────────────────────────────────────

fn build_recurrence(
    master: &ICalendarComponent,
    events: &[&ICalendarComponent],
    resolver: &TzResolver<&str>,
    source: Option<&SourceZone>,
) -> Result<Recurrence, CaldavError> {
    // Raw RRULE value, kept verbatim (UNTIL=…Z included) so no field is dropped;
    // the reconciler rewrites only the UNTIL token to wall-clock.
    let rrule = match master.property(&ICalendarProperty::Rrule).and_then(|e| e.values.first()) {
        Some(ICalendarValue::RecurrenceRule(r)) => r.to_string(),
        _ => return Err(CaldavError::Protocol("RRULE present but unparsed".into())),
    };

    // EXDATEs from the master — one entry can hold several comma-separated values.
    let mut exdates: Vec<String> = master
        .properties(&ICalendarProperty::Exdate)
        .flat_map(|e| {
            let tzid = e.tz_id();
            e.values
                .iter()
                .filter_map(|v| v.as_partial_date_time())
                .map(move |p| instant_wall_clock(p, tzid, resolver, source))
        })
        .collect();

    let mut overrides = Vec::new();
    for ov in events
        .iter()
        .copied()
        .filter(|c| c.property(&ICalendarProperty::RecurrenceId).is_some())
    {
        let recid = ov
            .property(&ICalendarProperty::RecurrenceId)
            .and_then(|e| e.values.first().and_then(|v| v.as_partial_date_time()).map(|p| (e, p)))
            .ok_or_else(|| CaldavError::Protocol("override without RECURRENCE-ID".into()))?;
        let original_date = instant_wall_clock(recid.1, recid.0.tz_id(), resolver, source);

        // A cancelled instance is a hole in the series, not a moved one → EXDATE.
        if ov.status() == Some(&ICalendarStatus::Cancelled) {
            exdates.push(original_date);
            continue;
        }
        // Drop only the bad instance on a malformed override (e.g. missing DTSTART) —
        // one broken VEVENT must not sink the whole series via `?`-propagation.
        match schedule_of(ov, resolver, source_zone(ov, resolver).as_ref().or(source)) {
            Ok(schedule) => overrides.push(OccurrenceOverride { original_date, schedule }),
            Err(e) => log::warn!("caldav ics: skipping malformed override in series: {e}"),
        }
    }

    Ok(Recurrence { rrule, exdates, overrides })
}

// ─── instant normalization ──────────────────────────────────────────────────────

/// One datetime → source-zone wall-clock (`YYYY-MM-DDTHH:MM:SS`), or a bare date
/// (`YYYY-MM-DD`) for an all-day value. A value already in the source zone's basis
/// is taken literally; one in UTC (`Z`), a fixed offset, or a foreign `TZID` is
/// converted into the source zone so the pure-wall-clock expansion matches it.
fn instant_wall_clock(
    pdt: &PartialDateTime,
    tzid: Option<&str>,
    resolver: &TzResolver<&str>,
    source: Option<&SourceZone>,
) -> String {
    if !pdt.has_time() {
        return fmt_date(pdt);
    }
    if let Some(src) = source {
        // Convert only when the value's basis differs from the source zone; a
        // same-zone TZID is already source wall-clock (and skipping the round-trip
        // dodges DST-fold ambiguity).
        let foreign_tz = tzid.is_some_and(|id| {
            resolver.resolve(id).and_then(|t| t.name()).as_deref() != Some(&src.iana)
        });
        if pdt.has_zone() || foreign_tz {
            if let Some(converted) = convert_to_zone(pdt, tzid, resolver, src) {
                return converted;
            }
        }
    }
    fmt_datetime(pdt)
}

/// Resolve `pdt` to an absolute instant (from its `Z`/offset or its `TZID`), then
/// render it as wall-clock in `src`. `None` if any component is missing or the
/// local time is non-existent/ambiguous — the caller falls back to the literal.
fn convert_to_zone(
    pdt: &PartialDateTime,
    tzid: Option<&str>,
    resolver: &TzResolver<&str>,
    src: &SourceZone,
) -> Option<String> {
    let naive = naive_dt(pdt)?;

    let instant = if pdt.has_zone() {
        let secs = (pdt.tz_hour.unwrap_or(0) as i32 * 3600) + (pdt.tz_minute.unwrap_or(0) as i32 * 60);
        let offset = FixedOffset::east_opt(if pdt.tz_minus { -secs } else { secs })?;
        offset.from_local_datetime(&naive).single()?.with_timezone(&Utc)
    } else {
        let zone: ChronoTz = tzid
            .and_then(|id| resolver.resolve(id))
            .and_then(|t| t.name())
            .and_then(|n| n.parse().ok())?;
        zone.from_local_datetime(&naive).single()?.with_timezone(&Utc)
    };
    Some(instant.with_timezone(&src.chrono).format("%Y-%m-%dT%H:%M:%S").to_string())
}

/// `start + DURATION` → an end wall-clock string, or `None` when the event has no
/// DURATION. A date-only start formats a date end (raw-exclusive, like DTEND); a
/// timed start formats a date-time end.
fn duration_end(comp: &ICalendarComponent, start: &PartialDateTime, all_day: bool) -> Option<String> {
    let delta = match comp.property(&ICalendarProperty::Duration).and_then(|e| e.values.first()) {
        Some(ICalendarValue::Duration(d)) => d.to_time_delta()?,
        _ => return None,
    };
    let end = naive_dt(start)?.checked_add_signed(delta)?;
    Some(if all_day {
        end.format("%Y-%m-%d").to_string()
    } else {
        end.format("%Y-%m-%dT%H:%M:%S").to_string()
    })
}

/// `PartialDateTime` → a `NaiveDateTime`, defaulting an absent time to midnight
/// (so an all-day date still anchors duration arithmetic). `None` if the date is
/// incomplete.
fn naive_dt(pdt: &PartialDateTime) -> Option<NaiveDateTime> {
    NaiveDate::from_ymd_opt(pdt.year? as i32, pdt.month? as u32, pdt.day? as u32)?.and_hms_opt(
        pdt.hour.unwrap_or(0) as u32,
        pdt.minute.unwrap_or(0) as u32,
        pdt.second.unwrap_or(0) as u32,
    )
}

fn fmt_date(pdt: &PartialDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        pdt.year.unwrap_or_default(),
        pdt.month.unwrap_or_default(),
        pdt.day.unwrap_or_default()
    )
}

fn fmt_datetime(pdt: &PartialDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        pdt.year.unwrap_or_default(),
        pdt.month.unwrap_or_default(),
        pdt.day.unwrap_or_default(),
        pdt.hour.unwrap_or_default(),
        pdt.minute.unwrap_or_default(),
        pdt.second.unwrap_or_default()
    )
}

#[cfg(test)]
#[path = "ics_tests.rs"]
mod ics_tests;
