//! The workspace's scheduled pages as one RFC 5545 `.ics` calendar.
//!
//! Scope is the [`fetch_export_pages`] predicate the other exports share: an un-actioned
//! calendar mirror is the calendar's own copy, and re-importing it elsewhere would duplicate
//! its event. Unscheduled pages are left out, as iCalendar has no home for them.
//!
//! ## Timed events carry a TZID, not a UTC instant
//!
//! A timed `DTSTART` is either `TZID=<zone>` plus a `VTIMEZONE`, or a `…Z` UTC instant. This
//! export emits the first, because the second can't state a recurring event: Pikos stores a
//! series as wall-clock plus a zone (a 09:00 standup stays 09:00 across DST), while
//! `DTSTART:…Z;RRULE:…` repeats one UTC instant, so every occurrence past a transition lands
//! an hour wrong.
//!
//! The `VTIMEZONE` is generated: [`vtimezone`] probes the zone through
//! [`zoned::utc_to_wall_clock`] and writes each real transition as its own observance. No
//! rule is inferred, since inferring `BYDAY=-1SU` from one transition is what gets a
//! hand-rolled `VTIMEZONE` wrong. The zone is exact within [`VTIMEZONE_FUTURE_YEARS`] of the
//! events; beyond that a consumer extrapolates from the last observance.

use std::collections::{BTreeSet, HashMap};

use chrono::{Datelike, Days, Duration, NaiveDate, NaiveDateTime, NaiveTime};
use pikos_recurrence::{rewrite_until_with, zoned, WallClock};

use crate::error::AppResult;
use crate::export::{column, fetch_export_pages, page_id};
use crate::pool::AtStep;

/// How far past the last exported occurrence the generated `VTIMEZONE` spells
/// its transitions out. An unbounded `RRULE` outruns any window; 30 years puts
/// the edge past the horizon anyone plans against, at ~60 observances per zone.
const VTIMEZONE_FUTURE_YEARS: i32 = 30;

/// Cap on the `DESCRIPTION` a page's body contributes: a whole document would fold into
/// thousands of lines and be truncated by the receiving client anyway.
const MAX_DESCRIPTION_CHARS: usize = 4000;

/// RFC 5545 §3.1: content lines are folded at 75 **octets**, excluding the CRLF.
const FOLD_OCTETS: usize = 75;

/// RFC 5545 §3.3.11 TEXT escaping: `\`, `;`, `,` and newline. A colon isn't escaped, as it
/// is special only in the name/value split. A lone `\r` is dropped so a CRLF becomes one `\n`.
fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

/// Appends one content line, folded to [`FOLD_OCTETS`] and CRLF-terminated. A continuation
/// line's leading space counts against the budget. Folds land on a character boundary, since
/// splitting a multi-byte character would hand the consumer two invalid fragments.
fn push_folded(out: &mut String, line: &str) {
    let mut start = 0;
    let mut limit = FOLD_OCTETS;
    while line.len() - start > limit {
        let mut cut = start + limit;
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        out.push_str(&line[start..cut]);
        out.push_str("\r\n ");
        start = cut;
        limit = FOLD_OCTETS - 1;
    }
    out.push_str(&line[start..]);
    out.push_str("\r\n");
}

/// Where one VEVENT sits in time, in the value type its `DTSTART` will use.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Placement {
    /// `VALUE=DATE`. `end_exclusive` is already the RFC's exclusive day — see
    /// [`Placement::build`] for the conversion off Pikos storage.
    AllDay {
        start: NaiveDate,
        end_exclusive: NaiveDate,
    },
    /// `TZID=<zone>`. `zone` is an IANA id that resolved.
    Timed {
        zone: String,
        start: NaiveDateTime,
        end: Option<NaiveDateTime>,
    },
}

impl Placement {
    /// A stored `(scheduled_start, scheduled_end, timezone)` triple as a VEVENT placement.
    /// `None` when the start is unparseable or absent.
    ///
    /// All-day ends invert the reconciler: it decrements a provider's exclusive `DTEND` on the
    /// way in (`InclusiveEnd::from_provider`), so `scheduled_end` holds the inclusive last
    /// day and going out adds a day. A missing end is a one-day event, landing on `start + 1`.
    fn build(start: &str, end: Option<&str>, zone: Option<&str>, device: &str) -> Option<Self> {
        let start_wc = WallClock::parse(start)?;
        let end_wc = end.filter(|e| !e.is_empty()).and_then(WallClock::parse);

        if start_wc.is_all_day() {
            // `.max` guards a stored end before its start; the exclusive end must follow DTSTART.
            let last = end_wc
                .map(|w| w.date)
                .unwrap_or(start_wc.date)
                .max(start_wc.date);
            return Some(Placement::AllDay {
                start: start_wc.date,
                end_exclusive: last.checked_add_days(Days::new(1))?,
            });
        }

        Some(Placement::Timed {
            zone: resolve_zone(zone, device),
            start: start_wc.as_datetime(),
            // A contradictory all-day end on a timed start is dropped, not emitted against DTSTART's type.
            end: end_wc.filter(|w| !w.is_all_day()).map(|w| w.as_datetime()),
        })
    }

    fn value_param(&self) -> String {
        match self {
            Placement::AllDay { .. } => ";VALUE=DATE".to_string(),
            Placement::Timed { zone, .. } => format!(";TZID={zone}"),
        }
    }

    /// An occurrence key (a stored `original_date` or exdate, a bare date or a full wall clock)
    /// in this event's value type, so `EXDATE` and `RECURRENCE-ID` match `DTSTART` as RFC 5545
    /// §3.8.5.1 requires. A date-only key on a timed series takes the series' time of day.
    fn occurrence_value(&self, key: &str) -> Option<String> {
        let wall = WallClock::parse(key)?;
        Some(match self {
            Placement::AllDay { .. } => date_value(wall.date),
            Placement::Timed { start, .. } => datetime_value(
                wall.date
                    .and_time(wall.time.unwrap_or_else(|| start.time())),
            ),
        })
    }

    fn zone(&self) -> Option<&str> {
        match self {
            Placement::AllDay { .. } => None,
            Placement::Timed { zone, .. } => Some(zone),
        }
    }
}

/// The IANA id a timed value is expressed in: the row's own zone if chrono-tz knows it, else
/// the device zone, else UTC. A row with no zone is device-local (the reschedule writer
/// clears it to say so).
fn resolve_zone(stored: Option<&str>, device: &str) -> String {
    for candidate in [stored.unwrap_or_default(), device] {
        if !candidate.is_empty() && zone_is_known(candidate) {
            return candidate.to_string();
        }
    }
    "UTC".to_string()
}

fn zone_is_known(zone: &str) -> bool {
    zoned::utc_to_wall_clock(zone, NaiveDateTime::default()).is_some()
}

fn date_value(d: NaiveDate) -> String {
    d.format("%Y%m%d").to_string()
}

fn datetime_value(dt: NaiveDateTime) -> String {
    dt.format("%Y%m%dT%H%M%S").to_string()
}

/// Seconds east of UTC that `zone` shows at a UTC instant; 0 for an unknown zone, which
/// [`resolve_zone`] already refused.
fn offset_at(zone: &str, utc: NaiveDateTime) -> i64 {
    zoned::utc_to_wall_clock(zone, utc)
        .map(|local| (local - utc).num_seconds())
        .unwrap_or(0)
}

/// One offset change: the first UTC second showing the new offset.
struct Transition {
    utc: NaiveDateTime,
    from: i64,
    to: i64,
}

/// Every offset change `zone` makes in `[from, to)`, walking UTC in six-hour strides and
/// bisecting the one that straddles a change. Six hours is under the shortest gap between
/// real modern transitions, so none is stepped over.
fn transitions(zone: &str, from: NaiveDateTime, to: NaiveDateTime) -> Vec<Transition> {
    const STRIDE_SECONDS: i64 = 6 * 3600;
    let mut out = Vec::new();
    let mut prev = offset_at(zone, from);
    let mut cursor = from;
    while cursor < to {
        let next = (cursor + Duration::seconds(STRIDE_SECONDS)).min(to);
        let offset = offset_at(zone, next);
        if offset != prev {
            let (mut lo, mut hi) = (cursor, next);
            while (hi - lo).num_seconds() > 1 {
                let mid = lo + (hi - lo) / 2;
                if offset_at(zone, mid) == prev {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            out.push(Transition {
                utc: hi,
                from: prev,
                to: offset,
            });
            prev = offset;
        }
        cursor = next;
    }
    out
}

/// RFC 5545 `UTC-OFFSET`: `+HHMM`, widened to `+HHMMSS` for an offset that isn't a whole minute.
fn utc_offset(seconds: i64) -> String {
    let sign = if seconds < 0 { '-' } else { '+' };
    let abs = seconds.abs();
    let (h, m, s) = (abs / 3600, (abs % 3600) / 60, abs % 60);
    if s == 0 {
        format!("{sign}{h:02}{m:02}")
    } else {
        format!("{sign}{h:02}{m:02}{s:02}")
    }
}

/// A `VTIMEZONE` for `zone` covering `[from, to)`.
///
/// The first observance anchors the window: a consumer uses the latest observance at or
/// before a time, so nothing before the first transition would have an offset. Each
/// transition is then its own observance, with `DTSTART` in the outgoing offset's local
/// time per §3.6.5.
///
/// STANDARD vs DAYLIGHT is read off the direction of the change. A zone permanently moving its
/// standard offset is labelled as a DST step, which is cosmetic: consumers read `TZOFFSETTO`.
fn vtimezone(zone: &str, from: NaiveDateTime, to: NaiveDateTime) -> String {
    let changes = transitions(zone, from, to);
    let base_offset = offset_at(zone, from);
    let base_name = match changes.first() {
        Some(first) if first.to < first.from => "DAYLIGHT",
        _ => "STANDARD",
    };

    let mut out = String::new();
    push_folded(&mut out, "BEGIN:VTIMEZONE");
    push_folded(&mut out, &format!("TZID:{zone}"));

    push_folded(&mut out, &format!("BEGIN:{base_name}"));
    push_folded(
        &mut out,
        &format!(
            "DTSTART:{}",
            datetime_value(from + Duration::seconds(base_offset))
        ),
    );
    push_folded(
        &mut out,
        &format!("TZOFFSETFROM:{}", utc_offset(base_offset)),
    );
    push_folded(&mut out, &format!("TZOFFSETTO:{}", utc_offset(base_offset)));
    push_folded(&mut out, &format!("END:{base_name}"));

    for change in &changes {
        let name = if change.to > change.from {
            "DAYLIGHT"
        } else {
            "STANDARD"
        };
        push_folded(&mut out, &format!("BEGIN:{name}"));
        push_folded(
            &mut out,
            &format!(
                "DTSTART:{}",
                datetime_value(change.utc + Duration::seconds(change.from))
            ),
        );
        push_folded(
            &mut out,
            &format!("TZOFFSETFROM:{}", utc_offset(change.from)),
        );
        push_folded(&mut out, &format!("TZOFFSETTO:{}", utc_offset(change.to)));
        push_folded(&mut out, &format!("END:{name}"));
    }

    push_folded(&mut out, "END:VTIMEZONE");
    out
}

/// The stored rule, with its `UNTIL` moved into the value type `DTSTART` forces.
///
/// Everything else goes out byte for byte, since a parse round-trip would drop fields
/// `RecurrenceOptions` doesn't carry. `UNTIL` can't: RFC 5545 §3.3.10 requires it to match
/// `DTSTART`'s value type, and be UTC when `DTSTART` has a `TZID`. Pikos stores it as
/// event-zone wall clock, so both readings need the conversion here.
fn export_rrule(rrule: &str, placement: &Placement) -> String {
    rewrite_until_with(rrule, |value| match placement {
        Placement::AllDay { .. } => Some(
            value
                .split(['T', 't'])
                .next()
                .filter(|d| d.len() == 8)?
                .to_string(),
        ),
        Placement::Timed { zone, .. } => {
            if value.ends_with('Z') || value.ends_with('z') {
                return None;
            }
            let wall = parse_compact(value)?;
            let utc = zoned::wall_clock_to_utc(zone, wall)?;
            Some(format!("{}Z", datetime_value(utc)))
        }
    })
}

/// The wall clock a bound spells. A date-only bound on a timed series means through the end
/// of that day, as `build_rrule` writes it.
fn parse_compact(value: &str) -> Option<NaiveDateTime> {
    let date = NaiveDate::parse_from_str(value.get(0..8)?, "%Y%m%d").ok()?;
    match value.len() {
        8 => Some(date.and_time(NaiveTime::from_hms_opt(23, 59, 59)?)),
        15 => Some(NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?),
        _ => None,
    }
}

/// Everything one VEVENT needs. An override reuses it with `recurrence_id` set and no rule,
/// the RFC's shape for a moved instance.
struct Vevent<'a> {
    uid: String,
    summary: &'a str,
    description: &'a str,
    placement: Placement,
    /// The `RECURRENCE-ID` tail (`;PARAM:value`) for an override, rendered in the series'
    /// value type: it identifies an occurrence of the master rule, so it uses the master's
    /// frame, not the zone the moved instance lands in.
    recurrence_id: Option<String>,
    rrule: Option<&'a str>,
    exdates: Vec<String>,
}

fn push_vevent(out: &mut String, dtstamp: &str, event: &Vevent<'_>) {
    let param = event.placement.value_param();

    push_folded(out, "BEGIN:VEVENT");
    push_folded(out, &format!("UID:{}", escape_text(&event.uid)));
    push_folded(out, &format!("DTSTAMP:{dtstamp}"));

    match &event.placement {
        Placement::AllDay {
            start,
            end_exclusive,
        } => {
            push_folded(out, &format!("DTSTART{param}:{}", date_value(*start)));
            push_folded(out, &format!("DTEND{param}:{}", date_value(*end_exclusive)));
        }
        Placement::Timed { start, end, .. } => {
            push_folded(out, &format!("DTSTART{param}:{}", datetime_value(*start)));
            if let Some(end) = end {
                push_folded(out, &format!("DTEND{param}:{}", datetime_value(*end)));
            }
        }
    }

    if let Some(recurrence_id) = &event.recurrence_id {
        push_folded(out, &format!("RECURRENCE-ID{recurrence_id}"));
    }

    let summary = if event.summary.is_empty() {
        "Untitled"
    } else {
        event.summary
    };
    push_folded(out, &format!("SUMMARY:{}", escape_text(summary)));

    if !event.description.is_empty() {
        push_folded(
            out,
            &format!("DESCRIPTION:{}", escape_text(&truncate(event.description))),
        );
    }

    if let Some(rrule) = event.rrule {
        push_folded(
            out,
            &format!("RRULE:{}", export_rrule(rrule, &event.placement)),
        );
    }
    if !event.exdates.is_empty() {
        push_folded(out, &format!("EXDATE{param}:{}", event.exdates.join(",")));
    }

    push_folded(out, "END:VEVENT");
}

/// A page body clipped to [`MAX_DESCRIPTION_CHARS`] on a character boundary, with an
/// ellipsis so the clip is visible.
fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_DESCRIPTION_CHARS) {
        None => text.to_string(),
        Some((cut, _)) => format!("{}…", &text[..cut]),
    }
}

struct RuleRow {
    rrule: String,
    exdates_json: String,
    start: String,
    end: Option<String>,
    timezone: String,
}

/// A materialized occurrence override: a `page_schedules` row pointing back at a rule.
struct OverrideRow {
    original_date: String,
    start: String,
    end: Option<String>,
    timezone: Option<String>,
    status: String,
}

/// Builds the whole calendar, split from [`export_ics`] so it is testable without the disk.
pub async fn build_export_ics(pool: &sqlx::SqlitePool, include_synced: bool) -> AppResult<String> {
    let device = crate::device_zone().name().to_string();
    let now = chrono::Utc::now();
    let dtstamp = now.format("%Y%m%dT%H%M%SZ").to_string();

    let pages = fetch_export_pages(
        pool,
        "id, title, content_text, scheduled_start, scheduled_end",
        include_synced,
    )
    .await
    .at_step("reading the pages")?;

    // Read once and keyed by page rather than joined, as the CSV export does.
    let rules: HashMap<String, RuleRow> =
        sqlx::query_as::<_, (String, String, String, String, Option<String>, String)>(
            "SELECT page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone \
             FROM page_recurrence_rules",
        )
        .fetch_all(pool)
        .await
        .at_step("reading the repeat rules")?
        .into_iter()
        .map(|(page_id, rrule, exdates_json, start, end, timezone)| {
            (
                page_id,
                RuleRow {
                    rrule,
                    exdates_json,
                    start,
                    end,
                    timezone,
                },
            )
        })
        .collect();

    // A skip dismissed its occurrence, and a completion moved it onto a done clone page that
    // exports as its own VEVENT, so emitting both would double it.
    let mut exclusions: HashMap<String, Vec<String>> = HashMap::new();
    for (page_id, occurrence_date) in sqlx::query_as::<_, (String, String)>(
        "SELECT page_id, occurrence_date FROM completed_set \
         UNION SELECT page_id, occurrence_date FROM skip_set",
    )
    .fetch_all(pool)
    .await
    .at_step("reading the skipped and completed occurrences")?
    {
        exclusions.entry(page_id).or_default().push(occurrence_date);
    }

    let mut overrides: HashMap<String, Vec<OverrideRow>> = HashMap::new();
    for (page_id, original_date, start, end, timezone, status) in sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
        ),
    >(
        "SELECT page_id, original_date, scheduled_start, scheduled_end, timezone, status \
         FROM page_schedules WHERE rule_id IS NOT NULL AND original_date IS NOT NULL \
         ORDER BY original_date",
    )
    .fetch_all(pool)
    .await
    .at_step("reading the changed occurrences")?
    {
        overrides.entry(page_id).or_default().push(OverrideRow {
            original_date,
            start,
            end,
            timezone,
            status,
        });
    }

    // A one-off's zone lives on its schedule row, keyed by (page, start) to match the denorm.
    let mut schedule_zones: HashMap<(String, String), String> = HashMap::new();
    for (page_id, start, timezone) in sqlx::query_as::<_, (String, String, String)>(
        "SELECT page_id, scheduled_start, timezone FROM page_schedules \
         WHERE timezone IS NOT NULL",
    )
    .fetch_all(pool)
    .await
    .at_step("reading the time zones of one-off events")?
    {
        schedule_zones.insert((page_id, start), timezone);
    }

    let mut body = String::new();
    let mut zones: BTreeSet<String> = BTreeSet::new();
    let mut span: Option<(NaiveDateTime, NaiveDateTime)> = None;
    let mut note_span = |dt: NaiveDateTime| {
        span = Some(match span {
            None => (dt, dt),
            Some((lo, hi)) => (lo.min(dt), hi.max(dt)),
        });
    };

    for (position, row) in pages.iter().enumerate() {
        let id = page_id(row, position)?;
        let title: String = column(row, &id, "title")?;
        let content_text: String = column(row, &id, "content_text")?;
        let start: Option<String> = column(row, &id, "scheduled_start")?;
        let end: Option<String> = column(row, &id, "scheduled_end")?;
        let rule = rules.get(&id);

        // Anchors on the rule's base occurrence: `scheduled_start` holds the next occurrence, and
        // anchoring an RRULE there would drop every occurrence behind the head.
        let placement = match rule {
            Some(rule) => Placement::build(
                &rule.start,
                rule.end.as_deref(),
                Some(&rule.timezone),
                &device,
            ),
            None => {
                let start = start.filter(|s| !s.is_empty());
                start.as_deref().and_then(|start| {
                    Placement::build(
                        start,
                        end.as_deref(),
                        schedule_zones
                            .get(&(id.clone(), start.to_string()))
                            .map(String::as_str),
                        &device,
                    )
                })
            }
        };
        let Some(placement) = placement else { continue };

        let page_overrides = overrides
            .get(&id)
            .map(Vec::as_slice)
            .filter(|_| rule.is_some())
            .unwrap_or_default();

        // An override replaces its occurrence through RECURRENCE-ID, so an EXDATE would delete
        // the instance it redefines. A `skipped` row redefines nothing, so it excludes instead.
        let mut exdates: BTreeSet<String> = BTreeSet::new();
        if let Some(rule) = rule {
            let stored: Vec<String> = serde_json::from_str(&rule.exdates_json).unwrap_or_default();
            let replaced: std::collections::HashSet<&str> = page_overrides
                .iter()
                .filter(|o| o.status != "skipped")
                .map(|o| o.original_date.as_str())
                .collect();
            for key in stored
                .iter()
                .map(String::as_str)
                .chain(
                    exclusions
                        .get(&id)
                        .into_iter()
                        .flatten()
                        .map(String::as_str),
                )
                .chain(
                    page_overrides
                        .iter()
                        .filter(|o| o.status == "skipped")
                        .map(|o| o.original_date.as_str()),
                )
            {
                if replaced.contains(key) {
                    continue;
                }
                if let Some(value) = placement.occurrence_value(key) {
                    exdates.insert(value);
                }
            }
        }

        if let Some(zone) = placement.zone() {
            zones.insert(zone.to_string());
        }
        if let Placement::Timed { start, end, .. } = &placement {
            note_span(*start);
            note_span(end.unwrap_or(*start));
        }

        push_vevent(
            &mut body,
            &dtstamp,
            &Vevent {
                uid: format!("{id}@pikos"),
                summary: &title,
                description: &content_text,
                placement: placement.clone(),
                recurrence_id: None,
                rrule: rule.map(|r| r.rrule.as_str()),
                exdates: exdates.into_iter().collect(),
            },
        );

        for over in page_overrides.iter().filter(|o| o.status != "skipped") {
            let Some(recurrence_id) = placement.occurrence_value(&over.original_date) else {
                continue;
            };
            let Some(moved) = Placement::build(
                &over.start,
                over.end.as_deref(),
                over.timezone.as_deref(),
                &device,
            ) else {
                continue;
            };
            if let Some(zone) = moved.zone() {
                zones.insert(zone.to_string());
            }
            if let Placement::Timed { start, end, .. } = &moved {
                note_span(*start);
                note_span(end.unwrap_or(*start));
            }
            push_vevent(
                &mut body,
                &dtstamp,
                &Vevent {
                    uid: format!("{id}@pikos"),
                    summary: &title,
                    description: &content_text,
                    placement: moved,
                    recurrence_id: Some(format!("{}:{recurrence_id}", placement.value_param())),
                    rrule: None,
                    exdates: Vec::new(),
                },
            );
        }
    }

    let mut out = String::new();
    push_folded(&mut out, "BEGIN:VCALENDAR");
    push_folded(&mut out, "VERSION:2.0");
    push_folded(
        &mut out,
        &format!("PRODID:-//Pikos//Pikos {}//EN", env!("CARGO_PKG_VERSION")),
    );
    push_folded(&mut out, "CALSCALE:GREGORIAN");

    // The generated zones must cover every timed instant emitted, out past an unbounded rule's horizon.
    if let Some((lo, hi)) = span {
        let from = january_first(lo.date().year());
        let to =
            january_first(hi.date().year().max(now.date_naive().year()) + VTIMEZONE_FUTURE_YEARS);
        for zone in &zones {
            out.push_str(&vtimezone(zone, from, to));
        }
    }

    out.push_str(&body);
    push_folded(&mut out, "END:VCALENDAR");
    Ok(out)
}

fn january_first(year: i32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(year, 1, 1)
        .unwrap_or_default()
        .and_time(NaiveTime::MIN)
}

// A child module because the helpers it pins are private to this file.
#[cfg(test)]
#[path = "export_ics_tests.rs"]
mod tests;
