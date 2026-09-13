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
use pikos_core::nlp::quick_add as core_quick_add;
use pikos_core::schedule as core_schedule;
use pikos_core::text::extract_text as core_extract_text;

pub mod workspace;

pub use workspace::{
    Folder, FolderAssignment, FolderScope, NewPage, Page, PageEdit, PageQuery, PageSummary,
    ReadOnlyWorkspace, SearchHit, Workspace, WorkspaceError,
};

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

impl From<pikos_recurrence::Occurrence> for Occurrence {
    fn from(o: pikos_recurrence::Occurrence) -> Self {
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

/// One thing for the calendar to draw.
///
/// Flattened on purpose. A recurring page is stored once — a head row plus a
/// rule — and its other occurrences are projected at display time rather than
/// written out, so the calendar's input is not "the pages in this range": it is
/// the pages *plus* whatever the rules project onto it. Working that out needs
/// three queries and a merge, and doing it in Swift would mean reimplementing
/// the desktop's `useRecurrenceExpansion` a second time, in a second language,
/// with no way to grade it. `Workspace::calendar_range` does it once.
#[derive(uniffi::Record, Debug)]
pub struct CalendarEntry {
    pub page_id: String,
    /// Distinct per drawn item — the page id for a real block, and the page id
    /// plus the occurrence's date for a projected one. `page_id` is *not*
    /// unique here: a weekly series appears several times in a week and every
    /// one of those carries the same page id, deliberately (see
    /// `pikos_core::calendar::occurrences`).
    pub key: String,
    pub title: String,
    pub status: String,
    pub priority: i64,
    pub folder_id: Option<String>,
    pub tags: Vec<String>,
    /// Tiebreaker for equal-length all-day spans, and nothing else.
    pub created_at: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    /// Projected from a recurrence rule: there is no row behind it, so editing
    /// it has to materialise one first.
    pub is_virtual: bool,
    /// The rule's own date for this occurrence, which is how a skip or an
    /// override is matched back to it. `None` on a real block.
    pub original_date: Option<String>,
}

/// What completing one occurrence of a series did.
///
/// Narrow on purpose. The caller refreshes its list afterwards, so the full
/// rows would be thrown away; what it cannot get from a refresh is *which*
/// clone was created, and whether the head advanced or the series is finished.
#[derive(uniffi::Record, Debug)]
pub struct RecurringCompletion {
    /// The completed clone. Keeping this is what makes the completion undoable
    /// without re-deriving which occurrence was meant.
    pub clone_id: String,
    /// `"done"` once the series is exhausted; otherwise the head has advanced.
    pub head_status: String,
    /// Where the head advanced to, if anywhere.
    pub head_scheduled_start: Option<String>,
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
    // The engine returns the start alone — pairing it with an end is
    // `compute_next_end`'s job, because carrying a duration across a day
    // boundary is a separate decision from finding the next date.
    let (start, end) =
        pikos_recurrence::next_occurrence_after(&rrule, &scheduled_start, &after_date, &exdates)
            .ok()
            .flatten()?;
    Some(Occurrence {
        original_date: start.get(..10).unwrap_or(&start).to_string(),
        scheduled_start: start,
        scheduled_end: end,
    })
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
    pikos_recurrence::compute_next_end(base_end, next_start)
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
    // A rule that will not parse yields nothing rather than an error: the
    // callers are display paths, and a malformed series must not blank a screen.
    pikos_recurrence::expand_range(
        &rrule,
        &scheduled_start,
        scheduled_end.as_deref(),
        &range_start,
        &range_end,
        &exdates,
    )
    .unwrap_or_default()
    .into_iter()
    .map(Into::into)
    .collect()
}

// ─── Quick add ───────────────────────────────────────────────────────────────

/// What a quick-add line said about priority.
///
/// Three states, not two: writing nothing leaves an existing priority alone,
/// while `!0` clears it. Collapsing them into an optional would make "no
/// priority mentioned" indistinguishable from "remove the priority", and the
/// second is a real edit.
#[derive(uniffi::Enum)]
pub enum PriorityEdit {
    Unchanged,
    Cleared,
    Set { priority: Priority },
}

#[derive(uniffi::Enum)]
pub enum Priority {
    Urgent,
    High,
    Medium,
    Low,
}

/// One page's worth of quick-add input.
#[derive(uniffi::Record)]
pub struct QuickAddInput {
    pub title: String,
    /// `YYYY-MM-DD` for an all-day page, `YYYY-MM-DDTHH:MM:SS` for a timed one.
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub duration_minutes: Option<i64>,
    pub tags: Vec<String>,
    /// A folder *name* as typed, not an id — matching it against the workspace
    /// is the caller's job, because only it knows the folder tree.
    pub folder_query: Option<String>,
    pub priority: PriorityEdit,
}

/// What a quick-add line asked for.
#[derive(uniffi::Enum)]
pub enum QuickAddResult {
    /// One page.
    Single { input: QuickAddInput },
    /// Several concrete pages — the user named specific days ("m/w/f",
    /// "weekdays") rather than a rule.
    Finite { inputs: Vec<QuickAddInput> },
    /// One page plus a recurrence rule; occurrences are expanded at display
    /// time rather than written out.
    Recurring { input: QuickAddInput, rrule: String },
}

/// Parse a line of quick-add input — "standup every weekday at 9am #work".
///
/// `reference` is "now" as a wall-clock ISO string, and it is a parameter
/// rather than read from the clock so the same line parses the same way in a
/// test, in a widget, and in the app. `None` when `reference` is malformed;
/// an input with nothing parseable in it is not an error, it is a page whose
/// title is the whole line.
#[uniffi::export]
pub fn parse_quick_add(input: String, reference: String) -> Option<QuickAddResult> {
    let reference = parse_local_iso(&reference)?;
    Some(core_quick_add::parse_input(&input, reference).into())
}

impl From<core_quick_add::Priority> for Priority {
    fn from(priority: core_quick_add::Priority) -> Self {
        match priority {
            core_quick_add::Priority::Urgent => Priority::Urgent,
            core_quick_add::Priority::High => Priority::High,
            core_quick_add::Priority::Medium => Priority::Medium,
            core_quick_add::Priority::Low => Priority::Low,
        }
    }
}

impl From<core_quick_add::ParsedInput> for QuickAddInput {
    fn from(input: core_quick_add::ParsedInput) -> Self {
        Self {
            title: input.title,
            scheduled_start: input.scheduled_start,
            scheduled_end: input.scheduled_end,
            duration_minutes: input.duration_minutes,
            tags: input.tags,
            folder_query: input.folder_query,
            priority: match input.priority {
                None => PriorityEdit::Unchanged,
                Some(None) => PriorityEdit::Cleared,
                Some(Some(priority)) => PriorityEdit::Set {
                    priority: priority.into(),
                },
            },
        }
    }
}

impl From<core_quick_add::ParseResult> for QuickAddResult {
    fn from(result: core_quick_add::ParseResult) -> Self {
        match result {
            core_quick_add::ParseResult::Single { input } => QuickAddResult::Single {
                input: input.into(),
            },
            core_quick_add::ParseResult::Finite { inputs } => QuickAddResult::Finite {
                inputs: inputs.into_iter().map(Into::into).collect(),
            },
            core_quick_add::ParseResult::Recurring { input, rrule } => QuickAddResult::Recurring {
                input: input.into(),
                rrule,
            },
        }
    }
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
