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

use chrono::{Days, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

use crate::error::AppResult;
use crate::now_iso;
use crate::sync_delta::{
    EventCore, EventUpsert, OccurrenceDelta, OccurrenceKind, Removal, SyncDelta, UpsertItem,
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

    // Whole-event removals last: detach if owned, else hard delete.
    for removal in &delta.removals {
        apply_removal(&mut tx, ctx, removal).await?;
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
    let existing = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        "SELECT id, page_id, etag, sync_state FROM page_sync
         WHERE account_id = ? AND calendar_id = ? AND external_id = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(&ev.core.external_id)
    .fetch_optional(&mut **tx)
    .await?;

    // User deleted this event locally — its link is tombstoned. Skip the upsert so
    // the next sync can't resurrect it from trash; restoring it reactivates the row.
    if matches!(&existing, Some((.., state)) if state == "tombstoned") {
        return Ok(());
    }

    let now = now_iso();
    let (mirror_location, mirror_attendees) = mirror_values(&ev.core);

    let (page_id, is_new) = if let Some((page_sync_id, page_id, stored_etag, _)) = existing {
        // Unchanged etag → skip every write, so the token-reject full re-sync
        // doesn't churn updated_at and refloat every synced page as "recent".
        if ev.core.etag.is_some() && stored_etag == ev.core.etag {
            return Ok(());
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
        insert_page_sync(tx, ctx, &page_id, &ev.core, &mirror_location, &mirror_attendees, &now)
            .await?;
        (page_id, true)
    };

    write_schedule(tx, &page_id, ev, &now).await?;
    apply_seeded_description(tx, &page_id, ev.core.description.as_deref(), is_new, &now).await?;
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
         WHERE account_id = ? AND calendar_id = ? AND ical_uid = ?
           AND sync_state != 'tombstoned'",
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
        // Only UNTIL still carries a zone — dtstart/EXDATE/original_date arrive
        // already wall-clock from the provider. Keep the whole rule on one basis.
        let rrule = rewrite_until_to_wall_clock(&rec.rrule, tz);
        sqlx::query(
            "INSERT INTO page_recurrence_rules
             (id, page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&rule_id)
        .bind(page_id)
        .bind(&rrule)
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

// ─── Lifecycle: removals + teardown ─────────────────────────────────────────────

/// A whole event gone upstream → detach if the page is Pikos-owned, else hard
/// delete the bare mirror. Tombstoned (locally deleted) and already-detached rows
/// are left untouched, so re-running a removal converges. The destructive call
/// errs toward keeping.
async fn apply_removal(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &ReconcileContext,
    removal: &Removal,
) -> AppResult<()> {
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
        return Ok(());
    };
    // tombstoned: user already trashed it; detached: already severed. Idempotent.
    if state != "active" {
        return Ok(());
    }
    if is_owned(tx, &page_id).await? {
        detach_sync(tx, &page_sync_id).await?;
    } else {
        hard_delete_page(tx, &page_id).await?;
    }
    Ok(())
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
            _ => {
                if is_owned(&mut tx, &page_id).await? {
                    detach_sync(&mut tx, &page_sync_id).await?;
                } else {
                    hard_delete_page(&mut tx, &page_id).await?;
                }
            }
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
/// tag or reminder). The row checks belt-and-suspenders the dirty bit: those edits
/// flow through the editor path that sets it, but reading the rows too keeps the
/// predicate correct even if a future edit path forgets. `last_opened_at` is not a
/// signal — reading an event is not authoring it.
async fn is_owned(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
) -> AppResult<bool> {
    let owned: bool = sqlx::query_scalar(
        "SELECT p.completed_at IS NOT NULL
              OR ps.user_modified
              OR (p.tags <> '[]' AND p.tags <> '')
              OR EXISTS (SELECT 1 FROM page_reminders pr WHERE pr.page_id = p.id)
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
/// re-link. Touches no `pages` field, so a detach never refloats the page as
/// "recently edited".
async fn detach_sync(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_sync_id: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE page_sync SET sync_state = 'detached' WHERE id = ?")
        .bind(page_sync_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
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
