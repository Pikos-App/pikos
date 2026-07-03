//! The sync engine: the provider-blind loop that turns one calendar poll into
//! page writes. It is the only place that sequences a [`CalendarProvider`] with
//! the shared reconciler and owns the per-calendar bookkeeping the trait
//! deliberately leaves out — cursor storage, post-backfill token bootstrap,
//! orphan-master resolution, and the offline/reconnect classification the UI
//! reads.
//!
//! **Atomic token advance.** A poll's stored cursor (`sync_calendar.sync_token`)
//! is advanced only after the whole run — reconcile *and* any orphan-master
//! fetch — succeeds. A transient failure anywhere short-circuits before the
//! advance, so the next poll re-runs from the same cursor and the reconciler's
//! idempotency (etag no-op, identity dedup) absorbs the re-delivery. No work is
//! buffered across runs.
//!
//! **Accepted backfill/bootstrap race.** A full enumerate carries no cursor, so
//! after reconcile the engine makes a *second* call to fetch the current token
//! (`current_sync_token`). An upstream change landing in that seconds-wide gap is
//! reflected in the fetched token but not in the just-applied delta — the cursor
//! now sits past a change we never ingested, so the next incremental poll skips
//! it. The change resurfaces only when that event next changes (bumping it past
//! the cursor again). Accepted, not fixed: closing it needs a provider-atomic
//! "enumerate-with-token" the CalDAV/Google APIs don't offer, and a full
//! re-enumerate (focus poll, token rejection) recovers it regardless.
//!
//! Scheduling (window-focus + interval polling) is **not** here — that's the
//! command/UI layer. This module is the unit of work a scheduler calls.

use chrono::{DateTime, Duration, Utc};
use pikos_db::error::{AppError, AppResult};
use pikos_db::now_iso;
use pikos_db::reconciler::{reconcile, MissingMaster, ReconcileContext, ReconcileOutcome};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{CalendarProvider, SyncDelta, SyncToken, UpsertItem};
use pikos_db::tx::retry_on_busy;

#[cfg(test)]
#[path = "engine_tests.rs"]
mod engine_tests;

/// What one calendar poll resolved to, for the status dot and the scheduler.
/// Transport and credential failures are *not* errors here — they're expected
/// operating states the UI surfaces calmly, so they map to variants rather than
/// `Err`. Only a genuine bug (DB/serde/internal) propagates as `Err`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncOutcome {
    /// Synced cleanly. `full_resync` is true when a stored cursor was rejected and
    /// the engine re-enumerated the window (it converges idempotently); false for
    /// an incremental delta or the very first backfill. `changed` is true when this
    /// poll actually mutated page data — derived from the reconciler's applied-write
    /// count plus any sweep removals, *not* from delta size. So a full re-enumerate
    /// where every etag no-ops reports `false` (no spurious UI refresh), and a
    /// sweep-only pass that deletes an upstream-vanished event reports `true`.
    Synced { full_resync: bool, changed: bool },
    /// Transport/offline failure — show a "synced <time> ago" stale indicator and
    /// keep the stored cursor; the next poll retries. No error storm.
    Offline,
    /// Credentials missing or rejected (keychain miss / revoked / rotated app
    /// password). Stop polling this account and surface a reconnect badge; every
    /// already-synced page stays viewable offline.
    ReconnectNeeded,
}

/// Run one poll for a single enabled calendar: sync from the stored cursor (or
/// backfill when there is none), reconcile, resolve any orphan masters, then
/// advance the cursor. `folder_id` is the calendar's system folder, resolved by
/// the caller — the engine never decides folder policy (mirrors the reconciler).
pub async fn sync_calendar<P: CalendarProvider>(
    pool: &sqlx::SqlitePool,
    provider: &P,
    account: &SyncAccountRow,
    calendar: &SyncCalendarRow,
    folder_id: &str,
) -> AppResult<SyncOutcome> {
    match run(pool, provider, account, calendar, folder_id).await {
        Ok(outcome) => Ok(outcome),
        // Offline and credential loss are expected states, not bugs — map them to
        // outcomes. CalDAV flattens keychain-miss *and* 401/403 to `Invalid`.
        Err(AppError::Network(_)) => Ok(SyncOutcome::Offline),
        Err(AppError::Invalid(_)) => Ok(SyncOutcome::ReconnectNeeded),
        Err(e) => Err(e),
    }
}

async fn run<P: CalendarProvider>(
    pool: &sqlx::SqlitePool,
    provider: &P,
    account: &SyncAccountRow,
    calendar: &SyncCalendarRow,
    folder_id: &str,
) -> AppResult<SyncOutcome> {
    let ctx = ReconcileContext {
        account_id: calendar.account_id.clone(),
        calendar_id: calendar.calendar_id.clone(),
        provider: account.provider.clone(),
        folder_id: folder_id.to_string(),
    };

    let since = calendar.sync_token.clone().map(SyncToken);
    let had_cursor = since.is_some();

    // A token-less collection (no `sync-collection`) would otherwise re-enumerate
    // every poll. Gate that on the collection's change-tag: unchanged since the
    // last full enumerate — and not yet due a periodic safety re-enumerate — means
    // nothing to do. Fetched before the enumerate so a change landing in the gap
    // re-triggers next poll rather than being masked by a newer stored ctag
    // (convergent, never lossy).
    let ctag = if had_cursor {
        None
    } else {
        provider.current_ctag(calendar).await.unwrap_or(None)
    };
    if !had_cursor && can_skip_enumerate(calendar, ctag.as_deref()) {
        persist_skip(pool, &calendar.id).await?;
        return Ok(SyncOutcome::Synced { full_resync: false, changed: false });
    }

    let delta = provider.sync(calendar, since).await?;

    // A provider returns no cursor only from a full enumerate — the initial
    // backfill, or a self-healed token rejection (CalDAV `403 valid-sync-token`
    // falls back to `calendar-query` internally). Both need a bootstrap; only the
    // latter is a "re-sync" for the UI.
    let was_full = delta.next_token.is_none();

    let outcome = reconcile_batched(pool, &ctx, &delta).await?;
    let resolved_masters = resolve_missing_masters(
        pool, provider, &ctx, calendar, &delta, &outcome.missing_masters,
    )
    .await?;
    let swept = sweep_absent_events(pool, &ctx, &delta, &resolved_masters).await?;
    let changed = outcome.applied > 0 || !resolved_masters.is_empty() || swept > 0;

    let next = match delta.next_token {
        Some(token) => Some(token),
        // Best-effort bootstrap: a failure here just leaves the cursor null, so the
        // next poll re-enumerates and retries — wasteful but convergent, never wrong.
        None => provider.current_sync_token(calendar).await.unwrap_or(None),
    };
    persist_progress(pool, &calendar.id, next.as_ref(), was_full, ctag.as_deref()).await?;

    Ok(SyncOutcome::Synced { full_resync: was_full && had_cursor, changed })
}

/// Drive `reconciler::sweep_absent` on a full authoritative enumerate; no-op
/// otherwise. Runs after the upserts commit, so every returned event is `active`
/// and won't be swept. Returns how many pages it removed (for the `changed` signal).
async fn sweep_absent_events(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
    delta: &SyncDelta,
    resolved_masters: &[String],
) -> AppResult<usize> {
    let Some(window_start) = &delta.authoritative_from else {
        return Ok(0);
    };
    let mut present: std::collections::HashSet<String> = delta
        .upserts
        .iter()
        .filter_map(|item| match item {
            UpsertItem::Event(ev) => Some(ev.core.external_id.clone()),
            UpsertItem::Occurrence(_) => None,
        })
        .collect();
    // Spare unresolved-but-present resources from the sweep (see `unresolved_present`).
    present.extend(delta.unresolved_present.iter().cloned());
    // Spare masters fetched to resolve a lone occurrence this pass — they carry the
    // series' external_id but never appear in `upserts`, so they'd otherwise be
    // detached/deleted in the same pass that created them.
    present.extend(resolved_masters.iter().cloned());
    retry_on_busy(|| {
        pikos_db::reconciler::sweep_absent(pool, ctx, &present, window_start)
    })
    .await
}

/// Above this many delta items, commit the upserts in batches instead of one
/// transaction — the initial backfill of a busy calendar would otherwise hold the
/// write lock for the whole ingest and stall interactive writes (the app's
/// instant-interaction bar). Small deltas keep the reconciler's single-transaction
/// all-or-nothing semantics.
const RECONCILE_BATCH: usize = 200;

/// A token-less calendar re-enumerates at least this often regardless of its
/// ctag, bounding staleness if the server's `getctag` is unreliable (doesn't move
/// on a change). The ctag skip is an optimisation over this backstop, never the
/// sole guarantee.
const FORCE_FULL_INTERVAL_HOURS: i64 = 6;

/// Reconcile a delta, splitting a large one into batched transactions (see
/// [`RECONCILE_BATCH`]). Whole-event/series upserts have no cross-item dependency
/// and batch freely; occurrence deltas (which may reference a master in the same
/// delta) and removals run last, after every event batch commits — so a master is
/// stored before its override, and only that final pass can surface a missing
/// master.
async fn reconcile_batched(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
    delta: &SyncDelta,
) -> AppResult<ReconcileOutcome> {
    if delta.upserts.len() + delta.removals.len() <= RECONCILE_BATCH {
        return reconcile_safe(pool, ctx, delta).await;
    }

    let mut events: Vec<UpsertItem> = Vec::new();
    let mut tail: Vec<UpsertItem> = Vec::new();
    for item in &delta.upserts {
        match item {
            UpsertItem::Event(_) => events.push(item.clone()),
            UpsertItem::Occurrence(_) => tail.push(item.clone()),
        }
    }

    let mut applied = 0;
    for batch in events.chunks(RECONCILE_BATCH) {
        let sub = SyncDelta { upserts: batch.to_vec(), ..Default::default() };
        applied += reconcile_safe(pool, ctx, &sub).await?.applied;
    }

    if tail.is_empty() && delta.removals.is_empty() {
        return Ok(ReconcileOutcome { missing_masters: vec![], applied });
    }
    // Occurrences + removals, once every master in this delta is stored.
    let sub = SyncDelta { upserts: tail, removals: delta.removals.clone(), ..Default::default() };
    let mut outcome = reconcile_safe(pool, ctx, &sub).await?;
    outcome.applied += applied;
    Ok(outcome)
}

/// `reconcile` under WAL busy/snapshot retry. Its deferred read-then-write can
/// lose the snapshot race (`SQLITE_BUSY_SNAPSHOT`, 517) — which `busy_timeout`
/// can't clear — when a sync poll collides with the editor; each retry opens a
/// fresh transaction and re-reads, so the write self-heals instead of dropping.
async fn reconcile_safe(
    pool: &sqlx::SqlitePool,
    ctx: &ReconcileContext,
    delta: &SyncDelta,
) -> AppResult<ReconcileOutcome> {
    retry_on_busy(|| reconcile(pool, ctx, delta)).await
}

/// Resolve occurrence deltas the reconciler couldn't apply because their series
/// rule isn't stored and no master arrived in this delta. For each, fetch the one
/// master (`fetch_event`, NOT a full-series re-fetch), then re-reconcile it
/// alongside its occurrence deltas from the original batch — the reconciler's
/// two-pass applies the master first, so the override lands cleanly.
///
/// A `404` means the master is truly gone: drop the occurrence delta (terminal,
/// so the cursor may safely advance). Any other error is transient and propagates
/// — the cursor is not advanced and the whole run retries next poll. Returns the
/// external ids of the masters it fetched and stored, so the authoritative sweep
/// can spare them; a non-empty result also drives the `changed` signal.
async fn resolve_missing_masters<P: CalendarProvider>(
    pool: &sqlx::SqlitePool,
    provider: &P,
    ctx: &ReconcileContext,
    calendar: &SyncCalendarRow,
    original: &SyncDelta,
    missing: &[MissingMaster],
) -> AppResult<Vec<String>> {
    if missing.is_empty() {
        return Ok(vec![]);
    }

    let mut resolved = SyncDelta::default();
    let mut master_ids = Vec::new();
    for mm in missing {
        match provider.fetch_event(calendar, &mm.series_ref).await {
            Ok(master) => {
                master_ids.push(master.core.external_id.clone());
                resolved.upserts.push(UpsertItem::Event(master));
                for item in &original.upserts {
                    if let UpsertItem::Occurrence(occ) = item {
                        if occ.ical_uid == mm.ical_uid {
                            resolved.upserts.push(item.clone());
                        }
                    }
                }
            }
            // Master gone upstream → drop the orphaned occurrence delta.
            Err(AppError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }

    if resolved.upserts.is_empty() {
        return Ok(vec![]);
    }
    // The masters we just fetched are present, so this pass resolves cleanly;
    // any lingering signal would mean a provider bug, not a retryable orphan.
    reconcile_safe(pool, ctx, &resolved).await?;
    Ok(master_ids)
}

/// Whether a token-less poll may skip enumerating: the collection change-tag must
/// be present on BOTH sides and match, AND a periodic safety re-enumerate must not
/// be due. A missing tag on either side (server doesn't support `getctag`, or the
/// first poll before one is stored) forces enumeration — so an absent or
/// unreliable tag degrades to bounded staleness, never a dropped change.
fn can_skip_enumerate(calendar: &SyncCalendarRow, current_ctag: Option<&str>) -> bool {
    let (Some(stored), Some(current)) = (calendar.ctag.as_deref(), current_ctag) else {
        return false;
    };
    stored == current && !force_full_due(calendar.last_full_sync_at.as_deref())
}

/// Whether the periodic safety re-enumerate is due. A missing or unparseable
/// timestamp counts as due, so the backstop errs toward enumerating.
fn force_full_due(last_full_sync_at: Option<&str>) -> bool {
    let Some(ts) = last_full_sync_at.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) else {
        return true;
    };
    Utc::now().signed_duration_since(ts.with_timezone(&Utc))
        >= Duration::hours(FORCE_FULL_INTERVAL_HOURS)
}

/// Stamp a no-op poll's freshness clock without touching the cursor, ctag, or
/// full-sync mark — the ctag matched, so nothing was enumerated.
async fn persist_skip(pool: &sqlx::SqlitePool, calendar_id: &str) -> AppResult<()> {
    let now = now_iso();
    sqlx::query("UPDATE sync_calendar SET last_synced_at = ?, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&now)
        .bind(calendar_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Advance the stored cursor and stamp the freshness clocks. The single writer of
/// `sync_calendar`'s sync state, run only after a fully successful poll. `ctag` is
/// recorded on a full enumerate so the next token-less poll can diff against it;
/// incremental polls leave it untouched.
async fn persist_progress(
    pool: &sqlx::SqlitePool,
    calendar_id: &str,
    token: Option<&SyncToken>,
    was_full: bool,
    ctag: Option<&str>,
) -> AppResult<()> {
    let now = now_iso();
    let token_str = token.map(|t| t.0.as_str());
    if was_full {
        sqlx::query(
            "UPDATE sync_calendar
             SET sync_token = ?, ctag = ?, last_full_sync_at = ?, last_synced_at = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(token_str)
        .bind(ctag)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .bind(calendar_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            "UPDATE sync_calendar
             SET sync_token = ?, last_synced_at = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(token_str)
        .bind(&now)
        .bind(&now)
        .bind(calendar_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}
