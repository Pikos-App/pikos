use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::now_iso;

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

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct PageSchedule {
    pub id: String,
    pub page_id: String,
    /// Local wall-clock: `YYYY-MM-DD` all-day, `YYYY-MM-DDTHH:MM:SS` timed.
    pub scheduled_start: String,
    /// Same shape as the start. `null` means a single day, or an hour by default.
    pub scheduled_end: Option<String>,
    /// IANA zone the time was authored in. Recurrence expansion ignores it.
    pub timezone: Option<String>,
    pub rule_id: Option<String>,
    pub original_date: Option<String>,
    #[ts(type = "'not_started' | 'done' | 'skipped'")]
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

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct NewPageSchedule {
    pub page_id: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: Option<String>,
    pub rule_id: Option<String>,
    pub original_date: Option<String>,
}

#[derive(Debug, Deserialize, Default, ts_rs::TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, optional_fields = nullable)]
pub struct PageScheduleUpdate {
    pub scheduled_start: Option<String>,
    #[serde(default, deserialize_with = "crate::pages::deserialize_nullable")]
    #[ts(type = "string | null", optional)]
    pub scheduled_end: Option<serde_json::Value>,
    #[ts(type = "'not_started' | 'done' | 'skipped'", optional)]
    pub status: Option<String>,
}

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

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct PageRecurrenceRule {
    pub id: String,
    pub page_id: String,
    /// An iCalendar RRULE, e.g. `FREQ=WEEKLY;BYDAY=MO`.
    pub rrule: String,
    /// Dates the rule would yield but that are excluded from it.
    pub rrule_exdates: Vec<String>,
    /// Where the repeat starts, in the same shape a schedule uses.
    pub scheduled_start: String,
    /// Where the first occurrence ends. `null` means an hour by default.
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

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct NewRecurrenceRule {
    pub page_id: String,
    pub rrule: String,
    #[serde(default)]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub rrule_exdates: Vec<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: String,
}

#[derive(Debug, Deserialize, Default, ts_rs::TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, optional_fields = nullable)]
pub struct RecurrenceRuleUpdate {
    pub rrule: Option<String>,
    pub rrule_exdates: Option<Vec<String>>,
    pub scheduled_start: Option<String>,
    #[serde(default, deserialize_with = "crate::pages::deserialize_nullable")]
    #[ts(type = "string | null", optional)]
    pub scheduled_end: Option<serde_json::Value>,
    pub timezone: Option<String>,
}

/// Refreshes `pages.scheduled_start` and `scheduled_end` to the page's nearest non-override
/// schedule: the earliest upcoming, else the most recent past. NULL when none remain.
pub async fn refresh_schedule_denorm(pool: &sqlx::SqlitePool, page_id: &str) -> AppResult<()> {
    let mut conn = pool.acquire().await?;
    refresh_schedule_denorm_conn(&mut conn, page_id).await
}

/// Transaction form of [`refresh_schedule_denorm`]: the schedule writers run it in the same
/// transaction as their mutation, so a crash can't leave `pages.scheduled_start` stale.
pub(crate) async fn refresh_schedule_denorm_conn(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> AppResult<()> {
    // Local wall-clock from Rust: `scheduled_start` is local, and SQLite's strftime('now') is
    // UTC, which misclassifies upcoming vs past by up to a day near midnight off-UTC.
    let now = chrono::Local::now().naive_local();
    refresh_schedule_denorm_at(conn, page_id, &now.format("%Y-%m-%dT%H:%M:%S").to_string()).await
}

/// Takes the local-now comparator explicitly so tests don't depend on the clock or timezone.
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

    // rrule-backed pages own their denorm: the head advances through complete_recurring_page_impl
    // and other occurrences are virtual. The original non-rule anchor row lingers at a past
    // date, so refreshing from page_schedules would clobber the head back to it.
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

    // A bare all-day date is padded to end-of-day, or it would flip to past at 00:00 (a bare
    // date sorts before any timed "now"). Bucket 0 is upcoming, 1 is past; earliest start wins.
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

// A synced page's schedule and recurrence are calendar-owned, so command-layer edits are
// rejected (see crate::sync::ensure_page_schedule_unlocked); the reconciler uses raw SQL.

async fn ensure_schedule_row_unlocked(pool: &sqlx::SqlitePool, schedule_id: &str) -> AppResult<()> {
    let page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM page_schedules WHERE id = ?")
            .bind(schedule_id)
            .fetch_optional(pool)
            .await?;
    if let Some(pid) = page_id {
        crate::sync::ensure_page_schedule_unlocked(pool, &pid).await?;
    }
    Ok(())
}

pub(crate) async fn ensure_rule_row_unlocked(
    pool: &sqlx::SqlitePool,
    rule_id: &str,
) -> AppResult<()> {
    let page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM page_recurrence_rules WHERE id = ?")
            .bind(rule_id)
            .fetch_optional(pool)
            .await?;
    if let Some(pid) = page_id {
        crate::sync::ensure_page_schedule_unlocked(pool, &pid).await?;
    }
    Ok(())
}

pub async fn create_page_schedule_impl(
    pool: &sqlx::SqlitePool,
    data: NewPageSchedule,
) -> AppResult<PageSchedule> {
    crate::sync::ensure_page_schedule_unlocked(pool, &data.page_id).await?;
    let id = crate::fresh::id();
    let now = now_iso();

    crate::tx::retry_on_busy(|| async {
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
        Ok(())
    })
    .await?;

    fetch_schedule(pool, &id).await
}

pub async fn update_page_schedule_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    updates: PageScheduleUpdate,
) -> AppResult<PageSchedule> {
    ensure_schedule_row_unlocked(pool, &id).await?;
    let has_updates = updates.scheduled_start.is_some()
        || updates.status.is_some()
        || updates.scheduled_end.is_some();
    if !has_updates {
        return fetch_schedule(pool, &id).await;
    }

    crate::tx::retry_on_busy(|| apply_schedule_update(pool, &id, &updates)).await?;
    fetch_schedule(pool, &id).await
}

/// The write half of [`update_page_schedule_impl`]; the statement is rebuilt on
/// each attempt because a `QueryBuilder` is spent once built.
async fn apply_schedule_update(
    pool: &sqlx::SqlitePool,
    id: &str,
    updates: &PageScheduleUpdate,
) -> AppResult<()> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE page_schedules SET ");
    let mut fields = builder.separated(", ");

    if let Some(v) = &updates.scheduled_start {
        fields.push("scheduled_start = ");
        fields.push_bind_unseparated(v.clone());
    }
    if let Some(v) = &updates.status {
        fields.push("status = ");
        fields.push_bind_unseparated(v.clone());
    }
    if let Some(val) = &updates.scheduled_end {
        fields.push("scheduled_end = ");
        match val {
            serde_json::Value::String(s) => fields.push_bind_unseparated(Some(s.clone())),
            _ => fields.push_bind_unseparated(None::<String>),
        };
    }

    drop(fields);
    builder.push(" WHERE id = ");
    builder.push_bind(id);

    // One tx: a crash between these could leave a stale dedup row (the reminder never re-fires
    // at the new time) or a stale pages.scheduled_start.
    let mut tx = pool.begin().await?;

    builder.build().execute(&mut *tx).await?;

    if updates.scheduled_start.is_some() {
        crate::notification_log::clear_reminder_log_tx(&mut tx, id).await?;
    }

    let page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM page_schedules WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(pid) = &page_id {
        refresh_schedule_denorm_conn(&mut tx, pid).await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn delete_page_schedule_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
    ensure_schedule_row_unlocked(pool, &id).await?;
    crate::tx::retry_on_busy(|| async {
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
    })
    .await
}

pub async fn list_page_schedules_impl(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> AppResult<Vec<PageSchedule>> {
    // Without the trashed filter a trashed page's schedules leak back into the UI.
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

/// The override rows (`rule_id` set) for the given rules, wherever each occurrence was moved.
/// The calendar's exclusion set needs an override's `original_date` even when its moved start
/// lands in another week; a range query on the moved position would miss it and ghost-render
/// the original slot. Trashed pages are excluded.
pub async fn list_page_schedules_for_rules_impl(
    pool: &sqlx::SqlitePool,
    rule_ids: &[String],
) -> AppResult<Vec<PageSchedule>> {
    if rule_ids.is_empty() {
        return Ok(vec![]);
    }
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT page_schedules.* FROM page_schedules
         JOIN pages ON pages.id = page_schedules.page_id
         WHERE pages.deleted_at IS NULL AND page_schedules.rule_id IN (",
    );
    let mut ids = builder.separated(", ");
    for id in rule_ids {
        ids.push_bind(id);
    }
    ids.push_unseparated(") ORDER BY page_schedules.scheduled_start ASC");
    let rows = builder
        .build_query_as::<PageScheduleRow>()
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(PageSchedule::from).collect())
}

pub async fn create_recurrence_rule_impl(
    pool: &sqlx::SqlitePool,
    data: NewRecurrenceRule,
) -> AppResult<PageRecurrenceRule> {
    crate::sync::ensure_page_schedule_unlocked(pool, &data.page_id).await?;
    let id = crate::fresh::id();
    let now = now_iso();
    let exdates_json =
        serde_json::to_string(&data.rrule_exdates).unwrap_or_else(|_| "[]".to_string());

    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
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
        .execute(&mut *tx)
        .await?;

        // Ownership handoff: the derivation now owns `pages.scheduled_start`; materialise the
        // oldest-open occurrence so the head reflects the rule at once.
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &data.page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await?;

    fetch_rule(pool, &id).await
}

async fn rule_page_id(pool: &sqlx::SqlitePool, rule_id: &str) -> AppResult<String> {
    sqlx::query_scalar("SELECT page_id FROM page_recurrence_rules WHERE id = ?")
        .bind(rule_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Recurrence rule not found: {rule_id}")))
}

pub async fn update_recurrence_rule_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    updates: RecurrenceRuleUpdate,
) -> AppResult<PageRecurrenceRule> {
    ensure_rule_row_unlocked(pool, &id).await?;
    let has_updates = updates.rrule.is_some()
        || updates.rrule_exdates.is_some()
        || updates.scheduled_start.is_some()
        || updates.timezone.is_some()
        || updates.scheduled_end.is_some();
    if !has_updates {
        return fetch_rule(pool, &id).await;
    }

    let page_id = rule_page_id(pool, &id).await?;
    crate::tx::retry_on_busy(|| apply_rule_update(pool, &id, &updates, &page_id)).await?;
    fetch_rule(pool, &id).await
}

/// The write half of [`update_recurrence_rule_impl`]; rebuilt each attempt because a
/// `QueryBuilder` is spent once built.
async fn apply_rule_update(
    pool: &sqlx::SqlitePool,
    id: &str,
    updates: &RecurrenceRuleUpdate,
    page_id: &str,
) -> AppResult<()> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE page_recurrence_rules SET ");
    let mut fields = builder.separated(", ");

    if let Some(v) = &updates.rrule {
        fields.push("rrule = ");
        fields.push_bind_unseparated(v.clone());
    }
    if let Some(v) = &updates.rrule_exdates {
        let json = serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string());
        fields.push("rrule_exdates = ");
        fields.push_bind_unseparated(json);
    }
    if let Some(v) = &updates.scheduled_start {
        fields.push("scheduled_start = ");
        fields.push_bind_unseparated(v.clone());
    }
    if let Some(v) = &updates.timezone {
        fields.push("timezone = ");
        fields.push_bind_unseparated(v.clone());
    }
    if let Some(val) = &updates.scheduled_end {
        fields.push("scheduled_end = ");
        match val {
            serde_json::Value::String(s) => fields.push_bind_unseparated(Some(s.clone())),
            _ => fields.push_bind_unseparated(None::<String>),
        };
    }

    drop(fields);
    builder.push(" WHERE id = ");
    builder.push_bind(id);

    let mut tx = pool.begin().await?;
    builder.build().execute(&mut *tx).await?;
    crate::recurrence_derive::recompute_recurring_schedule(&mut tx, page_id).await?;
    tx.commit().await?;
    Ok(())
}

/// Merges `add` into the rule's `rrule_exdates` in the caller's transaction and returns the
/// merged array, deduped, in stored order. This read-merge-write is the only safe way to grow
/// exdates: a client's full replacement array erases any exdate persisted since its snapshot,
/// and an interleaved skip or complete then resurrects a completed occurrence.
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

/// Adds dates to a rule's EXDATEs and recomputes the head, merging DB-side (see
/// `merge_rule_exdates_tx`). Native dismissals use the skip-set
/// ([`crate::pages::skip_occurrence_impl`]); this is for provider and manual writes.
pub async fn add_rule_exdates_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    dates: Vec<String>,
) -> AppResult<PageRecurrenceRule> {
    ensure_rule_row_unlocked(pool, &id).await?;
    let page_id = rule_page_id(pool, &id).await?;
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        merge_rule_exdates_tx(&mut tx, &id, &dates).await?;
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await?;
    fetch_rule(pool, &id).await
}

/// Removes one date from a rule's current EXDATEs and recomputes the head; exdates added
/// since survive.
pub async fn remove_rule_exdate_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    date: String,
) -> AppResult<PageRecurrenceRule> {
    ensure_rule_row_unlocked(pool, &id).await?;
    let page_id = rule_page_id(pool, &id).await?;
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
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await?;
    fetch_rule(pool, &id).await
}

/// Deletes a recurrence rule and hands `pages.scheduled_start` back to the one-off denorm in
/// one transaction. Split in two, a concurrent denorm refresh could read the lingering rule
/// row (`has_rule` still true) and skip, leaving the head pinned at the orphaned rule anchor.
pub async fn delete_recurrence_rule_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    ensure_rule_row_unlocked(pool, id).await?;
    let page_id = rule_page_id(pool, id).await?;
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        // The head is snapshotted before the rule goes, to carry onto the surviving anchor.
        let head: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT scheduled_start, scheduled_end FROM pages WHERE id = ?")
                .bind(&page_id)
                .fetch_optional(&mut *tx)
                .await?;
        sqlx::query("DELETE FROM page_recurrence_rules WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if let Some((Some(start), end)) = head {
            sqlx::query(
                "UPDATE page_schedules SET scheduled_start = ?, scheduled_end = ?
                 WHERE page_id = ? AND rule_id IS NULL",
            )
            .bind(&start)
            .bind(&end)
            .bind(&page_id)
            .execute(&mut *tx)
            .await?;
        }
        refresh_schedule_denorm_conn(&mut tx, &page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

pub async fn list_recurrence_rules_impl(
    pool: &sqlx::SqlitePool,
) -> AppResult<Vec<PageRecurrenceRule>> {
    // CROSS JOIN fixes the order, rules first, with or without statistics: `gather_statistics`.
    let rows = sqlx::query_as::<_, RecurrenceRuleRow>(
        "SELECT r.* FROM page_recurrence_rules r
         CROSS JOIN pages p ON p.id = r.page_id
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
