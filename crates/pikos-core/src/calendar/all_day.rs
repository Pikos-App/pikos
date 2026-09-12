//! All-day row packing and bar coalescing.
//!
//! Date comparisons here are string comparisons on `YYYY-MM-DD`, matching the
//! TypeScript original. That is not laziness: lexicographic ordering on a
//! zero-padded ISO date is exactly calendar ordering, and it sidesteps the
//! UTC/local midnight ambiguity that parsing would reintroduce.

use chrono::{Duration, NaiveDate, NaiveDateTime};

use super::LayoutPage;
use crate::dates::is_all_day_iso;

/// One page's presence on one day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllDayItem {
    pub page_id: String,
    pub created_at: String,
    /// True on days after the event's first — drives left-edge rounding.
    pub is_continuation_before: bool,
    /// True on days before the event's last — drives right-edge rounding.
    pub is_continuation_after: bool,
}

/// A contiguous run of one page across visible columns, in one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllDayBar {
    pub page_id: String,
    pub start_col: usize,
    pub span: usize,
    pub row: usize,
    /// The event begins before the visible range.
    pub continues_left: bool,
    /// The event ends after the visible range.
    pub continues_right: bool,
}

/// Midnight boundaries strictly between `start` and `end`.
///
/// An event ending exactly at midnight touches the boundary without crossing
/// it and counts zero. Walks one calendar day at a time so a DST transition
/// cannot shift the count.
pub fn crossing_midnights_count(start: &NaiveDateTime, end: &NaiveDateTime) -> u32 {
    if end <= start {
        return 0;
    }
    let mut count = 0;
    let mut cursor =
        start.date().and_hms_opt(0, 0, 0).expect("midnight exists") + Duration::days(1);
    while cursor < *end {
        count += 1;
        cursor += Duration::days(1);
    }
    count
}

/// The effective all-day span of a page, as `(start, end)` date strings.
///
/// Returns `None` for unscheduled or timed pages. A page with no all-day end
/// spans a single day.
fn all_day_span(page: &LayoutPage) -> Option<(&str, &str)> {
    let start = page.scheduled_start.as_deref()?;
    if !is_all_day_iso(start) {
        return None;
    }
    let end = match page.scheduled_end.as_deref() {
        Some(e) if is_all_day_iso(e) => e,
        _ => start,
    };
    Some((start, end))
}

/// Every page present on `day`, with its continuation flags for that day.
pub fn build_all_day_items(pages: &[LayoutPage], day: &str) -> Vec<AllDayItem> {
    pages
        .iter()
        .filter_map(|page| {
            let (start, end) = all_day_span(page)?;
            if day < start || day > end {
                return None;
            }
            Some(AllDayItem {
                page_id: page.id.clone(),
                created_at: page.created_at.clone(),
                is_continuation_before: day > start,
                is_continuation_after: day < end,
            })
        })
        .collect()
}

/// Assign each page a row that is stable across `days`.
///
/// Rows claim the specific day indices a page occupies, never a `min..max`
/// range. Recurring virtual occurrences share their head page's id, so a
/// Mon/Wed/Fri series produces a non-contiguous span; claiming the whole range
/// would push an unrelated Tuesday event down a row and leave a phantom gap
/// above it.
pub fn assign_all_day_rows(pages: &[LayoutPage], days: &[String]) -> Vec<Vec<Option<AllDayItem>>> {
    let items_by_day: Vec<Vec<AllDayItem>> =
        days.iter().map(|d| build_all_day_items(pages, d)).collect();

    struct Span {
        page_id: String,
        created_at: String,
        day_indices: Vec<usize>,
    }

    let mut spans: Vec<Span> = Vec::new();
    for (day_idx, day_items) in items_by_day.iter().enumerate() {
        for item in day_items {
            match spans.iter_mut().find(|s| s.page_id == item.page_id) {
                Some(existing) => existing.day_indices.push(day_idx),
                None => spans.push(Span {
                    page_id: item.page_id.clone(),
                    created_at: item.created_at.clone(),
                    day_indices: vec![day_idx],
                }),
            }
        }
    }

    // Longest spans first so multi-day bars anchor the top rows and the
    // single-day stack stays contiguous beneath them (the convention Google
    // and Apple Calendar both use). Ties break on first day, then createdAt,
    // then page id — the last purely for determinism.
    spans.sort_by(|a, b| {
        b.day_indices
            .len()
            .cmp(&a.day_indices.len())
            .then_with(|| a.day_indices[0].cmp(&b.day_indices[0]))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.page_id.cmp(&b.page_id))
    });

    let mut used_by_day: Vec<Vec<usize>> = vec![Vec::new(); days.len()];
    let mut row_by_page: Vec<(String, usize)> = Vec::new();

    for span in &spans {
        let mut row = 0usize;
        loop {
            let free = span
                .day_indices
                .iter()
                .all(|&d| !used_by_day[d].contains(&row));
            if free {
                break;
            }
            row += 1;
        }
        row_by_page.push((span.page_id.clone(), row));
        for &d in &span.day_indices {
            used_by_day[d].push(row);
        }
    }

    let total_rows = used_by_day
        .iter()
        .flat_map(|rows| rows.iter())
        .map(|r| r + 1)
        .max()
        .unwrap_or(0);

    items_by_day
        .into_iter()
        .map(|day_items| {
            let mut row: Vec<Option<AllDayItem>> = vec![None; total_rows];
            for item in day_items {
                if let Some((_, r)) = row_by_page.iter().find(|(id, _)| id == &item.page_id) {
                    row[*r] = Some(item);
                }
            }
            row
        })
        .collect()
}

/// Cross-week-stable variant of [`assign_all_day_rows`].
///
/// Expands the computation to the full span of every all-day page touching the
/// visible range, so a multi-week event keeps the same row in every week it
/// appears, then slices back to the visible days. Trailing rows empty across
/// all visible days are trimmed; interior empty rows are preserved, because
/// those hold a neighbouring week's anchor row in place.
pub fn assign_stable_all_day_rows(
    pages: &[LayoutPage],
    visible_days: &[String],
) -> Vec<Vec<Option<AllDayItem>>> {
    let Some(visible_start) = visible_days.first() else {
        return Vec::new();
    };
    let visible_end = visible_days.last().expect("non-empty checked above");

    let mut min_start = visible_start.clone();
    let mut max_end = visible_end.clone();
    for page in pages {
        let Some((s, e)) = all_day_span(page) else {
            continue;
        };
        if e < visible_start.as_str() || s > visible_end.as_str() {
            continue;
        }
        if s < min_start.as_str() {
            min_start = s.to_string();
        }
        if e > max_end.as_str() {
            max_end = e.to_string();
        }
    }

    // Fast path: nothing extends past the visible range, so expansion would
    // produce exactly the local computation.
    if &min_start == visible_start && &max_end == visible_end {
        return assign_all_day_rows(pages, visible_days);
    }

    let (Ok(from), Ok(to)) = (
        NaiveDate::parse_from_str(&min_start, "%Y-%m-%d"),
        NaiveDate::parse_from_str(&max_end, "%Y-%m-%d"),
    ) else {
        return assign_all_day_rows(pages, visible_days);
    };

    let mut expanded_days: Vec<String> = Vec::new();
    let mut cursor = from;
    while cursor <= to {
        expanded_days.push(cursor.format("%Y-%m-%d").to_string());
        cursor += Duration::days(1);
    }

    let expanded = assign_all_day_rows(pages, &expanded_days);
    let Some(first_visible) = expanded_days.iter().position(|d| d == visible_start) else {
        return assign_all_day_rows(pages, visible_days);
    };

    let visible: Vec<Vec<Option<AllDayItem>>> = expanded
        .into_iter()
        .skip(first_visible)
        .take(visible_days.len())
        .collect();

    let max_used = visible
        .iter()
        .filter_map(|row| row.iter().rposition(|slot| slot.is_some()))
        .max();

    match max_used {
        Some(last) => visible
            .into_iter()
            .map(|row| row.into_iter().take(last + 1).collect())
            .collect(),
        None => visible.into_iter().map(|_| Vec::new()).collect(),
    }
}

/// Collapse a row-assigned slot grid into one bar per visible segment.
///
/// A bar extends across a day boundary only for a genuine multi-day segment:
/// the current day must flag continuation-after *and* the next must be the
/// same page flagging continuation-before. Recurring virtuals share the head's
/// page id but are single-day, so a gapless daily series stays as separate
/// per-day bars rather than coalescing into one bar spanning the whole row.
pub fn build_all_day_bars(slots_by_day: &[Vec<Option<AllDayItem>>]) -> Vec<AllDayBar> {
    let day_count = slots_by_day.len();
    if day_count == 0 {
        return Vec::new();
    }
    let row_count = slots_by_day[0].len();
    let mut bars = Vec::new();

    let slot_at = |col: usize, row: usize| -> Option<&AllDayItem> {
        slots_by_day
            .get(col)
            .and_then(|d| d.get(row))
            .and_then(|s| s.as_ref())
    };

    for row in 0..row_count {
        let mut col = 0usize;
        while col < day_count {
            let Some(slot) = slot_at(col, row) else {
                col += 1;
                continue;
            };
            let start_col = col;
            let page_id = &slot.page_id;
            let mut end = col + 1;
            while end < day_count
                && slot_at(end - 1, row).is_some_and(|s| s.is_continuation_after)
                && slot_at(end, row).is_some_and(|s| &s.page_id == page_id)
                && slot_at(end, row).is_some_and(|s| s.is_continuation_before)
            {
                end += 1;
            }
            bars.push(AllDayBar {
                page_id: page_id.clone(),
                start_col,
                span: end - start_col,
                row,
                continues_left: slot.is_continuation_before,
                continues_right: slot_at(end - 1, row).is_some_and(|s| s.is_continuation_after),
            });
            col = end;
        }
    }
    bars
}
