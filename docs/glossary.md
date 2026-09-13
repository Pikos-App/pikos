# Pikos glossary

Domain vocabulary. Each entry is a **definition + where it lives in code**, not an
explanation of the model. When you need the model, follow the pointer.

Scope marker: entries marked **(0.4.0)** describe the unified recurring / sync model
shipping in 0.4.0. On shipped `0.3.1` those terms either don't exist or mean something
narrower. The difference is called out inline.

---

## Page origins

A page's **origin** is the primary discriminator in this codebase. It decides
locking, deletion semantics, and time rendering. Full behavior per origin ×
surface: [`functionality-matrix.md`](./functionality-matrix.md).

| Term | Meaning | Discriminator |
|---|---|---|
| **Native page** | Created in Pikos by the user. | no `page_sync` row |
| **Synced page** | Live mirror of an external calendar event. Real `pages` row, not a special type. | `page_sync.sync_state = 'active'` |
| **Detached page** | Was synced; link severed (upstream deleted, or calendar unsynced) while Pikos-owned. Keeps its last-known schedule and stays in its external folder. | `sync_state = 'detached'` |
| **Tombstoned** | Locally deleted while sync was active — suppressed so the next poll doesn't resurrect it. Cleared on unsync. | `sync_state = 'tombstoned'` |
| **Re-linked page** | A detached page the calendar has reclaimed — same row, back to synced. Not a fourth state: it *is* a synced page again, and the provider's title, schedule and folder overwrite whatever the user changed while it was detached. See [Unsync → re-link](#calendar-sync). | `sync_state` back to `'active'` |

**Schedule locked** — a synced page's schedule is calendar-owned and read-only.
Exposed as a derived `schedule_locked` flag joined from `page_sync.sync_state =
'active'`, deliberately *not* denormalized onto `pages`.

**Mirror layer / seeded content / user layer** — the three ownership buckets of a
synced page. Mirror = title + schedule + location/attendees (reconciler writes,
rendered read-only). Seeded content = the external description, written into the
body on first sync and the user's thereafter. User layer = body, tags, reminders,
links (editor writes only).

**Pikos-owned** — the predicate deciding detach-vs-hard-delete when an event
disappears. True if the page is completed, has a non-empty completed-set, or
`user_modified` is set. `last_opened_at` is explicitly not an ownership signal.
Ownership is **series-granular**, not per-occurrence.

**`user_modified`** — dirty bit set the first time the user edits any field through
the editor. Sync writes go through the Rust reconciler and never set it. Used
instead of per-field content diffing; errs toward keeping data.

**`seeded_description_hash`** — hash of `content_text` (not the ProseMirror JSON,
which re-serializes spuriously) as last written by sync. Lets the reconciler tell a
pristine seeded description from a user-edited one. Carries a projection **version**
tag. Without it a projection change invalidates the whole synced corpus at once.

---

## Recurrence

Behavior per origin and surface: [`functionality-matrix.md`](./functionality-matrix.md)
§5–§6.

**Series** — one recurring page. Always a single `pages` row plus one
`page_recurrence_rules` row; never one row per occurrence.

**Rule / anchor (base)** — the `page_recurrence_rules` row: RRULE string + base
wall-clock + IANA tz. The anchor is canonical. **(0.4.0)** completion never moves
it; on 0.3.1 the anchor shifts in lockstep when the head is dragged.

**Head** — the real page that owns the rule. **(0.4.0)** always sits on the
oldest-open occurrence, for native and synced alike. On 0.3.1 it advances on
completion ("head-advance").

**Virtual occurrence** — a client-rendered expansion of the rule. Never persisted.
**(0.4.0)** expanded by Rust `expand_range` over IPC; on 0.3.1 by `rrule.js` in
`useRecurrenceExpansion`. Not independently completable.

**Done clone** — a real page minted when an occurrence is completed, carrying the
occurrence's date and the head's content snapshot. No recurrence rule of its own.

**Detached clone** — the **native** "move one occurrence" result: an independent
real page at the new time, with the original date EXDATE'd. Fully independent of
the head thereafter. Native only. A synced series has an upstream that would
re-mirror the occurrence beside the clone, so it writes a
[materialized override](#recurrence) instead.

**Materialized override** — one occurrence of a **synced** series pinned to a time
other than the rule's. A `page_schedules` row carrying `rule_id` + `original_date`,
rendering as a real, completable block. Locked while the series is active,
editable once detached. Two authors, one shape: the provider (CalDAV
`RECURRENCE-ID` / Google `originalStartTime`), or the user moving an occurrence of
a **detached** series, which writes a row rather than a [detached clone](#recurrence)
precisely so a re-link can reclaim the slot. Native series have none.

**`original_date`** — the occurrence date an override replaces. The join key
between an override row and the virtual occurrence it suppresses. Every writer must
use the same basis: the provider's, i.e. source-zone wall-clock for a timed series
and the bare date for an all-day one. The reconciler replaces an override by
*exact* match on it while the render and derivation layers day-key. A mismatch
double-renders, orphans the override, or lets a provider move mint a second row for
the same occurrence.

**completed-set (0.4.0)** — `(page_id, occurrence_date) → clone_id`. Native and
synced. The clone back-link is what makes uncomplete possible.

**skip-set (0.4.0)** — `(page_id, occurrence_date)`. Dismissals only. A *moved*
occurrence is an override, never a skip.

**EXDATE / `rrule_exdates`** — RFC 5545 excluded dates. **(0.4.0)** narrows to
provider EXDATEs only; legacy native EXDATEs stay and are honored by the exclusion
union forever. On 0.3.1 this is where skips *and* completion gaps are written.

**`oldest_open_occurrence` (0.4.0)** — *display* derivation. First occurrence not in
(completed ∪ skip ∪ exdates ∪ override dates); may be overdue. Materialized into
`pages.scheduled_start` as a rebuildable cache, asserted `cache == f(truth)` in CI.

**`occurrences_with_open_reminder_window` (0.4.0)** — *reminders* derivation. A
bounded enumeration per (occurrence × reminder-lead), not a scalar. Never reads the
display cache. Headless surfaces have no load event to heal a stale one.

**Finite vs infinite recurrence** — "m/w/f for 2 weeks" → N independent pages, no
rule. "every monday 1pm" → one page + an RRULE, expanded on the fly.

---

## Time

Full model: [`time-handling.md`](./time-handling.md).

**Floating wall-clock** — the native storage model: the literal clock reading you
saw, no timezone, no `Z`, no conversion. "9am" stays 9am wherever you travel.

**Absolute (zoned)** — the synced model: a real instant, rendered in the viewer's
current zone. A 3pm PT event shows 6pm in ET. Discriminated by **origin**, not by
the `timezone` column.

**All-day vs timed** — the format *is* the discriminator: `YYYY-MM-DD` vs
`YYYY-MM-DDTHH:MM:SS`. `isAllDayIso()` is the single site that decides. Never coerce
one into the other; all-day synced events never shift zones.

**Source zone / viewer zone** — the event's own IANA zone vs the device's current
zone. Equal in the dominant case, which makes the conversion an identity.

**Source-zone badge** — the "in `<zone>`" label shown beside an **already-shifted**
synced time. A label on the shift, never a substitute for it.

**`now_iso()` vs `now_local_iso()`** — the two Rust clocks. UTC with `Z` for audit
fields (`created_at`/`updated_at`); local wall-clock for user-day instants
(`scheduled_start`, `completed_at`). Mirrors `nowLocalISO()` on the frontend.

---

## Calendar sync

Behavior per origin and surface: [`functionality-matrix.md`](./functionality-matrix.md)
§7–§9.

**Provider** — CalDAV (Fastmail first) or Google. Dispatched behind a shared trait;
providers normalize into one delta shape and share the reconciler.

**`SyncDelta`** — the provider-agnostic normalized change set the reconciler
consumes. Carries two upsert kinds: a **series bundle** (master RRULE + base +
tz, overrides, exdates) and a first-class **occurrence delta**
(`modify-occurrence` / `cancel-occurrence`) for when a provider ships a changed
instance with the master absent.

**Reconciler** — the shared, provider-independent stage that turns a `SyncDelta`
into Pikos rows. Never re-fetches a series on a series-touching delta (that would
defeat the sync token).

**`external_id` vs `ical_uid`** — `external_id` is the provider's resource identity
(Google event id / CalDAV **href**) and the dedup key. `ical_uid` is the RFC 5545
`UID`, used only to re-link a dormant or detached page to **its own** calendar on
resync. Deliberately no cross-calendar dedup.

**`etag` / `ctag` / `sync_token`** — change-detection handles. Per-resource,
per-collection, and per-calendar incremental cursor respectively.

**Full enumerate vs incremental** — an incremental poll follows the sync token; a
full enumerate re-lists the calendar. Google's 410 on an expired token forces a full
enumerate, which is marked explicitly so recovery counts as a re-sync.

**Unsync → re-link** — unsyncing keeps owned pages, keeps the folder, and leaves a
dormant sync identity behind. Re-syncing the same calendar matches on `ical_uid` and
re-links in place rather than duplicating.

---

## Architecture

**`pikos-db`** — the Rust crate that's the **single writer** over SQLite: schema,
migrations, pool/pragmas, and all `*_impl` writer functions. Tauri-free. The desktop
app's db module is thin `#[tauri::command]` shims over it; the CLI links it directly.

**`pikos-recurrence`** — the Rust RRULE engine, the single implementation everywhere:
native for backend/CLI, wasm (`@pikos/recurrence-wasm`) for the JS apps. `rrule.js` is
deleted; the corpus + goldens are regression fixtures generated from it before removal.
**(0.4.0)** becomes the single expansion engine for both display and reminders.

**`@pikos/bridge`** — how the CLI reaches the TS-only NLP + recurrence parsing, via a
one-shot `node` subprocess. Keeps that logic single-sourced in TypeScript.

**Storage adapter** — the interface every DB read/write goes through from the
frontend: `TauriSQLiteAdapter` in production, `MockStorageAdapter` under
`VITE_TEST_MODE=true`. Components never `invoke` a DB command directly.

**Workspace** — one SQLite file = one workspace, self-contained (no `workspace_id`
column anywhere inside). Registry lives in `@tauri-apps/plugin-store`. A power-user
concept, hidden from the default UI.

**Smart views** — `Today` and `Inbox`, pinned above folders. Today = schedules at or
before today that aren't done; Inbox = `folder_id IS NULL`. Neither is a real folder
row.

**Quick Add** — the `Cmd+N` modal with the natural-language parser. Parser lives in
`packages/core`.

**Head / mirror / user layer** — see [Page origins](#page-origins) above.

---

## Project constants

These live in code. Listed here so nobody records them as decisions.

| Fact | Owner |
|---|---|
| App name `Pikos`, identifier `app.pikos.desktop`, repo `pkos` | `tauri.conf.json` |
| Tauri project root `apps/desktop/src-tauri/` (`frontendDist: "../dist"`) | `tauri.conf.json` |
| Package manager: pnpm (Rust workspace for `crates/`) | `package.json`, `Cargo.toml` |
| Index list | `crates/pikos-db/migrations/` |
| Dev DB `app.pikos.desktop.dev` vs prod `app.pikos.desktop` | Tauri `app_data_dir()` |
