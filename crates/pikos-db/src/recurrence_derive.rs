//! The two backend derivations over a recurring series' truth — rule base + the
//! exclusion union (`completed ∪ skip ∪ provider-EXDATEs ∪ override
//! original_dates`, keyed by day) — consuming the pure [`pikos_recurrence`]
//! engine: [`recompute_recurring_schedule`] (the display cache) and
//! [`occurrences_with_open_reminder_window`] (reminders). Both derive from truth
//! and never read the cache, so a corrupted `pages.scheduled_start` can't skew
//! them.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};
use crate::notification_log::{synced_fire_instant, DueReminder};
use crate::{now_iso, now_local_iso};

const WALL_FMT: &str = "%Y-%m-%dT%H:%M:%S";

#[derive(sqlx::FromRow)]
struct RuleRow {
    id: String,
    rrule: String,
    rrule_exdates: String,
    base_start: String,
    base_end: Option<String>,
}

async fn load_rule(conn: &mut sqlx::SqliteConnection, page_id: &str) -> AppResult<Option<RuleRow>> {
    Ok(sqlx::query_as::<_, RuleRow>(
        "SELECT id, rrule, rrule_exdates, scheduled_start AS base_start, scheduled_end AS base_end
         FROM page_recurrence_rules WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// The exclusion union for a series: provider EXDATEs (from the rule row) ∪
/// completed-set ∪ skip-set ∪ materialized-override original_dates. The pure
/// derivation matches these against occurrence dates by day.
async fn exclusion_union(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    rule_id: &str,
    legacy_exdates_json: &str,
) -> AppResult<Vec<String>> {
    let mut union: Vec<String> = serde_json::from_str(legacy_exdates_json).unwrap_or_default();
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT occurrence_date FROM completed_set WHERE page_id = ?1
         UNION
         SELECT occurrence_date FROM skip_set WHERE page_id = ?1
         UNION
         SELECT original_date FROM page_schedules
           WHERE rule_id = ?2 AND original_date IS NOT NULL",
    )
    .bind(page_id)
    .bind(rule_id)
    .fetch_all(&mut *conn)
    .await?;
    union.extend(rows);
    Ok(union)
}

fn derive_oldest_open(
    rule: &RuleRow,
    exclusions: &[String],
) -> AppResult<Option<pikos_recurrence::Occurrence>> {
    pikos_recurrence::oldest_open_occurrence(
        &rule.rrule,
        &rule.base_start,
        rule.base_end.as_deref(),
        exclusions,
    )
    .map_err(|e| AppError::Internal(format!("recurrence derivation failed: {e}")))
}

/// Recomputes `pages.scheduled_start` for one recurring page from truth and flips
/// its terminal status. Runs inside the caller's transaction so the cache write is
/// atomic with the write that changed the truth (completion, skip, reconcile, …).
/// No-op on a non-recurring page — the rule-remove handoff clears the denorm
/// separately.
pub async fn recompute_recurring_schedule(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
) -> AppResult<()> {
    let Some(rule) = load_rule(tx, page_id).await? else {
        return Ok(());
    };
    let excl = exclusion_union(tx, page_id, &rule.id, &rule.rrule_exdates).await?;

    // An out-of-envelope rule (a provider shape the engine rejects) must not fail
    // the enclosing write — leave the cache as-is and skip, matching the reminder
    // enumeration's per-series isolation.
    let derived = match pikos_recurrence::oldest_open_occurrence(
        &rule.rrule,
        &rule.base_start,
        rule.base_end.as_deref(),
        &excl,
    ) {
        Ok(derived) => derived,
        Err(e) => {
            warn_unsupported_series_once(&rule.id, &e);
            return Ok(());
        }
    };
    let now = now_iso();

    match derived {
        // Head sits on the oldest open occurrence; un-mark `done` if the series
        // yields again (both CASE arms read the pre-update status).
        Some(occ) => {
            sqlx::query(
                "UPDATE pages SET
                   scheduled_start = ?1,
                   scheduled_end = ?2,
                   status = CASE WHEN status = 'done' THEN 'not_started' ELSE status END,
                   completed_at = CASE WHEN status = 'done' THEN NULL ELSE completed_at END,
                   updated_at = ?3
                 WHERE id = ?4",
            )
            .bind(&occ.scheduled_start)
            .bind(&occ.scheduled_end)
            .bind(&now)
            .bind(page_id)
            .execute(&mut **tx)
            .await?;
        }
        // Finite series exhausted → head done, no clone (native terminal
        // behavior). Guarded so a repeat recompute doesn't re-stamp completed_at.
        None => {
            sqlx::query(
                "UPDATE pages SET status = 'done', completed_at = ?1, updated_at = ?2
                 WHERE id = ?3 AND status != 'done'",
            )
            .bind(now_local_iso())
            .bind(&now)
            .bind(page_id)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}

/// Pool-level [`recompute_recurring_schedule`] in its own transaction, retrying on
/// `SQLITE_BUSY_SNAPSHOT`. For callers with no ambient transaction — the foreground
/// load/time-tick heal and the rule-add handoff — where the recompute is the whole
/// write, not a step folded into a larger one.
pub async fn recompute_recurring_schedule_pool(pool: &SqlitePool, page_id: &str) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        recompute_recurring_schedule(&mut tx, page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

/// The stateless display derivation for one page, read-only — the `cache ==
/// f(truth)` reference and the shadow-invariant oracle. `None` once a finite
/// series is exhausted.
pub async fn oldest_open_for_page(
    pool: &SqlitePool,
    page_id: &str,
) -> AppResult<Option<pikos_recurrence::Occurrence>> {
    let mut conn = pool.acquire().await?;
    let Some(rule) = load_rule(&mut conn, page_id).await? else {
        return Ok(None);
    };
    let excl = exclusion_union(&mut conn, page_id, &rule.id, &rule.rrule_exdates).await?;
    derive_oldest_open(&rule, &excl)
}

#[derive(sqlx::FromRow)]
struct ReminderSeries {
    rule_id: String,
    page_id: String,
    title: String,
    rrule: String,
    rrule_exdates: String,
    base_start: String,
    base_end: Option<String>,
    timezone: String,
    synced: bool,
}

/// Recurring occurrences whose reminder fire instant lands in the scheduler's
/// fixed 60-second window `[now − 60s, now]` — an enumeration per (occurrence ×
/// reminder-lead), so a series with two occurrences in-window fires both (a scalar
/// head misses one). Native series compare wall-clock in device-local time
/// (`now_local`); synced series resolve occurrence wall-clock + TZID → absolute
/// UTC and compare against `now_utc`. `synced` is `sync_state = 'active'`, so a
/// **detached** series is treated as native and fires on device-local wall-clock —
/// consistent with the display, which also treats a detached series as native once
/// it unlocks (`useRecurrenceExpansion`), even though its wall-clock stays
/// source-zone-stamped. Completed/skipped occurrences are excluded via the union,
/// and the dedup key matches the scheduler's existing `page_id@start[#lead]` format
/// so `notification_log` rows line up. All-day series are out of scope (they'd fire
/// at midnight-minus-N). `max_lead` bounds the enumeration window; the caller passes
/// an upper bound over every configured lead.
pub async fn occurrences_with_open_reminder_window(
    pool: &SqlitePool,
    now_local: NaiveDateTime,
    now_utc: DateTime<Utc>,
    default_minutes: i64,
    max_lead: i64,
) -> AppResult<Vec<DueReminder>> {
    let series: Vec<ReminderSeries> = sqlx::query_as(
        "SELECT r.id AS rule_id, r.page_id, p.title, r.rrule, r.rrule_exdates,
                r.scheduled_start AS base_start, r.scheduled_end AS base_end, r.timezone,
                EXISTS(SELECT 1 FROM page_sync sy
                       WHERE sy.page_id = r.page_id AND sy.sync_state = 'active') AS synced
         FROM page_recurrence_rules r
         JOIN pages p ON p.id = r.page_id
         WHERE p.deleted_at IS NULL
           AND p.status != 'done'
           AND r.scheduled_start LIKE '%T%'",
    )
    .fetch_all(pool)
    .await?;

    let mut candidates = Vec::new();
    for s in series {
        // The wall-clock "now" the occurrence enumeration seeks near: source-zone
        // for synced, device-local for native. An unparseable synced zone is
        // skipped (matches `synced_fire_instant`'s None).
        let zone_now = if s.synced {
            match s.timezone.parse::<chrono_tz::Tz>() {
                Ok(tz) => now_utc.with_timezone(&tz).naive_local(),
                Err(_) => continue,
            }
        } else {
            now_local
        };
        // Widen the upper bound by an hour so a DST shift on the synced wall→instant
        // mapping can't drop a boundary occurrence; the exact fire check filters the
        // over-enumeration.
        let lo = (zone_now - Duration::seconds(60)).format(WALL_FMT).to_string();
        let hi = (zone_now + Duration::minutes(max_lead) + Duration::hours(1))
            .format(WALL_FMT)
            .to_string();

        // Enumerate first (pure, no DB). Exclusions only ever remove occurrences,
        // so a series with none in-window here has none after exclusion — skip it
        // before running its leads/exclusion queries. An out-of-envelope rule (a
        // provider shape the engine rejects) is skipped, not fatal to the batch.
        match enumerate_window(&s, &lo, &hi, &[]) {
            Ok(occ) if occ.is_empty() => continue,
            Ok(_) => {}
            Err(e) => {
                warn_unsupported_series_once(&s.rule_id, &e);
                continue;
            }
        }

        let leads = reminder_leads(pool, &s.page_id, default_minutes).await?;
        if leads.is_empty() {
            continue;
        }

        let mut conn = pool.acquire().await?;
        let excl = exclusion_union(&mut conn, &s.page_id, &s.rule_id, &s.rrule_exdates).await?;
        drop(conn);
        // The rule already parsed in the prefilter, so this can't newly error.
        let occurrences = enumerate_window(&s, &lo, &hi, &excl).unwrap_or_default();

        for occ in &occurrences {
            for lead in &leads {
                if !fires_in_window(&s, &occ.scheduled_start, lead.minutes, now_local, now_utc) {
                    continue;
                }
                candidates.push(DueReminder {
                    schedule_id: lead.schedule_id(&s.page_id, &occ.scheduled_start),
                    page_id: s.page_id.clone(),
                    title: s.title.clone(),
                    scheduled_start: occ.scheduled_start.clone(),
                    minutes_before: lead.minutes,
                });
            }
        }
    }

    let fired = fired_schedule_ids(pool, &candidates).await?;
    Ok(candidates
        .into_iter()
        .filter(|c| !fired.contains(&c.schedule_id))
        .collect())
}

/// Recurring occurrences in `[lo, hi]` (wall-clock), minus `excl`. A thin wrapper
/// over the pure engine so the reminder path can enumerate once to prefilter
/// (empty `excl`) and again with the real exclusion set.
fn enumerate_window(
    s: &ReminderSeries,
    lo: &str,
    hi: &str,
    excl: &[String],
) -> Result<Vec<pikos_recurrence::Occurrence>, pikos_recurrence::RecurrenceError> {
    pikos_recurrence::occurrences_in_window(
        &s.rrule,
        &s.base_start,
        s.base_end.as_deref(),
        lo,
        hi,
        excl,
    )
}

/// Rule ids already warned about, so a persistently out-of-envelope series logs
/// once per process rather than on every ~60s reminder tick.
static WARNED_RULES: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn warn_unsupported_series_once(rule_id: &str, err: &pikos_recurrence::RecurrenceError) {
    let first = WARNED_RULES
        .lock()
        .map(|mut seen| seen.insert(rule_id.to_string()))
        .unwrap_or(true);
    if first {
        log::warn!("reminder enumeration skipping series {rule_id}: unsupported rule ({err})");
    }
}

/// A reminder lead for a series: its minutes and whether it came from an explicit
/// `page_reminders` row (which changes the dedup-key shape).
struct Lead {
    minutes: i64,
    explicit: bool,
}

impl Lead {
    /// Matches the scheduler's existing dedup ids: explicit reminders encode the
    /// lead so multiple reminders on one occurrence stay independent.
    fn schedule_id(&self, page_id: &str, scheduled_start: &str) -> String {
        if self.explicit {
            format!("{page_id}@{scheduled_start}#{}", self.minutes)
        } else {
            format!("{page_id}@{scheduled_start}")
        }
    }
}

/// A page with any `page_reminders` row is on the explicit path (a lone `-1`
/// sentinel row means "no reminders" → empty); a page with none uses the global
/// default lead — synced recurring series included, matching native.
async fn reminder_leads(
    pool: &SqlitePool,
    page_id: &str,
    default_minutes: i64,
) -> AppResult<Vec<Lead>> {
    let configured: Vec<i64> =
        sqlx::query_scalar("SELECT minutes_before FROM page_reminders WHERE page_id = ?")
            .bind(page_id)
            .fetch_all(pool)
            .await?;
    let leads = if configured.is_empty() {
        (default_minutes >= 0)
            .then_some(Lead { minutes: default_minutes, explicit: false })
            .into_iter()
            .collect()
    } else {
        configured
            .into_iter()
            .filter(|m| *m >= 0)
            .map(|minutes| Lead { minutes, explicit: true })
            .collect()
    };
    Ok(leads)
}

/// Whether `scheduled_start - lead` lands in the inclusive 60-second window.
fn fires_in_window(
    series: &ReminderSeries,
    scheduled_start: &str,
    minutes_before: i64,
    now_local: NaiveDateTime,
    now_utc: DateTime<Utc>,
) -> bool {
    if series.synced {
        match synced_fire_instant(scheduled_start, &series.timezone, minutes_before) {
            Some(fire) => fire >= now_utc - Duration::seconds(60) && fire <= now_utc,
            None => false,
        }
    } else {
        match NaiveDateTime::parse_from_str(scheduled_start, WALL_FMT) {
            Ok(start) => {
                let fire = start - Duration::minutes(minutes_before);
                fire >= now_local - Duration::seconds(60) && fire <= now_local
            }
            Err(_) => false,
        }
    }
}

/// The `schedule_id`s among `candidates` already logged as fired reminders —
/// one batched `IN(...)` lookup, so dedup costs a single query per tick rather
/// than one per candidate occurrence×lead.
async fn fired_schedule_ids(
    pool: &SqlitePool,
    candidates: &[DueReminder],
) -> AppResult<HashSet<String>> {
    if candidates.is_empty() {
        return Ok(HashSet::new());
    }
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT schedule_id FROM notification_log WHERE type = 'reminder' AND schedule_id IN (",
    );
    let mut separated = builder.separated(", ");
    for c in candidates {
        separated.push_bind(&c.schedule_id);
    }
    separated.push_unseparated(")");
    let rows: Vec<String> = builder.build_query_scalar().fetch_all(pool).await?;
    Ok(rows.into_iter().collect())
}

#[cfg(test)]
#[path = "recurrence_derive_tests.rs"]
mod recurrence_derive_tests;
