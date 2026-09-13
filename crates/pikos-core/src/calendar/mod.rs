//! Calendar layout — the portable half.
//!
//! Ported from `apps/desktop/src/features/calendar/utils/`, but deliberately
//! only the part that is platform-independent:
//!
//! | Ported here | Left in the platform layer |
//! |---|---|
//! | overlap clustering, sweep-line column assignment | hour↔pixel mapping, density tables |
//! | all-day row packing, bar coalescing | collapse-band geometry, `barPositionStyle` |
//! | continuation flags, midnight crossing | the text-collision heuristic |
//!
//! The text-collision heuristic is the interesting exclusion. It decides
//! whether two blocks' labels would visually clash by comparing their pixel
//! gap against `CASCADE_MIN_TOP_GAP_PX`, using a `isCompact` flag derived from
//! pixel height. Those thresholds encode one renderer's font metrics and row
//! heights. A native calendar has different ones, so inheriting the constants
//! would be a bug dressed as reuse — iOS should make that call for itself,
//! against the same *column assignment* computed here.
//!
//! Likewise absent: the final `blocks.sort(by leftPct)` that `buildDayBlocks`
//! applies before returning. That orders elements for DOM painting so deeper
//! cascades overlay their hosts; it is not layout, and it is the one part of
//! the pipeline that genuinely does vary with pixel density.

pub mod all_day;
pub mod occurrences;
pub mod timed;

/// The subset of a page the layout algorithms actually read.
///
/// Narrower than `PageSummary` on purpose: layout depends on four fields, so a
/// four-field input keeps the eventual Swift binding small and makes it obvious
/// that nothing here inspects titles, tags, or status.
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
