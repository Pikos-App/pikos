//! The phone's calendar edits, Now widget and page menu, answered by the same Rust the rules are
//! tested in.

use pikos_core::calendar::edits;
use pikos_core::now;
use pikos_core::page_actions::{self, PageAction, PageFacts};

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct DroppedSchedule {
    pub start: String,
    pub end: Option<String>,
}

/// The schedule a page dropped at `minute` of `day` (a `YYYY-MM-DD`) takes.
#[uniffi::export]
pub fn drop_schedule(
    day: String,
    minute: i32,
    previous_start: Option<String>,
    previous_end: Option<String>,
) -> DroppedSchedule {
    let schedule = edits::drop_schedule(
        &day,
        minute,
        previous_start.as_deref(),
        previous_end.as_deref(),
    );
    DroppedSchedule {
        start: schedule.start,
        end: schedule.end,
    }
}

#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockEdge {
    Top,
    Bottom,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct ResizedSchedule {
    pub start: String,
    pub end: String,
}

/// A timed page with one edge dragged to `minute`, or None for an all-day or overnight page.
#[uniffi::export]
pub fn resize_schedule(
    start: String,
    end: Option<String>,
    edge: BlockEdge,
    minute: i32,
) -> Option<ResizedSchedule> {
    let edge = match edge {
        BlockEdge::Top => edits::Edge::Top,
        BlockEdge::Bottom => edits::Edge::Bottom,
    };
    edits::resize(&start, end.as_deref(), edge, minute)
        .map(|(start, end)| ResizedSchedule { start, end })
}

#[derive(uniffi::Record, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MinuteRange {
    pub start: i32,
    pub end: i32,
}

/// The minutes a new block covers while a press at `pressed` is drawn to `reached`.
#[uniffi::export]
pub fn stretch_new_block(pressed: i32, reached: f64) -> MinuteRange {
    let (start, end) = edits::stretch(pressed, reached);
    MinuteRange { start, end }
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct NowPage {
    pub id: String,
    /// Milliseconds since the epoch; None for a page dated today with no time.
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub priority: i64,
}

#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NowReason {
    TopPriority,
    Overdue,
    FirstInList,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct NowSuggestion {
    pub id: String,
    pub reason: NowReason,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct NowAnswer {
    /// Where in the items passed the span in progress is.
    pub current: Option<u32>,
    /// Where in the items passed the next timed page to start is.
    pub next: Option<u32>,
    pub free_until: Option<i64>,
    pub suggestion: Option<NowSuggestion>,
    pub changes: Vec<i64>,
}

/// What the Now widget says at `now`, from today's open pages in the day list's order.
#[uniffi::export]
pub fn now_plan(items: Vec<NowPage>, now: i64) -> NowAnswer {
    let items: Vec<now::NowItem> = items
        .into_iter()
        .map(|item| now::NowItem {
            id: item.id,
            start: item.start,
            end: item.end,
            priority: item.priority,
        })
        .collect();
    let plan = now::plan(&items, now);
    NowAnswer {
        current: plan.current.map(|at| at as u32),
        next: plan.next.map(|at| at as u32),
        free_until: plan.free_until,
        suggestion: plan.suggestion.map(|s| NowSuggestion {
            id: s.id,
            reason: match s.reason {
                now::Reason::TopPriority => NowReason::TopPriority,
                now::Reason::Overdue => NowReason::Overdue,
                now::Reason::FirstInList => NowReason::FirstInList,
            },
        }),
        changes: plan.changes,
    }
}

#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Rename,
    MoveToFolder,
    ClearDate,
    Delete,
}

/// `"offered"`, or the reason the page menu withholds `action`, in the desktop's words.
#[uniffi::export]
pub fn page_action_answer(
    action: MenuAction,
    is_recurring: bool,
    schedule_locked: bool,
    has_date: bool,
    acts_on: u32,
) -> String {
    let action = match action {
        MenuAction::Rename => PageAction::Rename,
        MenuAction::MoveToFolder => PageAction::MoveToFolder,
        MenuAction::ClearDate => PageAction::ClearDate,
        MenuAction::Delete => PageAction::Delete,
    };
    let facts = PageFacts {
        is_recurring,
        schedule_locked,
        has_date,
        acts_on,
    };
    page_actions::answer(action, facts).to_owned()
}
