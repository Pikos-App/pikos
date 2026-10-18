//! What the Now widget says at one instant: what's happening, what's next, and what to do in the
//! gap between.
//!
//! The suggestion is a fixed rule, not a guess: priority first, then the order the day's list
//! already has, and it carries the reason that decided it so the widget can say why. A widget that
//! picks a page for unexplained reasons loses trust the first time it picks wrong.
//!
//! A timed page with no end is a moment, not a span: it is never in progress, and once its time
//! passes it is due like any page dated today. Assuming a length nobody typed would make the
//! widget say the person is busy when they aren't.

/// A page dated today, with its instants as milliseconds since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NowItem {
    pub id: String,
    /// None for a page dated today with no time.
    pub start: Option<i64>,
    pub end: Option<i64>,
    /// 1 is most urgent; 0 means none, which ranks last.
    pub priority: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    TopPriority,
    Overdue,
    FirstInList,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub id: String,
    pub reason: Reason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NowPlan {
    /// Where in `items` the span in progress is, the one ending soonest when spans overlap. A
    /// position rather than an id, since the caller's items can repeat an id.
    pub current: Option<usize>,
    /// Where in `items` the next timed page to start is.
    pub next: Option<usize>,
    /// When the person is next busy; None while something is in progress or nothing else is timed.
    pub free_until: Option<i64>,
    /// Only offered while nothing is in progress.
    pub suggestion: Option<Suggestion>,
    /// The instants after `now` when the plan changes, for the widget's timeline.
    pub changes: Vec<i64>,
}

/// `items` is today's open pages in the order the day's list shows them.
pub fn plan(items: &[NowItem], now: i64) -> NowPlan {
    let current = items
        .iter()
        .enumerate()
        .filter_map(|(at, item)| match (item.start, item.end) {
            (Some(start), Some(end)) if start <= now && now < end => Some((end, at)),
            _ => None,
        })
        .min_by_key(|(end, _)| *end)
        .map(|(_, at)| at);
    let next = items
        .iter()
        .enumerate()
        .filter_map(|(at, item)| {
            item.start
                .filter(|start| *start > now)
                .map(|start| (start, at))
        })
        .min_by_key(|(start, _)| *start);

    let mut changes: Vec<i64> = items
        .iter()
        .flat_map(|item| [item.start, item.end])
        .flatten()
        .filter(|at| *at > now)
        .collect();
    changes.sort_unstable();
    changes.dedup();

    NowPlan {
        current,
        next: next.map(|(_, at)| at),
        free_until: if current.is_none() {
            next.map(|(start, _)| start)
        } else {
            None
        },
        suggestion: if current.is_none() {
            suggest(items, now)
        } else {
            None
        },
        changes,
    }
}

fn rank(priority: i64) -> i64 {
    if priority == 0 {
        i64::MAX
    } else {
        priority
    }
}

/// Ranked by priority, then by list order. The reason names whichever of the two decided it.
fn suggest(items: &[NowItem], now: i64) -> Option<Suggestion> {
    let candidates: Vec<&NowItem> = items
        .iter()
        .filter(|item| match item.start {
            None => true,
            Some(start) => start <= now && item.end.unwrap_or(start) <= now,
        })
        .collect();
    // `min_by_key` keeps the first of equals, which is list order.
    let best = candidates.iter().min_by_key(|item| rank(item.priority))?;

    let outranks_another = candidates
        .iter()
        .any(|other| rank(other.priority) > rank(best.priority));
    let reason = if best.priority != 0 && outranks_another {
        Reason::TopPriority
    } else if best.start.is_some() {
        Reason::Overdue
    } else {
        Reason::FirstInList
    };
    Some(Suggestion {
        id: best.id.clone(),
        reason,
    })
}

#[cfg(test)]
#[path = "now_tests.rs"]
mod tests;
