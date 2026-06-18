//! The shared reconciler: turns a provider-agnostic [`SyncDelta`] into page
//! writes. Both providers co-own it, so it's the only regression surface —
//! pinned by the synthetic corpus in `reconciler_tests.rs`, which runs before
//! any real provider exists.
//!
//! Out of scope here, handled by later passes: content/mirror layering (seeded
//! description, mirror columns), per-instant timezone normalization, and
//! removal/teardown lifecycle. The contract carries `removals`; this core leaves
//! them untouched.

use chrono::{Days, NaiveDate};

use crate::error::AppResult;
use crate::now_iso;
use crate::sync_delta::{EventCore, EventUpsert, OccurrenceDelta, OccurrenceKind, SyncDelta, UpsertItem};

/// All-day recurring events have no meaningful zone, but
/// `page_recurrence_rules.timezone` is NOT NULL. Stamp this when the event
/// carries no zone, rather than relaxing the constraint.
const SENTINEL_TZ: &str = "UTC";

/// The calendar a reconcile runs against. The engine resolves the system folder
/// for the calendar and hands it in; the reconciler never decides folder policy.
pub struct ReconcileContext {
    pub account_id: String,
    pub calendar_id: String,
    pub provider: String,
    pub folder_id: String,
}

/// What a reconcile surfaced for the engine to act on. Today that's only orphan
/// masters needing a targeted fetch; it never buffers or drops them itself.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    pub missing_masters: Vec<MissingMaster>,
}

/// An occurrence delta whose series has no stored rule and no master in this
/// batch. The engine resolves it with a single targeted `fetch_event` against
/// `series_ref`, then re-runs — never a full-series re-fetch, never a synthesized
/// standalone page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingMaster {
    pub ical_uid: String,
    pub series_ref: String,
}

/// Apply a delta's upserts to the store. One transaction, so a mid-delta failure
/// rolls back whole and a retry re-applies cleanly (idempotent).
pub async fn reconcile(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
    delta: &SyncDelta,
) -> AppResult<ReconcileOutcome> {
    let mut tx = pool.begin().await?;
    let mut outcome = ReconcileOutcome::default();

    // Two-pass. Whole events/series first, so a master delivered in the same
    // batch is in the store before any occurrence delta that references it.
    for item in &delta.upserts {
        if let UpsertItem::Event(ev) = item {
            apply_event(&mut tx, ctx, ev).await?;
        }
    }
    for item in &delta.upserts {
        if let UpsertItem::Occurrence(occ) = item {
            if let Some(missing) = apply_occurrence(&mut tx, ctx, occ).await? {
                outcome.missing_masters.push(missing);
            }
        }
    }

    tx.commit().await?;
    Ok(outcome)
}

/// Upsert a whole event or series: match by external_id, else re-link by
/// `ical_uid` in-calendar, else create. No-ops on an unchanged etag.
async fn apply_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    ev: &EventUpsert,
) -> AppResult<()> {
    let existing = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT id, page_id, etag FROM page_sync
         WHERE account_id = ? AND calendar_id = ? AND external_id = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(&ev.core.external_id)
    .fetch_optional(&mut **tx)
    .await?;

    let now = now_iso();

    let page_id = if let Some((page_sync_id, page_id, stored_etag)) = existing {
        // Unchanged etag → skip every write, so the token-reject full re-sync
        // doesn't churn updated_at and refloat every synced page as "recent".
        if ev.core.etag.is_some() && stored_etag == ev.core.etag {
            return Ok(());
        }
        update_page_title(tx, &page_id, &ev.core.title, &now).await?;
        sqlx::query("UPDATE page_sync SET etag = ?, sync_state = 'active', last_synced_at = ? WHERE id = ?")
            .bind(&ev.core.etag)
            .bind(&now)
            .bind(&page_sync_id)
            .execute(&mut **tx)
            .await?;
        page_id
    } else if let Some((page_sync_id, page_id)) = find_relink(tx, ctx, &ev.core.ical_uid).await? {
        // Same UID, new/absent href → re-link this calendar's dormant page, no dup.
        sqlx::query(
            "UPDATE page_sync SET external_id = ?, etag = ?, sync_state = 'active', last_synced_at = ? WHERE id = ?",
        )
        .bind(&ev.core.external_id)
        .bind(&ev.core.etag)
        .bind(&now)
        .bind(&page_sync_id)
        .execute(&mut **tx)
        .await?;
        update_page_title(tx, &page_id, &ev.core.title, &now).await?;
        page_id
    } else {
        let page_id = insert_synced_page(tx, ctx, &ev.core.title, &now).await?;
        insert_page_sync(tx, ctx, &page_id, &ev.core, &now).await?;
        page_id
    };

    write_schedule(tx, &page_id, ev, &now).await?;
    Ok(())
}

/// Find a re-linkable page by `ical_uid`, scoped to this calendar (never across
/// calendars — that would ping-pong the identity every poll).
async fn find_relink(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    ical_uid: &str,
) -> AppResult<Option<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT id, page_id FROM page_sync
         WHERE account_id = ? AND calendar_id = ? AND ical_uid = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(ical_uid)
    .fetch_optional(&mut **tx)
    .await?)
}

/// Replace the page's mirror schedule wholesale. The schedule is fully
/// reconciler-owned for a synced page, so a clean delete-and-reinsert is the
/// simplest idempotent write — re-running yields the same rows.
async fn write_schedule(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    ev: &EventUpsert,
    now: &str,
) -> AppResult<()> {
    sqlx::query("DELETE FROM page_recurrence_rules WHERE page_id = ?")
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM page_schedules WHERE page_id = ?")
        .bind(page_id)
        .execute(&mut **tx)
        .await?;

    let base_end = to_inclusive_end(ev.schedule.end.as_deref());

    if let Some(rec) = &ev.recurrence {
        let rule_id = uuid::Uuid::new_v4().to_string();
        let exdates_json = serde_json::to_string(&rec.exdates).unwrap_or_else(|_| "[]".to_string());
        let tz = ev.schedule.timezone.as_deref().unwrap_or(SENTINEL_TZ);
        sqlx::query(
            "INSERT INTO page_recurrence_rules
             (id, page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&rule_id)
        .bind(page_id)
        .bind(&rec.rrule)
        .bind(&exdates_json)
        .bind(&ev.schedule.start)
        .bind(&base_end)
        .bind(tz)
        .bind(now)
        .execute(&mut **tx)
        .await?;

        for ov in &rec.overrides {
            insert_schedule_row(
                tx,
                page_id,
                &ov.schedule.start,
                to_inclusive_end(ov.schedule.end.as_deref()).as_deref(),
                ov.schedule.timezone.as_deref(),
                Some(&rule_id),
                Some(&ov.original_date),
                now,
            )
            .await?;
        }
    } else {
        insert_schedule_row(
            tx,
            page_id,
            &ev.schedule.start,
            base_end.as_deref(),
            ev.schedule.timezone.as_deref(),
            None,
            None,
            now,
        )
        .await?;
    }

    // Keep the calendar denorm pointing at the base occurrence.
    sqlx::query("UPDATE pages SET scheduled_start = ?, scheduled_end = ?, updated_at = ? WHERE id = ?")
        .bind(&ev.schedule.start)
        .bind(&base_end)
        .bind(now)
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Apply a lone occurrence change against the already-stored series. Returns a
/// missing-master signal when no rule exists yet — never buffers, drops, or
/// synthesizes a page.
async fn apply_occurrence(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    occ: &OccurrenceDelta,
) -> AppResult<Option<MissingMaster>> {
    let rule = sqlx::query_as::<_, (String, String)>(
        "SELECT r.id, r.page_id FROM page_recurrence_rules r
         JOIN page_sync ps ON ps.page_id = r.page_id
         WHERE ps.account_id = ? AND ps.calendar_id = ? AND ps.ical_uid = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(&occ.ical_uid)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((rule_id, page_id)) = rule else {
        return Ok(Some(MissingMaster {
            ical_uid: occ.ical_uid.clone(),
            series_ref: occ.series_ref.clone(),
        }));
    };

    match &occ.kind {
        OccurrenceKind::Cancel => {
            crate::schedules::merge_rule_exdates_tx(
                tx,
                &rule_id,
                std::slice::from_ref(&occ.original_date),
            )
            .await?;
        }
        OccurrenceKind::Modify(schedule) => {
            // One override per original_date — replace any prior one.
            sqlx::query("DELETE FROM page_schedules WHERE rule_id = ? AND original_date = ?")
                .bind(&rule_id)
                .bind(&occ.original_date)
                .execute(&mut **tx)
                .await?;
            insert_schedule_row(
                tx,
                &page_id,
                &schedule.start,
                to_inclusive_end(schedule.end.as_deref()).as_deref(),
                schedule.timezone.as_deref(),
                Some(&rule_id),
                Some(&occ.original_date),
                &now_iso(),
            )
            .await?;
        }
    }
    Ok(None)
}

// ─── Row writers ──────────────────────────────────────────────────────────────

async fn insert_synced_page(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    title: &str,
    now: &str,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let sort_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id = ?")
            .bind(&ctx.folder_id)
            .fetch_one(&mut **tx)
            .await?;
    sqlx::query(
        "INSERT INTO pages
         (id, folder_id, title, content, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, '{}', '', 'not_started', 0, '[]', ?, ?, ?)",
    )
    .bind(&id)
    .bind(&ctx.folder_id)
    .bind(title)
    .bind(sort_order)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

async fn insert_page_sync(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    page_id: &str,
    core: &EventCore,
    now: &str,
) -> AppResult<()> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO page_sync
         (id, page_id, account_id, provider, calendar_id, external_id, ical_uid, etag,
          sync_state, user_modified, last_synced_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)",
    )
    .bind(&id)
    .bind(page_id)
    .bind(&ctx.account_id)
    .bind(&ctx.provider)
    .bind(&ctx.calendar_id)
    .bind(&core.external_id)
    .bind(&core.ical_uid)
    .bind(&core.etag)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn update_page_title(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    title: &str,
    now: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE pages SET title = ?, updated_at = ? WHERE id = ?")
        .bind(title)
        .bind(now)
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_schedule_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    start: &str,
    end: Option<&str>,
    timezone: Option<&str>,
    rule_id: Option<&str>,
    original_date: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(&id)
    .bind(page_id)
    .bind(start)
    .bind(end)
    .bind(timezone)
    .bind(rule_id)
    .bind(original_date)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Decrement a provider-native **exclusive** all-day end to Pikos's inclusive
/// end. Only all-day (date-only) ends are exclusive; timed ends and `None` pass
/// through untouched. Single owner of this rule — providers carry the raw end.
fn to_inclusive_end(end: Option<&str>) -> Option<String> {
    let end = end?;
    if end.len() == 10 {
        if let Ok(date) = NaiveDate::parse_from_str(end, "%Y-%m-%d") {
            if let Some(inclusive) = date.checked_sub_days(Days::new(1)) {
                return Some(inclusive.format("%Y-%m-%d").to_string());
            }
        }
    }
    Some(end.to_string())
}

#[cfg(test)]
#[path = "reconciler_tests.rs"]
mod reconciler_tests;
