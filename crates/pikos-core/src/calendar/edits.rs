//! What a page's schedule becomes when a block on a day grid is dragged, resized or drawn.
//!
//! Wall-clock strings and minutes of a day only: turning a finger's position into a minute is each
//! renderer's own business, since it hangs on that renderer's row heights. Every edit snaps to the
//! quarter hour the desktop's grid snaps to, and stays inside the day it was aimed at.

const QUARTER: i32 = 15;
const DAY_MINUTES: i32 = 24 * 60;
/// The last minute a wall-clock string in a day can name.
const LAST_MINUTE: i32 = DAY_MINUTES - 1;

/// The `YYYY-MM-DD` part of a wall-clock string.
fn day_of(iso: &str) -> Option<&str> {
    iso.get(..10)
}

/// Minutes from midnight in a timed wall-clock string, None for an all-day one.
fn minutes_into_day(iso: &str) -> Option<i32> {
    let bytes = iso.as_bytes();
    let shaped = bytes.len() >= 16 && bytes[10] == b'T' && bytes[13] == b':';
    if !shaped {
        return None;
    }

    let hour: i32 = iso.get(11..13)?.parse().ok()?;
    let minute: i32 = iso.get(14..16)?.parse().ok()?;
    let in_range = (0..24).contains(&hour) && (0..60).contains(&minute);
    in_range.then_some(hour * 60 + minute)
}

fn wall_clock(day: &str, minute: i32) -> String {
    let minute = minute.clamp(0, LAST_MINUTE);
    format!("{day}T{:02}:{:02}:00", minute / 60, minute % 60)
}

fn nearest_quarter(minute: f64) -> i32 {
    (minute / f64::from(QUARTER)).round() as i32 * QUARTER
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    pub start: String,
    pub end: Option<String>,
}

/// The schedule a page dropped at `minute` of `day` takes. A timed page keeps its length; anything
/// else lands as a start with no end. An end is held to the day rather than rolled into tomorrow,
/// since a drop is aimed at the day on screen.
pub fn drop_schedule(
    day: &str,
    minute: i32,
    previous_start: Option<&str>,
    previous_end: Option<&str>,
) -> Schedule {
    let start_minute = minute.clamp(0, LAST_MINUTE);
    let start = wall_clock(day, start_minute);
    let length = match (previous_start, previous_end) {
        (Some(from), Some(to)) if day_of(from) == day_of(to) => {
            match (minutes_into_day(from), minutes_into_day(to)) {
                (Some(from), Some(to)) if to > from => Some(to - from),
                _ => None,
            }
        }
        _ => None,
    };

    Schedule {
        start,
        end: length.map(|length| wall_clock(day, start_minute + length)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Top,
    Bottom,
}

/// A timed page with one edge dragged to `minute`, snapped to the nearest quarter hour. The other
/// edge stays put and the page is never shorter than a quarter hour. A page with no end is a point
/// in time, so its far edge is its start. None for what an edge can't change: an all-day page, or
/// one that crosses midnight.
pub fn resize(start: &str, end: Option<&str>, edge: Edge, minute: i32) -> Option<(String, String)> {
    let day = day_of(start)?;
    let from = minutes_into_day(start)?;
    let to = match end {
        Some(end) if day_of(end) == Some(day) => minutes_into_day(end)?,
        Some(_) => return None,
        None => from,
    };

    let snapped = nearest_quarter(f64::from(minute));
    match edge {
        Edge::Top => {
            let new_start = snapped.min(to.max(from + QUARTER) - QUARTER).max(0);
            let new_end = to.max(new_start + QUARTER);
            Some((wall_clock(day, new_start), wall_clock(day, new_end)))
        }
        Edge::Bottom => {
            let new_end = snapped.max(from + QUARTER);
            Some((start.to_owned(), wall_clock(day, new_end)))
        }
    }
}

/// The minutes a new block covers while a finger that pressed at `pressed` is drawn to `reached`.
/// The far edge follows the finger to the nearest quarter hour and the pressed quarter stays
/// covered, so drawing up past the press makes the press the end.
pub fn stretch(pressed: i32, reached: f64) -> (i32, i32) {
    let reached = nearest_quarter(reached).clamp(0, DAY_MINUTES);
    if reached >= pressed {
        return (pressed, reached.max(pressed + QUARTER));
    }

    let top = reached.min(pressed - QUARTER).max(0);
    (top, pressed + QUARTER)
}

#[cfg(test)]
#[path = "edits_tests.rs"]
mod tests;
