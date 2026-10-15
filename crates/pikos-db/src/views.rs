//! Inbox and folder lists a window at a time, in the order the app shows them, so a list can be
//! shown without loading every page.
//!
//! Each sort mode is a run of sections, and a section is one or two streams read through an index.
//! Date order has two because a synced page's time is an instant, read in the viewer's zone, while
//! every other page's is a wall clock: the instants stream in UTC order and are converted to wall
//! clocks for the merge. A cursor is the last row's place in that order, so the next window starts
//! after it however the list changed in between. Ties break by manual order, then creation.

use std::cmp::Ordering;

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::{AppError, AppResult};
use crate::pages::{PageSummary, PageSummaryRow, SUMMARY_COLUMNS, SYNC_DERIVED_SELECT};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "kind", content = "folderId")]
pub enum ViewScope {
    Inbox,
    Folder(String),
    /// Every folder and the Inbox: Today's and Upcoming's sections, with [`ViewKey::dates`].
    Everywhere,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ViewSort {
    Manual,
    Date,
    Title,
    Priority,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, optional_fields = nullable)]
#[serde(rename_all = "camelCase")]
pub struct ViewKey {
    pub scope: ViewScope,
    pub sort: ViewSort,
    /// The IANA zone a synced page's time is shown in.
    pub zone: String,
    /// Only pages starting in these days in `zone`: a Today or Upcoming section. Date order.
    #[serde(default)]
    pub dates: Option<DateBounds>,
}

/// Days in the viewer's zone: from the start of `from` (or without limit) to the start of `until`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, optional_fields = nullable)]
#[serde(rename_all = "camelCase")]
pub struct DateBounds {
    /// `YYYY-MM-DD`.
    #[ts(type = "string | null")]
    pub from: Option<chrono::NaiveDate>,
    /// `YYYY-MM-DD`.
    #[ts(type = "string")]
    pub until: chrono::NaiveDate,
}

/// A row's place in its view: its section, its key within the section (a wall clock, or a title
/// key in hex), and the tie-break.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, optional_fields = nullable)]
#[serde(rename_all = "camelCase")]
pub struct ViewCursor {
    section: u8,
    key: Option<String>,
    #[ts(type = "number")]
    sort_order: i64,
    created_at: String,
    id: String,
}

impl ViewCursor {
    fn order(&self, other: &Self) -> Ordering {
        (
            self.section,
            &self.key,
            self.sort_order,
            &self.created_at,
            &self.id,
        )
            .cmp(&(
                other.section,
                &other.key,
                other.sort_order,
                &other.created_at,
                &other.id,
            ))
    }
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, optional_fields = nullable)]
#[serde(rename_all = "camelCase")]
pub struct ViewWindow {
    pub rows: Vec<PageSummary>,
    /// Where the next window starts, or None at the end of the list.
    pub next: Option<ViewCursor>,
    /// Every row in the view, on the first window only; a later window's place is known from its
    /// cursor.
    #[ts(type = "number | null")]
    pub total: Option<i64>,
}

/// Urgent first, low last, none after low.
const PRIORITY_TIERS: [i64; 5] = [1, 2, 3, 4, 0];

#[derive(Clone, Copy)]
enum Section {
    Manual,
    Title,
    Scheduled(Option<i64>),
    Unscheduled(Option<i64>),
}

fn sections(key: &ViewKey) -> Vec<Section> {
    if key.dates.is_some() {
        return vec![Section::Scheduled(None)];
    }
    match key.sort {
        ViewSort::Manual => vec![Section::Manual],
        ViewSort::Title => vec![Section::Title],
        ViewSort::Date => vec![Section::Scheduled(None), Section::Unscheduled(None)],
        ViewSort::Priority => PRIORITY_TIERS
            .iter()
            .flat_map(|&tier| {
                [
                    Section::Scheduled(Some(tier)),
                    Section::Unscheduled(Some(tier)),
                ]
            })
            .collect(),
    }
}

/// How one stream reads its rows: the rows it holds, and the column its key comes from.
#[derive(Clone, Copy)]
enum Stream {
    Manual,
    Title,
    Floating,
    Absolute,
    Unscheduled,
}

impl Stream {
    fn of(section: Section) -> &'static [Stream] {
        match section {
            Section::Manual => &[Stream::Manual],
            Section::Title => &[Stream::Title],
            Section::Scheduled(_) => &[Stream::Floating, Stream::Absolute],
            Section::Unscheduled(_) => &[Stream::Unscheduled],
        }
    }

    fn filter(self) -> &'static str {
        match self {
            Stream::Manual | Stream::Title => "",
            Stream::Floating => " AND is_absolute = 0 AND order_start IS NOT NULL",
            Stream::Absolute => " AND is_absolute = 1",
            Stream::Unscheduled => " AND scheduled_start IS NULL",
        }
    }

    /// The column the stream orders by before the tie-break, and how its key reads as text.
    fn key(self) -> Option<(&'static str, &'static str)> {
        match self {
            Stream::Manual | Stream::Unscheduled => None,
            Stream::Title => Some(("title_key", "hex(title_key)")),
            Stream::Floating => Some(("order_start", "order_start")),
            Stream::Absolute => Some(("abs_start_utc", "abs_start_utc")),
        }
    }
}

fn push_scope(builder: &mut QueryBuilder<'_, Sqlite>, scope: &ViewScope) {
    match scope {
        ViewScope::Inbox => {
            builder.push(" AND folder_id IS NULL");
        }
        ViewScope::Folder(id) => {
            builder.push(" AND folder_id = ");
            builder.push_bind(id.clone());
        }
        ViewScope::Everywhere => {}
    }
}

/// Keep a stream to `bounds`, in its own key's terms: wall clocks for floating pages, instants for
/// synced ones.
fn push_dates(
    builder: &mut QueryBuilder<'_, Sqlite>,
    column: &str,
    absolute: bool,
    bounds: &DateBounds,
    zone: &str,
) {
    let edge = |day: chrono::NaiveDate| {
        let wall = format!("{day}T00:00:00");
        if absolute {
            utc_of(&wall, zone).unwrap_or_default()
        } else {
            wall
        }
    };
    if let Some(from) = bounds.from {
        builder.push(format!(" AND {column} >= "));
        builder.push_bind(edge(from));
    }
    builder.push(format!(" AND {column} < "));
    builder.push_bind(edge(bounds.until));
}

const UTC_FORMAT: &str = "%Y-%m-%dT%H:%M:%SZ";
pub(crate) const WALL_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";

/// Upcoming's days, counting today: `UPCOMING_WINDOW_DAYS` in packages/core.
pub(crate) const UPCOMING_DAYS: u64 = 7;

/// A stored start as a full wall clock, as `order_start` computes it: an all-day date at the start
/// of its day, a time without seconds given them.
pub(crate) fn wall_clock(start: &str) -> String {
    match start.len() {
        10 => format!("{start}T00:00:00"),
        16 => format!("{start}:00"),
        _ => start.get(..19).unwrap_or(start).to_string(),
    }
}

pub(crate) fn wall_of(utc: &str, zone: &str) -> Option<String> {
    let utc = NaiveDateTime::parse_from_str(utc, UTC_FORMAT).ok()?;
    let wall = pikos_recurrence::zoned::utc_to_wall_clock(zone, utc)?;
    Some(wall.format(WALL_FORMAT).to_string())
}

pub(crate) fn utc_of(wall: &str, zone: &str) -> Option<String> {
    let wall = NaiveDateTime::parse_from_str(wall, WALL_FORMAT).ok()?;
    let utc = pikos_recurrence::zoned::wall_clock_to_utc(zone, wall)?;
    Some(utc.format(UTC_FORMAT).to_string())
}

#[derive(sqlx::FromRow)]
struct ViewRow {
    #[sqlx(flatten)]
    summary: PageSummaryRow,
    view_key: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ViewIdRow {
    id: String,
    sort_order: i64,
    created_at: String,
    view_key: Option<String>,
}

/// One stream's rows after `after`, at most `limit`, each with its cursor, and its summary when
/// `full` asks for one.
async fn read_stream(
    pool: &SqlitePool,
    key: &ViewKey,
    section: (u8, Section),
    stream: Stream,
    after: Option<&ViewCursor>,
    limit: usize,
    full: bool,
) -> AppResult<Vec<(ViewCursor, Option<PageSummary>)>> {
    let (index, section) = section;
    let key_column = stream.key();
    let select = if full {
        format!("{SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT}")
    } else {
        "id, sort_order, created_at".to_string()
    };
    let key_text = key_column.map_or("NULL", |(_, text)| text);
    // sql-ok: the select list, key expressions and filters are compile-time constants
    let mut builder = QueryBuilder::<Sqlite>::new(format!(
        "SELECT {select}, {key_text} AS view_key FROM pages \
         WHERE deleted_at IS NULL AND status <> 'done'{}",
        stream.filter()
    ));
    push_scope(&mut builder, &key.scope);
    if let (Some(bounds), Some((column, _))) = (&key.dates, key_column) {
        push_dates(
            &mut builder,
            column,
            matches!(stream, Stream::Absolute),
            bounds,
            &key.zone,
        );
    }
    if let Section::Scheduled(Some(tier)) | Section::Unscheduled(Some(tier)) = section {
        builder.push(" AND priority = ");
        builder.push_bind(tier);
    }
    if let Some(cursor) = after {
        match (key_column, &cursor.key) {
            (Some((column, _)), Some(cursor_key)) => {
                builder.push(format!(" AND ({column}, sort_order, created_at, id) > ("));
                match stream {
                    Stream::Title => {
                        let bytes = decode_hex(cursor_key)
                            .ok_or_else(|| AppError::Invalid("a title cursor isn't hex".into()))?;
                        builder.push_bind(bytes);
                    }
                    Stream::Absolute => {
                        let utc = utc_of(cursor_key, &key.zone).ok_or_else(|| {
                            AppError::Invalid(format!("no instant for {cursor_key}"))
                        })?;
                        builder.push_bind(utc);
                    }
                    _ => {
                        builder.push_bind(cursor_key.clone());
                    }
                }
                builder.push(", ");
            }
            _ => {
                builder.push(" AND (sort_order, created_at, id) > (");
            }
        }
        builder.push_bind(cursor.sort_order);
        builder.push(", ");
        builder.push_bind(cursor.created_at.clone());
        builder.push(", ");
        builder.push_bind(cursor.id.clone());
        builder.push(")");
    }
    builder.push(" ORDER BY ");
    if let Some((column, _)) = key_column {
        builder.push(format!("{column}, "));
    }
    builder.push("sort_order, created_at, id LIMIT ");
    builder.push_bind(limit as i64);

    let cursor_of = |view_key: Option<String>, sort_order, created_at, id| -> ViewCursor {
        let key = match stream {
            Stream::Absolute => view_key.and_then(|utc| wall_of(&utc, &key.zone)),
            _ => view_key,
        };
        ViewCursor {
            section: index,
            key,
            sort_order,
            created_at,
            id,
        }
    };
    if full {
        let rows = builder.build_query_as::<ViewRow>().fetch_all(pool).await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let summary = PageSummary::from(row.summary);
                let cursor = cursor_of(
                    row.view_key,
                    summary.sort_order,
                    summary.created_at.clone(),
                    summary.id.clone(),
                );
                (cursor, Some(summary))
            })
            .collect())
    } else {
        let rows = builder
            .build_query_as::<ViewIdRow>()
            .fetch_all(pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    cursor_of(row.view_key, row.sort_order, row.created_at, row.id),
                    None,
                )
            })
            .collect())
    }
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The rows after `after` in the view's order, at most `limit`, and whether more follow.
async fn walk(
    pool: &SqlitePool,
    key: &ViewKey,
    after: Option<&ViewCursor>,
    limit: usize,
    full: bool,
) -> AppResult<(Vec<(ViewCursor, Option<PageSummary>)>, bool)> {
    let mut out: Vec<(ViewCursor, Option<PageSummary>)> = Vec::new();
    let first = after.map_or(0, |c| c.section as usize);
    for (index, section) in sections(key).into_iter().enumerate().skip(first) {
        let index = index as u8;
        let within = after.filter(|c| c.section == index);
        let wanted = limit + 1 - out.len();
        let mut rows = Vec::new();
        for &stream in Stream::of(section) {
            rows.extend(
                read_stream(pool, key, (index, section), stream, within, wanted, full).await?,
            );
        }
        rows.sort_by(|a, b| a.0.order(&b.0));
        rows.truncate(wanted);
        out.extend(rows);
        if out.len() > limit {
            break;
        }
    }
    let more = out.len() > limit;
    out.truncate(limit);
    Ok((out, more))
}

fn folder_key(scope: &ViewScope) -> &str {
    match scope {
        ViewScope::Inbox | ViewScope::Everywhere => "",
        ViewScope::Folder(id) => id,
    }
}

/// A folder's open and done counts, from the table triggers keep.
async fn folder_counts(pool: &SqlitePool, scope: &ViewScope) -> AppResult<(i64, i64)> {
    let counts: Option<(i64, i64)> =
        sqlx::query_as("SELECT open, done FROM folder_counts WHERE folder_key = ?")
            .bind(folder_key(scope))
            .fetch_optional(pool)
            .await?;
    Ok(counts.unwrap_or_default())
}

/// The next window of an Inbox or folder list: up to `limit` rows after `after`, or from the top.
pub async fn list_view(
    pool: &SqlitePool,
    key: &ViewKey,
    after: Option<&ViewCursor>,
    limit: usize,
) -> AppResult<ViewWindow> {
    let (rows, more) = walk(pool, key, after, limit, true).await?;
    let next = more.then(|| rows.last().map(|(c, _)| c.clone())).flatten();
    let total = match (after, &key.dates) {
        (Some(_), _) => None,
        (None, Some(bounds)) => {
            Some(crate::reads::open_starting(pool, &key.zone, bounds.from, bounds.until).await?)
        }
        (None, None) => Some(folder_counts(pool, &key.scope).await?.0),
    };
    Ok(ViewWindow {
        rows: rows.into_iter().filter_map(|(_, s)| s).collect(),
        next,
        total,
    })
}

/// How many ids [`list_view_ids`] reads per query.
const IDS_BATCH: usize = 5_000;

/// The ids after `after`, through `through` or to the end, in the view's order. For selecting
/// what a window hasn't loaded, so it reads no summaries.
pub async fn list_view_ids(
    pool: &SqlitePool,
    key: &ViewKey,
    after: Option<&ViewCursor>,
    through: Option<&ViewCursor>,
) -> AppResult<Vec<String>> {
    let mut ids = Vec::new();
    let mut cursor = after.cloned();
    loop {
        let (rows, more) = walk(pool, key, cursor.as_ref(), IDS_BATCH, false).await?;
        for (row, _) in &rows {
            if through.is_some_and(|end| row.order(end) == Ordering::Greater) {
                return Ok(ids);
            }
            ids.push(row.id.clone());
        }
        match (more, rows.last()) {
            (true, Some((last, _))) => cursor = Some(last.clone()),
            _ => return Ok(ids),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, optional_fields = nullable)]
#[serde(rename_all = "camelCase")]
pub struct CompletedCursor {
    completed_at: String,
    id: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, optional_fields = nullable)]
#[serde(rename_all = "camelCase")]
pub struct CompletedWindow {
    pub rows: Vec<PageSummary>,
    pub next: Option<CompletedCursor>,
    /// On the first window only, as [`ViewWindow::total`].
    #[ts(type = "number | null")]
    pub total: Option<i64>,
}

/// A view's done pages, newest first, a window at a time. `scope` None means every folder, for
/// Today's and Upcoming's sections, which `since` limits to pages done on or after that date.
pub async fn list_completed(
    pool: &SqlitePool,
    scope: Option<&ViewScope>,
    since: Option<&str>,
    after: Option<&CompletedCursor>,
    limit: usize,
) -> AppResult<CompletedWindow> {
    let filter = |builder: &mut QueryBuilder<'_, Sqlite>| {
        if let Some(scope) = scope {
            push_scope(builder, scope);
        }
        if let Some(since) = since {
            builder.push(" AND completed_at >= ");
            builder.push_bind(since.to_string());
        }
    };
    // Named, because the planner otherwise counts every done page through the status index and
    // filters by folder after.
    let index = if scope.is_some() {
        "idx_view_done"
    } else {
        "idx_view_done_everywhere"
    };
    let total = match (after, scope, since) {
        (Some(_), _, _) => None,
        (None, Some(scope), None) => Some(folder_counts(pool, scope).await?.1),
        (None, _, _) => {
            // sql-ok: the index name is one of two constants
            let mut count = QueryBuilder::<Sqlite>::new(format!(
                "SELECT COUNT(*) FROM pages INDEXED BY {index} \
                 WHERE deleted_at IS NULL AND status = 'done'"
            ));
            filter(&mut count);
            Some(count.build_query_scalar().fetch_one(pool).await?)
        }
    };

    // sql-ok: SUMMARY_COLUMNS and SYNC_DERIVED_SELECT are compile-time constants
    let mut builder = QueryBuilder::<Sqlite>::new(format!(
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages \
         WHERE deleted_at IS NULL AND status = 'done'"
    ));
    filter(&mut builder);
    if let Some(cursor) = after {
        builder.push(" AND (completed_at, id) < (");
        builder.push_bind(cursor.completed_at.clone());
        builder.push(", ");
        builder.push_bind(cursor.id.clone());
        builder.push(")");
    }
    builder.push(" ORDER BY completed_at DESC, id DESC LIMIT ");
    builder.push_bind(limit as i64 + 1);
    let mut rows: Vec<PageSummary> = builder
        .build_query_as::<PageSummaryRow>()
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(PageSummary::from)
        .collect();
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = more.then(|| rows.last()).flatten().and_then(|last| {
        Some(CompletedCursor {
            completed_at: last.completed_at.clone()?,
            id: last.id.clone(),
        })
    });
    Ok(CompletedWindow { rows, next, total })
}

#[cfg(test)]
#[path = "views_tests.rs"]
mod views_tests;
