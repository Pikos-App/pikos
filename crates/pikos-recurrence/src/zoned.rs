//! Timezone-aware boundary layer (native mirror of
//! `packages/core/src/utils/zoned.ts` — keep the two in sync).
//!
//! The recurrence engine itself is timezone-naive on purpose: RFC 5545
//! defines recurrence in the event's own wall-clock time. Externally synced
//! events additionally need conversions at the engine's boundary —
//! viewer wall-clock ⇄ UTC instant ⇄ event wall-clock — which this module
//! provides via chrono-tz.
//!
//! Feature-gated behind `tz` so the WebAssembly build never links the
//! embedded timezone database (~2MB); wasm consumers use the platform's own
//! tz data through the Intl-based TS twin instead.
//!
//! DST edge policy (identical in the TS twin):
//! - Nonexistent wall times (spring-forward gap) resolve with the
//!   pre-transition offset, shifting the wall clock forward by the gap
//!   (matches Google Calendar).
//! - Ambiguous wall times (fall-back repeat) resolve to the EARLIEST instant.

use chrono::{Duration, LocalResult, NaiveDateTime, Offset, TimeZone};
use chrono_tz::Tz;

use crate::engine::expand_range;
use crate::WallClock;

/// One occurrence of a zone-aware recurrence, expressed for a viewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZonedOccurrence {
    /// Occurrence date (YYYY-MM-DD) in the EVENT's zone — the stable identity
    /// used for exdates/overrides, matching the source calendar.
    pub original_date: String,
    /// Start as viewer-zone wall-clock ISO.
    pub scheduled_start: String,
    /// End as viewer-zone wall-clock ISO, when the rule has one.
    pub scheduled_end: Option<String>,
    /// Exact UTC instant of the start ('YYYY-MM-DDTHH:MM:SSZ').
    pub utc_start: String,
}

fn parse_naive(s: &str) -> Option<NaiveDateTime> {
    WallClock::parse(s).map(|w| w.as_datetime())
}

fn format_datetime(dt: NaiveDateTime) -> String {
    WallClock {
        date: dt.date(),
        time: Some(dt.time()),
    }
    .format()
}

fn offset_seconds_at(tz: &Tz, utc: NaiveDateTime) -> i64 {
    tz.offset_from_utc_datetime(&utc).fix().local_minus_utc() as i64
}

/// Converts a wall-clock datetime in `zone` to its UTC instant, applying the
/// DST edge policy above. None when the zone name is unknown.
pub fn wall_clock_to_utc(zone: &str, wall: NaiveDateTime) -> Option<NaiveDateTime> {
    let tz: Tz = zone.parse().ok()?;
    Some(match tz.from_local_datetime(&wall) {
        LocalResult::Single(dt) => dt.naive_utc(),
        // Fall-back repeat: earliest instant (first time the clock shows it).
        LocalResult::Ambiguous(a, b) => a.naive_utc().min(b.naive_utc()),
        // Spring-forward gap: interpret with the pre-transition offset — the
        // offset in effect at the earlier of the two candidate instants —
        // which shifts the wall clock forward by the gap.
        LocalResult::None => {
            let cand1 = wall - Duration::seconds(offset_seconds_at(&tz, wall));
            let cand2 = wall - Duration::seconds(offset_seconds_at(&tz, cand1));
            let earlier = cand1.min(cand2);
            wall - Duration::seconds(offset_seconds_at(&tz, earlier))
        }
    })
}

/// Wall-clock datetime shown in `zone` at a UTC instant. None when the zone
/// name is unknown.
pub fn utc_to_wall_clock(zone: &str, utc: NaiveDateTime) -> Option<NaiveDateTime> {
    let tz: Tz = zone.parse().ok()?;
    Some(tz.from_utc_datetime(&utc).naive_local())
}

/// RFC 5545 expresses a timed UNTIL in UTC when DTSTART carries a TZID. The
/// engine compares occurrences in event-zone wall-clock, so rewrite the UNTIL
/// bound into that frame before expansion. Date-only UNTILs and rules without
/// UNTIL pass through unchanged, as does an unknown zone.
pub fn normalize_until_to_zone(rrule: &str, event_zone: &str) -> String {
    let Some(pos) = rrule.find("UNTIL=") else {
        return rrule.to_string();
    };
    let value_start = pos + "UNTIL=".len();
    let value_end = rrule[value_start..]
        .find(';')
        .map(|i| value_start + i)
        .unwrap_or(rrule.len());
    let value = &rrule[value_start..value_end];

    // Only the UTC datetime form ('YYYYMMDDTHHMMSS' + optional Z) converts.
    let compact = value.strip_suffix(['Z', 'z']).unwrap_or(value);
    let Some((date, time)) = compact.split_once(['T', 't']) else {
        return rrule.to_string();
    };
    if date.len() != 8 || time.len() != 6 {
        return rrule.to_string();
    }
    let iso = format!(
        "{}-{}-{}T{}:{}:{}",
        &date[0..4],
        &date[4..6],
        &date[6..8],
        &time[0..2],
        &time[2..4],
        &time[4..6]
    );
    let Some(utc) = parse_naive(&iso) else {
        return rrule.to_string();
    };
    let Some(wall) = utc_to_wall_clock(event_zone, utc) else {
        return rrule.to_string();
    };
    format!(
        "{}UNTIL={}Z{}",
        &rrule[..pos],
        wall.format("%Y%m%dT%H%M%S"),
        &rrule[value_end..]
    )
}

/// Expands a zone-aware recurrence (an externally synced event) into
/// occurrences expressed in the viewer's zone. Mirrors the TS
/// `expandRecurrenceInZone` exactly; see that function for the pipeline.
///
/// `range_start`/`range_end` are viewer-zone wall-clock ISO strings, end
/// exclusive. `exdates` are YYYY-MM-DD dates in the event's zone. All-day
/// rules are zone-less and pass through unconverted.
#[allow(clippy::too_many_arguments)]
pub fn expand_range_in_zone(
    rrule: &str,
    scheduled_start: &str,
    scheduled_end: Option<&str>,
    event_zone: &str,
    viewer_zone: &str,
    range_start: &str,
    range_end: &str,
    exdates: &[String],
) -> Vec<ZonedOccurrence> {
    let all_day = WallClock::parse(scheduled_start).is_none_or(|w| w.is_all_day());

    if all_day {
        return expand_range(rrule, scheduled_start, scheduled_end, range_start, range_end, exdates)
            .unwrap_or_default()
            .into_iter()
            .map(|occ| ZonedOccurrence {
                original_date: occ.original_date,
                utc_start: occ.scheduled_start.clone(),
                scheduled_start: occ.scheduled_start,
                scheduled_end: occ.scheduled_end,
            })
            .collect();
    }

    let to_event_wall = |viewer_iso: &str| -> Option<String> {
        let utc = wall_clock_to_utc(viewer_zone, parse_naive(viewer_iso)?)?;
        Some(format_datetime(utc_to_wall_clock(event_zone, utc)?))
    };
    let (Some(rs), Some(re)) = (to_event_wall(range_start), to_event_wall(range_end)) else {
        return Vec::new();
    };

    let normalized = normalize_until_to_zone(rrule, event_zone);
    expand_range(&normalized, scheduled_start, scheduled_end, &rs, &re, exdates)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|occ| {
            let utc_start = wall_clock_to_utc(event_zone, parse_naive(&occ.scheduled_start)?)?;
            let scheduled_end = match &occ.scheduled_end {
                Some(end) => Some(format_datetime(utc_to_wall_clock(
                    viewer_zone,
                    wall_clock_to_utc(event_zone, parse_naive(end)?)?,
                )?)),
                None => None,
            };
            Some(ZonedOccurrence {
                original_date: occ.original_date,
                scheduled_start: format_datetime(utc_to_wall_clock(viewer_zone, utc_start)?),
                scheduled_end,
                utc_start: format!("{}Z", format_datetime(utc_start)),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors packages/core/src/utils/zoned.test.ts — same zones, same
    // instants, same expected outputs, so TS/Rust parity is pinned by CI on
    // both sides.

    const NY: &str = "America/New_York";
    const LA: &str = "America/Los_Angeles";

    fn dt(iso: &str) -> NaiveDateTime {
        parse_naive(iso).unwrap()
    }

    #[test]
    fn round_trips_standard_and_daylight_time() {
        assert_eq!(wall_clock_to_utc(NY, dt("2026-01-15T09:00:00")), Some(dt("2026-01-15T14:00:00")));
        assert_eq!(wall_clock_to_utc(NY, dt("2026-07-15T09:00:00")), Some(dt("2026-07-15T13:00:00")));
        assert_eq!(utc_to_wall_clock(NY, dt("2026-07-15T13:00:00")), Some(dt("2026-07-15T09:00:00")));
    }

    #[test]
    fn shifts_spring_forward_gap_forward() {
        let utc = wall_clock_to_utc(NY, dt("2026-03-08T02:30:00")).unwrap();
        assert_eq!(utc, dt("2026-03-08T07:30:00"));
        assert_eq!(utc_to_wall_clock(NY, utc), Some(dt("2026-03-08T03:30:00")));
    }

    #[test]
    fn resolves_fall_back_ambiguity_to_earliest() {
        assert_eq!(
            wall_clock_to_utc(NY, dt("2026-11-01T01:30:00")),
            Some(dt("2026-11-01T05:30:00"))
        );
    }

    #[test]
    fn handles_non_hour_offsets() {
        assert_eq!(
            wall_clock_to_utc("Asia/Kathmandu", dt("2026-01-15T09:00:00")),
            Some(dt("2026-01-15T03:15:00"))
        );
    }

    #[test]
    fn unknown_zone_is_none() {
        assert_eq!(wall_clock_to_utc("Not/AZone", dt("2026-01-15T09:00:00")), None);
    }

    #[test]
    fn normalizes_utc_until_into_event_zone() {
        assert_eq!(
            normalize_until_to_zone("FREQ=DAILY;UNTIL=20260701T035959Z", NY),
            "FREQ=DAILY;UNTIL=20260630T235959Z"
        );
        assert_eq!(
            normalize_until_to_zone("FREQ=DAILY;UNTIL=20260701", NY),
            "FREQ=DAILY;UNTIL=20260701"
        );
        assert_eq!(normalize_until_to_zone("FREQ=DAILY;COUNT=3", NY), "FREQ=DAILY;COUNT=3");
    }

    #[test]
    fn keeps_event_wall_clock_fixed_across_dst() {
        let occ = expand_range_in_zone(
            "FREQ=WEEKLY;BYDAY=WE",
            "2026-02-25T09:00:00",
            Some("2026-02-25T10:00:00"),
            NY,
            LA,
            "2026-02-25T00:00:00",
            "2026-03-20T00:00:00",
            &[],
        );
        let starts: Vec<&str> = occ.iter().map(|o| o.scheduled_start.as_str()).collect();
        assert_eq!(
            starts,
            ["2026-02-25T06:00:00", "2026-03-04T06:00:00", "2026-03-11T06:00:00", "2026-03-18T06:00:00"]
        );
        let utcs: Vec<&str> = occ.iter().map(|o| o.utc_start.as_str()).collect();
        assert_eq!(
            utcs,
            [
                "2026-02-25T14:00:00Z",
                "2026-03-04T14:00:00Z",
                "2026-03-11T13:00:00Z",
                "2026-03-18T13:00:00Z"
            ]
        );
        assert_eq!(occ[0].scheduled_end.as_deref(), Some("2026-02-25T07:00:00"));
        assert_eq!(occ[0].original_date, "2026-02-25");
    }

    #[test]
    fn converts_into_fixed_offset_zone() {
        let occ = expand_range_in_zone(
            "FREQ=WEEKLY;BYDAY=WE",
            "2026-02-25T09:00:00",
            None,
            NY,
            "America/Phoenix",
            "2026-03-01T00:00:00",
            "2026-03-20T00:00:00",
            &[],
        );
        let starts: Vec<&str> = occ.iter().map(|o| o.scheduled_start.as_str()).collect();
        assert_eq!(starts, ["2026-03-04T07:00:00", "2026-03-11T06:00:00", "2026-03-18T06:00:00"]);
    }

    #[test]
    fn crosses_the_date_line() {
        let occ = expand_range_in_zone(
            "FREQ=DAILY",
            "2026-01-05T21:00:00",
            None,
            NY,
            "Asia/Tokyo",
            "2026-01-14T00:00:00",
            "2026-01-17T00:00:00",
            &[],
        );
        let starts: Vec<&str> = occ.iter().map(|o| o.scheduled_start.as_str()).collect();
        assert_eq!(starts, ["2026-01-14T11:00:00", "2026-01-15T11:00:00", "2026-01-16T11:00:00"]);
        let dates: Vec<&str> = occ.iter().map(|o| o.original_date.as_str()).collect();
        assert_eq!(dates, ["2026-01-13", "2026-01-14", "2026-01-15"]);
    }

    #[test]
    fn honors_utc_until_at_zone_boundary() {
        let occ = expand_range_in_zone(
            "FREQ=DAILY;UNTIL=20260116T043000Z",
            "2026-01-10T23:00:00",
            None,
            NY,
            NY,
            "2026-01-14T00:00:00",
            "2026-02-01T00:00:00",
            &[],
        );
        let dates: Vec<&str> = occ.iter().map(|o| o.original_date.as_str()).collect();
        assert_eq!(dates, ["2026-01-14", "2026-01-15"]);
    }

    #[test]
    fn occurrence_in_viewer_gap_renders_post_gap() {
        let occ = expand_range_in_zone(
            "FREQ=DAILY",
            "2026-03-01T07:30:00",
            None,
            "Europe/London",
            NY,
            "2026-03-07T00:00:00",
            "2026-03-09T00:00:00",
            &[],
        );
        let starts: Vec<&str> = occ.iter().map(|o| o.scheduled_start.as_str()).collect();
        assert_eq!(starts, ["2026-03-07T02:30:00", "2026-03-08T03:30:00"]);
    }

    #[test]
    fn all_day_rules_pass_through() {
        let occ = expand_range_in_zone(
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-01-05",
            None,
            NY,
            "Asia/Tokyo",
            "2026-01-12T00:00:00",
            "2026-01-20T00:00:00",
            &[],
        );
        let starts: Vec<&str> = occ.iter().map(|o| o.scheduled_start.as_str()).collect();
        assert_eq!(starts, ["2026-01-12", "2026-01-19"]);
        assert_eq!(occ[0].scheduled_end, None);
    }
}
