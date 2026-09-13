//! Reading and resolving schedule values.
//!
//! Two shapes exist — all-day and timed — and the whole schedule model turns on
//! the distinction. Everything here is pure: it decides what a write *would* be,
//! so a rejection lands before the first write rather than half-way through one.

use pikos_recurrence::WallClock;

use crate::error::CliError;

/// Parse `list --due`: a single day, or a `YYYY-MM-DD..YYYY-MM-DD` range, into
/// the `(scheduled_after, scheduled_before)` bounds a `PageFilter` takes.
pub fn parse_due(due: &str) -> Result<(String, String), CliError> {
    let is_date = |s: &str| shape_of(s) == Some(Shape::AllDay);
    let end_of = |d: &str| format!("{d}T23:59:59");
    if let Some((a, b)) = due.split_once("..") {
        if !is_date(a) || !is_date(b) {
            return Err(CliError::usage(format!(
                "--due range must be YYYY-MM-DD..YYYY-MM-DD (got \"{due}\")"
            )));
        }
        return Ok((a.to_string(), end_of(b)));
    }
    if !is_date(due) {
        return Err(CliError::usage(format!(
            "--due must be YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD (got \"{due}\")"
        )));
    }
    Ok((due.to_string(), end_of(due)))
}

/// All-day or timed, the distinction the whole schedule model turns on — a
/// date-only string is all-day, a full local timestamp is timed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    AllDay,
    Timed,
}

/// The shape of a stored or supplied schedule value, or None if it is neither.
///
/// The lengths pin zero-padding, which chrono's `%m`/`%d` do not: "2026-9-1"
/// parses fine and then sorts before every padded date it should follow.
/// `scheduled_start` carries no CHECK, so an unparsed "tomorrow" would sit in the
/// column reading as garbage against every date compare and rendering nowhere.
pub fn shape_of(value: &str) -> Option<Shape> {
    match WallClock::parse(value)? {
        w if w.is_all_day() && value.len() == 10 => Some(Shape::AllDay),
        w if !w.is_all_day() && value.len() == 19 => Some(Shape::Timed),
        _ => None,
    }
}

/// What `update` will write to the schedule.
#[derive(Debug)]
pub struct ScheduleChange {
    pub start: String,
    pub end: Option<String>,
}

/// Resolve `--due` / `--all-day` / `--end` against the page's current schedule.
///
/// The rule is that a flag never silently changes a page's *shape*. A bare date
/// aimed at a timed page is refused rather than quietly converting it, because
/// that conversion also destroys the time and the end, and nothing in the command
/// said so; `--all-day` is the one way to ask for it, and a timestamp is the one
/// way to ask for the reverse. `--end` alone extends a page without moving it.
///
/// Duration is the deliberate exception: a bare timed `--due` keeps the length
/// the page already had, because dragging a block in the app keeps its length and
/// dropping the end silently is the same defect this refusal exists to prevent.
/// Explicit governs the shape, not the length — which is also why `--all-day`
/// only clears an end it cannot represent (a timed one), and preserves a span it
/// can.
pub fn resolve_schedule_change(
    current: Option<(&str, Option<&str>)>,
    due: Option<&str>,
    all_day: Option<&str>,
    end: Option<&str>,
) -> Result<Option<ScheduleChange>, CliError> {
    if due.is_none() && all_day.is_none() && end.is_none() {
        return Ok(None);
    }
    let current_shape = current.and_then(|(s, _)| shape_of(s));

    if let Some(v) = all_day {
        if shape_of(v) != Some(Shape::AllDay) {
            return Err(CliError::usage(format!(
                "--all-day must be YYYY-MM-DD — use --due for a time of day (got \"{v}\")"
            )));
        }
    }
    if let Some(v) = due {
        match shape_of(v) {
            None => {
                return Err(CliError::usage(format!(
                    "--due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS (got \"{v}\")"
                )))
            }
            Some(Shape::AllDay) if current_shape == Some(Shape::Timed) => {
                return Err(CliError::usage(format!(
                    "This page is scheduled at a time of day, and \"{v}\" names only a date. \
                     Use --due {v}THH:MM:SS to move it and keep the time, or --all-day {v} to \
                     make it an all-day page."
                )))
            }
            _ => {}
        }
    }

    let (start, start_shape) =
        match (due, all_day) {
            (Some(v), _) => (v.to_string(), shape_of(v).expect("validated above")),
            (_, Some(v)) => (v.to_string(), Shape::AllDay),
            // A start the shape check can't read counts as no start: the page has
            // nothing `--end` can extend either way.
            (None, None) => match (current, current_shape) {
                (Some((s, _)), Some(shape)) => (s.to_string(), shape),
                _ => return Err(CliError::usage(
                    "--end needs a page that is already scheduled — pass --due or --all-day too.",
                )),
            },
        };

    let end = match end {
        Some(v) => Some(validated_end(v, &start, start_shape)?),
        None => carried_end(current, &start, start_shape),
    };
    Ok(Some(ScheduleChange { start, end }))
}

/// An explicit `--end`, refused unless it matches the start's shape and follows
/// it. An all-day end is the last day the page covers, so it may equal the start.
fn validated_end(value: &str, start: &str, start_shape: Shape) -> Result<String, CliError> {
    if shape_of(value) != Some(start_shape) {
        return Err(CliError::usage(match start_shape {
            Shape::AllDay => {
                format!("--end must be YYYY-MM-DD to match an all-day page (got \"{value}\")")
            }
            Shape::Timed => {
                format!("--end must be YYYY-MM-DDTHH:MM:SS to match a timed page (got \"{value}\")")
            }
        }));
    }
    let too_early = match start_shape {
        Shape::AllDay => value < start,
        Shape::Timed => value <= start,
    };
    if too_early {
        return Err(CliError::usage(format!(
            "--end \"{value}\" is not after the start \"{start}\"."
        )));
    }
    Ok(value.to_string())
}

/// The end a page keeps when `--end` wasn't given.
fn carried_end(
    current: Option<(&str, Option<&str>)>,
    start: &str,
    start_shape: Shape,
) -> Option<String> {
    let (current_start, current_end) = current?;
    let current_end = current_end?;
    if shape_of(current_start) != Some(start_shape) || shape_of(current_end) != Some(start_shape) {
        return None;
    }
    match start_shape {
        Shape::AllDay => (current_end >= start).then(|| current_end.to_string()),
        Shape::Timed => {
            let parse = |v: &str| WallClock::parse(v).map(|w| w.as_datetime());
            let duration = parse(current_end)? - parse(current_start)?;
            if duration <= chrono::TimeDelta::zero() {
                return None;
            }
            Some(WallClock::timed(parse(start)? + duration).format())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_due_single_date() {
        let (after, before) = parse_due("2026-05-24").unwrap();
        assert_eq!(after, "2026-05-24");
        assert_eq!(before, "2026-05-24T23:59:59");
    }

    #[test]
    fn parse_due_range() {
        let (after, before) = parse_due("2026-05-01..2026-05-31").unwrap();
        assert_eq!(after, "2026-05-01");
        assert_eq!(before, "2026-05-31T23:59:59");
    }

    #[test]
    fn parse_due_rejects_garbage() {
        let err = parse_due("nope").unwrap_err();
        assert_eq!(err.kind, "Usage");
        assert_eq!(err.code, 2);
        let err2 = parse_due("2026-5-1").unwrap_err();
        assert_eq!(err2.kind, "Usage");
    }

    const TIMED: Option<(&str, Option<&str>)> =
        Some(("2026-05-20T09:00:00", Some("2026-05-20T11:00:00")));
    const ALL_DAY_SPAN: Option<(&str, Option<&str>)> = Some(("2026-05-20", Some("2026-05-22")));

    fn resolve(
        current: Option<(&str, Option<&str>)>,
        due: Option<&str>,
        all_day: Option<&str>,
        end: Option<&str>,
    ) -> (String, Option<String>) {
        let change = resolve_schedule_change(current, due, all_day, end)
            .unwrap()
            .expect("a flag was passed");
        (change.start, change.end)
    }

    #[test]
    fn no_schedule_flag_leaves_the_schedule_alone() {
        assert!(resolve_schedule_change(TIMED, None, None, None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_bare_timed_due_carries_the_duration() {
        let (start, end) = resolve(TIMED, Some("2026-06-01T14:00:00"), None, None);
        assert_eq!(start, "2026-06-01T14:00:00");
        assert_eq!(end.as_deref(), Some("2026-06-01T16:00:00"));
    }

    #[test]
    fn a_bare_date_on_a_timed_page_is_refused() {
        let err = resolve_schedule_change(TIMED, Some("2026-06-01"), None, None).unwrap_err();
        assert_eq!(err.kind, "Usage");
        assert!(err.message.contains("--due 2026-06-01THH:MM:SS"));
        assert!(err.message.contains("--all-day 2026-06-01"));
    }

    #[test]
    fn all_day_converts_a_timed_page_and_drops_the_end_it_cannot_hold() {
        let (start, end) = resolve(TIMED, None, Some("2026-06-01"), None);
        assert_eq!(start, "2026-06-01");
        assert_eq!(end, None);
    }

    #[test]
    fn moving_an_all_day_page_keeps_its_span() {
        let (_, kept) = resolve(ALL_DAY_SPAN, Some("2026-05-21"), None, None);
        assert_eq!(kept.as_deref(), Some("2026-05-22"));
        let (_, shifted) = resolve(ALL_DAY_SPAN, None, Some("2026-05-21"), None);
        assert_eq!(shifted.as_deref(), Some("2026-05-22"));
    }

    #[test]
    fn a_span_left_behind_by_the_move_is_dropped() {
        let (_, end) = resolve(ALL_DAY_SPAN, Some("2026-06-01"), None, None);
        assert_eq!(end, None);
    }

    #[test]
    fn all_day_rejects_a_timestamp() {
        let err =
            resolve_schedule_change(TIMED, None, Some("2026-06-01T09:00:00"), None).unwrap_err();
        assert_eq!(err.kind, "Usage");
        assert!(err.message.contains("--due"));
    }

    #[test]
    fn end_alone_extends_without_moving() {
        let (start, end) = resolve(TIMED, None, None, Some("2026-05-20T17:00:00"));
        assert_eq!(start, "2026-05-20T09:00:00");
        assert_eq!(end.as_deref(), Some("2026-05-20T17:00:00"));
    }

    #[test]
    fn end_must_match_the_shape_it_is_extending() {
        let err = resolve_schedule_change(TIMED, None, None, Some("2026-05-21")).unwrap_err();
        assert!(err.message.contains("YYYY-MM-DDTHH:MM:SS"));
        let err = resolve_schedule_change(ALL_DAY_SPAN, None, None, Some("2026-05-21T09:00:00"))
            .unwrap_err();
        assert!(err.message.contains("YYYY-MM-DD to match an all-day page"));
    }

    #[test]
    fn end_must_follow_the_start() {
        let err =
            resolve_schedule_change(TIMED, None, None, Some("2026-05-20T09:00:00")).unwrap_err();
        assert_eq!(err.kind, "Usage");
        // An all-day end is the last day covered, so the start's own day is fine.
        let (_, same_day) = resolve(ALL_DAY_SPAN, None, None, Some("2026-05-20"));
        assert_eq!(same_day.as_deref(), Some("2026-05-20"));
    }

    #[test]
    fn end_alone_needs_something_to_extend() {
        let err = resolve_schedule_change(None, None, None, Some("2026-05-21")).unwrap_err();
        assert_eq!(err.kind, "Usage");
    }

    #[test]
    fn converting_all_day_to_timed_starts_a_fresh_duration() {
        let (start, end) = resolve(ALL_DAY_SPAN, Some("2026-05-21T09:00:00"), None, None);
        assert_eq!(start, "2026-05-21T09:00:00");
        assert_eq!(end, None);
    }

    #[test]
    fn scheduling_an_unscheduled_page_still_works_both_ways() {
        assert_eq!(
            resolve(None, Some("2026-06-01"), None, None).0,
            "2026-06-01"
        );
        assert_eq!(
            resolve(None, Some("2026-06-01T09:00:00"), None, None).0,
            "2026-06-01T09:00:00"
        );
        assert_eq!(
            resolve(None, None, Some("2026-06-01"), None).0,
            "2026-06-01"
        );
    }

    #[test]
    fn due_still_rejects_an_unparseable_date() {
        for bad in ["tomorrow", "2026-5-1", "2026-06-01T09:00"] {
            let err = resolve_schedule_change(None, Some(bad), None, None).unwrap_err();
            assert_eq!(err.kind, "Usage", "{bad}");
            assert_eq!(err.code, 2, "{bad}");
        }
    }
}
