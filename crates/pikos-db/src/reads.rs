//! The reads the app makes instead of holding every page: a calendar range, the recurring series,
//! the sidebar's counts, pages by id, a page only when it's newer, recents and tags. Each answers
//! what the app computes from its in-memory list today.

use std::collections::BTreeMap;

use chrono::{Days, NaiveDate, NaiveDateTime};
use serde::Serialize;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::AppResult;
use crate::pages::{Page, PageSummary, PageSummaryRow, SUMMARY_COLUMNS, SYNC_DERIVED_SELECT};
use crate::views::{utc_of, wall_of, WALL_FORMAT};

fn midnight(day: NaiveDate) -> String {
    format!("{day}T00:00:00")
}

#[derive(Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ViewCounts {
    #[ts(type = "number")]
    pub today: i64,
    #[ts(type = "number")]
    pub upcoming: i64,
    #[ts(type = "number")]
    pub inbox: i64,
    /// Open pages per folder, for folders that have held one.
    #[ts(type = "Record<string, number>")]
    pub folders: BTreeMap<String, i64>,
}

/// How many open pages start before a wall clock in the viewer's zone, or between two.
pub(crate) async fn open_starting(
    pool: &SqlitePool,
    zone: &str,
    from: Option<NaiveDate>,
    before: NaiveDate,
) -> AppResult<i64> {
    let mut floating = QueryBuilder::<Sqlite>::new(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND is_absolute = 0 \
         AND order_start IS NOT NULL AND status <> 'done' AND order_start < ",
    );
    floating.push_bind(midnight(before));
    let mut absolute = QueryBuilder::<Sqlite>::new(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND is_absolute = 1 \
         AND status <> 'done' AND abs_start_utc < ",
    );
    absolute.push_bind(utc_of(&midnight(before), zone).unwrap_or_default());
    if let Some(from) = from {
        floating.push(" AND order_start >= ");
        floating.push_bind(midnight(from));
        absolute.push(" AND abs_start_utc >= ");
        absolute.push_bind(utc_of(&midnight(from), zone).unwrap_or_default());
    }
    let floating: i64 = floating.build_query_scalar().fetch_one(pool).await?;
    let absolute: i64 = absolute.build_query_scalar().fetch_one(pool).await?;
    Ok(floating + absolute)
}

/// The sidebar's counts. Today is every open page starting on or before `today` in `zone`;
/// Upcoming every one starting in the seven days from `today`. Pages are counted as heads, the
/// way the badges count them now: a recurring series counts once, by its head's date.
pub async fn count_views(pool: &SqlitePool, zone: &str, today: NaiveDate) -> AppResult<ViewCounts> {
    let tomorrow = today + Days::new(1);
    let week_out = today + Days::new(crate::views::UPCOMING_DAYS);
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT folder_key, open FROM folder_counts")
        .fetch_all(pool)
        .await?;
    let mut inbox = 0;
    let mut folders = BTreeMap::new();
    for (key, open) in rows {
        if key.is_empty() {
            inbox = open;
        } else {
            folders.insert(key, open);
        }
    }
    Ok(ViewCounts {
        today: open_starting(pool, zone, None, tomorrow).await?,
        upcoming: open_starting(pool, zone, Some(today), week_out).await?,
        inbox,
        folders,
    })
}

#[derive(sqlx::FromRow)]
struct RangeRow {
    #[sqlx(flatten)]
    summary: PageSummaryRow,
    range_start: Option<String>,
}

fn parse_wall(text: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(text, WALL_FORMAT).ok()
}

/// A page's start and end as wall clocks in `zone`, the way the calendar places it: an all-day
/// page covers its start date through its end date, a timed page with no end is a moment.
fn interval(page: &PageSummary, start: &str, zone: &str) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let start = parse_wall(start)?;
    let scheduled = page.scheduled_start.as_deref()?;
    if scheduled.len() == 10 {
        let last = match page.scheduled_end.as_deref() {
            Some(end) if end.len() == 10 => NaiveDate::parse_from_str(end, "%Y-%m-%d").ok()?,
            _ => start.date(),
        };
        return Some((start, (last + Days::new(1)).and_hms_opt(0, 0, 0)?));
    }
    let end = match (
        page.scheduled_end.as_deref(),
        page.schedule_locked,
        &page.timezone,
    ) {
        (Some(end), true, Some(source)) => {
            parse_wall(&wall_of(&crate::sql_functions::utc_of(end, source)?, zone)?)?
        }
        (Some(end), _, _) => parse_wall(&crate::views::wall_clock(end))?,
        (None, _, _) => start,
    };
    Some((start, end))
}

/// Every page touching the range from `start` (unbounded when None) to `end`, both UTC instants,
/// placed in `zone`; with `open_only`, the done ones are left out. Of any status otherwise, as the
/// calendar shows them.
pub async fn list_range(
    pool: &SqlitePool,
    start: Option<&str>,
    end: &str,
    zone: &str,
    open_only: bool,
) -> AppResult<Vec<PageSummary>> {
    let longest: Option<f64> = sqlx::query_scalar(
        "SELECT MAX(span_days) FROM pages WHERE deleted_at IS NULL AND span_days IS NOT NULL",
    )
    .fetch_one(pool)
    .await?;
    // A day more than the longest span, since a synced page's span is in its own zone's days.
    let reach = Days::new(longest.unwrap_or(0.0).max(0.0).ceil() as u64 + 1);
    let start_wall = start
        .and_then(|s| wall_of(s, zone))
        .and_then(|w| parse_wall(&w));
    let end_wall = wall_of(end, zone).and_then(|w| parse_wall(&w));
    let Some(end_wall) = end_wall else {
        return Ok(Vec::new());
    };

    let mut found: Vec<(NaiveDateTime, PageSummary)> = Vec::new();
    for absolute in [false, true] {
        let column = if absolute {
            "abs_start_utc"
        } else {
            "order_start"
        };
        let filter = if absolute {
            "is_absolute = 1"
        } else {
            "is_absolute = 0 AND order_start IS NOT NULL"
        };
        // sql-ok: the column and filter are one of two constant pairs
        let mut builder = QueryBuilder::<Sqlite>::new(format!(
            "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT}, {column} AS range_start FROM pages \
             WHERE deleted_at IS NULL AND {filter} AND {column} < "
        ));
        if absolute {
            builder.push_bind(end.to_string());
        } else {
            builder.push_bind(end_wall.format(WALL_FORMAT).to_string());
        }
        if let Some(start_wall) = start_wall {
            let reach_back = start_wall - reach;
            let (back, from) = if absolute {
                let utc = |wall: NaiveDateTime| {
                    utc_of(&wall.format(WALL_FORMAT).to_string(), zone).unwrap_or_default()
                };
                (utc(reach_back), utc(start_wall))
            } else {
                (
                    reach_back.format(WALL_FORMAT).to_string(),
                    start_wall.format(WALL_FORMAT).to_string(),
                )
            };
            // Of the pages starting before the range, only those spanning into it, with a day to
            // spare for an all-day end and a zone's offset; the exact test is `interval`'s.
            builder.push(format!(" AND {column} >= "));
            builder.push_bind(back);
            builder.push(format!(" AND ({column} >= "));
            builder.push_bind(from.clone());
            builder.push(format!(
                " OR julianday(substr({column}, 1, 19)) + COALESCE(span_days, 0) + 1 >= julianday("
            ));
            builder.push_bind(from[..19].to_string());
            builder.push("))");
        }
        if open_only {
            builder.push(" AND status <> 'done'");
        }
        for row in builder.build_query_as::<RangeRow>().fetch_all(pool).await? {
            let page = PageSummary::from(row.summary);
            let Some(start_text) =
                row.range_start
                    .and_then(|s| if absolute { wall_of(&s, zone) } else { Some(s) })
            else {
                continue;
            };
            let Some((page_start, page_end)) = interval(&page, &start_text, zone) else {
                continue;
            };
            let touches = page_start < end_wall && start_wall.is_none_or(|s| page_end > s);
            if touches {
                found.push((page_start, page));
            }
        }
    }
    found.sort_by(|a, b| {
        (a.0, a.1.sort_order, &a.1.created_at, &a.1.id).cmp(&(
            b.0,
            b.1.sort_order,
            &b.1.created_at,
            &b.1.id,
        ))
    });
    Ok(found.into_iter().map(|(_, p)| p).collect())
}

/// Every recurring series' head, which a range needs whatever its dates, since its occurrences
/// are expanded from the rule. With `open_only`, finished series are left out.
pub async fn list_series_heads(pool: &SqlitePool, open_only: bool) -> AppResult<Vec<PageSummary>> {
    // sql-ok: SUMMARY_COLUMNS and SYNC_DERIVED_SELECT are compile-time constants
    let mut builder = QueryBuilder::<Sqlite>::new(format!(
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE deleted_at IS NULL \
         AND id IN (SELECT page_id FROM page_recurrence_rules)"
    ));
    if open_only {
        builder.push(" AND status <> 'done'");
    }
    builder.push(" ORDER BY sort_order, created_at, id");
    Ok(builder
        .build_query_as::<PageSummaryRow>()
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(PageSummary::from)
        .collect())
}

/// How many ids [`get_pages`] binds per query.
const IDS_PER_QUERY: usize = 500;

/// The summaries of `ids` that exist and aren't trashed, in the order asked for.
pub async fn get_pages(pool: &SqlitePool, ids: &[String]) -> AppResult<Vec<PageSummary>> {
    let mut by_id = std::collections::HashMap::new();
    for chunk in ids.chunks(IDS_PER_QUERY) {
        // sql-ok: SUMMARY_COLUMNS and SYNC_DERIVED_SELECT are compile-time constants
        let mut builder = QueryBuilder::<Sqlite>::new(format!(
            "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages \
             WHERE deleted_at IS NULL AND id IN ("
        ));
        let mut list = builder.separated(", ");
        for id in chunk {
            list.push_bind(id.clone());
        }
        list.push_unseparated(")");
        for row in builder
            .build_query_as::<PageSummaryRow>()
            .fetch_all(pool)
            .await?
        {
            let page = PageSummary::from(row);
            by_id.insert(page.id.clone(), page);
        }
    }
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum PageIfNewer {
    /// The copy the caller holds is still the page.
    Current,
    Newer {
        page: Box<Page>,
        #[ts(type = "number")]
        row_seq: i64,
    },
    /// Gone or trashed.
    Missing,
}

/// The full page, unless the caller's copy at `known` is still current. Reads the change number
/// and the page in one transaction, so the number returned is the page's.
pub async fn get_page_if_newer(
    pool: &SqlitePool,
    id: &str,
    known: Option<i64>,
) -> AppResult<PageIfNewer> {
    let mut tx = pool.begin().await?;
    let row_seq: Option<i64> =
        sqlx::query_scalar("SELECT row_seq FROM pages WHERE id = ? AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(row_seq) = row_seq else {
        return Ok(PageIfNewer::Missing);
    };
    if known.is_some_and(|known| known >= row_seq) {
        return Ok(PageIfNewer::Current);
    }
    let page = crate::pages::get_page_in(&mut tx, id).await?;
    tx.commit().await?;
    Ok(match page {
        Some(page) => PageIfNewer::Newer {
            page: Box::new(page),
            row_seq,
        },
        None => PageIfNewer::Missing,
    })
}

/// Open pages opened before, most recent first, without `exclude`: the search palette's recents.
pub async fn list_recent_pages(
    pool: &SqlitePool,
    exclude: Option<&str>,
    limit: usize,
) -> AppResult<Vec<PageSummary>> {
    // sql-ok: SUMMARY_COLUMNS and SYNC_DERIVED_SELECT are compile-time constants
    let mut builder = QueryBuilder::<Sqlite>::new(format!(
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE deleted_at IS NULL \
         AND status <> 'done' AND last_opened_at IS NOT NULL"
    ));
    if let Some(exclude) = exclude {
        builder.push(" AND id <> ");
        builder.push_bind(exclude.to_string());
    }
    builder.push(" ORDER BY last_opened_at DESC LIMIT ");
    builder.push_bind(limit as i64);
    Ok(builder
        .build_query_as::<PageSummaryRow>()
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(PageSummary::from)
        .collect())
}

#[derive(Debug, Serialize, PartialEq, Eq, sqlx::FromRow, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    #[ts(type = "number")]
    pub page_count: i64,
}

/// Tags on open pages with how many carry them, most used first, ties by name, from
/// the counts triggers keep.
pub async fn list_tags(pool: &SqlitePool) -> AppResult<Vec<TagCount>> {
    Ok(sqlx::query_as(
        "SELECT t.name, c.open_pages AS page_count FROM tag_counts c JOIN tags t ON t.id = c.tag_id
         WHERE c.open_pages > 0 ORDER BY c.open_pages DESC, t.name",
    )
    .fetch_all(pool)
    .await?)
}

#[cfg(test)]
#[path = "reads_tests.rs"]
mod reads_tests;
