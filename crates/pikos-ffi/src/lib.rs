//! The Swift-facing surface of Pikos's shared Rust logic.
//!
//! UniFFI generates a Swift package from what this module exports, which is how
//! the iOS app consumes `pikos-core` without reimplementing any of it. The
//! desktop app does not go through here — it links `pikos-core` and `pikos-db`
//! directly through Tauri — so this crate is additive, and nothing about the
//! existing app changes when it does.
//!
//! ## Why the boundary is string-typed
//!
//! Dates cross as `String`, not as a date type. That looks lossy and is
//! deliberate: Pikos stores *local wall-clock* strings with no zone (see
//! `pikos_core::dates`), because "09:00 every day" must stay 09:00 across a DST
//! transition. `Foundation.Date` is an instant. Converting at the boundary
//! would force a zone to be chosen on every call, and the wrong choice silently
//! shifts events by an hour twice a year. Keeping the wire format identical to
//! the storage format means Swift converts once, at the point of display, where
//! the user's calendar is actually the right context.
//!
//! ## Scope
//!
//! Pure logic only, for now. The database layer (`pikos-db`) is async and needs
//! an App Group container path decided on the Swift side first; it is the next
//! layer to land here, and `docs/ios/02-ffi-surface.md` records the shape it
//! will take.

use pikos_core::calendar::all_day::{
    assign_stable_all_day_rows, build_all_day_bars, crossing_midnights_count,
};
use pikos_core::calendar::timed::assign_timed_columns;
use pikos_core::calendar::LayoutPage as CoreLayoutPage;
use pikos_core::dates::parse_local_iso;
use pikos_core::deep_link::{parse_deep_link as core_parse_deep_link, DeepLink as CoreDeepLink};
use pikos_core::recurrence as core_recurrence;
use pikos_core::schedule as core_schedule;
use pikos_core::text::extract_text as core_extract_text;

uniffi::setup_scaffolding!();

// ─── Records ─────────────────────────────────────────────────────────────────

/// The subset of a page the layout algorithms read.
///
/// Mirrors `pikos_core::calendar::LayoutPage`. Duplicated rather than exported
/// directly so the FFI surface can evolve without forcing a change on the core
/// type, and so Swift never sees a field it has no use for.
#[derive(uniffi::Record, Clone)]
pub struct LayoutPage {
    pub id: String,
    /// Stable tiebreaker for equal-length all-day spans. Page ids are UUIDs, so
    /// ordering by them alone would be arbitrary rather than meaningful.
    pub created_at: String,
    /// `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM:SS` (timed); `None` when the
    /// page is unscheduled.
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
}

impl From<&LayoutPage> for CoreLayoutPage {
    fn from(p: &LayoutPage) -> Self {
        CoreLayoutPage {
            id: p.id.clone(),
            created_at: p.created_at.clone(),
            scheduled_start: p.scheduled_start.clone(),
            scheduled_end: p.scheduled_end.clone(),
        }
    }
}

/// One expanded occurrence of a recurring series.
#[derive(uniffi::Record)]
pub struct Occurrence {
    /// The rule's own occurrence date (`YYYY-MM-DD`), used to match skips and
    /// overrides. Always date-only, even for a timed series.
    pub original_date: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
}

impl From<pikos_core::recurrence::Occurrence> for Occurrence {
    fn from(o: pikos_core::recurrence::Occurrence) -> Self {
        Occurrence {
            original_date: o.original_date,
            scheduled_start: o.scheduled_start,
            scheduled_end: o.scheduled_end,
        }
    }
}

/// Structural placement of one timed event within a day.
///
/// Carries no pixels. The cascade column says which lane the event occupies;
/// turning that into a frame is the renderer's job, and iOS should do it with
/// its own metrics rather than inherit the desktop's.
#[derive(uniffi::Record)]
pub struct TimedBlock {
    pub page_id: String,
    /// Sweep-line column: 0 is the cluster host, deeper values cascade over it.
    pub cascade_depth: u32,
    pub is_continuation_before: bool,
    pub is_continuation_after: bool,
}

/// A contiguous run of one all-day page across visible columns, in one row.
#[derive(uniffi::Record)]
pub struct AllDayBar {
    pub page_id: String,
    pub start_col: u32,
    pub span: u32,
    pub row: u32,
    /// The event begins before the visible range — cut the leading edge.
    pub continues_left: bool,
    /// The event ends after the visible range — cut the trailing edge.
    pub continues_right: bool,
}

/// Result of moving a schedule's start. `end` of `None` is a single occurrence.
#[derive(uniffi::Record)]
pub struct ScheduleTransition {
    pub start: String,
    pub end: Option<String>,
}

/// A parsed `pikos://` link.
#[derive(uniffi::Enum)]
pub enum DeepLink {
    Page { page_id: String },
    View { view_id: SmartView },
    Calendar,
    QuickAdd { prefill: String },
    Search { prefill: String },
}

#[derive(uniffi::Enum)]
pub enum SmartView {
    Today,
    Inbox,
}

// ─── Text ────────────────────────────────────────────────────────────────────

/// Plain text of a Tiptap document, for the full-text index.
///
/// iOS calls this on the editor webview's `docChanged` message so search keeps
/// working for anything typed on the phone — the ProseMirror JSON itself is not
/// searchable. Never fails: malformed content yields an empty string rather
/// than blocking the save, because an unsearchable page beats an unsaveable one.
#[uniffi::export]
pub fn extract_text(doc_json: String) -> String {
    core_extract_text(&doc_json)
}

// ─── Deep links ──────────────────────────────────────────────────────────────

/// Parse a `pikos://` URL. Returns `None` for anything unrecognised; callers
/// should treat that as a no-op, since deep links arrive from outside the app.
#[uniffi::export]
pub fn parse_deep_link(url: String) -> Option<DeepLink> {
    core_parse_deep_link(&url).map(|link| match link {
        CoreDeepLink::Page { page_id } => DeepLink::Page { page_id },
        CoreDeepLink::View { view_id } => DeepLink::View {
            view_id: match view_id {
                pikos_core::deep_link::SmartView::Today => SmartView::Today,
                pikos_core::deep_link::SmartView::Inbox => SmartView::Inbox,
            },
        },
        CoreDeepLink::Calendar => DeepLink::Calendar,
        CoreDeepLink::QuickAdd { prefill } => DeepLink::QuickAdd { prefill },
        CoreDeepLink::Search { prefill } => DeepLink::Search { prefill },
    })
}

// ─── Recurrence ──────────────────────────────────────────────────────────────

/// Next occurrence strictly after `after_date`, skipping `exdates`.
///
/// `None` when the series is exhausted, the rule or start is malformed, or
/// every candidate within the internal bound is excluded.
#[uniffi::export]
pub fn next_occurrence_after(
    rrule: String,
    scheduled_start: String,
    after_date: String,
    exdates: Vec<String>,
) -> Option<Occurrence> {
    let after = parse_local_iso(&after_date)?;
    core_recurrence::next_occurrence_after(&rrule, &scheduled_start, &after, &exdates)
        .map(Into::into)
}

/// Carry a series' end onto a new start, preserving duration.
///
/// `None` when either side is all-day. An end earlier than the start means an
/// overnight event, so the end lands on the following day.
#[uniffi::export]
pub fn compute_next_end(base_end: String, next_start: String) -> Option<String> {
    core_schedule_compute_next_end(&base_end, &next_start)
}

fn core_schedule_compute_next_end(base_end: &str, next_start: &str) -> Option<String> {
    core_recurrence::compute_next_end(base_end, next_start)
}

/// Expand a rule into occurrences within `[range_start, range_end)`.
#[uniffi::export]
pub fn expand_recurrence(
    rrule: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
    exdates: Vec<String>,
    range_start: String,
    range_end: String,
) -> Vec<Occurrence> {
    let (Some(from), Some(to)) = (parse_local_iso(&range_start), parse_local_iso(&range_end))
    else {
        return Vec::new();
    };
    core_recurrence::expand_for_range(
        &rrule,
        &scheduled_start,
        scheduled_end.as_deref(),
        &exdates,
        &from,
        &to,
    )
    .into_iter()
    .map(Into::into)
    .collect()
}

// ─── Calendar layout ─────────────────────────────────────────────────────────

/// Cascade columns for every timed event touching `day` (a `YYYY-MM-DD`).
#[uniffi::export]
pub fn layout_timed_day(pages: Vec<LayoutPage>, day: String) -> Vec<TimedBlock> {
    let core: Vec<CoreLayoutPage> = pages.iter().map(Into::into).collect();
    assign_timed_columns(&core, &day)
        .into_iter()
        .map(|b| TimedBlock {
            page_id: b.page_id,
            cascade_depth: b.cascade_depth as u32,
            is_continuation_before: b.is_continuation_before,
            is_continuation_after: b.is_continuation_after,
        })
        .collect()
}

/// All-day bars for `days` (each a `YYYY-MM-DD`), with rows stable across the
/// full span of any event overlapping the range — so a multi-week event keeps
/// its row in every week it appears.
#[uniffi::export]
pub fn layout_all_day(pages: Vec<LayoutPage>, days: Vec<String>) -> Vec<AllDayBar> {
    let core: Vec<CoreLayoutPage> = pages.iter().map(Into::into).collect();
    let slots = assign_stable_all_day_rows(&core, &days);
    build_all_day_bars(&slots)
        .into_iter()
        .map(|b| AllDayBar {
            page_id: b.page_id,
            start_col: b.start_col as u32,
            span: b.span as u32,
            row: b.row as u32,
            continues_left: b.continues_left,
            continues_right: b.continues_right,
        })
        .collect()
}

/// Midnight boundaries strictly between two wall-clock datetimes. An event
/// ending exactly at midnight touches the boundary without crossing it.
#[uniffi::export]
pub fn count_crossing_midnights(start: String, end: String) -> u32 {
    let (Some(s), Some(e)) = (parse_local_iso(&start), parse_local_iso(&end)) else {
        return 0;
    };
    crossing_midnights_count(&s, &e)
}

// ─── Schedule editing ────────────────────────────────────────────────────────

/// Decide what happens to an event's end when its start moves to `iso`.
#[uniffi::export]
pub fn compute_schedule_transition(
    current_start: Option<String>,
    current_end: Option<String>,
    iso: String,
) -> ScheduleTransition {
    let r = core_schedule::compute_schedule_transition(
        current_start.as_deref(),
        current_end.as_deref(),
        &iso,
    );
    ScheduleTransition {
        start: r.start,
        end: r.end,
    }
}

/// Normalise an end-date picker result. `None` means a single-day event.
#[uniffi::export]
pub fn normalize_end_input(current_start: String, end_iso: Option<String>) -> Option<String> {
    core_schedule::normalize_end_input(&current_start, end_iso.as_deref())
}

/// The Tiptap document schema this build writes.
///
/// Exposed so the iOS app can refuse to save over a page whose
/// `contentSchemaVersion` exceeds its own — re-serialising through an older
/// editor schema silently drops node types it cannot represent, which is the
/// corruption mode a second writing client introduces.
#[uniffi::export]
pub fn content_schema_version() -> i64 {
    CONTENT_SCHEMA_VERSION
}

/// Kept in step with `pikos_db::CONTENT_SCHEMA_VERSION` by a test below —
/// this crate does not depend on pikos-db, so the value is mirrored rather
/// than re-exported.
const CONTENT_SCHEMA_VERSION: i64 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    /// `CONTENT_SCHEMA_VERSION` now exists in three places: pikos-db (the
    /// authority), packages/core (for TypeScript callers) and here (so iOS can
    /// check it without linking the database layer). pikos-db already guards
    /// itself against the TypeScript copy; this guards the third.
    ///
    /// Reading the constant out of pikos-db's source rather than depending on
    /// the crate is deliberate — pulling in sqlx and tokio to read one integer
    /// would put a database engine inside a pure-logic binding.
    #[test]
    fn content_schema_version_matches_pikos_db() {
        let db_lib =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pikos-db/src/lib.rs");
        let src = std::fs::read_to_string(&db_lib)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", db_lib.display()));

        const NEEDLE: &str = "pub const CONTENT_SCHEMA_VERSION: i64 = ";
        let start = src
            .find(NEEDLE)
            .unwrap_or_else(|| panic!("`{NEEDLE}` not found in {}", db_lib.display()))
            + NEEDLE.len();
        let digits: String = src[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let db_value: i64 = digits.parse().expect("pikos-db constant parses");

        assert_eq!(
            CONTENT_SCHEMA_VERSION, db_value,
            "CONTENT_SCHEMA_VERSION drifted: pikos-ffi says {CONTENT_SCHEMA_VERSION}, \
             pikos-db says {db_value}. iOS would then believe it can safely write a \
             document shape it cannot represent."
        );
    }

    /// The exported surface is pure and total: no input should panic across the
    /// FFI boundary, because a panic in Rust becomes a crash in the host app
    /// with no Swift-side recovery.
    #[test]
    fn exported_functions_tolerate_malformed_input() {
        let junk = ["", "  ", "not-a-date", "2026-13-45", "\u{0}", "{{{"];
        for s in junk {
            let _ = extract_text(s.to_string());
            let _ = parse_deep_link(s.to_string());
            let _ = count_crossing_midnights(s.to_string(), s.to_string());
            let _ = normalize_end_input(s.to_string(), Some(s.to_string()));
            let _ = compute_schedule_transition(
                Some(s.to_string()),
                Some(s.to_string()),
                s.to_string(),
            );
            let _ = compute_next_end(s.to_string(), s.to_string());
            let _ = next_occurrence_after(s.to_string(), s.to_string(), s.to_string(), vec![]);
            let _ = expand_recurrence(
                s.to_string(),
                s.to_string(),
                None,
                vec![],
                s.to_string(),
                s.to_string(),
            );
            let _ = layout_timed_day(vec![], s.to_string());
            let _ = layout_all_day(vec![], vec![s.to_string()]);
        }
    }

    /// A malformed page must be skipped, not crash the layout pass. Real data
    /// can contain a half-written row after a crash, and the phone should still
    /// render its calendar.
    #[test]
    fn layout_skips_unparseable_pages() {
        let pages = vec![
            LayoutPage {
                id: "bad".into(),
                created_at: "nonsense".into(),
                scheduled_start: Some("2026-02-30T99:99:99".into()),
                scheduled_end: None,
            },
            LayoutPage {
                id: "good".into(),
                created_at: "2026-03-01T00:00:00".into(),
                scheduled_start: Some("2026-03-16T09:00:00".into()),
                scheduled_end: Some("2026-03-16T10:00:00".into()),
            },
        ];
        let blocks = layout_timed_day(pages, "2026-03-16".into());
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].page_id, "good");
    }
}
