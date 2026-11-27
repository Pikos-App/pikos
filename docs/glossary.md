# Pikos glossary

Domain vocabulary the whole product shares. Each entry is a definition and where it lives in
code. For the model behind a term, follow the link. Terms one folder owns are in that
folder's own `GLOSSARY.md`, such as
[replica sync](../crates/pikos-db/src/replica/GLOSSARY.md).

---

## Page origins

A page's **origin** is the primary discriminator in this codebase. It decides locking,
deletion semantics, and time rendering. Behavior per origin and surface:
[`functionality-matrix.md`](./functionality-matrix.md).

| Term               | Meaning                                                                                                                                                                                                                                  | Discriminator                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Native page**    | Created in Pikos by the user.                                                                                                                                                                                                            | no `page_sync` row                |
| **Synced page**    | Live mirror of an external calendar event. A real `pages` row, not a special type.                                                                                                                                                       | `page_sync.sync_state = 'active'` |
| **Detached page**  | Was synced; link severed (upstream deleted, or calendar unsynced) while Pikos-owned. Keeps its last-known schedule and stays in its external folder.                                                                                     | `sync_state = 'detached'`         |
| **Tombstoned**     | Locally deleted while sync was active, and suppressed so the next poll doesn't resurrect it. Cleared on unsync.                                                                                                                          | `sync_state = 'tombstoned'`       |
| **Re-linked page** | A detached page its calendar has reclaimed: same row, back to synced. Not a fourth state. The provider's title, schedule and folder overwrite whatever the user changed while it was detached. See [Unsync and re-link](#calendar-sync). | `sync_state` back to `'active'`   |

**Schedule locked**: a synced page's schedule is calendar-owned and read-only. A derived
`schedule_locked` flag joined from `page_sync.sync_state = 'active'`, never stored on `pages`.

**Mirror layer / seeded content / user layer**: the three ownership buckets of a synced page.
Mirror is title, schedule, location and attendees: the reconciler writes them and they render
read-only. Seeded content is the external description, written into the body on first sync
and the user's after that. User layer is body, tags, reminders and links, which only the
editor writes.

**Pikos-owned**: the predicate deciding detach versus hard delete when an event disappears.
True if the page is completed, has a non-empty completed-set, or `user_modified` is set.
`last_opened_at` is not an ownership signal. Ownership is per series, not per occurrence.

**`user_modified`**: dirty bit set the first time the user edits any field through the
editor. Sync writes go through the Rust reconciler and never set it. It stands in for
per-field content diffing and errs toward keeping data.

**`seeded_description_hash`**: hash of `content_text` (not the ProseMirror JSON, which
re-serializes spuriously) as last written by sync. Lets the reconciler tell a pristine seeded
description from a user-edited one. It carries a projection version, so changing the
projection doesn't invalidate every synced page at once.

---

## Recurrence

Behavior per origin and surface: [`functionality-matrix.md`](./functionality-matrix.md)
§4 to §6.

**Finite recurrence**: a quick-add phrase bounded by a count or an end date ("m/w/f for 2
weeks"). Creates N independent pages, one per matched day, each scheduled on its own and
carrying no rule. It never becomes a series. The parser returns `ParseResult` type `finite`.
"Every monday 1pm" is the unbounded case: one page and an RRULE, expanded on the fly.

**Series**: one recurring page. Always a single `pages` row plus one `page_recurrence_rules`
row, never one row per occurrence.

**Rule / anchor (base)**: the `page_recurrence_rules` row: RRULE string, base wall-clock and
IANA zone. The anchor is canonical, and completion never moves it.

**Head**: the real page that owns the rule. It always sits on the oldest open occurrence, for
native and synced series alike.

**Virtual occurrence**: a client-rendered expansion of the rule. Never persisted, and not
independently completable. Expanded by the Rust engine, over IPC on desktop.

**Done clone**: a real page minted when an occurrence is completed, carrying the occurrence's
date and the head's content snapshot. No recurrence rule of its own.

**Detached clone**: the native "move one occurrence" result: an independent real page at the
new time, with the original date EXDATE'd. Native only. A synced series has an upstream that
would re-mirror the occurrence beside the clone, so it writes a
[materialized override](#recurrence) instead.

**Materialized override**: one occurrence of a synced series pinned to a time other than the
rule's. A `page_schedules` row carrying `rule_id` and `original_date`, rendering as a real,
completable block. Locked while the series is active, editable once detached. Two authors, one
shape: the provider (CalDAV `RECURRENCE-ID`, Google `originalStartTime`), or the user moving
an occurrence of a detached series. That writes a row rather than a
[detached clone](#recurrence) so a re-link can reclaim the slot. Native series have none.

**`original_date`**: the occurrence date an override replaces, and the join key between an
override row and the virtual occurrence it suppresses. Every writer uses the provider's basis:
source-zone wall-clock for a timed series, the bare date for an all-day one. The reconciler
replaces an override by exact match on it, while the render and derivation layers key by day.
A mismatch double-renders, orphans the override, or lets a provider move mint a second row for
the same occurrence.

**Completed-set**: `(page_id, occurrence_date) → clone_id`, native and synced. The clone
back-link is what makes uncomplete possible.

**Skip-set**: `(page_id, occurrence_date)`. Dismissals only. A moved occurrence is an
override, never a skip.

**EXDATE / `rrule_exdates`**: RFC 5545 excluded dates. Provider EXDATEs, plus the dates of
detached clones. The exclusion union also honors every EXDATE older versions wrote for skips
and completions.

**`oldest_open_occurrence`**: the display derivation. The first occurrence not in completed,
skip, exdates or override dates. It may be overdue. It is materialized into
`pages.scheduled_start` as a rebuildable cache, and CI asserts `cache == f(truth)`.

**`occurrences_with_open_reminder_window`**: the reminders derivation. A bounded enumeration
per occurrence and reminder lead, not a scalar. It never reads the display cache, because
headless surfaces have no load event to heal a stale one.

---

## Time

Full model: [`time-handling.md`](./time-handling.md).

**Floating wall-clock**: the native storage model. The literal clock reading you saw, with no
timezone, no `Z`, no conversion. "9am" stays 9am wherever you travel.

**Absolute (zoned)**: the synced model. A real instant, rendered in the viewer's current
zone, so a 3pm PT event shows 6pm in ET. Discriminated by origin, not by the `timezone`
column.

**All-day vs timed**: the format is the discriminator, `YYYY-MM-DD` versus
`YYYY-MM-DDTHH:MM:SS`. `isAllDayIso()` is the single site that decides. Never coerce one into
the other. All-day synced events never shift zones.

**Source zone / viewer zone**: the event's own IANA zone versus the device's current zone.
Equal in the dominant case, which makes the conversion an identity.

**Source-zone badge**: the "in `<zone>`" label beside an already-shifted synced time. A label
on the shift, never a substitute for it.

**`now_iso()` vs `now_local_iso()`**: the two Rust clocks. UTC with `Z` for audit fields
(`created_at`, `updated_at`), local wall-clock for user-day instants (`scheduled_start`,
`completed_at`). `nowLocalISO()` is the frontend's twin of the second.

---

## Calendar sync

Behavior per origin and surface: [`functionality-matrix.md`](./functionality-matrix.md)
§7 to §9.

**Provider**: CalDAV or Google, dispatched behind a shared trait. Providers normalize into
one delta shape and share the reconciler.

**`SyncDelta`**: the provider-agnostic change set the reconciler consumes. It carries two
upsert kinds: a series bundle (master RRULE, base and zone, overrides, exdates) and a
first-class occurrence delta (`modify-occurrence`, `cancel-occurrence`) for when a provider
ships a changed instance with the master absent.

**Reconciler**: the shared, provider-independent stage that turns a `SyncDelta` into Pikos
rows. It never re-fetches a series on a series-touching delta, which would defeat the sync
token.

**`external_id` vs `ical_uid`**: `external_id` is the provider's resource identity (Google
event id, CalDAV href) and the dedup key. `ical_uid` is the RFC 5545 `UID`, used only to
re-link a dormant or detached page to its own calendar on resync. There is no cross-calendar
dedup.

**`etag` / `ctag` / `sync_token`**: change-detection handles. Per resource, per collection,
and the per-calendar incremental cursor, respectively.

**Full enumerate vs incremental**: an incremental poll follows the sync token, and a full
enumerate re-lists the calendar. Google's 410 on an expired token forces a full enumerate,
which is marked explicitly so recovery counts as a re-sync.

**Unsync and re-link**: unsyncing keeps owned pages, keeps the folder, and leaves a dormant
sync identity behind. Re-syncing the same calendar matches on `ical_uid` and re-links in place
rather than duplicating.

---

## Architecture

**`pikos-db`**: the Rust crate that is the single writer over SQLite: schema, migrations,
pool and pragmas, and all `*_impl` writer functions. Tauri-free. The desktop app's db module
is thin `#[tauri::command]` shims over it, and the CLI links it directly.

**`pikos-recurrence`**: the Rust RRULE engine, the single implementation everywhere. Native
for the backend and CLI, wasm (`@pikos/recurrence-wasm`) for the JS apps. It serves both
display and reminders.

**Replica sync**: keeping one workspace the same across a person's own devices. Terms in
[`crates/pikos-db/src/replica/GLOSSARY.md`](../crates/pikos-db/src/replica/GLOSSARY.md).

**Storage adapter**: the interface every DB read and write goes through from the frontend:
`TauriSQLiteAdapter` in production, `MockStorageAdapter` under `VITE_TEST_MODE=true`.
Components never `invoke` a DB command directly.

**Real writer (e2e)**: `pikos-db` behind the end-to-end tests. The browser's
`TauriSQLiteAdapter` sends its commands over localhost to the e2e bridge
(`pikos-e2e-bridge`), which runs them against a SQLite file of the test's own. Every e2e test
runs there unless tagged `@mock-only`.

**Workspace**: one SQLite file is one workspace, self-contained, with no `workspace_id`
column anywhere inside. The registry lives in `@tauri-apps/plugin-store`. A power-user
concept, hidden from the default UI. Any SQLite tool can read the file, but only the app, the
CLI and MCP can write it, because its triggers call functions only `pikos_db` registers.

**Smart views**: Today and Inbox, pinned above folders. Today is schedules at or before today
that aren't done, and Inbox is `folder_id IS NULL`. Neither is a real folder row.

**Quick Add**: the `Cmd+N` modal with the natural-language parser. The desktop runs the
TypeScript parser in `packages/core`; the phone and the CLI run its Rust port in
`crates/pikos-core/src/nlp/quick_add`, which is graded against it.
