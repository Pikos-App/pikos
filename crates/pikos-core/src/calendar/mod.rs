//! Calendar layout, the portable half.
//!
//! Ported from `apps/desktop/src/features/calendar/utils/`: overlap clustering, column
//! assignment, all-day row packing, bar coalescing, continuation flags and midnight crossing.
//! Hour-to-pixel mapping, density tables, collapse-band geometry and the text-collision
//! heuristic stay in the platform layer. The heuristic's thresholds encode one renderer's font
//! metrics and row heights, so a native calendar must choose its own against the same column
//! assignment computed here. Column assignment reads one metric, the shortest a block is drawn,
//! which the caller passes as minutes (see [`timed::assign_timed_columns`]).
//!
//! The final `blocks.sort(by leftPct)` in `buildDayBlocks` is absent too: it orders DOM
//! painting, not layout.

pub mod all_day;
pub mod edits;
pub mod occurrences;
pub mod timed;

/// The subset of a page the layout algorithms read. Four fields, so nothing here inspects
/// titles, tags or status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutPage {
    pub id: String,
    /// Stable, user-meaningful tiebreaker for equal-length all-day spans.
    /// Page ids are UUIDs, so ordering by them alone would be arbitrary.
    pub created_at: String,
    /// Local wall-clock ISO string: `YYYY-MM-DD` (all-day) or
    /// `YYYY-MM-DDTHH:MM:SS` (timed). `None` means unscheduled.
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
}
