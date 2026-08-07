//! The shared reconciler: turns a provider-agnostic [`SyncDelta`] into page
//! writes. Both providers co-own it, so it's the only regression surface —
//! pinned by the synthetic corpus in `reconciler_tests.rs`, which runs before
//! any real provider exists.
//!
//! Covers the upsert path (three field layers — locked mirror, seeded
//! description, user layer — plus per-instant timezone normalization) and the
//! lifecycle path: a `SyncDelta` removal detaches an owned page or hard-deletes a
//! bare mirror, and [`teardown_calendar`] applies the same own-vs-delete rule
//! across a whole calendar when the user unsyncs it. The ownership decision
//! always errs toward keeping.

use chrono::{NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

use self::allday_end::InclusiveEnd;
use crate::error::AppResult;
use crate::now_iso;
use crate::sync_delta::{
    EventCore, EventUpsert, OccurrenceDelta, OccurrenceFidelity, OccurrenceKind, Removal,
    SyncDelta, UpsertItem,
};

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

/// What a reconcile surfaced for the engine to act on: orphan masters needing a
/// targeted fetch, and `applied` — the count of upserts/removals that actually
/// mutated state (an etag no-op or tombstoned skip is *not* counted). The engine
/// derives its `changed` UI-reload signal from `applied` rather than from delta size.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    pub missing_masters: Vec<MissingMaster>,
    pub applied: usize,
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
            if apply_event(&mut tx, ctx, ev).await? {
                outcome.applied += 1;
            }
        }
    }
    for item in &delta.upserts {
        if let UpsertItem::Occurrence(occ) = item {
            match apply_occurrence(&mut tx, ctx, occ).await? {
                OccurrenceResult::Applied => outcome.applied += 1,
                OccurrenceResult::Missing(missing) => outcome.missing_masters.push(missing),
                OccurrenceResult::Skipped => {}
            }
        }
    }

    // Whole-event removals last: detach if owned, else hard delete.
    for removal in &delta.removals {
        if apply_removal(&mut tx, ctx, removal).await? {
            outcome.applied += 1;
        }
    }

    tx.commit().await?;
    Ok(outcome)
}

/// Upsert a whole event or series: match by external_id, else re-link by
/// `ical_uid` in-calendar, else create. No-ops on an unchanged etag. Returns
/// whether it wrote anything — `false` on the tombstoned or etag-no-op skip.
async fn apply_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    ev: &EventUpsert,
) -> AppResult<bool> {
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

    // User deleted this event locally — its link is tombstoned. Skip the upsert so
    // the next sync can't resurrect it from trash; restoring it reactivates the row.
    if matches!(&existing, Some((_, _, _, state, _)) if state == "tombstoned") {
        return Ok(false);
    }

    // A detached page the user then trashed (sync severed first, then deleted): keep
    // that copy severed in the trash — reactivating it would rewrite an invisible
    // (`deleted_at`) row and re-lock it on restore. Drop the stale link so its
    // `external_id` frees, then fall through to mirror the live event fresh.
    if let Some((page_sync_id, _, _, _, true)) = &existing {
        sqlx::query("DELETE FROM page_sync WHERE id = ?")
            .bind(page_sync_id)
            .execute(&mut **tx)
            .await?;
        existing = None;
    }

    let now = now_iso();
    let (mirror_location, mirror_attendees) = mirror_values(&ev.core);

    let (page_id, is_new) = if let Some((page_sync_id, page_id, stored_etag, state, _)) = existing {
        // Unchanged etag → skip every write, so the token-reject full re-sync
        // doesn't churn updated_at and refloat every synced page as "recent".
        // Only when already active: a detached row (calendar re-enabled, same etag)
        // must fall through to reactivate its sync_state, or live sync never resumes.
        if state == "active" && ev.core.etag.is_some() && stored_etag == ev.core.etag {
            return Ok(false);
        }
        update_page_title(tx, &page_id, &ev.core.title, &now).await?;
        sqlx::query(
            "UPDATE page_sync SET etag = ?, sync_state = 'active', mirror_location = ?,
             mirror_attendees = ?, last_synced_at = ? WHERE id = ?",
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
        // Same UID, new/absent href → re-link this calendar's dormant page, no dup.
        sqlx::query(
            "UPDATE page_sync SET external_id = ?, etag = ?, sync_state = 'active',
             mirror_location = ?, mirror_attendees = ?, last_synced_at = ? WHERE id = ?",
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

    if !is_new {
        reclaim_calendar_folder(tx, &page_id, &ctx.folder_id).await?;
    }
    write_schedule(tx, &page_id, ev, &now).await?;
    apply_seeded_description(tx, &page_id, ev.core.description.as_deref(), is_new, &now).await?;
    Ok(true)
}

/// Move a reactivated page back into its calendar folder. A detached page is
/// freely filable, so it may sit anywhere by the time the calendar reclaims it —
/// and once re-linked it is locked again, which every other surface reads as
/// "lives in its calendar folder". Deliberately does not touch `updated_at`: the
/// page didn't change, its placement was overruled. No-op for a page already
/// there, which is every ordinary poll.
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

/// Find a re-linkable page by `ical_uid`, scoped to this calendar (never across
/// calendars — that would ping-pong the identity every poll). Trashed pages are
/// excluded: re-linking one under a changed href would rewrite an invisible
/// (`deleted_at`) row and re-lock it on restore — same invariant the external_id
/// match site enforces (never write a deleted page's link).
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

/// Replace the page's mirror schedule wholesale. The schedule is fully
/// reconciler-owned for a synced page, so a clean delete-and-reinsert is the
/// simplest idempotent write — re-running yields the same rows.
///
/// A [`OccurrenceFidelity::MasterOnly`] bundle is the exception: it can't see the
/// series' exdates and overrides (see the enum), so those are read back before the
/// delete and re-applied under the new rule — union for exdates, incoming-wins by
/// `original_date` for overrides, and only while the pattern still matches (see
/// [`load_carried_occurrences`]).
///
/// A recurring page's head is then recomputed to its oldest-open occurrence
/// (completed/skip sets, keyed by `page_id`, survive the rule rewrite and may push
/// it past the raw base) with the derivation owning terminal status both
/// directions. Any rewrite of a page that *had* a rule first un-marks a stale
/// terminal `done` the old series' recompute stamped: on a recurrence→single drop
/// no rule survives to clear it (and re-delivery as a single means it's live), and
/// on a recurrence→recurrence rewrite an engine-rejected new rule makes the
/// recompute skip — leaving the page invisibly `done` — so it's cleared up front
/// and a supported recompute re-marks it if the new series is still exhausted.
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
    // Only UNTIL still carries a zone — dtstart/EXDATE/original_date arrive
    // already wall-clock from the provider. Keep the whole rule on one basis.
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
        let rule_id = uuid::Uuid::new_v4().to_string();
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

        for ov in &rec.overrides {
            insert_schedule_row(
                tx,
                page_id,
                &ov.schedule.start,
                &InclusiveEnd::from_provider(&ov.schedule.end),
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

    // Base-occurrence floor; the recurring recompute below refines it, and a
    // rewrite of a page that had a rule clears a stale terminal `done` here (see fn doc).
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

/// A series' stored occurrence deltas, read back so a `MasterOnly` rewrite can
/// carry them across. Empty when the page has no rule yet.
#[derive(Default)]
struct CarriedOccurrences {
    exdates: Vec<String>,
    /// `(start, end, timezone, original_date)`.
    overrides: Vec<(String, Option<String>, Option<String>, String)>,
}

/// Carry forward only while the series' pattern is untouched. A changed RRULE or
/// base start shifts every occurrence date, so exdates and overrides keyed to the
/// old dates describe a pattern that no longer exists — carrying them would strand
/// a ghost occurrence the user can't move or delete (the mirror schedule is locked)
/// and can't stop from firing a reminder. Dropping them is correct rather than
/// lossy: nothing here is user-authored, and the provider's own occurrence deltas
/// plus the next full enumerate rebuild the live set.
///
/// `incoming_rrule` must already be UNTIL-rewritten, or a `UNTIL=…Z` rule reads as
/// changed on every poll and never carries anything.
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

    Ok(CarriedOccurrences {
        exdates: serde_json::from_str(&exdates_json).unwrap_or_default(),
        overrides,
    })
}

/// Apply a lone occurrence change against the already-stored series. Returns a
/// missing-master signal when no rule exists yet — never buffers, drops, or
/// synthesizes a page.
async fn apply_occurrence(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    occ: &OccurrenceDelta,
) -> AppResult<OccurrenceResult> {
    let rule = sqlx::query_as::<_, (String, String, String)>(
        "SELECT r.id, r.page_id, ps.sync_state FROM page_recurrence_rules r
         JOIN page_sync ps ON ps.page_id = r.page_id
         WHERE ps.account_id = ? AND ps.calendar_id = ? AND ps.ical_uid = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(&occ.ical_uid)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((rule_id, page_id, state)) = rule else {
        return Ok(OccurrenceResult::Missing(MissingMaster {
            ical_uid: occ.ical_uid.clone(),
            series_ref: occ.series_ref.clone(),
        }));
    };
    // tombstoned: user trashed the series; detached: sync severed. Mutating its
    // EXDATEs/overrides would resurrect a schedule the user no longer syncs.
    // Mirrors apply_removal's active-only guard.
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
                &InclusiveEnd::from_provider(&schedule.end),
                schedule.timezone.as_deref(),
                Some(&rule_id),
                Some(&occ.original_date),
                &now_iso(),
            )
            .await?;
        }
    }
    Ok(OccurrenceResult::Applied)
}

/// What applying one occurrence delta resolved to: it wrote (Cancel/Modify), it
/// skipped a non-active series, or its master isn't stored yet.
enum OccurrenceResult {
    Applied,
    Skipped,
    Missing(MissingMaster),
}

// ─── Lifecycle: removals + teardown ─────────────────────────────────────────────

/// A whole event gone upstream → detach if the page is Pikos-owned, else hard
/// delete the bare mirror. Tombstoned (locally deleted) and already-detached rows
/// are left untouched, so re-running a removal converges. The destructive call
/// errs toward keeping.
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
    // tombstoned: user already trashed it; detached: already severed. Idempotent.
    if state != "active" {
        return Ok(false);
    }
    detach_or_delete(tx, &page_sync_id, &page_id).await?;
    Ok(true)
}

/// The own-vs-delete decision, shared by an explicit removal, teardown, and the
/// full-enumerate sweep: an owned page detaches (keeps its dormant identity for a
/// later resync re-link); a bare mirror hard-deletes. Errs toward keeping.
async fn detach_or_delete(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_sync_id: &str,
    page_id: &str,
) -> AppResult<()> {
    if is_owned(tx, page_id).await? {
        detach_sync(tx, page_sync_id, page_id).await?;
    } else {
        hard_delete_page(tx, page_id).await?;
    }
    Ok(())
}

/// After a full authoritative enumerate, remove stored active pages the provider
/// no longer returns — the deletion signal an incremental cursor would carry as a
/// [`Removal`] but a backfill (initial, stale-token recovery, or a server with no
/// `sync-collection`) cannot. `present_ids` is every `external_id` the enumerate
/// returned; `window_start` is its query-window date. A page absent from the set
/// is a genuine upstream deletion **unless** it's merely pre-window (all its
/// occurrences precede `window_start`, so a time-bounded query legitimately omits
/// it) — [`is_pre_window`] spares those. Genuine removals run the normal
/// detach-if-owned / hard-delete lifecycle. Idempotent, and its own read-then-write
/// tx (wrap in `retry_on_busy`). Returns how many pages it removed — the only
/// applied count on a sweep-only pass (no upserts, no explicit removals).
pub async fn sweep_absent(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
    present_ids: &std::collections::HashSet<String>,
    window_start: &str,
) -> AppResult<usize> {
    let mut tx = pool.begin().await?;

    // One SELECT joins each active link's rule + head schedule, so the pre-window
    // check is a pure comparison per row instead of 1–2 queries inside the tx.
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
        detach_or_delete(&mut tx, &page_sync_id, &page_id).await?;
        removed += 1;
    }

    tx.commit().await?;
    Ok(removed)
}

/// Whether a page's occurrences all precede `window_start`, so the sweep spares it.
/// Day-granularity, and deliberately biased toward keeping:
///
/// - **One day of slack** (`<=`, not `<`): storage is source-zone wall-clock while
///   the server's time-range bound is a UTC instant, so an ahead-of-UTC event whose
///   UTC instant falls just before the window (≤ ~14h) is server-excluded yet its
///   local wall-clock date lands on the window day. Sparing that day keeps a live
///   event from being swept; behind-UTC zones already fail safe.
/// - **Recurring is bounded only by a readable `UNTIL`** (via [`extract_until`],
///   FREQ-agnostic so an out-of-envelope rule still reads its bound). No `UNTIL`
///   (infinite or `COUNT`) is assumed in-window. A `COUNT`-bounded series that truly
///   ended pre-window is the one accepted false negative — expanding COUNT to catch
///   it isn't worth the cost for a soft sweep guard. Rare, and worst case detaches an
///   owned page (re-links on the next real change) or drops a stale past mirror.
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
    // End (inclusive) is the latest instant when present, else the start; no stored
    // schedule can't be proven pre-window, so don't spare it.
    match end.or(start) {
        Some(instant) => date_key(instant).as_str() <= window_key,
        None => false,
    }
}

/// First 8 digits of any date / date-time string → `YYYYMMDD`, so day-granularity
/// comparison works regardless of format (`2026-06-24`, `2026-06-24T09:00:00`,
/// `20260624T090000`). Lexical order over the fixed-width result is date order.
fn date_key(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).take(8).collect()
}

/// Tear down a calendar's live sync (the user unsynced or disconnected it). Same
/// own-vs-delete rule as an upstream removal, applied across the whole calendar:
/// owned pages detach and keep their dormant identity so a later resync re-links
/// them in place; non-owned pages hard delete; tombstoned links are cleared so a
/// fresh resync legitimately brings those events back (the page stays in trash).
/// The folder survives — de-flagged to a regular folder — whenever a live page
/// remains, and is removed only when nothing owned survived. Idempotent.
pub async fn teardown_calendar(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    calendar_id: &str,
    folder_id: &str,
) -> AppResult<()> {
    // Deferred read-then-write (enumerate the links, then rewrite them) — the same
    // shape that loses the WAL snapshot race elsewhere, so it takes the same retry.
    crate::tx::retry_on_busy(|| teardown_calendar_once(pool, account_id, calendar_id, folder_id))
        .await
}

async fn teardown_calendar_once(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    calendar_id: &str,
    folder_id: &str,
) -> AppResult<()> {
    let mut tx = pool.begin().await?;

    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, page_id, sync_state FROM page_sync
         WHERE account_id = ? AND calendar_id = ?",
    )
    .bind(account_id)
    .bind(calendar_id)
    .fetch_all(&mut *tx)
    .await?;

    for (page_sync_id, page_id, state) in rows {
        match state.as_str() {
            // Drop the dormant tombstone so a fresh resync recreates the event;
            // the soft-deleted page stays in trash, recoverable.
            "tombstoned" => {
                sqlx::query("DELETE FROM page_sync WHERE id = ?")
                    .bind(&page_sync_id)
                    .execute(&mut *tx)
                    .await?;
            }
            // Already severed by a prior upstream removal — keep its dormant identity.
            "detached" => {}
            _ => detach_or_delete(&mut tx, &page_sync_id, &page_id).await?,
        }
    }

    // Keep the folder if any live page survived (it just stops being a live sync
    // folder); remove it only when nothing owned remained.
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

/// Pikos-owned = the user has invested in this page, so teardown keeps it. True if
/// completed, the dirty bit is set, or it carries a field sync never writes (a user
/// tag or reminder, or a non-empty completed-set/skip-set for a recurring series the
/// user has completed or dismissed occurrences of). The row checks belt-and-suspenders
/// the dirty bit: those edits flow through the editor path that sets it, but reading
/// the rows too keeps the predicate correct even if a future edit path forgets.
/// `last_opened_at` is not a signal — reading an event is not authoring it. Without
/// the completed-set/skip-set checks a synced series whose only user investment is
/// completed or skipped occurrences would classify non-owned and hard-delete on
/// upstream removal — losing the completion/dismissal history and resurrecting
/// dismissed occurrences on reconnect.
async fn is_owned(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, page_id: &str) -> AppResult<bool> {
    let owned: bool = sqlx::query_scalar(
        "SELECT p.completed_at IS NOT NULL
              OR ps.user_modified
              OR (p.tags <> '[]' AND p.tags <> '')
              OR EXISTS (SELECT 1 FROM page_reminders pr WHERE pr.page_id = p.id)
              OR EXISTS (SELECT 1 FROM completed_set cs WHERE cs.page_id = p.id)
              OR EXISTS (SELECT 1 FROM skip_set ss WHERE ss.page_id = p.id)
         FROM pages p JOIN page_sync ps ON ps.page_id = p.id
         WHERE p.id = ?",
    )
    .bind(page_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(owned)
}

/// Sever the live sync link, keeping the page, its last-known schedule, and its
/// dormant identity (`ical_uid` + provider/calendar hint) for a later resync
/// re-link. Recomputes a recurring head (no-op otherwise): once detached the page
/// unlocks and the frontend's completed-base head suppression stops applying, so a
/// series whose base is a completed occurrence would double-render beside its done
/// clone until the next on-load heal — the recompute moves the head to oldest-open
/// now. The `sync_state` flip is on `page_sync`, so a non-recurring detach leaves
/// `pages.updated_at` untouched (the recompute no-ops). A recurring detach does
/// bump it via the recompute's head write — correct, since unlocking the page is a
/// real state change — so it refloats as "recently edited".
async fn detach_sync(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_sync_id: &str,
    page_id: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE page_sync SET sync_state = 'detached' WHERE id = ?")
        .bind(page_sync_id)
        .execute(&mut **tx)
        .await?;
    float_wall_clock(tx, page_id).await?;
    crate::recurrence_derive::recompute_recurring_schedule(tx, page_id).await?;
    Ok(())
}

/// Spend the source-zone stamp instead of dropping it: rewrite every stored
/// wall-clock into the device's zone and clear the stamp, so a page that was
/// rendered at its absolute instant keeps that instant when it starts floating.
/// Without this a detached 3pm Berlin event becomes 3pm wherever the user is —
/// the block moves and the reminder (which falls back to the naive device-local
/// path once the page is no longer active-synced) fires at the wrong time.
///
/// **Refused when a recurring series' base start changes date.** Every occurrence
/// date derives from that base, and those dates key `completed_set`, `skip_set`,
/// `rrule_exdates` and each override's `original_date`, while the rule's BYDAY
/// names the base's weekday — shifting it means rewriting five things in step, and
/// a partial rewrite silently moves the series to a different day of the week.
/// Such a series keeps its raw wall-clock. It takes a non-local calendar *and* a
/// start within the zone offset of midnight to reach.
///
/// All-day rows carry no zone (a date has none) and are left alone throughout.
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
    let Some(source) = source.and_then(|tz| tz.parse::<Tz>().ok()) else {
        return Ok(());
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
        .bind(shift_until_to_device(rrule, source, device))
        .bind(&start)
        .bind(end)
        .bind(device.name())
        .bind(rule_id)
        .execute(&mut **tx)
        .await?;
    }

    // Override rows included: a moved instance renders and fires on its own row,
    // so leaving it source-zoned would strand it an offset away from the series it
    // belongs to. Each row converts from **its own** stamp — a provider can move an
    // instance into a different zone from the master's.
    for (schedule_id, start, end, tz) in &schedules {
        let Some(row_source) = tz.as_ref().and_then(|tz| tz.parse::<Tz>().ok()) else {
            continue;
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

    // A recurring page's denorm is rewritten by the recompute that follows; a
    // one-off's is a plain copy of the row just converted, so convert it in step.
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

/// `2026-03-15T15:00:00` in `source` → the same instant as device-local
/// wall-clock, DST-correct per instant. `None` for a date-only value (all-day
/// floats already) or anything unparseable, and for a wall-clock that doesn't
/// exist in the source zone (spring-forward gap) — the caller keeps the original
/// rather than inventing a time.
fn to_device_wall_clock(wall_clock: &str, source: Tz, device: Tz) -> Option<String> {
    Some(
        convert_instant(wall_clock, "%Y-%m-%dT%H:%M:%S", source, device)?
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string(),
    )
}

/// Shift a source-zone `UNTIL` token to device-local so the series' bound floats
/// with the occurrences it bounds. The reconciler already rewrote any UTC `UNTIL`
/// to source-zone wall-clock on ingest, so there is no `Z` left to handle; a
/// date-only bound needs no shift. Surgical edit for the same reason as
/// [`rewrite_until_to_wall_clock`] — a parse round-trip drops rule fields.
fn shift_until_to_device(rrule: &str, source: Tz, device: Tz) -> String {
    rrule
        .split(';')
        .map(|part| match part.split_once('=') {
            Some((key, value)) if key.eq_ignore_ascii_case("UNTIL") => {
                match convert_instant(value, "%Y%m%dT%H%M%S", source, device) {
                    Some(shifted) => format!("{key}={}", shifted.format("%Y%m%dT%H%M%S")),
                    None => part.to_string(),
                }
            }
            _ => part.to_string(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Re-express one wall-clock in another zone. `earliest()` for the same reason as
/// [`crate::notification_log::synced_fire_instant`]: a fall-back-ambiguous hour
/// resolves to its first pass rather than dropping the value entirely.
fn convert_instant(value: &str, fmt: &str, source: Tz, device: Tz) -> Option<NaiveDateTime> {
    let naive = NaiveDateTime::parse_from_str(value, fmt).ok()?;
    Some(
        source
            .from_local_datetime(&naive)
            .earliest()?
            .with_timezone(&device)
            .naive_local(),
    )
}

/// The device's IANA zone, resolved once per process — the lookup reads OS config
/// and this runs inside the detach transaction, where a per-value lookup would
/// widen the write lock under a racing editor write. Tests pin UTC (the corpus
/// convention), so no conversion assertion depends on the machine that ran it.
fn device_zone() -> Tz {
    #[cfg(test)]
    {
        Tz::UTC
    }
    #[cfg(not(test))]
    {
        use std::sync::OnceLock;
        static ZONE: OnceLock<Tz> = OnceLock::new();
        *ZONE.get_or_init(|| {
            iana_time_zone::get_timezone()
                .ok()
                .and_then(|name| name.parse().ok())
                .unwrap_or(Tz::UTC)
        })
    }
}

/// Destroy a non-owned synced page. The FK cascade removes its `page_sync` link,
/// schedules, rules, reminders, and FTS row — nothing of the user's is lost
/// because ownership was already checked.
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

// ─── Row writers ──────────────────────────────────────────────────────────────

async fn insert_synced_page(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    title: &str,
    now: &str,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id = ?",
    )
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
    let id = uuid::Uuid::new_v4().to_string();
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

/// Calendar-owned read-only metadata → mirror columns. Empty attendees store NULL
/// so "none" and "never synced" read alike.
fn mirror_values(core: &EventCore) -> (Option<String>, Option<String>) {
    let attendees = if core.attendees.is_empty() {
        None
    } else {
        serde_json::to_string(&core.attendees).ok()
    };
    (core.location.clone(), attendees)
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
    end: &InclusiveEnd,
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
    .bind(end.as_deref())
    .bind(timezone)
    .bind(rule_id)
    .bind(original_date)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ─── Seeded description (description → body, conflict-aware) ─────────────────────

/// Version of the `content_text` projection. Persisted with each
/// `seeded_description_hash` so a projection change re-seeds pristine bodies
/// instead of reading the whole synced corpus as "user edited". Bump on any change
/// to `build_tiptap_doc` or `extract_text_from_tiptap`.
const CONTENT_TEXT_PROJECTION_VERSION: i64 = 1;

/// Seed the external description into the body, conflict-aware: (over)write only
/// while the body is pristine, else park the withheld text in
/// `pending_description`. Pristineness is the `content_text` hash, falling back to
/// `user_modified` when the stored projection version is stale (the old hash can't
/// be compared).
async fn apply_seeded_description(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    description: Option<&str>,
    is_new: bool,
    now: &str,
) -> AppResult<()> {
    let Some(desc) = description.map(str::trim).filter(|d| !d.is_empty()) else {
        // No upstream description — never blank out a body the user may own.
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

    // Already matches upstream: clear any parked notice and re-stamp the hash.
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
        // Stale projection version → old hash incomparable; trust the ownership flag.
        (Some(_), _) => !user_modified,
        (None, _) => content_text.is_empty() && !user_modified,
    };

    if body_pristine {
        write_seeded_body(tx, page_id, &content_json, &projected_text, &new_hash, now).await?;
    } else {
        sqlx::query("UPDATE page_sync SET pending_description = ? WHERE page_id = ?")
            .bind(&projected_text)
            .bind(page_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// Read the body + seed bookkeeping needed to classify a description change.
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

/// Write the seed into the body and record its hash + version, clearing any
/// parked notice.
async fn write_seeded_body(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    content_json: &str,
    content_text: &str,
    hash: &str,
    now: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE pages SET content = ?, content_text = ?, updated_at = ? WHERE id = ?")
        .bind(content_json)
        .bind(content_text)
        .bind(now)
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
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

/// Plain-text description → (Tiptap doc JSON, its `content_text` projection).
/// Projects through the *same* extractor FTS uses so a pristine body hashes
/// identically whether the editor or reconciler last wrote it — which is why the
/// hash is over `content_text`, not the ProseMirror JSON.
fn project_description(text: &str) -> (String, String) {
    let doc = build_tiptap_doc(text);
    let projected = crate::pool::extract_text_from_tiptap(&doc);
    (doc, projected)
}

/// One paragraph per line — matches the doc the editor produces for pasted text.
fn build_tiptap_doc(text: &str) -> String {
    let content: Vec<serde_json::Value> = text
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                serde_json::json!({ "type": "paragraph" })
            } else {
                serde_json::json!({ "type": "paragraph", "content": [{ "type": "text", "text": line }] })
            }
        })
        .collect();
    serde_json::json!({ "type": "doc", "content": content }).to_string()
}

/// FNV-1a 64-bit hex — deterministic across builds (std `DefaultHasher` isn't)
/// and dep-free. Change detection, not security.
fn fnv_hex(s: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Rewrite a UTC `UNTIL=…Z` token inside a raw RRULE to source-zone wall-clock,
/// leaving every other field intact. Expansion matches occurrences by wall-clock
/// string, so a UTC UNTIL clips the final occurrence(s) on the wrong day for
/// viewers outside the source zone. Surgical edit, not a parse round-trip (that
/// drops BYSETPOS/BYMONTHDAY); floating/date-only UNTIL is already wall-clock.
fn rewrite_until_to_wall_clock(rrule: &str, tz: &str) -> String {
    let Ok(zone) = tz.parse::<Tz>() else {
        return rrule.to_string(); // unknown zone: leave raw rather than panic
    };
    rrule
        .split(';')
        .map(|part| match part.split_once('=') {
            Some((key, value)) if key.eq_ignore_ascii_case("UNTIL") => {
                match until_utc_to_wall_clock(value, zone) {
                    Some(local) => format!("{key}={local}"),
                    None => part.to_string(),
                }
            }
            _ => part.to_string(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// `20260315T100000Z` in `zone` → `20260315T060000` wall-clock, DST-correct per
/// instant. `None` for anything that isn't a UTC date-time (floating/date-only/
/// unparseable) — already wall-clock, so the caller leaves it as-is.
fn until_utc_to_wall_clock(value: &str, zone: Tz) -> Option<String> {
    let stamp = value.strip_suffix('Z')?;
    let naive = NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%S").ok()?;
    let local = Utc.from_utc_datetime(&naive).with_timezone(&zone);
    Some(local.format("%Y%m%dT%H%M%S").to_string())
}

/// The storage form of an end, and the single bridge from [`ExclusiveEnd`].
///
/// A second decrement shortens every multi-day all-day span by another day —
/// invisible until it's wrong everywhere — and stored ends really do re-enter
/// this module, since a `MasterOnly` rewrite re-inserts the override rows it
/// carried forward. The field is private to this module, so a stored value can
/// only be rebuilt through [`InclusiveEnd::from_stored`], which cannot decrement,
/// and the provider form has no conversion of its own. Applying it twice is a
/// missing method rather than a review catch.
mod allday_end {
    use chrono::{Days, NaiveDate};

    use crate::sync_delta::ExclusiveEnd;

    /// A Pikos-stored end: the inclusive last covered day. The only form the
    /// schedule writer accepts.
    pub(super) struct InclusiveEnd(Option<String>);

    impl InclusiveEnd {
        /// Sole owner of the decrement. Only date-only (all-day) ends are
        /// exclusive; timed ends and `None` pass through untouched.
        pub(super) fn from_provider(end: &ExclusiveEnd) -> Self {
            let Some(end) = end.as_deref() else {
                return Self(None);
            };
            if end.len() == 10 {
                if let Ok(date) = NaiveDate::parse_from_str(end, "%Y-%m-%d") {
                    if let Some(inclusive) = date.checked_sub_days(Days::new(1)) {
                        return Self(Some(inclusive.format("%Y-%m-%d").to_string()));
                    }
                }
            }
            Self(Some(end.to_string()))
        }

        /// A value read back out of `page_schedules` — already inclusive.
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
