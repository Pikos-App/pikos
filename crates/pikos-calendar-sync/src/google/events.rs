//! A flat page of Calendar API events → normalized [`UpsertItem`]s and removals.
//!
//! Google splits a recurring series across resources: the master carries
//! `RRULE`, while every moved or cancelled instance is its own event carrying
//! `recurringEventId` + `originalStartTime`. This module regroups them — a child
//! whose master is in the same page folds into that master's bundle, a child
//! whose master is absent becomes a standalone occurrence delta for the engine
//! to resolve.
//!
//! `status: "cancelled"` *with* a `recurringEventId` cancels one instance
//! (→ EXDATE); *without* one, the whole event is gone (→ removal). Getting this
//! backwards deletes or detaches the entire series.
//!
//! Every recurrence instant is normalized to the source-zone wall-clock the
//! client expansion matches against — `originalStartTime`, each `EXDATE` value,
//! and the base start alike. The `RRULE` itself is carried raw (incl. a
//! `UNTIL=…Z`) for the reconciler to rewrite.

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use pikos_recurrence::{zoned, WallClock};

use pikos_db::sync_delta::{
    EventCore, EventSchedule, EventUpsert, ExclusiveEnd, OccurrenceDelta, OccurrenceFidelity,
    OccurrenceKind, OccurrenceOverride, Recurrence, Removal, UpsertItem,
};

use super::error::GoogleError;
use super::model::{Event, EventDateTime};

const CANCELLED: &str = "cancelled";

/// A resolved instant in the shape every stored schedule value takes.
fn wall(dt: NaiveDateTime) -> String {
    WallClock::timed(dt).format()
}

/// What one page of events reduces to.
#[derive(Default)]
pub(crate) struct Grouped {
    pub upserts: Vec<UpsertItem>,
    pub removals: Vec<Removal>,
    /// Ids present upstream that couldn't upsert — the full-enumerate sweep
    /// spares these instead of treating them as deleted.
    pub unresolved_present: Vec<String>,
}

/// Regroup a page of events. `calendar_tz` is the collection's default zone, used
/// for a timed event Google didn't stamp with one of its own. `fidelity` is
/// `Complete` only for a full enumerate, where every child arrives with its
/// master.
pub(crate) fn group(
    events: Vec<Event>,
    calendar_tz: Option<&str>,
    fidelity: OccurrenceFidelity,
) -> Grouped {
    let mut out = Grouped::default();

    let (masters, children): (Vec<Event>, Vec<Event>) = events
        .into_iter()
        .partition(|e| e.recurring_event_id.is_none());

    // A cancelled master takes its series with it — drop its children rather
    // than emit deltas against a dying page.
    let cancelled_masters: Vec<String> = masters
        .iter()
        .filter(|m| is_cancelled(m))
        .map(|m| m.id.clone())
        .collect();

    let mut bundles: Vec<(Event, Vec<Event>)> = Vec::new();
    for master in masters {
        if is_cancelled(&master) {
            out.removals.push(Removal {
                external_id: master.id.clone(),
            });
            continue;
        }
        bundles.push((master, Vec::new()));
    }

    for child in children {
        let parent = child.recurring_event_id.as_deref().unwrap_or_default();
        if cancelled_masters.iter().any(|m| m == parent) {
            continue;
        }
        match bundles.iter_mut().find(|(m, _)| m.id == parent) {
            Some((_, kids)) => kids.push(child),
            None => match lone_occurrence(&child, calendar_tz) {
                Ok(item) => out.upserts.push(item),
                Err(e) => {
                    log::warn!(
                        "google events: skipping unusable occurrence {}: {e}",
                        child.id
                    );
                    out.unresolved_present.push(child.id);
                }
            },
        }
    }

    for (master, kids) in bundles {
        let id = master.id.clone();
        match build_bundle(master, kids, calendar_tz, fidelity) {
            Ok(ev) => out.upserts.push(UpsertItem::Event(ev)),
            Err(e) => {
                log::warn!("google events: skipping unusable event {id}: {e}");
                out.unresolved_present.push(id);
            }
        }
    }

    out
}

fn is_cancelled(e: &Event) -> bool {
    e.status.as_deref() == Some(CANCELLED)
}

/// A master plus whatever of its instances shared this page: moved ones become
/// overrides, cancelled ones become EXDATEs.
fn build_bundle(
    master: Event,
    kids: Vec<Event>,
    calendar_tz: Option<&str>,
    fidelity: OccurrenceFidelity,
) -> Result<EventUpsert, GoogleError> {
    let zone = source_zone(&master, calendar_tz);
    let schedule = schedule_of(&master, zone.as_ref())?;
    let core = core_of(&master);

    let Some(rrule) = rrule_line(&master.recurrence) else {
        // No RRULE: a plain event, or an RDATE-only master Pikos has no rule
        // shape for. Either way it stores as a single event.
        if !master.recurrence.is_empty() {
            log::warn!(
                "google events: event {} has recurrence lines but no RRULE; storing as a single event",
                master.id
            );
        }
        return Ok(EventUpsert {
            core,
            schedule,
            recurrence: None,
        });
    };

    let mut exdates = exdate_values(&master.recurrence, zone.as_ref());
    let mut overrides = Vec::new();
    for kid in kids {
        let original_date = match original_date_of(&kid, zone.as_ref()) {
            Some(d) => d,
            None => {
                log::warn!(
                    "google events: instance {} has no usable originalStartTime; skipping it",
                    kid.id
                );
                continue;
            }
        };
        if is_cancelled(&kid) {
            if !exdates.contains(&original_date) {
                exdates.push(original_date);
            }
            continue;
        }
        match schedule_of(
            &kid,
            source_zone(&kid, calendar_tz).as_ref().or(zone.as_ref()),
        ) {
            Ok(schedule) => overrides.push(OccurrenceOverride {
                original_date,
                schedule,
            }),
            // One broken instance must not sink the series it belongs to.
            Err(e) => log::warn!("google events: skipping malformed instance {}: {e}", kid.id),
        }
    }

    Ok(EventUpsert {
        core,
        schedule,
        recurrence: Some(Recurrence {
            rrule,
            exdates,
            overrides,
            fidelity,
        }),
    })
}

/// An instance whose master isn't in this page — the shape only Google produces.
/// Named by the series' shared `iCalUID`, with `recurringEventId` as the handle
/// the engine re-fetches the master by.
fn lone_occurrence(child: &Event, calendar_tz: Option<&str>) -> Result<UpsertItem, GoogleError> {
    let ical_uid = child
        .ical_uid
        .clone()
        .ok_or_else(|| GoogleError::Protocol("instance without iCalUID".into()))?;
    let series_ref = child
        .recurring_event_id
        .clone()
        .ok_or_else(|| GoogleError::Protocol("instance without recurringEventId".into()))?;
    // The master's zone isn't available here, so `originalStartTime`'s zone
    // stands in — Google stamps instances with the series' zone, the same basis
    // the stored rule's dates already use.
    let zone = original_zone(child, calendar_tz);
    let original_date = original_date_of(child, zone.as_ref())
        .ok_or_else(|| GoogleError::Protocol("instance without originalStartTime".into()))?;

    let kind = if is_cancelled(child) {
        OccurrenceKind::Cancel
    } else {
        OccurrenceKind::Modify(schedule_of(child, zone.as_ref())?)
    };

    Ok(UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid,
        series_ref,
        original_date,
        kind,
    }))
}

fn core_of(e: &Event) -> EventCore {
    EventCore {
        external_id: e.id.clone(),
        ical_uid: e.ical_uid.clone().unwrap_or_else(|| e.id.clone()),
        etag: e.etag.clone(),
        title: e.summary.clone().unwrap_or_default(),
        description: e.description.clone(),
        location: e.location.clone(),
        attendees: e.attendees.iter().filter_map(|a| a.email.clone()).collect(),
    }
}

// ─── zone + instant normalization ───────────────────────────────────────────────

/// The event's source zone: its own `timeZone`, else the calendar's. `None` for an
/// all-day event, which has no meaningful zone.
struct SourceZone {
    iana: String,
    tz: Tz,
}

fn source_zone(e: &Event, calendar_tz: Option<&str>) -> Option<SourceZone> {
    let start = e.start.as_ref()?;
    if start.date.is_some() {
        return None;
    }
    resolve_zone(start.time_zone.as_deref().or(calendar_tz))
}

fn original_zone(e: &Event, calendar_tz: Option<&str>) -> Option<SourceZone> {
    let named = e
        .original_start_time
        .as_ref()
        .and_then(|o| o.time_zone.as_deref())
        .or_else(|| e.start.as_ref().and_then(|s| s.time_zone.as_deref()))
        .or(calendar_tz);
    resolve_zone(named)
}

fn resolve_zone(named: Option<&str>) -> Option<SourceZone> {
    let iana = named?;
    match iana.parse::<Tz>() {
        Ok(tz) => Some(SourceZone {
            iana: iana.to_string(),
            tz,
        }),
        // Degrades to floating, like an unzoned event — logged so an unrecognised
        // zone isn't traceless.
        Err(_) => {
            log::warn!("google events: unknown IANA zone {iana}; treating event as floating");
            None
        }
    }
}

/// `start`/`end` → a normalized schedule.
fn schedule_of(e: &Event, zone: Option<&SourceZone>) -> Result<EventSchedule, GoogleError> {
    let start_field = e
        .start
        .as_ref()
        .ok_or_else(|| GoogleError::Protocol("event without start".into()))?;
    let start = wall_clock(start_field, zone)
        .ok_or_else(|| GoogleError::Protocol("event start is neither date nor dateTime".into()))?;
    let end = e.end.as_ref().and_then(|f| wall_clock(f, zone));

    Ok(EventSchedule {
        start,
        end: ExclusiveEnd::new(end),
        // All-day carries no zone; a timed event without a resolvable one floats.
        timezone: if start_field.date.is_some() {
            None
        } else {
            zone.map(|z| z.iana.clone())
        },
    })
}

fn original_date_of(e: &Event, zone: Option<&SourceZone>) -> Option<String> {
    wall_clock(e.original_start_time.as_ref()?, zone)
}

/// One Google date-or-datetime → source-zone wall-clock (or a bare `YYYY-MM-DD`
/// for all-day). A `dateTime` is an absolute instant; rendering it in the source
/// zone puts it on the same basis as the rule's other instants.
fn wall_clock(field: &EventDateTime, zone: Option<&SourceZone>) -> Option<String> {
    if let Some(date) = &field.date {
        return Some(date.clone());
    }
    let raw = field.date_time.as_ref()?;
    let parsed = DateTime::parse_from_rfc3339(raw).ok()?;
    Some(match zone {
        Some(z) => wall(zoned::wall_clock_at(z.tz, parsed.to_utc())),
        // Floating: keep the offset's own wall-clock rather than shifting to UTC.
        None => wall(parsed.naive_local()),
    })
}

// ─── recurrence lines ───────────────────────────────────────────────────────────

/// The compact form ICS spells a date-time in.
const COMPACT_FMT: &str = "%Y%m%dT%H%M%S";

/// The `RRULE` line's value, carried raw. Google may also send `EXRULE`/`RDATE`
/// lines; only `RRULE` maps onto `page_recurrence_rules`.
fn rrule_line(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .find_map(|l| l.strip_prefix("RRULE:"))
        .map(str::to_owned)
}

/// Every `EXDATE` line's values, normalized to source-zone wall-clock. One line can
/// carry several comma-separated dates, and each line names its own zone — a UTC
/// or foreign-`TZID` value left as-is wouldn't string-match the expansion, letting
/// the occurrence silently reappear.
fn exdate_values(lines: &[String], zone: Option<&SourceZone>) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let Some(rest) = line.strip_prefix("EXDATE") else {
            continue;
        };
        let Some((params, values)) = rest.split_once(':') else {
            continue;
        };
        let line_tz = params
            .split(';')
            .find_map(|p| p.strip_prefix("TZID="))
            .and_then(|t| t.parse::<Tz>().ok());
        for value in values.split(',') {
            match normalize_exdate(value.trim(), line_tz, zone) {
                Some(v) => out.push(v),
                None => log::warn!("google events: unparseable EXDATE value {value}; ignoring it"),
            }
        }
    }
    out
}

/// One `EXDATE` value → source-zone wall-clock. Three wire shapes: date-only
/// (all-day), a `Z`-suffixed UTC instant, and a local time qualified by the line's
/// `TZID` (or floating when it has none).
fn normalize_exdate(value: &str, line_tz: Option<Tz>, zone: Option<&SourceZone>) -> Option<String> {
    if let Some(utc) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(utc, COMPACT_FMT).ok()?;
        let instant = chrono::Utc.from_utc_datetime(&naive);
        return Some(match zone {
            Some(z) => wall(zoned::wall_clock_at(z.tz, instant)),
            None => wall(naive),
        });
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(value, COMPACT_FMT) {
        let Some(target) = zone else {
            return Some(wall(naive));
        };
        return Some(match line_tz {
            // A foreign TZID is a real instant elsewhere — re-render it here.
            // `single()`, not the zoned module's earliest-pass reading: an EXDATE
            // that the naming zone never had (or had twice) identifies no single
            // occurrence, and a guessed instant would exclude the wrong one.
            Some(from) if from != target.tz => wall(zoned::wall_clock_at(
                target.tz,
                from.from_local_datetime(&naive).single()?.to_utc(),
            )),
            _ => wall(naive),
        });
    }
    NaiveDate::parse_from_str(value, "%Y%m%d")
        .ok()
        .map(|d| WallClock::all_day(d).format())
}
