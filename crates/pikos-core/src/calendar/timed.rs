//! Timed-event overlap clustering and sweep-line column assignment.
//!
//! Answers one question: given the timed events touching a day, which column
//! (cascade depth) does each one occupy? Pixel placement is the renderer's job;
//! this decides the structure the renderer places.

use chrono::{Duration, NaiveDateTime, Timelike};

use super::LayoutPage;
use crate::dates::{is_all_day_iso, parse_local_iso};

/// Minimum visual duration of a timed event, in minutes.
///
/// A zero-length or very short event still occupies a readable slot, and that
/// slot is what overlap is computed against — two 5-minute events 10 minutes
/// apart do overlap, because both are quantized up to 15.
const MIN_TIMED_MINUTES: i64 = 15;

/// One timed event's structural placement within a day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimedBlock {
    pub page_id: String,
    /// Sweep-line column. 0 is the cluster host; deeper values cascade over it.
    pub cascade_depth: usize,
    /// The event began before this day.
    pub is_continuation_before: bool,
    /// The event continues past the end of this day.
    pub is_continuation_after: bool,
}

const MINUTES_PER_DAY: f64 = 1440.0;

/// Internal per-event view, in minutes of the grid rather than pixels.
struct Raw {
    page_id: String,
    start: NaiveDateTime,
    /// Start clamped into the day.
    visual_start: NaiveDateTime,
    /// Where the block's top edge is drawn, in minutes from midnight. Usually
    /// the start, but a floored block late in the day rises to stay on the grid.
    top: f64,
    /// Visual end used for overlap: what the drawn block covers.
    overlap_end: NaiveDateTime,
    is_continuation_before: bool,
    is_continuation_after: bool,
}

fn minute_of_day(at: NaiveDateTime) -> f64 {
    f64::from(at.hour() * 60 + at.minute())
}

fn build_raw(
    page: &LayoutPage,
    day_start: NaiveDateTime,
    day_end: NaiveDateTime,
    shortest_block_minutes: f64,
) -> Option<Raw> {
    let start_str = page.scheduled_start.as_deref()?;
    if is_all_day_iso(start_str) {
        return None;
    }
    let real_start = parse_local_iso(start_str)?;
    let has_end = page.scheduled_end.is_some();
    let real_end = match page.scheduled_end.as_deref() {
        Some(e) => parse_local_iso(e)?,
        None => real_start,
    };

    // Overlap with the day is half-open on both sides: an event ending exactly
    // at midnight belongs to the previous day only. One with no length belongs
    // where its start falls, or at exactly midnight it would land on no day.
    let touches_day = if real_end > real_start {
        real_start < day_end && real_end > day_start
    } else {
        real_start >= day_start && real_start < day_end
    };
    if !touches_day {
        return None;
    }

    let duration_minutes = if has_end {
        (real_end - real_start).num_milliseconds() as f64 / 60_000.0
    } else {
        0.0
    };

    let is_continuation_before = real_start < day_start;
    let is_continuation_after = has_end && duration_minutes > 0.0 && real_end >= day_end;

    let visual_start = if is_continuation_before {
        day_start
    } else {
        real_start
    };
    let visual_end = if is_continuation_after {
        day_end
    } else {
        real_end
    };

    let slot = MIN_TIMED_MINUTES as f64;
    let visual_duration = slot.max((duration_minutes.max(0.0) / slot).ceil() * slot);

    let start_minute = minute_of_day(visual_start);
    let end_minute = if is_continuation_after {
        MINUTES_PER_DAY
    } else if is_continuation_before {
        minute_of_day(visual_end)
    } else {
        MINUTES_PER_DAY.min(start_minute + visual_duration)
    };
    let height = (end_minute - start_minute).max(shortest_block_minutes);
    let top = start_minute.min(MINUTES_PER_DAY - height);

    let overlap_end = if is_continuation_after {
        visual_end
    } else {
        // Truncated to the millisecond, as a JavaScript Date is.
        let overlap_ms = (visual_duration.max(height) * 60_000.0) as i64;
        visual_start + Duration::milliseconds(overlap_ms)
    };

    Some(Raw {
        page_id: page.id.clone(),
        start: real_start,
        visual_start,
        top,
        overlap_end,
        is_continuation_before,
        is_continuation_after,
    })
}

/// Group into transitively-connected overlap clusters.
///
/// Requires input sorted by top. A overlapping B and B overlapping C
/// puts all three in one cluster even when A and C do not touch.
fn group_into_clusters(raws: Vec<Raw>) -> Vec<Vec<Raw>> {
    let mut clusters: Vec<Vec<Raw>> = Vec::new();
    let mut current: Vec<Raw> = Vec::new();
    let mut current_end: Option<NaiveDateTime> = None;

    for raw in raws {
        if let Some(end) = current_end {
            if raw.visual_start >= end && !current.is_empty() {
                clusters.push(std::mem::take(&mut current));
                current_end = None;
            }
        }
        let end = raw.overlap_end;
        current.push(raw);
        current_end = Some(match current_end {
            Some(e) if e >= end => e,
            _ => end,
        });
    }
    if !current.is_empty() {
        clusters.push(current);
    }
    clusters
}

/// Assign a sweep-line column to each event in one cluster.
///
/// Columns are walked from the highest down, and a free column is reused only
/// when every column above it is also free. Reusing a lower column while a
/// higher one is still alive would place the new event underneath a cascade
/// that is still painted over it, hiding it.
fn assign_columns(cluster: &[Raw]) -> Vec<usize> {
    let mut column_overlap_ends: Vec<NaiveDateTime> = Vec::new();
    let mut assignments = Vec::with_capacity(cluster.len());

    for raw in cluster {
        let mut assigned: Option<usize> = None;
        for col in (0..column_overlap_ends.len()).rev() {
            if column_overlap_ends[col] > raw.visual_start {
                break; // still alive — blocks every column below it
            }
            assigned = Some(col);
        }
        match assigned {
            Some(col) => {
                column_overlap_ends[col] = raw.overlap_end;
                assignments.push(col);
            }
            None => {
                assignments.push(column_overlap_ends.len());
                column_overlap_ends.push(raw.overlap_end);
            }
        }
    }
    assignments
}

/// Structural layout for every timed event touching `day` (a `YYYY-MM-DD`).
///
/// `shortest_block_minutes` is the shortest a block is drawn, in minutes of
/// the grid: the renderer's minimum block height over its hour height, times
/// 60. Overlap is decided by what is drawn, so a floored block claims the
/// minutes its height covers, or a 9:00 reminder drawn 24 minutes tall would
/// sit on a 9:15 event. That makes columns depend on the renderer's metrics,
/// which is why the caller passes them in as minutes rather than this crate
/// carrying any pixels.
///
/// Returns blocks in cluster order. The TypeScript original additionally sorts
/// its result by `leftPct` before returning, to control DOM paint order; that
/// is a rendering concern and is deliberately not reproduced here.
pub fn assign_timed_columns(
    pages: &[LayoutPage],
    day: &str,
    shortest_block_minutes: f64,
) -> Vec<TimedBlock> {
    let Some(day_start) = parse_local_iso(day) else {
        return Vec::new();
    };
    let day_end = day_start + Duration::days(1);

    let mut raws: Vec<Raw> = pages
        .iter()
        .filter_map(|p| build_raw(p, day_start, day_end, shortest_block_minutes))
        .collect();

    if raws.is_empty() {
        return Vec::new();
    }

    raws.sort_by(|a, b| {
        a.top
            .total_cmp(&b.top)
            .then_with(|| a.start.cmp(&b.start))
            .then_with(|| a.page_id.cmp(&b.page_id))
    });

    let mut blocks = Vec::new();
    for cluster in group_into_clusters(raws) {
        let assignments = assign_columns(&cluster);
        for (raw, depth) in cluster.iter().zip(assignments) {
            blocks.push(TimedBlock {
                page_id: raw.page_id.clone(),
                cascade_depth: depth,
                is_continuation_before: raw.is_continuation_before,
                is_continuation_after: raw.is_continuation_after,
            });
        }
    }
    blocks
}
