use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::now_iso;

// ─── PageSchedule ──────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct PageScheduleRow {
    id: String,
    page_id: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
    // IANA source zone; metadata only, not consumed by expansion.
    timezone: Option<String>,
    rule_id: Option<String>,
    original_date: Option<String>,
    status: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSchedule {
    pub id: String,
    pub page_id: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: Option<String>,
    pub rule_id: Option<String>,
    pub original_date: Option<String>,
    pub status: String,
    pub created_at: String,
}

impl From<PageScheduleRow> for PageSchedule {
    fn from(row: PageScheduleRow) -> Self {
        PageSchedule {
            id: row.id,
            page_id: row.page_id,
            scheduled_start: row.scheduled_start,
            scheduled_end: row.scheduled_end,
            timezone: row.timezone,
            rule_id: row.rule_id,
            original_date: row.original_date,
            status: row.status,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPageSchedule {
    pub page_id: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: Option<String>,
    pub rule_id: Option<String>,
    pub original_date: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageScheduleUpdate {
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<serde_json::Value>, // Value::Null clears it
    pub status: Option<String>,
}

// ─── PageRecurrenceRule ────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct RecurrenceRuleRow {
    id: String,
    page_id: String,
    rrule: String,
    rrule_exdates: String, // JSON array
    scheduled_start: String,
    scheduled_end: Option<String>,
    // IANA source zone; metadata only, not consumed by expansion.
    timezone: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRecurrenceRule {
    pub id: String,
    pub page_id: String,
    pub rrule: String,
    pub rrule_exdates: Vec<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: String,
    pub created_at: String,
}

impl From<RecurrenceRuleRow> for PageRecurrenceRule {
    fn from(row: RecurrenceRuleRow) -> Self {
        let rrule_exdates: Vec<String> =
            serde_json::from_str(&row.rrule_exdates).unwrap_or_default();
        PageRecurrenceRule {
            id: row.id,
            page_id: row.page_id,
            rrule: row.rrule,
            rrule_exdates,
            scheduled_start: row.scheduled_start,
            scheduled_end: row.scheduled_end,
            timezone: row.timezone,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRecurrenceRule {
    pub page_id: String,
    pub rrule: String,
    #[serde(default)]
    pub rrule_exdates: Vec<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecurrenceRuleUpdate {
    pub rrule: Option<String>,
    pub rrule_exdates: Option<Vec<String>>,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<serde_json::Value>, // Value::Null clears it
    pub timezone: Option<String>,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Refreshes pages.scheduled_start/end to the nearest schedule for this page
/// (non-override rows only): prefers the earliest upcoming schedule; falls back
/// to the most recent past schedule if no future one exists.
/// Clears to NULL when no explicit schedules remain.
pub async fn refresh_schedule_denorm(pool: &sqlx::SqlitePool, page_id: &str) -> AppResult<()> {
    let mut conn = pool.acquire().await?;
    refresh_schedule_denorm_conn(&mut conn, page_id).await
}

/// Connection/transaction form of [`refresh_schedule_denorm`]. The schedule
/// writers run their mutation and this denorm refresh inside one transaction,
/// so a mid-flight crash can't commit the row change while leaving
/// `pages.scheduled_start` stale.
async fn refresh_schedule_denorm_conn(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> AppResult<()> {
    // The comparator is computed in Rust as LOCAL wall-clock. scheduled_start is
    // stored as local wall-clock (no TZ suffix), but SQLite's strftime('now') is
    // UTC — comparing the two misclassifies "upcoming vs past" by up to a day for
    // non-UTC users near midnight.
    let now = chrono::Local::now().naive_local();
    refresh_schedule_denorm_at(conn, page_id, &now.format("%Y-%m-%dT%H:%M:%S").to_string()).await
}

/// Inner form taking an explicit local-now comparator (`YYYY-MM-DDTHH:MM:SS`),
/// so the upcoming-vs-past bucketing is deterministically testable without
/// depending on the machine clock or timezone.
async fn refresh_schedule_denorm_at(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    now_datetime: &str,
) -> AppResult<()> {
    #[derive(sqlx::FromRow)]
    struct Denorm {
        scheduled_start: String,
        scheduled_end: Option<String>,
    }

    // rrule-backed pages own their denorm scheduled_start directly: the head's
    // "current occurrence" is advanced by complete_recurring_page_impl, and the
    // other occurrences are virtual (expanded client-side) with no non-rule
    // page_schedules row tracking them. The page's original non-rule anchor row
    // (from the initial scheduleOnce, before the rule was added) lingers at a
    // now-past date, so refreshing from page_schedules here would clobber the
    // head back to that anchor. Leave the denorm to the recurring logic.
    let has_rule = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM page_recurrence_rules WHERE page_id = ?)",
    )
    .bind(page_id)
    .fetch_one(&mut *conn)
    .await?
        != 0;
    if has_rule {
        return Ok(());
    }

    // All-day rows store a bare date (10 chars); pad them to end-of-day before
    // comparing so an all-day event dated today stays "upcoming" all day instead
    // of flipping to "past" at 00:00 (a bare date sorts before any timed "now"
    // lexicographically). Bucket 0 = upcoming, 1 = past; within a bucket the
    // earliest scheduled_start wins.
    let row = sqlx::query_as::<_, Denorm>(
        "SELECT scheduled_start, scheduled_end
         FROM page_schedules
         WHERE page_id = ? AND rule_id IS NULL
         ORDER BY
           CASE WHEN
             (CASE WHEN length(scheduled_start) = 10
                   THEN scheduled_start || 'T23:59:59'
                   ELSE scheduled_start END) >= ?
           THEN 0 ELSE 1 END ASC,
           scheduled_start ASC
         LIMIT 1",
    )
    .bind(page_id)
    .bind(now_datetime)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(d) => {
            sqlx::query("UPDATE pages SET scheduled_start = ?, scheduled_end = ? WHERE id = ?")
                .bind(&d.scheduled_start)
                .bind(&d.scheduled_end)
                .bind(page_id)
                .execute(&mut *conn)
                .await?;
        }
        None => {
            sqlx::query(
                "UPDATE pages SET scheduled_start = NULL, scheduled_end = NULL WHERE id = ?",
            )
            .bind(page_id)
            .execute(&mut *conn)
            .await?;
        }
    }

    Ok(())
}

async fn fetch_schedule(pool: &sqlx::SqlitePool, id: &str) -> AppResult<PageSchedule> {
    sqlx::query_as::<_, PageScheduleRow>("SELECT * FROM page_schedules WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Schedule not found: {id}")))
        .map(PageSchedule::from)
}

async fn fetch_rule(pool: &sqlx::SqlitePool, id: &str) -> AppResult<PageRecurrenceRule> {
    sqlx::query_as::<_, RecurrenceRuleRow>("SELECT * FROM page_recurrence_rules WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Recurrence rule not found: {id}")))
        .map(PageRecurrenceRule::from)
}

// ─── Schedule commands ────────────────────────────────────────────────────────

pub async fn create_page_schedule_impl(
    pool: &sqlx::SqlitePool,
    data: NewPageSchedule,
) -> AppResult<PageSchedule> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();

    // Insert + denorm refresh in one tx so a crash can't leave the row
    // committed with a stale pages.scheduled_start.
    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(&id)
    .bind(&data.page_id)
    .bind(&data.scheduled_start)
    .bind(&data.scheduled_end)
    .bind(&data.timezone)
    .bind(&data.rule_id)
    .bind(&data.original_date)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    refresh_schedule_denorm_conn(&mut tx, &data.page_id).await?;
    tx.commit().await?;

    fetch_schedule(pool, &id).await
}

pub async fn update_page_schedule_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    updates: PageScheduleUpdate,
) -> AppResult<PageSchedule> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE page_schedules SET ");
    let mut fields = builder.separated(", ");
    let mut has_updates = false;
    let start_changed = updates.scheduled_start.is_some();

    if let Some(v) = updates.scheduled_start {
        fields.push("scheduled_start = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.status {
        fields.push("status = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(val) = updates.scheduled_end {
        fields.push("scheduled_end = ");
        match val {
            serde_json::Value::Null => fields.push_bind_unseparated(None::<String>),
            serde_json::Value::String(s) => fields.push_bind_unseparated(s),
            _ => fields.push_bind_unseparated(None::<String>),
        };
        has_updates = true;
    }

    if !has_updates {
        return fetch_schedule(pool, &id).await;
    }

    drop(fields);
    builder.push(" WHERE id = ");
    builder.push_bind(&id);

    // Update + reminder-log clear + denorm refresh in one tx: a crash
    // between them could otherwise leave a stale dedup row (reminder never
    // re-fires at the new time) or a stale pages.scheduled_start.
    let mut tx = pool.begin().await?;

    builder.build().execute(&mut *tx).await?;

    // If scheduled_start changed, clear reminder notification_log entries for
    // this schedule so the scheduler can re-fire at the new time.
    if start_changed {
        sqlx::query("DELETE FROM notification_log WHERE schedule_id = ? AND type = 'reminder'")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }

    let page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM page_schedules WHERE id = ?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(pid) = &page_id {
        refresh_schedule_denorm_conn(&mut tx, pid).await?;
    }

    tx.commit().await?;
    fetch_schedule(pool, &id).await
}

pub async fn delete_page_schedule_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
    // Lookup + delete + denorm refresh in one tx so the denorm can't be
    // left pointing at the now-deleted row after a mid-flight crash.
    let mut tx = pool.begin().await?;

    let page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM page_schedules WHERE id = ?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;

    sqlx::query("DELETE FROM page_schedules WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;

    if let Some(pid) = &page_id {
        refresh_schedule_denorm_conn(&mut tx, pid).await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn list_page_schedules_impl(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> AppResult<Vec<PageSchedule>> {
    // Filter trashed pages (mirrors list_page_schedules_range_impl). Desktop
    // calls this from scheduleOnce / clearSchedule / rescheduleVirtualOccurrence —
    // without the guard a trashed page's schedules leak back into the UI.
    let rows = sqlx::query_as::<_, PageScheduleRow>(
        "SELECT page_schedules.* FROM page_schedules
         JOIN pages ON pages.id = page_schedules.page_id
         WHERE page_schedules.page_id = ? AND pages.deleted_at IS NULL
         ORDER BY page_schedules.scheduled_start ASC",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(PageSchedule::from).collect())
}

/// Returns all schedule rows that overlap [start, end] (YYYY-MM-DD).
/// All-day single: scheduled_end IS NULL, start must be within range.
/// Multi-day / timed with end: overlaps if start <= range_end AND end >= range_start.
pub async fn list_page_schedules_range_impl(
    pool: &sqlx::SqlitePool,
    start: &str,
    end: &str,
) -> AppResult<Vec<PageSchedule>> {
    let rows = sqlx::query_as::<_, PageScheduleRow>(
        "SELECT page_schedules.* FROM page_schedules
         JOIN pages ON pages.id = page_schedules.page_id
         WHERE pages.deleted_at IS NULL
           AND ((page_schedules.scheduled_end IS NULL AND date(page_schedules.scheduled_start) BETWEEN ? AND ?)
             OR (page_schedules.scheduled_end IS NOT NULL
                 AND date(page_schedules.scheduled_start) <= ?
                 AND date(page_schedules.scheduled_end)   >= ?))
         ORDER BY page_schedules.scheduled_start ASC",
    )
    .bind(start)
    .bind(end)
    .bind(end)
    .bind(start)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(PageSchedule::from).collect())
}

pub async fn create_recurrence_rule_impl(
    pool: &sqlx::SqlitePool,
    data: NewRecurrenceRule,
) -> AppResult<PageRecurrenceRule> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let exdates_json =
        serde_json::to_string(&data.rrule_exdates).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&data.page_id)
    .bind(&data.rrule)
    .bind(&exdates_json)
    .bind(&data.scheduled_start)
    .bind(&data.scheduled_end)
    .bind(&data.timezone)
    .bind(&now)
    .execute(pool)
    .await?;

    fetch_rule(pool, &id).await
}

pub async fn update_recurrence_rule_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    updates: RecurrenceRuleUpdate,
) -> AppResult<PageRecurrenceRule> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE page_recurrence_rules SET ");
    let mut fields = builder.separated(", ");
    let mut has_updates = false;

    if let Some(v) = updates.rrule {
        fields.push("rrule = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.rrule_exdates {
        let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".to_string());
        fields.push("rrule_exdates = ");
        fields.push_bind_unseparated(json);
        has_updates = true;
    }
    if let Some(v) = updates.scheduled_start {
        fields.push("scheduled_start = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.timezone {
        fields.push("timezone = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(val) = updates.scheduled_end {
        fields.push("scheduled_end = ");
        match val {
            serde_json::Value::Null => fields.push_bind_unseparated(None::<String>),
            serde_json::Value::String(s) => fields.push_bind_unseparated(s),
            _ => fields.push_bind_unseparated(None::<String>),
        };
        has_updates = true;
    }

    if !has_updates {
        return fetch_rule(pool, &id).await;
    }

    drop(fields);
    builder.push(" WHERE id = ");
    builder.push_bind(&id);

    builder.build().execute(pool).await?;

    fetch_rule(pool, &id).await
}

/// Merges `add` into the rule's `rrule_exdates` inside the caller's transaction
/// and returns the post-merge array. This read-merge-write is the ONLY safe way
/// to grow exdates: clients computing the full replacement array from their own
/// snapshot erase any exdate persisted since that snapshot was taken — an
/// interleaved skip/complete then resurrects a completed occurrence. Dedups;
/// preserves stored order.
pub(crate) async fn merge_rule_exdates_tx(
    tx: &mut sqlx::SqliteConnection,
    rule_id: &str,
    add: &[String],
) -> AppResult<Vec<String>> {
    let current: String =
        sqlx::query_scalar("SELECT rrule_exdates FROM page_recurrence_rules WHERE id = ?")
            .bind(rule_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Recurrence rule not found: {rule_id}")))?;
    let mut exdates: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
    for d in add {
        if !exdates.contains(d) {
            exdates.push(d.clone());
        }
    }
    let json = serde_json::to_string(&exdates).unwrap_or_else(|_| "[]".to_string());
    sqlx::query("UPDATE page_recurrence_rules SET rrule_exdates = ? WHERE id = ?")
        .bind(&json)
        .bind(rule_id)
        .execute(&mut *tx)
        .await?;
    Ok(exdates)
}

/// Adds dates to a rule's exdates (skip an occurrence). Merge happens DB-side —
/// see merge_rule_exdates_tx for why callers must not send a replacement array.
pub async fn add_rule_exdates_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    dates: Vec<String>,
) -> AppResult<PageRecurrenceRule> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        merge_rule_exdates_tx(&mut tx, &id, &dates).await?;
        tx.commit().await?;
        Ok(())
    })
    .await?;
    fetch_rule(pool, &id).await
}

/// Removes a single date from a rule's exdates (undo a skip). Removes ONLY that
/// date from the current row — exdates added since the skip survive.
pub async fn remove_rule_exdate_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    date: String,
) -> AppResult<PageRecurrenceRule> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        let current: String =
            sqlx::query_scalar("SELECT rrule_exdates FROM page_recurrence_rules WHERE id = ?")
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("Recurrence rule not found: {id}")))?;
        let exdates: Vec<String> = serde_json::from_str::<Vec<String>>(&current)
            .unwrap_or_default()
            .into_iter()
            .filter(|d| d != &date)
            .collect();
        let json = serde_json::to_string(&exdates).unwrap_or_else(|_| "[]".to_string());
        sqlx::query("UPDATE page_recurrence_rules SET rrule_exdates = ? WHERE id = ?")
            .bind(&json)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    })
    .await?;
    fetch_rule(pool, &id).await
}

pub async fn delete_recurrence_rule_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    // Cascades to page_schedules rows with rule_id = id
    sqlx::query("DELETE FROM page_recurrence_rules WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_recurrence_rules_impl(
    pool: &sqlx::SqlitePool,
) -> AppResult<Vec<PageRecurrenceRule>> {
    let rows = sqlx::query_as::<_, RecurrenceRuleRow>(
        "SELECT r.* FROM page_recurrence_rules r
         INNER JOIN pages p ON p.id = r.page_id
         WHERE p.deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(PageRecurrenceRule::from).collect())
}

pub async fn get_recurrence_rule_impl(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> AppResult<Option<PageRecurrenceRule>> {
    let row = sqlx::query_as::<_, RecurrenceRuleRow>(
        "SELECT * FROM page_recurrence_rules WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(PageRecurrenceRule::from))
}

#[cfg(test)]
#[path = "schedules_tests.rs"]
mod schedules_tests;
