//! Derivations over a recurring series' truth, the rule base plus the exclusion union
//! (completed, skip, provider EXDATEs and override `original_date`s, keyed by day), on the
//! pure [`pikos_recurrence`] engine: [`recompute_recurring_schedule`] (the display cache),
//! [`occurrences_with_open_reminder_window`] and [`recurring_pages_in_window`]. None reads
//! the cache, so a corrupted `pages.scheduled_start` can't skew them.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use chrono::{Duration, NaiveDateTime};
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

/// The exclusion union for a series: provider EXDATEs, completed-set, skip-set and
/// materialized-override original dates. The engine matches them against occurrences by day.
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
    floor: Option<&str>,
) -> AppResult<Option<pikos_recurrence::Occurrence>> {
    pikos_recurrence::oldest_open_occurrence(
        &rule.rrule,
        &rule.base_start,
        rule.base_end.as_deref(),
        exclusions,
        floor,
    )
    .map_err(|e| AppError::Internal(format!("recurrence derivation failed: {e}")))
}

/// Upper bound for expanding a whole series, reached only on one already found exhausted,
/// which is finite.
const SERIES_END: &str = "9999-12-31T23:59:59";

/// The newest occurrence no exclusion covers, ignoring the synced head floor.
/// Where an exhausted mirror's head parks: the provider's base would date the row at the
/// first occurrence of a series that has ended. `None` when every occurrence is excluded,
/// which leaves the head where it is, as the frontend hides a head on a completed date.
fn last_open_occurrence(
    rule: &RuleRow,
    exclusions: &[String],
) -> Option<pikos_recurrence::Occurrence> {
    pikos_recurrence::occurrences_in_window(
        &rule.rrule,
        &rule.base_start,
        rule.base_end.as_deref(),
        &rule.base_start,
        SERIES_END,
        exclusions,
    )
    .ok()?
    .pop()
}

/// Lower bound on a synced series' head: the day the page was first synced. Without it the
/// head parks on the master's original `DTSTART`, which a provider returns whenever the
/// series still yields instances in the backfill window and can predate the connection by
/// years, so completing it completes the wrong instance.
///
/// Applies to active and detached alike: a synced series keeps task semantics, so an
/// occurrence passed while away surfaces as the head, as for a native series. Detaching
/// doesn't rewrite the provider's base, so dropping the floor would let the head fall back.
///
/// The anchor is the connect day, not the backfill window ([`crate::sync::BACKFILL_DAYS`]):
/// those occurrences predate the user, and flooring there would open a fresh series already
/// overdue. The render floor (`Page::synced_since`) uses the same anchor.
///
/// `page_sync.created_at` is written once on insert and never rewritten, so a
/// `410`-triggered re-enumerate can't march the floor forward and strand an advanced head.
/// `sync_calendar.last_full_sync_at` restamps on every full enumerate, so it isn't used.
///
/// A floor only moves the head forward, so completion history still wins.
async fn synced_head_floor(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> AppResult<Option<String>> {
    let created: Option<String> =
        sqlx::query_scalar("SELECT created_at FROM page_sync WHERE page_id = ?")
            .bind(page_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(created.as_deref().and_then(crate::sync::local_day_of))
}

/// Whether the person has resolved a synced series to its end: they ticked or skipped
/// something, and no moved occurrence on or after the connect day is still open. The caller
/// has already found no open occurrence of the rule itself.
///
/// Such a series completes like a native one. A live mirror is otherwise never marked done,
/// because the stamped `completed_at` counts as ownership (`PAGE_OWNED_SQL`) and an untouched
/// mirror must not survive disconnect or ship in an export as authored. A tick or skip already
/// made the page owned, so nothing new is claimed; left undone it parks open on a ticked date.
async fn ticked_through(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    rule_id: &str,
    floor: Option<&str>,
) -> AppResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT (EXISTS(SELECT 1 FROM completed_set WHERE page_id = ?1)
                 OR EXISTS(SELECT 1 FROM skip_set WHERE page_id = ?1))
            AND NOT EXISTS(
                SELECT 1 FROM page_schedules o
                 WHERE o.rule_id = ?2 AND o.original_date IS NOT NULL
                   AND substr(o.original_date, 1, 10) >= coalesce(?3, '')
                   AND substr(o.original_date, 1, 10) NOT IN (
                       SELECT substr(occurrence_date, 1, 10) FROM completed_set WHERE page_id = ?1
                       UNION
                       SELECT substr(occurrence_date, 1, 10) FROM skip_set WHERE page_id = ?1))",
    )
    .bind(page_id)
    .bind(rule_id)
    .bind(floor)
    .fetch_one(&mut *conn)
    .await?)
}

/// Recomputes `pages.scheduled_start` for one recurring page from truth and flips its
/// terminal status, inside the caller's transaction so the cache write is atomic with the
/// write that changed the truth. No-op on a non-recurring page.
pub async fn recompute_recurring_schedule(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
) -> AppResult<()> {
    let Some(rule) = load_rule(tx, page_id).await? else {
        return Ok(());
    };
    let excl = exclusion_union(tx, page_id, &rule.id, &rule.rrule_exdates).await?;
    let floor = synced_head_floor(tx, page_id).await?;

    // A rule the engine rejects must not fail the enclosing write; the cache is left as is.
    let derived = match pikos_recurrence::oldest_open_occurrence(
        &rule.rrule,
        &rule.base_start,
        rule.base_end.as_deref(),
        &excl,
        floor.as_deref(),
    ) {
        Ok(derived) => derived,
        Err(e) => {
            warn_unsupported_series_once(&rule.id, &e);
            return Ok(());
        }
    };
    let now = now_iso();

    match derived {
        // Un-marks `done` if the series yields again (both CASE arms read the pre-update
        // status). The trailing guard makes a no-op recompute write nothing: the load-time
        // heal runs over every series, and an unconditional write would restamp `updated_at`
        // and float untouched mirrors to the top of recently edited.
        Some(occ) => {
            sqlx::query(
                "UPDATE pages SET
                   scheduled_start = ?1,
                   scheduled_end = ?2,
                   status = CASE WHEN status = 'done' THEN 'not_started' ELSE status END,
                   completed_at = CASE WHEN status = 'done' THEN NULL ELSE completed_at END,
                   updated_at = ?3
                 WHERE id = ?4
                   AND (scheduled_start IS NOT ?1 OR scheduled_end IS NOT ?2 OR status = 'done')",
            )
            .bind(&occ.scheduled_start)
            .bind(&occ.scheduled_end)
            .bind(&now)
            .bind(page_id)
            .execute(&mut **tx)
            .await?;
        }
        // Exhausted. A native series, and a mirror the person ticked through, ends here with
        // the head done; any other mirror parks on its last occurrence (`ticked_through`).
        None => {
            if crate::sync::page_schedule_locked_conn(tx, page_id).await?
                && !ticked_through(tx, page_id, &rule.id, floor.as_deref()).await?
            {
                if let Some(occ) = last_open_occurrence(&rule, &excl) {
                    sqlx::query(
                        "UPDATE pages SET
                           scheduled_start = ?1,
                           scheduled_end = ?2,
                           updated_at = ?3
                         WHERE id = ?4
                           AND (scheduled_start IS NOT ?1 OR scheduled_end IS NOT ?2)",
                    )
                    .bind(&occ.scheduled_start)
                    .bind(&occ.scheduled_end)
                    .bind(&now)
                    .bind(page_id)
                    .execute(&mut **tx)
                    .await?;
                }
                return Ok(());
            }
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

/// [`recompute_recurring_schedule`] in its own transaction, retrying on
/// `SQLITE_BUSY_SNAPSHOT`, for callers with no ambient transaction.
pub async fn recompute_recurring_schedule_pool(pool: &SqlitePool, page_id: &str) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        recompute_recurring_schedule(&mut tx, page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

/// The read-only display derivation for one page, the reference for `cache == f(truth)`
/// and the shadow-invariant oracle. `None` once a finite series is exhausted.
pub async fn oldest_open_for_page(
    pool: &SqlitePool,
    page_id: &str,
) -> AppResult<Option<pikos_recurrence::Occurrence>> {
    let mut conn = pool.acquire().await?;
    let Some(rule) = load_rule(&mut conn, page_id).await? else {
        return Ok(None);
    };
    let excl = exclusion_union(&mut conn, page_id, &rule.id, &rule.rrule_exdates).await?;
    let floor = synced_head_floor(&mut conn, page_id).await?;
    derive_oldest_open(&rule, &excl, floor.as_deref())
}

#[derive(sqlx::FromRow)]
struct WindowSeries {
    rule_id: String,
    page_id: String,
    rrule: String,
    rrule_exdates: String,
    base_start: String,
    base_end: Option<String>,
}

/// Distinct pages whose rule yields an open occurrence starting inside the inclusive
/// wall-clock window `[lo, hi]`.
///
/// The daily-summary counts read this, not `pages.scheduled_start`: only completion advances
/// the head, so a running series sits on a past occurrence while the calendar renders
/// today's, invisible to a head read.
///
/// Excluded occurrences don't count; a moved instance is a `page_schedules` row, counted at
/// its new date. Synced series floor at the connect day as the head does ([`synced_head_floor`]).
///
/// `timed_only` drops all-day series, which have no instant to be late against;
/// `created_before` drops pages newer than the cutoff and is UTC, like the
/// `created_at` it meets (see [`crate::overdue_count`]).
pub(crate) async fn recurring_pages_in_window(
    pool: &SqlitePool,
    lo: &str,
    hi: &str,
    timed_only: bool,
    created_before: Option<&str>,
) -> AppResult<Vec<String>> {
    // CROSS JOIN fixes the order, rules first, with or without statistics: `gather_statistics`.
    let series: Vec<WindowSeries> = sqlx::query_as(
        "SELECT r.id AS rule_id, r.page_id, r.rrule, r.rrule_exdates,
                r.scheduled_start AS base_start, r.scheduled_end AS base_end
         FROM page_recurrence_rules r
         CROSS JOIN pages p ON p.id = r.page_id
         WHERE p.deleted_at IS NULL
           AND p.status != 'done'
           AND (?1 = 0 OR r.scheduled_start LIKE '%T%')
           AND (?2 IS NULL OR datetime(p.created_at) < datetime(?2))",
    )
    .bind(timed_only)
    .bind(created_before)
    .fetch_all(pool)
    .await?;

    let mut pages = Vec::new();
    for s in series {
        let mut conn = pool.acquire().await?;
        let excl = exclusion_union(&mut conn, &s.page_id, &s.rule_id, &s.rrule_exdates).await?;
        let floor = synced_head_floor(&mut conn, &s.page_id).await?;
        drop(conn);

        // A rule the engine rejects is skipped, not fatal to the count.
        let occurrences = match pikos_recurrence::occurrences_in_window(
            &s.rrule,
            &s.base_start,
            s.base_end.as_deref(),
            lo,
            hi,
            &excl,
        ) {
            Ok(occurrences) => occurrences,
            Err(e) => {
                warn_unsupported_series_once(&s.rule_id, &e);
                continue;
            }
        };
        if occurrences.iter().any(|o| {
            floor
                .as_deref()
                .is_none_or(|f| o.original_date.as_str() >= f)
        }) {
            pages.push(s.page_id);
        }
    }
    Ok(pages)
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

/// Recurring occurrences whose reminder fire instant lands in the tick's window, enumerated
/// per (occurrence, lead) so a series with two occurrences in-window fires both. Native
/// series compare device-local wall-clock; synced series resolve wall-clock and TZID to an
/// absolute instant. `synced` is `sync_state = 'active'`, so a detached series fires as native,
/// as the display treats it (`useRecurrenceExpansion`). Excluded occurrences are skipped, and
/// the dedup key is the scheduler's `page_id@start[#lead]`. All-day series are out of scope.
/// `max_lead` bounds the enumeration window; pass an upper bound over every configured lead.
pub async fn occurrences_with_open_reminder_window(
    pool: &SqlitePool,
    window: &crate::notification_log::ReminderWindow,
    default_minutes: i64,
    max_lead: i64,
) -> AppResult<Vec<DueReminder>> {
    let fires =
        occurrences_with_reminders_firing_in(pool, window, default_minutes, max_lead).await?;
    Ok(fires.into_iter().map(|fire| fire.reminder).collect())
}

/// [`occurrences_with_open_reminder_window`] with each fire's instant kept.
pub async fn occurrences_with_reminders_firing_in(
    pool: &SqlitePool,
    window: &crate::notification_log::ReminderWindow,
    default_minutes: i64,
    max_lead: i64,
) -> AppResult<Vec<crate::notification_log::ReminderFire>> {
    use crate::notification_log::ReminderFire;

    // CROSS JOIN fixes the order, rules first, with or without statistics: `gather_statistics`.
    let series: Vec<ReminderSeries> = sqlx::query_as(
        "SELECT r.id AS rule_id, r.page_id, p.title, r.rrule, r.rrule_exdates,
                r.scheduled_start AS base_start, r.scheduled_end AS base_end, r.timezone,
                EXISTS(SELECT 1 FROM page_sync sy
                       WHERE sy.page_id = r.page_id AND sy.sync_state = 'active') AS synced
         FROM page_recurrence_rules r
         CROSS JOIN pages p ON p.id = r.page_id
         WHERE p.deleted_at IS NULL
           AND p.status != 'done'
           AND r.scheduled_start LIKE '%T%'",
    )
    .fetch_all(pool)
    .await?;

    let mut candidates: Vec<ReminderFire> = Vec::new();
    for s in series {
        // Source-zone for synced, device-local for native; an unparseable synced zone is skipped.
        let (zone_lo, zone_hi) = if s.synced {
            match s.timezone.parse::<chrono_tz::Tz>() {
                Ok(tz) => (
                    window.start_utc().with_timezone(&tz).naive_local(),
                    window.end_utc().with_timezone(&tz).naive_local(),
                ),
                Err(_) => continue,
            }
        } else {
            (window.start_local(), window.end_local())
        };
        // A reminder fires up to `max_lead` before its occurrence, so enumeration runs that much
        // past the window, plus an hour so a DST shift can't drop a boundary occurrence. The
        // exact fire check filters the excess.
        let lo = zone_lo.format(WALL_FMT).to_string();
        let hi = (zone_hi + Duration::minutes(max_lead) + Duration::hours(1))
            .format(WALL_FMT)
            .to_string();

        // Exclusions only remove occurrences, so a series with none in-window here has none
        // after them; skip it before its lead and exclusion queries. A rule the engine rejects
        // is skipped, not fatal to the batch.
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
        let occurrences = enumerate_window(&s, &lo, &hi, &excl).unwrap_or_default();

        for occ in &occurrences {
            for lead in &leads {
                let Some(fire_at) = fire_in_window(&s, &occ.scheduled_start, lead.minutes, window)
                else {
                    continue;
                };
                candidates.push(ReminderFire {
                    reminder: DueReminder {
                        schedule_id: lead.schedule_id(&s.page_id, &occ.scheduled_start),
                        page_id: s.page_id.clone(),
                        title: s.title.clone(),
                        scheduled_start: occ.scheduled_start.clone(),
                        minutes_before: lead.minutes,
                    },
                    fire_at,
                });
            }
        }
    }

    let rows: Vec<DueReminder> = candidates.iter().map(|c| c.reminder.clone()).collect();
    let fired = fired_schedule_ids(pool, &rows).await?;
    Ok(candidates
        .into_iter()
        .filter(|c| !fired.contains(&c.reminder.schedule_id))
        .collect())
}

/// Recurring occurrences in `[lo, hi]` minus `excl`, so the reminder path can prefilter with
/// an empty `excl` and enumerate again with the real set.
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

/// Rule ids already warned about, so a rejected series logs once per process, not every tick.
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

/// A reminder lead for a series: its minutes, and whether it came from an explicit
/// `page_reminders` row, which changes the dedup-key shape.
struct Lead {
    minutes: i64,
    explicit: bool,
}

impl Lead {
    /// Explicit reminders encode the lead, so several on one occurrence stay independent.
    fn schedule_id(&self, page_id: &str, scheduled_start: &str) -> String {
        if self.explicit {
            format!("{page_id}@{scheduled_start}#{}", self.minutes)
        } else {
            format!("{page_id}@{scheduled_start}")
        }
    }
}

/// A page with any `page_reminders` row uses them (a lone `-1` row means none); a page with
/// none uses the global default lead, synced series included.
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
            .then_some(Lead {
                minutes: default_minutes,
                explicit: false,
            })
            .into_iter()
            .collect()
    } else {
        configured
            .into_iter()
            .filter(|m| *m >= 0)
            .map(|minutes| Lead {
                minutes,
                explicit: true,
            })
            .collect()
    };
    Ok(leads)
}

/// When `scheduled_start - lead` fires, if that lands in the window. A synced series resolves
/// to an instant; a native one stays device-local wall-clock.
fn fire_in_window(
    series: &ReminderSeries,
    scheduled_start: &str,
    minutes_before: i64,
    window: &crate::notification_log::ReminderWindow,
) -> Option<crate::notification_log::FireAt> {
    use crate::notification_log::FireAt;

    if series.synced {
        let fire = synced_fire_instant(scheduled_start, &series.timezone, minutes_before)?;
        window.holds_utc(fire).then_some(FireAt::Absolute(fire))
    } else {
        let start = NaiveDateTime::parse_from_str(scheduled_start, WALL_FMT).ok()?;
        let fire = start - Duration::minutes(minutes_before);
        window.holds_local(fire).then_some(FireAt::Local(fire))
    }
}

/// The `schedule_id`s among `candidates` already logged as fired, in one batched lookup
/// rather than one per candidate.
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
