//! The shared reconciler: turns a provider-agnostic [`SyncDelta`] into page writes. Both
//! providers share it, so it is the regression surface, pinned by the synthetic corpus in
//! `reconciler_tests.rs`.
//!
//! The upsert path has three field layers (locked mirror, seeded description, user layer) plus
//! per-instant timezone normalization. The lifecycle path detaches an owned page or hard-deletes
//! a bare mirror on removal, and [`teardown_calendar`] applies the same own-vs-delete rule
//! across a calendar. Ownership always errs toward keeping.

use chrono::{NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
pub(crate) use pikos_core::hash::fnv_hex;
use pikos_recurrence::{rewrite_until_with, zoned, WallClock};

use self::allday_end::InclusiveEnd;
use crate::error::AppResult;
use crate::sync_delta::{
    EventCore, EventUpsert, OccurrenceDelta, OccurrenceFidelity, OccurrenceKind, Removal,
    SyncDelta, UpsertItem,
};
use crate::{device_zone, now_iso};

/// The compact form RFC 5545 spells an `UNTIL` instant in; the only place here that isn't a
/// [`WallClock`].
const UNTIL_FMT: &str = "%Y%m%dT%H%M%S";

/// Stamped on an event with no zone, since all-day recurring events have none but
/// `page_recurrence_rules.timezone` is NOT NULL.
const SENTINEL_TZ: &str = "UTC";

/// Pages severed per teardown transaction. Keeps the write-lock hold short enough that a
/// concurrent editor write can wait it out inside its retry budget, as with the engine's
/// backfill batch. About 0.1 ms per page.
const TEARDOWN_BATCH: i64 = 200;

/// How many times the page drain restarts from the top. The cursor only walks `page_sync.id`
/// forward, but a sync pass in flight when disable began commits rows with random-sorting
/// uuids, about half below a cursor already passed, and a link left active in a de-flagged
/// folder is a permanently locked page. One restart catches those; the cap is a livelock
/// backstop, since the caller clears `enabled` first and the poll loop selects on it.
const TEARDOWN_MAX_DRAINS: u32 = 4;

/// The calendar a reconcile runs against. The engine hands in the system folder; the
/// reconciler never decides folder policy.
pub struct ReconcileContext {
    pub account_id: String,
    pub calendar_id: String,
    pub provider: String,
    pub folder_id: String,
    /// The first day this sync reaches back to, [`backfill_window_start`] for a real
    /// sync. A series that ended before it is not mirrored (see [`ended_before_window`]).
    pub window_start: chrono::NaiveDate,
}

/// The first day a sync reaches back to: [`crate::sync::BACKFILL_DAYS`] before today.
pub fn backfill_window_start() -> chrono::NaiveDate {
    chrono::Local::now().date_naive() - chrono::Days::new(crate::sync::BACKFILL_DAYS as u64)
}

/// What a reconcile surfaced for the engine: orphan masters needing a targeted fetch, and
/// `applied`, the count of upserts and removals that mutated state (an etag no-op or tombstoned
/// skip isn't counted). The engine derives its `changed` signal from `applied`, not delta size.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    pub missing_masters: Vec<MissingMaster>,
    pub applied: usize,
}

/// An occurrence delta whose series has no stored rule and no master in this batch. The engine
/// resolves it with one targeted `fetch_event` against `series_ref`, then re-runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingMaster {
    pub ical_uid: String,
    pub series_ref: String,
}

/// Applies a delta's upserts in one transaction, so a failure rolls back whole and a retry
/// re-applies cleanly.
pub async fn reconcile(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
    delta: &SyncDelta,
) -> AppResult<ReconcileOutcome> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut outcome = ReconcileOutcome::default();

    // Whole events and series first, so a master in the same batch is stored before any
    // occurrence delta that references it.
    let mut written = Vec::new();
    for item in &delta.upserts {
        if let UpsertItem::Event(ev) = item {
            if let Some(page_id) = apply_event(&mut tx, ctx, ev, delta.full_enumerate).await? {
                outcome.applied += 1;
                written.push(page_id);
            }
        }
    }
    carry_split_series(&mut tx, ctx, &written).await?;
    for item in &delta.upserts {
        if let UpsertItem::Occurrence(occ) = item {
            match apply_occurrence(&mut tx, ctx, occ).await? {
                OccurrenceResult::Applied => outcome.applied += 1,
                OccurrenceResult::Missing(missing) => outcome.missing_masters.push(missing),
                OccurrenceResult::Skipped => {}
            }
        }
    }

    for removal in &delta.removals {
        if apply_removal(&mut tx, ctx, removal).await? {
            outcome.applied += 1;
        }
    }

    tx.commit().await?;
    Ok(outcome)
}

/// Upserts a whole event or series: match by external_id, else re-link by `ical_uid` in the
/// calendar, else create. Returns the page written, `None` on a tombstoned or unchanged-etag
/// skip.
async fn apply_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    ev: &EventUpsert,
    full_enumerate: bool,
) -> AppResult<Option<String>> {
    let mut existing = sqlx::query_as::<_, (String, String, Option<String>, String, bool)>(
        "SELECT ps.id, ps.page_id, ps.etag, ps.sync_state, p.deleted_at IS NOT NULL
         FROM page_sync ps JOIN pages p ON p.id = ps.page_id
         WHERE ps.account_id = ? AND ps.calendar_id = ? AND ps.external_id = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(&ev.core.external_id)
    .fetch_optional(&mut **tx)
    .await?;

    // A tombstoned link means the user deleted it; skip so sync can't resurrect it from trash.
    if matches!(&existing, Some((_, _, _, state, _)) if state == "tombstoned") {
        return Ok(None);
    }

    // A detached page the user then trashed stays severed there: reactivating would rewrite an
    // invisible row and re-lock it on restore. Drop the stale link to free its `external_id`,
    // then mirror the live event fresh.
    if let Some((page_sync_id, page_id, _, _, true)) = &existing {
        sqlx::query("DELETE FROM page_sync WHERE id = ?")
            .bind(page_sync_id)
            .execute(&mut **tx)
            .await?;
        set_mirror_search_text(tx, page_id, None).await?;
        existing = None;
    }

    if ended_before_window(ev, ctx.window_start) {
        return match existing {
            Some((page_sync_id, page_id, _, state, _)) if state == "active" => {
                detach_or_delete(tx, &page_sync_id, &page_id, Severed::Upstream, Some(ENDED))
                    .await?;
                Ok(Some(page_id))
            }
            _ => {
                log::info!(
                    "calendar_sync_refused event={} why={ENDED}",
                    ev.core.external_id
                );
                Ok(None)
            }
        };
    }

    // A full enumerate is already windowed by the provider's own query.
    if !full_enumerate && existing.is_none() && one_off_ended_before_window(ev, ctx.window_start) {
        log::info!(
            "calendar_sync_refused event={} why=one_off_before_window",
            ev.core.external_id
        );
        return Ok(None);
    }

    let now = now_iso();
    let (mirror_location, mirror_attendees) = mirror_values(&ev.core);

    let (page_id, is_new) = if let Some((page_sync_id, page_id, stored_etag, state, _)) = existing {
        // An unchanged etag skips every write, so a full re-sync doesn't refloat every page as
        // recent. Only when active: a detached row with the same etag must fall through to
        // reactivate, or live sync never resumes.
        if state == "active" && ev.core.etag.is_some() && stored_etag == ev.core.etag {
            return Ok(None);
        }
        update_page_title(tx, &page_id, &ev.core.title, &now).await?;
        sqlx::query(
            "UPDATE page_sync SET etag = ?, sync_state = 'active', detached_by = NULL,
             mirror_location = ?, mirror_attendees = ?, last_synced_at = ? WHERE id = ?",
        )
        .bind(&ev.core.etag)
        .bind(&mirror_location)
        .bind(&mirror_attendees)
        .bind(&now)
        .bind(&page_sync_id)
        .execute(&mut **tx)
        .await?;
        (page_id, false)
    } else if let Some((page_sync_id, page_id)) = find_relink(tx, ctx, &ev.core.ical_uid).await? {
        // Same UID, new or absent href: re-link this calendar's dormant page.
        sqlx::query(
            "UPDATE page_sync SET external_id = ?, etag = ?, sync_state = 'active',
             detached_by = NULL, mirror_location = ?, mirror_attendees = ?, last_synced_at = ?
             WHERE id = ?",
        )
        .bind(&ev.core.external_id)
        .bind(&ev.core.etag)
        .bind(&mirror_location)
        .bind(&mirror_attendees)
        .bind(&now)
        .bind(&page_sync_id)
        .execute(&mut **tx)
        .await?;
        update_page_title(tx, &page_id, &ev.core.title, &now).await?;
        (page_id, false)
    } else {
        let page_id = insert_synced_page(tx, ctx, &ev.core.title, &now).await?;
        insert_page_sync(
            tx,
            ctx,
            &page_id,
            &ev.core,
            &mirror_location,
            &mirror_attendees,
            &now,
        )
        .await?;
        (page_id, true)
    };

    let mirror_search = mirror_search_text(mirror_location.as_deref(), mirror_attendees.as_deref());
    set_mirror_search_text(tx, &page_id, mirror_search.as_deref()).await?;
    if !is_new {
        reclaim_calendar_folder(tx, &page_id, &ctx.folder_id).await?;
    }
    write_schedule(tx, &page_id, ev, &now).await?;
    apply_seeded_description(tx, &page_id, ev.core.description.as_deref(), is_new, &now).await?;
    Ok(Some(page_id))
}

/// A synced series as the split check reads it: its start day and, when its rule is bounded by
/// a date, its end day, in the rule's wall clock.
struct SeriesSpan {
    page_id: String,
    starts: String,
    ends: Option<String>,
}

impl SeriesSpan {
    fn from_row((page_id, rrule, start): (String, String, String)) -> Self {
        Self {
            page_id,
            starts: start.chars().take(10).collect(),
            ends: until_day(&rrule),
        }
    }
}

/// The day an `UNTIL` bound falls on, as `YYYY-MM-DD`: the last day the series can land on,
/// since it is stored in the rule's wall clock. A `COUNT` or open rule has none.
fn until_day(rrule: &str) -> Option<String> {
    let value = rrule
        .split(';')
        .find_map(|part| part.strip_prefix("UNTIL="))?;
    let digits = value
        .get(..8)
        .filter(|d| d.bytes().all(|b| b.is_ascii_digit()))?;
    Some(format!(
        "{}-{}-{}",
        &digits[..4],
        &digits[4..6],
        &digits[6..]
    ))
}

/// Editing a repeating event "this and following" ends the series the day before and starts a
/// new event for the rest, and neither provider links the two (Google gives the rest an id,
/// CalDAV a UID). Dates already ticked or skipped from that day on stay keyed to the ended
/// page, where nothing reads them, while the rest shows them open.
///
/// So once a batch's events are in, each series it wrote is checked from both sides. One that
/// ended, with dates resolved past its end, hands them to the same-titled series in its
/// calendar that starts first after that end. One newly starting takes them from the
/// same-titled series that ended last before it starts. After the whole batch, because the
/// halves can arrive in either order or in different syncs.
///
/// Only dates past the old end move, so a same-titled series that ended on its own hands on
/// nothing, and only dates the rest has an occurrence on. A rest renamed in the same edit isn't
/// recognised.
async fn carry_split_series(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    written: &[String],
) -> AppResult<()> {
    for page_id in written {
        let Some(series) = sqlx::query_as::<_, (String, String, String)>(
            "SELECT r.page_id, r.rrule, r.scheduled_start FROM page_recurrence_rules r
             JOIN page_sync ps ON ps.page_id = r.page_id AND ps.sync_state = 'active'
             JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL
             WHERE r.page_id = ?",
        )
        .bind(page_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(SeriesSpan::from_row) else {
            continue;
        };
        let siblings: Vec<SeriesSpan> = sqlx::query_as::<_, (String, String, String)>(
            "SELECT r.page_id, r.rrule, r.scheduled_start FROM page_recurrence_rules r
             JOIN page_sync ps ON ps.page_id = r.page_id AND ps.sync_state = 'active'
             JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL
             WHERE ps.account_id = ? AND ps.calendar_id = ? AND r.page_id <> ?
               AND p.title = (SELECT title FROM pages WHERE id = ?)",
        )
        .bind(&ctx.account_id)
        .bind(&ctx.calendar_id)
        .bind(page_id)
        .bind(page_id)
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(SeriesSpan::from_row)
        .collect();

        if let Some(ends) = &series.ends {
            let rest = siblings
                .iter()
                .filter(|s| s.starts > *ends)
                .min_by(|a, b| a.starts.cmp(&b.starts));
            if let Some(rest) = rest {
                carry_past_end(tx, &series.page_id, ends, &rest.page_id).await?;
            }
        }
        let ended = siblings
            .iter()
            .filter_map(|s| Some((s, s.ends.as_ref()?)))
            .filter(|(_, ends)| **ends < series.starts)
            .max_by(|a, b| a.1.cmp(b.1));
        if let Some((ended, ends)) = ended {
            carry_past_end(tx, &ended.page_id, ends, &series.page_id).await?;
        }
    }
    Ok(())
}

/// Moves the ticks and skips `from_page` holds for days after `ends` to `to_page`, each one
/// `to_page` has an occurrence on, and re-derives both pages' next date when any moved.
async fn carry_past_end(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    from_page: &str,
    ends: &str,
    to_page: &str,
) -> AppResult<()> {
    let Some(from_day) = chrono::NaiveDate::parse_from_str(ends, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.succ_opt())
        .map(|d| d.format("%Y-%m-%d").to_string())
    else {
        log::warn!(
            "reconciler: page {from_page} ends on {ends}, which isn't a day, so nothing past it moves to page {to_page}"
        );
        return Ok(());
    };
    let (ticked, ticks_left) = move_occurring_dates(
        tx,
        "SELECT occurrence_date FROM completed_set
         WHERE page_id = ? AND substr(occurrence_date, 1, 10) >= ?",
        "UPDATE completed_set SET page_id = ? WHERE page_id = ? AND occurrence_date = ?",
        from_page,
        &from_day,
        to_page,
    )
    .await?;
    let (skipped, skips_left) = move_occurring_dates(
        tx,
        "SELECT occurrence_date FROM skip_set
         WHERE page_id = ? AND substr(occurrence_date, 1, 10) >= ?",
        "UPDATE skip_set SET page_id = ? WHERE page_id = ? AND occurrence_date = ?",
        from_page,
        &from_day,
        to_page,
    )
    .await?;
    // Log only moves: a pass seeing both halves checks the pair twice, and the second finds
    // nothing.
    if ticked + skipped + ticks_left + skips_left > 0 {
        log::info!(
            "calendar_sync_split_carry from={from_page} to={to_page} after={ends} \
             ticks={ticked} skips={skipped} left_behind={}",
            ticks_left + skips_left
        );
    }
    if ticked + skipped > 0 {
        crate::recurrence_derive::recompute_recurring_schedule(tx, from_page).await?;
        crate::recurrence_derive::recompute_recurring_schedule(tx, to_page).await?;
    }
    Ok(())
}

/// Moves each date `select` reads off `from_page` from `from_day` on that `to_page` has an
/// occurrence on. Returns how many moved and how many stayed.
async fn move_occurring_dates(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    select: &'static str,
    update: &'static str,
    from_page: &str,
    from_day: &str,
    to_page: &str,
) -> AppResult<(usize, usize)> {
    let dates: Vec<String> = sqlx::query_scalar(select)
        .bind(from_page)
        .bind(from_day)
        .fetch_all(&mut **tx)
        .await?;
    let mut moved = 0;
    for date in &dates {
        if crate::pages::synced_occurrence_is_valid(tx, to_page, date).await? {
            sqlx::query(update)
                .bind(to_page)
                .bind(from_page)
                .bind(date)
                .execute(&mut **tx)
                .await?;
            moved += 1;
        }
    }
    Ok((moved, dates.len() - moved))
}

/// Whether a one-off event was over before `window`, the first day the sync reaches.
///
/// Neither provider's incremental cursor is windowed, so a resumed one hands over every event
/// changed upstream since it was stored, of any age, where a full enumerate asks only from the
/// window on. Without this, a re-authorisation sent a work calendar's one-offs from a year back
/// and each became an open page. Only a new page is refused; one already stored takes the
/// change.
fn one_off_ended_before_window(ev: &EventUpsert, window: chrono::NaiveDate) -> bool {
    if ev.recurrence.is_some() {
        return false;
    }
    let last = ev.schedule.end.as_deref().unwrap_or(&ev.schedule.start);
    let last = date_key(last);
    last.len() == 8 && last < window.format("%Y%m%d").to_string()
}

/// Whether a series ran out before `window`, the first day the sync reaches: no occurrence
/// on or after it, and no instance moved into it.
///
/// Google's `events.list` with `singleEvents=false` returns a recurring master whole, so a
/// series a "this and following" edit cut short a year ago still arrives and would sit in the
/// list as an open page nothing can tick. CalDAV's time-range query leaves it out, but neither
/// incremental cursor is windowed, so the check lives here for every path. Only a bounded rule
/// can end; one the engine can't read is kept.
fn ended_before_window(ev: &EventUpsert, window: chrono::NaiveDate) -> bool {
    let Some(rec) = &ev.recurrence else {
        return false;
    };
    if !rec.rrule.contains("UNTIL=") && !rec.rrule.contains("COUNT=") {
        return false;
    }
    let window_key = window.format("%Y%m%d").to_string();
    let moved_in = rec
        .overrides
        .iter()
        .any(|ov| date_key(&ov.schedule.start) >= window_key);
    let tz = ev.schedule.timezone.as_deref().unwrap_or(SENTINEL_TZ);
    !moved_in && rule_ended(&rec.rrule, &ev.schedule.start, tz, window)
}

/// Whether a rule yields nothing on or after `window`. A rule the engine can't read
/// counts as still running.
fn rule_ended(rrule: &str, start: &str, tz: &str, window: chrono::NaiveDate) -> bool {
    let Some(day_before) = window.checked_sub_days(chrono::Days::new(1)) else {
        return false;
    };
    let rrule = rewrite_until_to_wall_clock(rrule, tz);
    let day_before = day_before.format("%Y-%m-%dT00:00:00").to_string();
    matches!(
        pikos_recurrence::next_occurrence_after(&rrule, start, &day_before, &[]),
        Ok(None)
    )
}

/// Removes this calendar's stored live series that ended before `ctx.window_start`, as an
/// upstream deletion would: detached if owned, deleted if not. Runs every pass, since an
/// incremental cursor never re-sends an unchanged series. Its own retried transaction; returns
/// how many it removed.
pub async fn remove_ended_series(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
) -> AppResult<usize> {
    let window = ctx.window_start.format("%Y-%m-%d").to_string();
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        let rows = sqlx::query_as::<_, (String, String, String, String, String, bool)>(
            "SELECT ps.id, ps.page_id, r.rrule, r.scheduled_start, r.timezone,
                    EXISTS(SELECT 1 FROM page_schedules o
                            WHERE o.rule_id = r.id AND o.original_date IS NOT NULL
                              AND substr(o.scheduled_start, 1, 10) >= ?)
             FROM page_sync ps JOIN page_recurrence_rules r ON r.page_id = ps.page_id
             WHERE ps.account_id = ? AND ps.calendar_id = ? AND ps.sync_state = 'active'
               AND (r.rrule LIKE '%UNTIL=%' OR r.rrule LIKE '%COUNT=%')",
        )
        .bind(&window)
        .bind(&ctx.account_id)
        .bind(&ctx.calendar_id)
        .fetch_all(&mut *tx)
        .await?;
        let mut removed = 0;
        for (page_sync_id, page_id, rrule, start, tz, moved_in) in rows {
            if !moved_in && rule_ended(&rrule, &start, &tz, ctx.window_start) {
                detach_or_delete(
                    &mut tx,
                    &page_sync_id,
                    &page_id,
                    Severed::Upstream,
                    Some(ENDED),
                )
                .await?;
                removed += 1;
            }
        }
        tx.commit().await?;
        Ok(removed)
    })
    .await
}

/// Moves a reactivated page back into its calendar folder: a detached page files anywhere, and
/// once re-linked every other surface reads it as living in its calendar folder. Leaves
/// `updated_at` alone, since the page didn't change.
async fn reclaim_calendar_folder(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    folder_id: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE pages SET folder_id = ? WHERE id = ? AND folder_id IS NOT ?")
        .bind(folder_id)
        .bind(page_id)
        .bind(folder_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Finds a re-linkable page by `ical_uid`, scoped to this calendar, since matching across
/// calendars would ping-pong the identity every poll. Trashed pages are excluded, as at the
/// `external_id` match in [`apply_event`].
async fn find_relink(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    ical_uid: &str,
) -> AppResult<Option<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT ps.id, ps.page_id FROM page_sync ps JOIN pages p ON p.id = ps.page_id
         WHERE ps.account_id = ? AND ps.calendar_id = ? AND ps.ical_uid = ?
           AND ps.sync_state != 'tombstoned' AND p.deleted_at IS NULL",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(ical_uid)
    .fetch_optional(&mut **tx)
    .await?)
}

/// Replaces the page's mirror schedule wholesale. The schedule is fully reconciler-owned, so
/// delete-and-reinsert is the simplest idempotent write. Fresh row ids also re-arm a reminder
/// an upstream time edit moved; updating in place would need
/// [`crate::notification_log::clear_reminder_log_tx`].
///
/// A [`OccurrenceFidelity::MasterOnly`] bundle is the exception: it can't see the series'
/// exdates and overrides, so those are read back before the delete and re-applied under the
/// new rule: union for exdates, incoming-wins by `original_date` for overrides, and only while
/// the pattern still matches (see [`load_carried_occurrences`]).
///
/// A recurring page's head is then recomputed to its oldest-open occurrence (the completed and
/// skip sets, keyed by `page_id`, survive the rewrite and may push it past the raw base), the
/// derivation owning terminal status both directions. Any rewrite of a page that had a rule
/// first un-marks a stale terminal `done`: a recurrence-to-single drop leaves no rule to clear
/// it, and an engine-rejected new rule makes the recompute skip, leaving the page invisibly
/// `done`. A supported recompute re-marks it if the new series is still exhausted.
async fn write_schedule(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    ev: &EventUpsert,
    now: &str,
) -> AppResult<()> {
    let had_rule: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM page_recurrence_rules WHERE page_id = ?)")
            .bind(page_id)
            .fetch_one(&mut **tx)
            .await?;

    let tz = ev.schedule.timezone.as_deref().unwrap_or(SENTINEL_TZ);
    // Only UNTIL still carries a zone; dtstart, EXDATE and original_date arrive as wall-clock.
    let rrule = ev
        .recurrence
        .as_ref()
        .map(|rec| rewrite_until_to_wall_clock(&rec.rrule, tz));

    let carried = match (&ev.recurrence, rrule.as_deref()) {
        (Some(rec), Some(rrule)) if rec.fidelity == OccurrenceFidelity::MasterOnly => {
            load_carried_occurrences(tx, page_id, rrule, &ev.schedule.start).await?
        }
        _ => CarriedOccurrences::default(),
    };

    sqlx::query("DELETE FROM page_recurrence_rules WHERE page_id = ?")
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM page_schedules WHERE page_id = ?")
        .bind(page_id)
        .execute(&mut **tx)
        .await?;

    let base_end = InclusiveEnd::from_provider(&ev.schedule.end);

    if let (Some(rec), Some(rrule)) = (&ev.recurrence, &rrule) {
        let rule_id = crate::fresh::id();
        let mut exdates = carried.exdates;
        for d in &rec.exdates {
            if !exdates.contains(d) {
                exdates.push(d.clone());
            }
        }
        let exdates_json = serde_json::to_string(&exdates).unwrap_or_else(|_| "[]".to_string());
        sqlx::query(
            "INSERT INTO page_recurrence_rules
             (id, page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&rule_id)
        .bind(page_id)
        .bind(rrule)
        .bind(&exdates_json)
        .bind(&ev.schedule.start)
        .bind(base_end.as_deref())
        .bind(tz)
        .bind(now)
        .execute(&mut **tx)
        .await?;

        let base = Occurrence {
            start: &ev.schedule.start,
            end: base_end.as_deref(),
            timezone: tz,
        };
        for ov in &rec.overrides {
            let end = InclusiveEnd::from_provider(&ov.schedule.end);
            if base.unmoved(
                &ov.original_date,
                &ov.schedule.start,
                end.as_deref(),
                ov.schedule.timezone.as_deref(),
            ) {
                continue;
            }
            insert_schedule_row(
                tx,
                page_id,
                &ov.schedule.start,
                &end,
                ov.schedule.timezone.as_deref(),
                Some(&rule_id),
                Some(&ov.original_date),
                now,
            )
            .await?;
        }

        for (start, end, timezone, original_date) in &carried.overrides {
            if rec
                .overrides
                .iter()
                .any(|ov| &ov.original_date == original_date)
                || base.unmoved(original_date, start, end.as_deref(), timezone.as_deref())
            {
                continue;
            }
            insert_schedule_row(
                tx,
                page_id,
                start,
                &InclusiveEnd::from_stored(end.clone()),
                timezone.as_deref(),
                Some(&rule_id),
                Some(original_date),
                now,
            )
            .await?;
        }
    } else {
        insert_schedule_row(
            tx,
            page_id,
            &ev.schedule.start,
            &base_end,
            ev.schedule.timezone.as_deref(),
            None,
            None,
            now,
        )
        .await?;
    }

    // Base-occurrence floor, refined by the recurring recompute below; also clears a stale
    // terminal `done` (see the fn doc).
    let clear_terminal = had_rule;
    sqlx::query(
        "UPDATE pages SET scheduled_start = ?1, scheduled_end = ?2,
           status = CASE WHEN ?3 AND status = 'done' THEN 'not_started' ELSE status END,
           completed_at = CASE WHEN ?3 AND status = 'done' THEN NULL ELSE completed_at END,
           updated_at = ?4
         WHERE id = ?5",
    )
    .bind(&ev.schedule.start)
    .bind(base_end.as_deref())
    .bind(clear_terminal)
    .bind(now)
    .bind(page_id)
    .execute(&mut **tx)
    .await?;

    if ev.recurrence.is_some() {
        crate::recurrence_derive::recompute_recurring_schedule(tx, page_id).await?;
    }
    Ok(())
}

/// A series' stored occurrence deltas, read back so a `MasterOnly` rewrite can carry them
/// across. Empty when the page has no rule yet.
#[derive(Default)]
struct CarriedOccurrences {
    exdates: Vec<String>,
    /// `(start, end, timezone, original_date)`.
    overrides: Vec<(String, Option<String>, Option<String>, String)>,
}

/// Carries forward only while the series' pattern is untouched. A changed RRULE or base start
/// shifts every occurrence date, so exdates and overrides keyed to the old dates would strand
/// a ghost occurrence the user can't move, delete or stop firing a reminder (the mirror
/// schedule is locked). Dropping them loses nothing user-authored: the provider's occurrence
/// deltas and the next full enumerate rebuild the set.
///
/// `incoming_rrule` must already be UNTIL-rewritten, or a `UNTIL=…Z` rule reads as changed on
/// every poll and never carries anything.
async fn load_carried_occurrences(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    incoming_rrule: &str,
    incoming_start: &str,
) -> AppResult<CarriedOccurrences> {
    let Some((rule_id, exdates_json, stored_rrule, stored_start)) =
        sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT id, rrule_exdates, rrule, scheduled_start
             FROM page_recurrence_rules WHERE page_id = ?",
        )
        .bind(page_id)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(CarriedOccurrences::default());
    };

    if stored_rrule != incoming_rrule || stored_start != incoming_start {
        return Ok(CarriedOccurrences::default());
    }

    let overrides = sqlx::query_as(
        "SELECT scheduled_start, scheduled_end, timezone, original_date FROM page_schedules
         WHERE rule_id = ? AND original_date IS NOT NULL",
    )
    .bind(&rule_id)
    .fetch_all(&mut **tx)
    .await?;

    // Not refused: these are the provider's, and the next full enumerate sends them again.
    let exdates = crate::schedules::stored_exdates(&rule_id, &exdates_json).unwrap_or_else(|e| {
        log::warn!("reconciler: {e}; carried forward as none");
        Vec::new()
    });
    Ok(CarriedOccurrences { exdates, overrides })
}

/// Applies a lone occurrence change against the stored series. Returns a missing-master signal
/// when no rule exists yet; never buffers, drops or synthesizes a page.
async fn apply_occurrence(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    occ: &OccurrenceDelta,
) -> AppResult<OccurrenceResult> {
    let rule = sqlx::query_as::<_, (String, String, String, String, Option<String>, String)>(
        "SELECT r.id, r.page_id, ps.sync_state, r.scheduled_start, r.scheduled_end, r.timezone
         FROM page_recurrence_rules r
         JOIN page_sync ps ON ps.page_id = r.page_id
         WHERE ps.account_id = ? AND ps.calendar_id = ? AND ps.ical_uid = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(&occ.ical_uid)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((rule_id, page_id, state, base_start, base_end, base_tz)) = rule else {
        return Ok(OccurrenceResult::Missing(MissingMaster {
            ical_uid: occ.ical_uid.clone(),
            series_ref: occ.series_ref.clone(),
        }));
    };
    // Mutating a tombstoned or detached series' EXDATEs and overrides would resurrect a
    // schedule the user no longer syncs; the same active-only guard as `apply_removal`.
    if state != "active" {
        return Ok(OccurrenceResult::Skipped);
    }

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
            // One override per `original_date`; an instance back at its own slot needs none.
            sqlx::query("DELETE FROM page_schedules WHERE rule_id = ? AND original_date = ?")
                .bind(&rule_id)
                .bind(&occ.original_date)
                .execute(&mut **tx)
                .await?;
            let end = InclusiveEnd::from_provider(&schedule.end);
            let base = Occurrence {
                start: &base_start,
                end: base_end.as_deref(),
                timezone: &base_tz,
            };
            if !base.unmoved(
                &occ.original_date,
                &schedule.start,
                end.as_deref(),
                schedule.timezone.as_deref(),
            ) {
                insert_schedule_row(
                    tx,
                    &page_id,
                    &schedule.start,
                    &end,
                    schedule.timezone.as_deref(),
                    Some(&rule_id),
                    Some(&occ.original_date),
                    &now_iso(),
                )
                .await?;
            }
        }
    }
    crate::recurrence_derive::recompute_recurring_schedule(tx, &page_id).await?;
    Ok(OccurrenceResult::Applied)
}

/// What applying one occurrence delta resolved to: it wrote, it skipped a non-active series,
/// or its master isn't stored yet.
enum OccurrenceResult {
    Applied,
    Skipped,
    Missing(MissingMaster),
}

/// A whole event gone upstream: detach if the page is Pikos-owned, else hard-delete the bare
/// mirror. Tombstoned and detached rows are left alone, so re-running converges.
async fn apply_removal(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    removal: &Removal,
) -> AppResult<bool> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, page_id, sync_state FROM page_sync
         WHERE account_id = ? AND calendar_id = ? AND external_id = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(&removal.external_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((page_sync_id, page_id, state)) = row else {
        return Ok(false);
    };
    if state != "active" {
        return Ok(false);
    }
    detach_or_delete(
        tx,
        &page_sync_id,
        &page_id,
        Severed::Upstream,
        Some("removed_upstream"),
    )
    .await?;
    Ok(true)
}

/// Why a link was severed, recorded on the row as `detached_by`: only a turn-off's
/// pages come back when the calendar is turned on again.
#[derive(Clone, Copy)]
enum Severed {
    TurnOff,
    Upstream,
}

impl Severed {
    fn as_str(self) -> &'static str {
        match self {
            Severed::TurnOff => "turn_off",
            Severed::Upstream => "upstream",
        }
    }
}

/// The reason a series that ended before the window was refused or removed, as logged.
const ENDED: &str = "series_ended_before_window";

/// The own-vs-delete decision, shared by an explicit removal, teardown and the full-enumerate
/// sweep: an owned page detaches, keeping its dormant identity for a later re-link; a bare
/// mirror hard-deletes. `why` names the cause in the log, ids only, never a title.
async fn detach_or_delete(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_sync_id: &str,
    page_id: &str,
    by: Severed,
    why: Option<&str>,
) -> AppResult<()> {
    let owned = is_owned(tx, page_id).await?;
    if owned {
        detach_sync(tx, page_sync_id, page_id, by).await?;
    } else {
        hard_delete_page(tx, page_id).await?;
    }
    if let Some(why) = why {
        let what = if owned { "detached" } else { "deleted" };
        log::info!("calendar_sync_{what} page={page_id} why={why}");
    }
    Ok(())
}

/// After a full authoritative enumerate, removes stored active pages the provider no longer
/// returns: the deletion signal an incremental cursor carries as a [`Removal`] but a backfill
/// (initial, stale-token recovery, or a server with no `sync-collection`) can't. `present_ids`
/// is every `external_id` the enumerate returned and `window_start` its query-window date. An
/// absent page is a genuine deletion unless it's pre-window, which a time-bounded query
/// legitimately omits ([`is_pre_window`] spares those). Removals run the detach-if-owned or
/// hard-delete lifecycle. Its own read-then-write tx (wrap in `retry_on_busy`). Returns how many
/// pages it removed, the only applied count on a sweep-only pass.
pub async fn sweep_absent(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
    present_ids: &std::collections::HashSet<String>,
    window_start: &str,
) -> AppResult<usize> {
    let mut tx = pool.begin().await?;

    // One SELECT joins each link's rule and head schedule, so the pre-window check is a pure
    // comparison per row.
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT ps.id, ps.page_id, ps.external_id, r.rrule, p.scheduled_start, p.scheduled_end
         FROM page_sync ps
         JOIN pages p ON p.id = ps.page_id
         LEFT JOIN page_recurrence_rules r ON r.page_id = ps.page_id
         WHERE ps.account_id = ? AND ps.calendar_id = ? AND ps.sync_state = 'active'",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .fetch_all(&mut *tx)
    .await?;

    let window_key = date_key(window_start);
    let mut removed = 0;
    for (page_sync_id, page_id, external_id, rrule, start, end) in rows {
        if present_ids.contains(&external_id) {
            continue;
        }
        if is_pre_window(
            rrule.as_deref(),
            start.as_deref(),
            end.as_deref(),
            &window_key,
        ) {
            continue;
        }
        detach_or_delete(
            &mut tx,
            &page_sync_id,
            &page_id,
            Severed::Upstream,
            Some("absent_from_full_enumerate"),
        )
        .await?;
        removed += 1;
    }

    tx.commit().await?;
    Ok(removed)
}

/// Whether a page's occurrences all precede `window_start`, so the sweep spares it.
/// Day-granularity, and deliberately biased toward keeping:
///
/// - **One day of slack** (`<=`, not `<`): storage is source-zone wall-clock while the server's
///   bound is a UTC instant, so an ahead-of-UTC event just before the window (up to about 14h)
///   is server-excluded yet its wall-clock date lands on the window day. Sparing that day keeps
///   a live event from being swept; behind-UTC zones already fail safe.
/// - **Recurring is bounded only by a readable `UNTIL`** (via [`extract_until`], FREQ-agnostic
///   so an out-of-envelope rule still reads its bound). No `UNTIL` is assumed in-window. A
///   `COUNT`-bounded series that ended pre-window is the one accepted false negative; the worst
///   case detaches an owned page (re-links on the next change) or drops a stale past mirror.
fn is_pre_window(
    rrule: Option<&str>,
    start: Option<&str>,
    end: Option<&str>,
    window_key: &str,
) -> bool {
    if let Some(rrule) = rrule {
        return match pikos_recurrence::extract_until(rrule) {
            Some(until) => until.format("%Y%m%d").to_string().as_str() <= window_key,
            None => false,
        };
    }
    // No stored schedule can't be proven pre-window, so it isn't spared.
    match end.or(start) {
        Some(instant) => date_key(instant).as_str() <= window_key,
        None => false,
    }
}

/// The first 8 digits of any date or date-time string as `YYYYMMDD`, so day comparison works
/// across formats (`2026-06-24`, `2026-06-24T09:00:00`, `20260624T090000`).
fn date_key(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).take(8).collect()
}

/// Tears down a calendar's live sync (unsynced or disconnected): the own-vs-delete rule of an
/// upstream removal (see [`detach_or_delete`]) across the whole calendar. Tombstoned links are
/// cleared so a fresh resync brings those events back (the page stays in trash). The folder
/// survives, de-flagged to a regular folder, while a live page remains. Resumable: a rerun
/// after a failed drain picks up what is left.
///
/// The caller must clear `sync_calendar.enabled` first; see [`TEARDOWN_MAX_DRAINS`].
pub async fn teardown_calendar(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    calendar_id: &str,
    folder_id: &str,
) -> AppResult<()> {
    for _ in 0..TEARDOWN_MAX_DRAINS {
        let mut cursor = String::new();
        while let Some(next) = crate::tx::retry_on_busy(|| {
            teardown_page_batch(pool, account_id, calendar_id, cursor.clone())
        })
        .await?
        {
            cursor = next;
        }
        if !live_link_remains(pool, account_id, calendar_id).await? {
            break;
        }
    }

    crate::tx::retry_on_busy(|| teardown_folder(pool, folder_id)).await
}

/// True while any of the calendar's links is un-severed; `detached` is teardown's terminal
/// state.
async fn live_link_remains(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    calendar_id: &str,
) -> AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM page_sync
          WHERE account_id = ? AND calendar_id = ? AND sync_state <> 'detached')",
    )
    .bind(account_id)
    .bind(calendar_id)
    .fetch_one(pool)
    .await?)
}

/// Severs one batch of the calendar's pages, resuming after `cursor`. Returns the new cursor,
/// or `None` once none are left. Paginates by `page_sync.id` because a detached row stays
/// behind and a plain `LIMIT` would re-read it forever.
async fn teardown_page_batch(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    calendar_id: &str,
    cursor: String,
) -> AppResult<Option<String>> {
    let mut tx = pool.begin().await?;

    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, page_id, sync_state FROM page_sync
         WHERE account_id = ? AND calendar_id = ? AND id > ?
         ORDER BY id LIMIT ?",
    )
    .bind(account_id)
    .bind(calendar_id)
    .bind(&cursor)
    .bind(TEARDOWN_BATCH)
    .fetch_all(&mut *tx)
    .await?;

    let Some((last_id, _, _)) = rows.last() else {
        return Ok(None);
    };
    let next_cursor = last_id.clone();

    for (page_sync_id, page_id, state) in rows {
        match state.as_str() {
            // The soft-deleted page stays in the trash; a fresh resync recreates the event.
            "tombstoned" => {
                sqlx::query("DELETE FROM page_sync WHERE id = ?")
                    .bind(&page_sync_id)
                    .execute(&mut *tx)
                    .await?;
                set_mirror_search_text(&mut tx, &page_id, None).await?;
            }
            // Already severed by an upstream removal: keep its dormant identity.
            "detached" => {}
            // Asked for by the user, page by page through a whole calendar: unlogged.
            _ => detach_or_delete(&mut tx, &page_sync_id, &page_id, Severed::TurnOff, None).await?,
        }
    }

    tx.commit().await?;
    Ok(Some(next_cursor))
}

/// Deletes the calendar's folder, or de-flags it when pages survived there.
async fn teardown_folder(pool: &sqlx::SqlitePool, folder_id: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;

    let survivors: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE folder_id = ? AND deleted_at IS NULL")
            .bind(folder_id)
            .fetch_one(&mut *tx)
            .await?;
    if survivors == 0 {
        sqlx::query("DELETE FROM folders WHERE id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE folders SET is_external_calendar = 0 WHERE id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Teardown and upstream removal keep a Pikos-owned page and destroy a bare
/// mirror. See [`crate::sync::PAGE_OWNED_SQL`] for what ownership means.
async fn is_owned(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, page_id: &str) -> AppResult<bool> {
    let sql = format!(
        "SELECT {}
         FROM pages p JOIN page_sync ps ON ps.page_id = p.id
         WHERE p.id = ?",
        crate::sync::PAGE_OWNED_SQL
    );
    let owned: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(page_id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(owned)
}

/// Severs the live sync link, keeping the page, its last-known schedule and its dormant
/// identity (`ical_uid` plus provider and calendar hint) for a later re-link. Recomputes a
/// recurring head: once detached the frontend's completed-base head suppression stops
/// applying, so a series whose base is a completed occurrence would double-render beside its
/// done clone until the next on-load heal. A non-recurring detach leaves `pages.updated_at`
/// alone; a recurring one bumps it through the head write, since unlocking is a real change.
async fn detach_sync(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_sync_id: &str,
    page_id: &str,
    by: Severed,
) -> AppResult<()> {
    sqlx::query("UPDATE page_sync SET sync_state = 'detached', detached_by = ? WHERE id = ?")
        .bind(by.as_str())
        .bind(page_sync_id)
        .execute(&mut **tx)
        .await?;
    float_wall_clock(tx, page_id).await?;
    crate::recurrence_derive::recompute_recurring_schedule(tx, page_id).await?;
    Ok(())
}

/// Spends the source-zone stamp instead of dropping it: rewrites every stored wall-clock into
/// the device's zone and clears the stamp, so a page rendered at its absolute instant keeps it
/// when it floats. Otherwise a detached 3pm Berlin event becomes 3pm wherever the user is, and
/// its reminder fires at the wrong time.
///
/// Refused when a recurring series' base start changes date. Every occurrence date derives from
/// the base and keys `completed_set`, `skip_set`, `rrule_exdates` and each override's
/// `original_date`, while BYDAY names the base's weekday; a partial rewrite silently moves the
/// series to a different weekday. Such a series keeps its raw wall-clock, and takes a non-local
/// calendar and a start within the zone offset of midnight to reach.
///
/// All-day rows carry no zone and are left alone.
async fn float_wall_clock(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
) -> AppResult<()> {
    let rule: Option<(String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, rrule, scheduled_start, scheduled_end, timezone
         FROM page_recurrence_rules WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_optional(&mut **tx)
    .await?;

    let schedules: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, scheduled_start, scheduled_end, timezone
         FROM page_schedules WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_all(&mut **tx)
    .await?;

    let source = rule
        .as_ref()
        .map(|(_, _, _, _, tz)| tz.clone())
        .or_else(|| schedules.iter().find_map(|(_, _, _, tz)| tz.clone()));
    let Some(source) = source else {
        return Ok(());
    };
    let source = match source.parse::<Tz>() {
        Ok(source) => source,
        Err(e) => {
            log::warn!("reconciler: page {page_id} keeps its stored wall clock: {e}");
            return Ok(());
        }
    };
    let device = device_zone();
    if source == device {
        return Ok(());
    }

    if let Some((rule_id, rrule, base_start, base_end, _)) = &rule {
        let Some(start) = to_device_wall_clock(base_start, source, device) else {
            return Ok(());
        };
        if start[..10] != base_start[..10] {
            return Ok(());
        }
        let end = base_end
            .as_deref()
            .and_then(|e| to_device_wall_clock(e, source, device));
        sqlx::query(
            "UPDATE page_recurrence_rules
             SET rrule = ?, scheduled_start = ?, scheduled_end = COALESCE(?, scheduled_end),
                 timezone = ?
             WHERE id = ?",
        )
        .bind(shift_until_to_device(rule_id, rrule, source, device))
        .bind(&start)
        .bind(end)
        .bind(device.name())
        .bind(rule_id)
        .execute(&mut **tx)
        .await?;
    }

    // Override rows too: a moved instance renders and fires on its own row. Each converts from
    // its own stamp, since a provider can move an instance into another zone than the master's.
    for (schedule_id, start, end, tz) in &schedules {
        let Some(tz) = tz else {
            continue;
        };
        let row_source = match tz.parse::<Tz>() {
            Ok(row_source) => row_source,
            Err(e) => {
                log::warn!("reconciler: schedule {schedule_id} keeps its stored wall clock: {e}");
                continue;
            }
        };
        let converted_start = to_device_wall_clock(start, row_source, device);
        let converted_end = end
            .as_deref()
            .and_then(|e| to_device_wall_clock(e, row_source, device));
        sqlx::query(
            "UPDATE page_schedules
             SET scheduled_start = COALESCE(?, scheduled_start),
                 scheduled_end = COALESCE(?, scheduled_end), timezone = NULL
             WHERE id = ?",
        )
        .bind(converted_start)
        .bind(converted_end)
        .bind(schedule_id)
        .execute(&mut **tx)
        .await?;
    }

    // A recurring page's denorm is rewritten by the recompute that follows; a one-off's is a
    // copy of the converted row.
    if rule.is_none() {
        let denorm: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT scheduled_start, scheduled_end FROM pages WHERE id = ?")
                .bind(page_id)
                .fetch_optional(&mut **tx)
                .await?;
        if let Some((start, end)) = denorm {
            sqlx::query(
                "UPDATE pages
                 SET scheduled_start = COALESCE(?, scheduled_start),
                     scheduled_end = COALESCE(?, scheduled_end)
                 WHERE id = ?",
            )
            .bind(
                start
                    .as_deref()
                    .and_then(|s| to_device_wall_clock(s, source, device)),
            )
            .bind(
                end.as_deref()
                    .and_then(|e| to_device_wall_clock(e, source, device)),
            )
            .bind(page_id)
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(())
}

/// `2026-03-15T15:00:00` in `source` as the same instant in device-local wall-clock, DST-correct
/// per instant. `None` for a date-only value, anything unparseable, or a wall-clock in the
/// source zone's spring-forward gap; the caller keeps the original rather than inventing a time.
pub(crate) fn to_device_wall_clock(wall_clock: &str, source: Tz, device: Tz) -> Option<String> {
    let wall = WallClock::parse(wall_clock).filter(|w| !w.is_all_day())?;
    Some(WallClock::timed(convert_instant(wall.as_datetime(), source, device)?).format())
}

/// Shifts a source-zone `UNTIL` token to device-local so the bound floats with its occurrences.
/// Ingest already rewrote any UTC `UNTIL`, so no `Z` is left; a date-only bound needs no shift.
fn shift_until_to_device(rule_id: &str, rrule: &str, source: Tz, device: Tz) -> String {
    rewrite_until_with(rrule, |value| {
        let date_only = value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit());
        let naive = match NaiveDateTime::parse_from_str(value, UNTIL_FMT) {
            Ok(naive) => naive,
            Err(e) => {
                if !date_only {
                    log::warn!("reconciler: rule {rule_id} keeps UNTIL={value} unshifted: {e}");
                }
                return None;
            }
        };
        Some(
            convert_instant(naive, source, device)?
                .format(UNTIL_FMT)
                .to_string(),
        )
    })
}

/// Re-expresses one wall-clock in another zone. The fall-back and gap reading is
/// [`zoned::wall_clock_instant`]'s, shared with [`crate::notification_log::synced_fire_instant`]:
/// an ambiguous hour resolves to its first pass.
fn convert_instant(naive: NaiveDateTime, source: Tz, device: Tz) -> Option<NaiveDateTime> {
    Some(zoned::wall_clock_at(
        device,
        zoned::wall_clock_instant(source, naive)?,
    ))
}

/// Destroys a non-owned synced page. The FK cascade removes its `page_sync` link, schedules,
/// rules, reminders and FTS row; ownership was already checked.
async fn hard_delete_page(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
) -> AppResult<()> {
    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn insert_synced_page(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    title: &str,
    now: &str,
) -> AppResult<String> {
    let id = crate::fresh::id();
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id = ?",
    )
    .bind(&ctx.folder_id)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO pages
         (id, folder_id, title, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, '', 'not_started', 0, '[]', ?, ?, ?)",
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

#[allow(clippy::too_many_arguments)]
async fn insert_page_sync(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    page_id: &str,
    core: &EventCore,
    mirror_location: &Option<String>,
    mirror_attendees: &Option<String>,
    now: &str,
) -> AppResult<()> {
    let id = crate::fresh::id();
    sqlx::query(
        "INSERT INTO page_sync
         (id, page_id, account_id, provider, calendar_id, external_id, ical_uid, etag,
          sync_state, user_modified, mirror_location, mirror_attendees, last_synced_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(page_id)
    .bind(&ctx.account_id)
    .bind(&ctx.provider)
    .bind(&ctx.calendar_id)
    .bind(&core.external_id)
    .bind(&core.ical_uid)
    .bind(&core.etag)
    .bind(mirror_location)
    .bind(mirror_attendees)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Writes calendar-owned read-only metadata to the mirror columns. Empty attendees store NULL,
/// so "none" and "never synced" read alike.
fn mirror_values(core: &EventCore) -> (Option<String>, Option<String>) {
    let attendees = if core.attendees.is_empty() {
        None
    } else {
        serde_json::to_string(&core.attendees).ok()
    };
    (core.location.clone(), attendees)
}

/// Every searchable piece of mirror metadata as one blob, for the `pages.mirror_search_text`
/// denorm the FTS index reads (see `011_mirror_search_text.sql` for why one column). A new
/// searchable field is added here and nowhere else, with two copies to keep in step: the
/// mock's `mirrorSearchText` twin and that migration's frozen SQL backfill. The blob is also
/// a search result's excerpt (`build_mirror_excerpt`, search.rs), so a field added here is
/// shown to the user, not merely matched on.
///
/// Takes the stored column shapes rather than an [`EventCore`], so a caller with rows and no
/// provider payload can't derive a value the columns don't support. Returns None when there is
/// nothing to index.
pub fn mirror_search_text(location: Option<&str>, attendees_json: Option<&str>) -> Option<String> {
    let attendees: Vec<String> = attendees_json
        // swallow-ok: search text only, and reading the page logs a list that won't parse.
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    let parts: Vec<&str> = std::iter::once(location.unwrap_or(""))
        .chain(attendees.iter().map(String::as_str))
        .filter(|p| !p.trim().is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("\n"))
}

/// Keeps the search denorm level with the `page_sync` mirror columns written in the same
/// transaction. Leaves `updated_at` alone: sync owns this value, so it isn't a page edit.
async fn set_mirror_search_text(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    text: Option<&str>,
) -> AppResult<()> {
    sqlx::query("UPDATE pages SET mirror_search_text = ? WHERE id = ?")
        .bind(text)
        .bind(page_id)
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

/// A series' own occurrence shape (base start, end and zone), against which a provider's
/// per-instance copy is judged.
struct Occurrence<'a> {
    start: &'a str,
    end: Option<&'a str>,
    timezone: &'a str,
}

impl Occurrence<'_> {
    /// Whether an override puts its occurrence exactly where the rule already does: same start,
    /// length and zone. Google sends an instance as its own resource whenever anything about it
    /// differs (attendees, a call link, a description), none of which an override row stores.
    /// Stored, such a copy reads as a moved occurrence, excluded from the head and drawn as its
    /// own block, so a series with nothing else open drew the copy's date twice.
    fn unmoved(
        &self,
        original_date: &str,
        start: &str,
        end: Option<&str>,
        timezone: Option<&str>,
    ) -> bool {
        start == original_date
            && timezone.is_none_or(|tz| tz == self.timezone)
            && span(start, end) == span(self.start, self.end)
    }
}

/// An occurrence's length: whole days if all-day, seconds if timed, `None` with no end.
fn span(start: &str, end: Option<&str>) -> Option<i64> {
    let start = WallClock::parse(start)?;
    let end = WallClock::parse(end?)?;
    if start.is_all_day() {
        Some((end.date - start.date).num_days())
    } else {
        Some((end.as_datetime() - start.as_datetime()).num_seconds())
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_schedule_row(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    start: &str,
    end: &InclusiveEnd,
    timezone: Option<&str>,
    rule_id: Option<&str>,
    original_date: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let id = crate::fresh::id();
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(&id)
    .bind(page_id)
    .bind(start)
    .bind(end.as_deref())
    .bind(timezone)
    .bind(rule_id)
    .bind(original_date)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Version of the `content_text` projection, persisted with each `seeded_description_hash` so a
/// projection change re-seeds pristine bodies instead of reading the whole synced corpus as
/// user-edited.
///
/// Bump when [`crate::pool::build_description_doc`] or the projection produces different output
/// for a document the editor can hold, not on every edit to them: a bump swaps a precise signal
/// for the coarse `user_modified` fallback on every page [`rebuild_seeded_bodies`] can't
/// restamp. The projection is two implementations, since the hash is compared against
/// `pages.content_text`, which the editor writes through TypeScript `extractText`. Both answer
/// to `tests/fixtures/content-text-projection.json`.
const CONTENT_TEXT_PROJECTION_VERSION: i64 = 2;

/// Seeds the external description into the body, overwriting only while the body is pristine
/// and otherwise parking the text in `pending_description`. Pristineness is the `content_text`
/// hash, falling back to `user_modified` when the stored projection version is stale.
async fn apply_seeded_description(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    description: Option<&str>,
    is_new: bool,
    now: &str,
) -> AppResult<()> {
    let Some(desc) = description.map(str::trim).filter(|d| !d.is_empty()) else {
        // Never blank out a body the user may own.
        return Ok(());
    };
    let (content_json, projected_text) = project_description(desc);
    let new_hash = fnv_hex(&projected_text);

    if is_new {
        write_seeded_body(tx, page_id, &content_json, &projected_text, &new_hash, now).await?;
        return Ok(());
    }

    let (content_text, stored_hash, stored_version, user_modified) =
        fetch_seed_state(tx, page_id).await?;

    if projected_text == content_text {
        sqlx::query(
            "UPDATE page_sync SET pending_description = NULL, seeded_description_hash = ?,
             seeded_description_hash_version = ? WHERE page_id = ?",
        )
        .bind(&new_hash)
        .bind(CONTENT_TEXT_PROJECTION_VERSION)
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    let body_pristine = match (stored_hash.as_deref(), stored_version) {
        (Some(h), Some(v)) if v == CONTENT_TEXT_PROJECTION_VERSION => fnv_hex(&content_text) == h,
        // The old hash is incomparable; trust the ownership flag.
        (Some(_), _) => !user_modified,
        (None, _) => content_text.is_empty() && !user_modified,
    };

    if body_pristine {
        write_seeded_body(tx, page_id, &content_json, &projected_text, &new_hash, now).await?;
    } else {
        // As written rather than projected, so Append builds the same list a seed would.
        sqlx::query("UPDATE page_sync SET pending_description = ? WHERE page_id = ?")
            .bind(desc)
            .bind(page_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// Rebuilds each body still as seeded (its text hashing to the stored seed) the way a seed is
/// built: web addresses linked and "- " lines a bullet list. Any other body is the person's.
/// The hash is restamped at the current projection version, so the next description change
/// still sees the body as untouched, and `updated_at` stays put. The write is captured like any
/// edit: a detached page's body syncs, and nothing else carries this change to another device.
pub(crate) async fn rebuild_seeded_bodies(pool: &sqlx::SqlitePool) -> AppResult<()> {
    let body = crate::page_chunks::body_sql("p.id");
    // sql-ok: body_sql is built from a compile-time constant
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT p.id, {body}, p.content_text, ps.seeded_description_hash
         FROM pages p JOIN page_sync ps ON ps.page_id = p.id
         WHERE ps.seeded_description_hash IS NOT NULL"
    )))
    .fetch_all(pool)
    .await?;
    let mut tx = pool.begin().await?;
    for (id, content, text, hash) in rows {
        if fnv_hex(&text) != hash {
            continue;
        }
        let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };

        let linked = crate::pool::link_addresses(&mut doc);
        let listed = doc
            .get_mut("content")
            .and_then(|c| c.as_array_mut())
            .is_some_and(crate::pool::bullet_dashed_paragraphs);
        let content = doc.to_string();
        let text = if listed {
            crate::pool::extract_text_from_tiptap(&content)
        } else {
            text
        };

        if linked || listed {
            sqlx::query("UPDATE pages SET content_text = ? WHERE id = ?")
                .bind(&text)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            crate::page_chunks::write_body(&mut *tx, &id, &content).await?;
        }
        sqlx::query(
            "UPDATE page_sync SET seeded_description_hash = ?, seeded_description_hash_version = ?
             WHERE page_id = ?",
        )
        .bind(fnv_hex(&text))
        .bind(CONTENT_TEXT_PROJECTION_VERSION)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Reads the body and seed bookkeeping needed to classify a description change.
async fn fetch_seed_state(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
) -> AppResult<(String, Option<String>, Option<i64>, bool)> {
    let row = sqlx::query_as::<_, (String, Option<String>, Option<i64>, bool)>(
        "SELECT p.content_text, ps.seeded_description_hash, ps.seeded_description_hash_version,
                ps.user_modified
         FROM pages p JOIN page_sync ps ON ps.page_id = p.id
         WHERE p.id = ?",
    )
    .bind(page_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(row)
}

/// Writes the seed into the body, records its hash and version, and clears any parked notice.
async fn write_seeded_body(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    content_json: &str,
    content_text: &str,
    hash: &str,
    now: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE pages SET content_text = ?, updated_at = ? WHERE id = ?")
        .bind(content_text)
        .bind(now)
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
    crate::page_chunks::write_body(&mut **tx, page_id, content_json).await?;
    sqlx::query(
        "UPDATE page_sync SET seeded_description_hash = ?, seeded_description_hash_version = ?,
         pending_description = NULL WHERE page_id = ?",
    )
    .bind(hash)
    .bind(CONTENT_TEXT_PROJECTION_VERSION)
    .bind(page_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// A plain-text description as (Tiptap doc JSON, its `content_text` projection). Projects
/// through the extractor FTS uses, so a pristine body hashes identically whoever wrote it last;
/// hence the hash is over `content_text`, not the JSON.
fn project_description(text: &str) -> (String, String) {
    let doc = crate::pool::build_description_doc(text);
    let projected = crate::pool::extract_text_from_tiptap(&doc);
    (doc, projected)
}

/// Rewrites a UTC `UNTIL=…Z` token inside a raw RRULE to source-zone wall-clock, leaving every
/// other field intact. Expansion matches occurrences by wall-clock string, so a UTC UNTIL
/// clips the final occurrences on the wrong day for viewers outside the source zone. Edited in
/// place through [`rewrite_until_with`], since a parse round-trip would drop BYSETPOS and
/// BYMONTHDAY.
fn rewrite_until_to_wall_clock(rrule: &str, tz: &str) -> String {
    let zone = match tz.parse::<Tz>() {
        Ok(zone) => zone,
        Err(e) => {
            let utc_until = rrule
                .split(';')
                .any(|part| part.starts_with("UNTIL=") && part.ends_with('Z'));
            if utc_until {
                log::warn!("reconciler: a UTC UNTIL is kept in UTC: {e}");
            }
            return rrule.to_string();
        }
    };
    rewrite_until_with(rrule, |value| until_utc_to_wall_clock(value, zone))
}

/// `20260315T100000Z` in `zone` as `20260315T060000` wall-clock, DST-correct per instant.
/// `None` for anything that isn't a UTC date-time, which is already wall-clock.
fn until_utc_to_wall_clock(value: &str, zone: Tz) -> Option<String> {
    let stamp = value.strip_suffix('Z')?;
    let naive = match NaiveDateTime::parse_from_str(stamp, UNTIL_FMT) {
        Ok(naive) => naive,
        Err(e) => {
            log::warn!("reconciler: UNTIL={value} is kept as it came: {e}");
            return None;
        }
    };
    let local = zoned::wall_clock_at(zone, Utc.from_utc_datetime(&naive));
    Some(local.format(UNTIL_FMT).to_string())
}

/// The storage form of a provider [`ExclusiveEnd`], and the only bridge to it.
///
/// Applying the decrement twice shortens every multi-day all-day span by another day, and
/// stored ends do re-enter here, since a `MasterOnly` rewrite re-inserts the overrides it
/// carried forward. Hence the private field: a stored value can only be rebuilt through
/// [`InclusiveEnd::from_stored`], which can't decrement.
mod allday_end {
    use chrono::Days;
    use pikos_recurrence::WallClock;

    use crate::sync_delta::ExclusiveEnd;

    /// The only end form `insert_schedule_row` accepts.
    pub(super) struct InclusiveEnd(Option<String>);

    impl InclusiveEnd {
        /// Only date-only ends carry the exclusivity convention; timed ends and `None` pass
        /// through. The length gate pins zero-padding, which [`WallClock::parse`] leaves to its
        /// caller.
        pub(super) fn from_provider(end: &ExclusiveEnd) -> Self {
            let Some(end) = end.as_deref() else {
                return Self(None);
            };
            if end.len() == 10 {
                if let Some(wall) = WallClock::parse(end) {
                    if let Some(inclusive) = wall.date.checked_sub_days(Days::new(1)) {
                        return Self(Some(WallClock::all_day(inclusive).format()));
                    }
                }
            }
            Self(Some(end.to_string()))
        }

        /// A value read back out of `page_schedules`, already inclusive.
        pub(super) fn from_stored(end: Option<String>) -> Self {
            Self(end)
        }

        pub(super) fn as_deref(&self) -> Option<&str> {
            self.0.as_deref()
        }
    }
}

#[cfg(test)]
#[path = "reconciler_tests.rs"]
mod reconciler_tests;
