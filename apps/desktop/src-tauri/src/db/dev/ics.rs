//! The workspace's scheduled pages as one RFC 5545 `.ics` calendar.
//!
//! Scope matches the other exports: a page the user owns, which for a mirror is
//! the [`fetch_export_pages`] predicate the Markdown and CSV exports already
//! share — an un-actioned calendar mirror is the calendar's own copy, and
//! re-importing it somewhere else would duplicate the event it came from.
//! Unscheduled pages are left out entirely: iCalendar has no home for a page
//! that never claimed a moment.
//!
//! ## Timed events carry a TZID, not a UTC instant
//!
//! The two candidate spellings for a timed `DTSTART` are `TZID=<zone>` plus a
//! `VTIMEZONE`, or a `…Z` UTC instant with no zone at all. This export emits the
//! first, because the second cannot state a recurring event correctly: Pikos
//! stores a series as wall-clock plus a zone (a 09:00 standup stays 09:00 across
//! a DST boundary), while `DTSTART:…Z;RRULE:…` fixes one UTC instant and repeats
//! *that*, so every occurrence on the far side of a transition lands an hour
//! wrong. Recurring pages are most of what this export exists to carry, and a
//! format that is right for one-offs but silently shifts a weekly meeting twice
//! a year is not the correct-by-default choice.
//!
//! The `VTIMEZONE` that obligation implies is generated rather than tabulated:
//! [`vtimezone`] probes the zone through [`zoned::utc_to_wall_clock`] (the same
//! chrono-tz data every other layer resolves against) and writes each real
//! transition out as its own observance. No rule is *inferred* — inferring
//! `BYDAY=-1SU` from one transition is the step that gets a hand-rolled
//! `VTIMEZONE` wrong — so the emitted zone is exact within
//! [`VTIMEZONE_FUTURE_YEARS`] of the events it covers, and beyond that a
//! consumer extrapolates from the last observance.

use std::collections::{BTreeSet, HashMap};

use chrono::{Datelike, Days, Duration, NaiveDate, NaiveDateTime, NaiveTime};
use pikos_recurrence::{rewrite_until_with, zoned, WallClock};
use sqlx::Row;

use super::export::fetch_export_pages;
use crate::db::DbState;
use crate::error::{AppError, AppResult};

/// How far past the last exported occurrence the generated `VTIMEZONE` spells
/// its transitions out. An unbounded `RRULE` outruns any window; 30 years puts
/// the edge past the horizon anyone plans against, at ~60 observances per zone.
const VTIMEZONE_FUTURE_YEARS: i32 = 30;

/// Cap on the `DESCRIPTION` a page's body contributes. A Pikos page can hold a
/// whole document; a calendar entry that carried one would fold into thousands
/// of lines and be truncated by the receiving client anyway.
const MAX_DESCRIPTION_CHARS: usize = 4000;

/// RFC 5545 §3.1: content lines are folded at 75 **octets**, excluding the CRLF.
const FOLD_OCTETS: usize = 75;

// ─── Text primitives ──────────────────────────────────────────────────────────

/// RFC 5545 §3.3.11 TEXT escaping: `\`, `;`, `,` and newline. A colon is
/// deliberately *not* escaped — it is only special in a property's name/value
/// split, which has already happened by the time a value gets here. A lone `\r`
/// is dropped rather than doubled so a CRLF in a page body becomes one `\n`.
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

/// Append one content line, folded to [`FOLD_OCTETS`] and CRLF-terminated.
///
/// Continuation lines open with a single space, which counts against the octet
/// budget — hence the narrower limit after the first. Folds land on a character
/// boundary: splitting a multi-byte character across a fold would hand the
/// consumer two invalid fragments, and RFC 5545 §3.1 requires the boundary to be
/// respected even though the count is in octets.
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

// ─── Placement ────────────────────────────────────────────────────────────────

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
    /// One stored `(scheduled_start, scheduled_end, timezone)` triple → a VEVENT
    /// placement. `None` when the start is unparseable or absent.
    ///
    /// **All-day ends invert the reconciler.** Providers send an exclusive
    /// `DTEND` (a single Jun 15 event ends Jun 16) and
    /// `reconciler::allday_end::InclusiveEnd::from_provider` decrements it once
    /// on the way in, so `page_schedules.scheduled_end` holds the **inclusive**
    /// last covered day. Going back out is the same step in reverse: add a day.
    /// A missing end is a one-day event, so it lands on `start + 1` too.
    fn build(start: &str, end: Option<&str>, zone: Option<&str>, device: &str) -> Option<Self> {
        let start_wc = WallClock::parse(start)?;
        let end_wc = end.filter(|e| !e.is_empty()).and_then(WallClock::parse);

        if start_wc.is_all_day() {
            // `.max` guards a stored end that predates its start; the exclusive
            // end must stay strictly after DTSTART for the event to have a day.
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
            // An all-day end on a timed start is contradictory storage; drop it
            // rather than emit a DTEND whose value type fights its DTSTART.
            end: end_wc.filter(|w| !w.is_all_day()).map(|w| w.as_datetime()),
        })
    }

    /// The parameter every value of this event's start/end/exdates carries.
    fn value_param(&self) -> String {
        match self {
            Placement::AllDay { .. } => ";VALUE=DATE".to_string(),
            Placement::Timed { zone, .. } => format!(";TZID={zone}"),
        }
    }

    /// Render an occurrence key — a stored `original_date` or exdate, either a
    /// bare `YYYY-MM-DD` or a full wall clock — in this event's value type, so
    /// `EXDATE`/`RECURRENCE-ID` match `DTSTART` as RFC 5545 §3.8.5.1 requires.
    /// A date-only key on a timed series takes the series' own time of day,
    /// which is the instant the expansion would have produced for that day.
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

    /// The zone a timed placement lives in, for VTIMEZONE collection.
    fn zone(&self) -> Option<&str> {
        match self {
            Placement::AllDay { .. } => None,
            Placement::Timed { zone, .. } => Some(zone),
        }
    }
}

/// The IANA id a timed value is expressed in: the row's own zone when it names
/// one chrono-tz knows, else the device zone, else UTC. A row that stores no
/// zone is device-local by construction (the reschedule writer clears the zone
/// precisely to say "the user just asserted a device-local time").
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

// ─── VTIMEZONE ────────────────────────────────────────────────────────────────

/// Seconds east of UTC that `zone` shows at a UTC instant. An unknown zone
/// answers 0 — [`resolve_zone`] has already refused to emit one.
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

/// Every offset change `zone` makes in `[from, to)`, found by walking UTC in
/// six-hour strides and bisecting the stride that straddles a change. Six hours
/// is under the shortest gap between two real transitions in any zone tzdb
/// carries for the modern era, so no change is stepped over.
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

/// RFC 5545 `UTC-OFFSET`: `+HHMM`, widened to `+HHMMSS` for the pre-1970-style
/// zones whose offset is not a whole minute.
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
/// The first observance anchors the window — a consumer resolves a time by the
/// latest observance at or before it, so without one, anything before the first
/// transition has no offset. Each transition then becomes its own observance,
/// with `DTSTART` in the *outgoing* offset's local time per §3.6.5.
///
/// STANDARD vs DAYLIGHT is read off the direction of the change (a step up is
/// into daylight). A zone that permanently moves its standard offset is labelled
/// as if it were a DST step, which is cosmetic: consumers resolve times from
/// `TZOFFSETTO`, not from which subcomponent it sits in.
fn vtimezone(zone: &str, from: NaiveDateTime, to: NaiveDateTime) -> String {
    let changes = transitions(zone, from, to);
    let base_offset = offset_at(zone, from);
    // In daylight already if the next thing the zone does is fall back.
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

// ─── RRULE ────────────────────────────────────────────────────────────────────

/// The stored rule, with its `UNTIL` moved into the value type `DTSTART` forces.
///
/// Everything else goes out byte for byte — the stored string is already the
/// RFC's own spelling, and a parse round-trip would drop the fields
/// `RecurrenceOptions` doesn't carry. `UNTIL` is the one token that cannot: RFC
/// 5545 §3.3.10 requires it to match `DTSTART`'s value type, and to be UTC when
/// `DTSTART` carries a `TZID`. Pikos stores it as event-zone wall clock (the
/// reconciler rewrites a provider's `…Z` inbound, and `build_rrule` writes
/// `T235959` local), so both readings need the conversion here.
fn export_rrule(rrule: &str, placement: &Placement) -> String {
    rewrite_until_with(rrule, |value| match placement {
        // Date-valued DTSTART: keep the day, drop any time.
        Placement::AllDay { .. } => Some(
            value
                .split(['T', 't'])
                .next()
                .filter(|d| d.len() == 8)?
                .to_string(),
        ),
        Placement::Timed { zone, .. } => {
            // Already UTC — the frame the RFC wants — so leave it alone.
            if value.ends_with('Z') || value.ends_with('z') {
                return None;
            }
            let wall = parse_compact(value)?;
            let utc = zoned::wall_clock_to_utc(zone, wall)?;
            Some(format!("{}Z", datetime_value(utc)))
        }
    })
}

/// `20260701` or `20260701T235959` → the wall clock it spells. A date-only bound
/// on a timed series means "through the end of that day", which is the reading
/// `build_rrule` writes out explicitly anyway.
fn parse_compact(value: &str) -> Option<NaiveDateTime> {
    let date = NaiveDate::parse_from_str(value.get(0..8)?, "%Y%m%d").ok()?;
    match value.len() {
        8 => Some(date.and_time(NaiveTime::from_hms_opt(23, 59, 59)?)),
        15 => Some(NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?),
        _ => None,
    }
}

// ─── VEVENT ───────────────────────────────────────────────────────────────────

/// Everything one VEVENT needs. Overrides reuse it with `recurrence_id` set and
/// no rule of their own, which is exactly the RFC's shape for a moved instance.
struct Vevent<'a> {
    uid: String,
    summary: &'a str,
    description: &'a str,
    placement: Placement,
    /// The `RECURRENCE-ID` tail (`;PARAM:value`) for an override, already
    /// rendered in the **series'** value type. It identifies an occurrence of
    /// the master rule, so it is stated in the master's frame — not in the zone
    /// the moved instance happens to land in, which may differ (the reschedule
    /// writer clears the zone to say "device-local" whenever a user moves one).
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

/// A page body clipped to [`MAX_DESCRIPTION_CHARS`], on a character boundary,
/// with an ellipsis so the clip is visible rather than a body that just stops.
fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_DESCRIPTION_CHARS) {
        None => text.to_string(),
        Some((cut, _)) => format!("{}…", &text[..cut]),
    }
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

/// A recurrence rule row, keyed by page.
struct RuleRow {
    rrule: String,
    exdates_json: String,
    start: String,
    end: Option<String>,
    timezone: String,
}

/// A materialized occurrence override — a `page_schedules` row pointing back at
/// a rule.
struct OverrideRow {
    original_date: String,
    start: String,
    end: Option<String>,
    timezone: Option<String>,
    status: String,
}

/// Build the whole calendar. Split from [`export_ics`] so the folding, escaping
/// and value-type rules are testable without touching the disk.
pub(crate) async fn build_export_ics_impl(
    pool: &sqlx::SqlitePool,
    include_synced: bool,
) -> AppResult<String> {
    let device = pikos_db::device_zone().name().to_string();
    let now = chrono::Utc::now();
    let dtstamp = now.format("%Y%m%dT%H%M%SZ").to_string();

    let pages = fetch_export_pages(
        pool,
        "id, title, content_text, scheduled_start, scheduled_end",
        include_synced,
    )
    .await?;

    // Recurrence, exclusions and overrides each hang off their own table; read
    // once and key by page rather than joining, exactly as the CSV export does.
    let rules: HashMap<String, RuleRow> =
        sqlx::query_as::<_, (String, String, String, String, Option<String>, String)>(
            "SELECT page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone \
             FROM page_recurrence_rules",
        )
        .fetch_all(pool)
        .await?
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

    // A completed or skipped occurrence is not on the calendar: the skip
    // dismissed it, and a completion moves it onto its own done clone page,
    // which exports as its own VEVENT — emitting both would double it.
    let mut exclusions: HashMap<String, Vec<String>> = HashMap::new();
    for (page_id, occurrence_date) in sqlx::query_as::<_, (String, String)>(
        "SELECT page_id, occurrence_date FROM completed_set \
         UNION SELECT page_id, occurrence_date FROM skip_set",
    )
    .fetch_all(pool)
    .await?
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
    .await?
    {
        overrides.entry(page_id).or_default().push(OverrideRow {
            original_date,
            start,
            end,
            timezone,
            status,
        });
    }

    // A one-off page's zone lives on its schedule row, not on the page's denorm
    // columns; key by (page, start) so the row matching the denormalized start
    // is the one that answers.
    let mut schedule_zones: HashMap<(String, String), String> = HashMap::new();
    for (page_id, start, timezone) in sqlx::query_as::<_, (String, String, String)>(
        "SELECT page_id, scheduled_start, timezone FROM page_schedules \
         WHERE timezone IS NOT NULL",
    )
    .fetch_all(pool)
    .await?
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

    for row in &pages {
        let id: String = row.try_get("id").unwrap_or_default();
        let title: String = row.try_get("title").unwrap_or_default();
        let content_text: String = row.try_get("content_text").unwrap_or_default();
        let rule = rules.get(&id);

        // A recurring page anchors on its rule's base occurrence, never on the
        // page's denormalized `scheduled_start` — that column holds the *next*
        // occurrence, and anchoring an RRULE there would drop every occurrence
        // already behind the head.
        let placement = match rule {
            Some(rule) => Placement::build(
                &rule.start,
                rule.end.as_deref(),
                Some(&rule.timezone),
                &device,
            ),
            None => {
                let start: Option<String> = row.try_get("scheduled_start").ok();
                let end: Option<String> = row.try_get("scheduled_end").ok();
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
        // No schedule, no VEVENT — iCalendar has nowhere to put a page that
        // never claimed a moment.
        let Some(placement) = placement else { continue };

        let page_overrides = overrides
            .get(&id)
            .map(Vec::as_slice)
            .filter(|_| rule.is_some())
            .unwrap_or_default();

        // A materialized override replaces its occurrence through
        // RECURRENCE-ID, so it must not also be excluded — an EXDATE would
        // delete the instance the override is there to redefine. A `skipped`
        // row has no instance to redefine, so it excludes instead.
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
            // The moved instance keeps the series' value type by construction:
            // it is the same event, so a timed series' override stays timed.
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

    // The window the generated zones must cover: every timed instant the export
    // emitted, widened to whole years and out past any unbounded rule's horizon.
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

/// Export every scheduled page as one `.ics` file in ~/Downloads. Same
/// destination shape and same return value as the CSV export, so the settings
/// panel treats all three exports identically.
#[tauri::command]
pub async fn export_ics(
    state: tauri::State<'_, DbState>,
    include_synced: bool,
) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let out = build_export_ics_impl(&pool, include_synced).await?;

    let home =
        std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let dest = format!("{home}/Downloads/pikos-export-{timestamp}.ics");

    let event_count = out.matches("BEGIN:VEVENT").count();
    std::fs::write(&dest, out)?;

    log::info!(
        "export_ics events={} dest={}",
        event_count,
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
}

// A child module (rather than a sibling in `dev/tests.rs`) because the folding,
// escaping and offset helpers it pins are private to this file — testing them
// through a sibling would mean widening them for the tests' benefit.
#[cfg(test)]
#[path = "ics_tests.rs"]
mod ics_tests;
