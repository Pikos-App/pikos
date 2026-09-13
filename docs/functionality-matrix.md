# Pikos functionality matrix

**Single source of truth for how each operation behaves across page origins and surfaces.**
Rows are operations at the granularity a user performs them; columns are the origin of the
thing being operated on (does it come from Pikos or a calendar?) and the surface it's
performed from.

Scope: **0.4.0**. 0.3.1 (shipped) has the Native column only. No `page_sync` table, so
every Synced/Detached cell is unreachable there. Mobile is a placeholder column
(`apps/mobile` is a bare `package.json`).

Use it for: checking a new feature covers every origin, and settling "what should this
do?" for a case the app itself doesn't make obvious.

---

## Legend

| Symbol | Meaning |
| --- | --- |
| ✅ | Supported, no caveat |
| ⚠️ | Supported, but this origin behaves differently from Native |
| 🚫 | The product refuses it, by a guard or by never offering it |
| ❌ | Offered by the UI but fails: a real gap |
| — | The concept doesn't exist here, so there's nothing to allow or refuse |
| ○ | Surface not built |

⚠️ is reserved for a **divergence between columns**. A caveat that lands the same way on
every origin is ✅ with the footnote carrying it. Otherwise a row of four ⚠️ says only
"this feature has a catch", which the footnote already said.

## Column definitions

| Column | Meaning | Discriminator |
| --- | --- | --- |
| **Native** | Page created in Pikos | no `page_sync` row |
| **Synced** | Live mirror of an external calendar event | `page_sync.sync_state = 'active'` → derived `schedule_locked = true` |
| **Detached** | Was synced, link severed (upstream deleted, or calendar unsynced, while Pikos-owned) | `sync_state = 'detached'`; **unlocked**, but still lives in its external folder |
| **CLI** | `pikos` binary over the same `pikos-db` writer | headless; no recurrence expansion, no UI |
| **Mobile** | Future mobile runtime | not built |

## Row vocabulary (recurring)

Restated here with storage, since the matrix is read cell-by-cell. Canonical
definitions (and the rest of the domain vocabulary): [`glossary.md`](./glossary.md).

| Term | What it is | Storage |
| --- | --- | --- |
| **Head** (materialized) | The real page that owns the rule. Always sits on the **oldest-open occurrence** — for native *and* synced. | `pages` row + `page_recurrence_rules` |
| **Virtual occurrence** | A client-rendered expansion of the rule. Not in the DB. | none — `expand_recurrence_range` over IPC |
| **Done clone** | Real page minted when an occurrence is completed. | `pages` row + `completed_set(page_id, occurrence_date) → clone_id` |
| **Detached clone** | Native "move one occurrence" result: an independent real page, original date EXDATE'd. Native only. | `pages` row + `rrule_exdates` entry |
| **Materialized override** | One occurrence of a **synced** series pinned off-rule — by the provider, or by the user on a detached series. Renders as a real, completable block; locked while active. | `page_schedules` row with `rule_id` + `original_date` |

---

## 1. Page lifecycle

| Functionality | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Create page | ✅ | 🚫 ¹ | 🚫 ¹ | ✅ `add` ² | ○ |
| Open in editor | ✅ | ✅ read-only mirror ³ | ✅ | ✅ `read` | ○ |
| Adjust page title | ✅ | 🚫 locked ⁴ | ✅ | ⚠️ `update --title`, refused on synced ⁴ | ○ |
| Edit body / content | ✅ | ✅ marks owned ⁵ | ✅ | ⚠️ `update --content`, plain text, replaces body | ○ |
| Adjust priority | ✅ | ✅ marks owned ⁵ | ✅ | ✅ `update --priority` | ○ |
| Add / remove tags | ✅ | ✅ marks owned ⁵ | ✅ | ⚠️ `add` only, no tag flag on `update` | ○ |
| Toggle status (non-recurring) | ✅ | ✅ marks owned ⁵ | ✅ | ✅ `done` / `status` | ○ |
| Move page to another folder | ✅ | 🚫 locked ⁶ | ✅ ⁶ | — no `--folder` | ○ |
| Drag page from list onto a folder | ✅ ⁶ | 🚫 locked ⁶ | ✅ ⁶ | — | ○ |
| Reorder in page list | ✅ | ✅ doesn't mark owned ⁵ | ✅ | — | ○ |
| Delete page | ✅ soft → trash | ⚠️ soft + tombstone ⁷ | ⚠️ soft, stays detached ⁸ | ✅ soft; ⚠️ `--hard` ⁹ | ○ |
| Restore from trash | ✅ | ✅ resumes sync ⁷ | ✅ stays detached ⁸ | ✅ `restore` | ○ |

¹ `create_page_impl` rejects any create targeting an external-calendar folder
(`crates/pikos-db/src/pages.rs`). Only the reconciler seeds pages there, via raw SQL.
² Needs Node on PATH. The NL parser runs in a one-shot `node` bridge subprocess
(`crates/pikos-cli/src/main.rs`). Every other command is pure Rust.
³ Normal editor: title + schedule + recurrence render read-only with a "from \<calendar\>"
affordance; body, tags, priority, status, reminders stay live (`MetadataHeader.tsx`).
⁴ Locked mirror. Backend rejects title/`scheduled_start`/`scheduled_end` on an active-synced
page (`pages.rs` → `sync::ensure_page_schedule_unlocked`, which the CLI surfaces as exit code
4, `Conflict`); the editor and the calendar popover render the title read-only, and the
page-list context menu drops its "Clear Date" item on a locked page, so the reject is never
reachable from the UI.
⁵ Ownership (`page_sync.user_modified = 1`, set by `update_page_impl`'s `marks_ownership`)
makes the page **Pikos-owned** → an upstream delete or unsync **detaches** instead of
hard-deleting. `last_opened_at` and `sort_order` are both excluded: reading a page and
arranging it in a list author nothing, so neither changes its lifecycle. A user who only ever
*rearranges* a synced event will see it disappear on an upstream delete rather than detach, which is
the intended read of "they never made it theirs".
⁶ The guard keys on the page's **live link**, not on the folder (`update_page_impl`'s placement
lock): an active `page_sync` row pins the page to its calendar folder, and no page of any
origin may move *into* an external-calendar folder. Those stay system-managed. A detached page
is the user's, so it files anywhere, and re-linking it moves it back
(`reclaim_calendar_folder`), keeping "a synced page lives in its calendar folder" true. The
editor renders the folder as a read-only label while locked; the page list drops its "Move to
Folder" menu item and skips locked pages in the sidebar-folder drop (`useThreePanelDnD`'s
`unlockedIds`), so the reject is unreachable from the UI. The
*inbound* half is unreachable too, but by a different mechanism worth knowing before
anyone unifies the two sidebar components: `folderMoveTargets` hides calendar folders from
the menu, and a calendar folder renders as `ExternalCalendarItem`, which registers no dnd
droppable at all. Only `FolderItem` (user folders) does. So no page of any origin can be
dropped onto a calendar folder, and the guard is never reached from the UI.
⁷ Soft-delete + `sync_state = 'tombstoned'` so the next poll can't resurrect it (`pages.rs`).
Doubles as the "hide this event" affordance. Restore flips the tombstone back to `active` and
resumes syncing.
⁸ `soft_delete_page_impl` only tombstones an **active** link, and `restore_page_impl` only
un-tombstones what that delete set. So detached survives the trash round-trip.
⁹ `pikos delete` soft-deletes through the app's own path (`soft_delete_page_impl`, the same trash
+ tombstone semantics as the desktop, every origin). `--hard` destroys (`hard_delete_page_impl`,
no trash) and is refused on any link that isn't detached. Active
*and* tombstoned (`hard_delete_would_resurrect`), because the cascade would take the
tombstone with the page and the next poll would resurrect the event. A **detached** page is
the only `page_sync`-bearing page it destroys, which is right: nothing upstream re-creates
it.

## 2. Schedule (non-recurring)

| Functionality | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Adjust page date | ✅ | 🚫 locked ⁴ | ✅ | ✅ `update --due` ¹⁰ | ○ |
| Adjust page time | ✅ | 🚫 locked ⁴ | ✅ | ✅ `--due` with a time ¹⁰ | ○ |
| Adjust duration (end) | ✅ | 🚫 locked ⁴ | ✅ | ✅ `--end` ¹⁰ | ○ |
| Clear the schedule | ✅ | 🚫 locked ⁴ | ✅ | 🚫 ¹⁰ | ○ |
| Drag block on calendar | ✅ | 🚫 locked ¹¹ | ✅ | — | ○ |
| Resize block on calendar | ✅ | 🚫 locked ¹¹ | ✅ | — | ○ |
| Drag page from list onto calendar | ✅ | 🚫 locked ¹² | ✅ | — | ○ |
| Set / change per-page reminder | ✅ timed only ¹³ | ✅ same ¹³ | ✅ same ¹³ | ⚠️ `reminders add` ¹³ | ○ |
| Reminder fires with no explicit lead set | ✅ global default ¹³ | ✅ same ¹³ | ✅ same ¹³ | — | ○ |
| Several leads on one page | ✅ each fires once ¹³ | ✅ same ¹³ | ✅ same ¹³ | — | ○ |
| Re-timing re-arms a reminder that already fired | ✅ ¹³ | 🚫 locked; upstream move re-arms ¹³ | ✅ page and override ¹³ | ✅ `update --due` ¹³ | ○ |
| Timezone semantics | floats (device-local) | ⚠️ timed absolute, all-day floats ¹⁴ | ⚠️ floats, converted at detach ¹⁵ | — | ○ |

¹⁰ Three flags, and none of them changes a page's shape by inference: `--due` moves it
(zero-padded date, or a full timed ISO), `--all-day` is the only way to drop an existing time,
and `--end` sets the end, on its own, to extend without moving. `resolve_schedule_change`
settles every refusal before the first write, so a partial update can't half-apply: an
unparseable value, an `--end` in the other shape or ahead of its start, `--end` alone on an
unscheduled page, `--all-day` with a time, `--due` with `--all-day`, and (the defect this
replaced) a bare date pointed at a timed page, which names both ways to say what was meant
instead of silently converting. A locked mirror or a recurring page is refused up front with a
surface-appropriate message. **Duration is the one thing still inferred:** a bare timed `--due`
shifts the end with the start, and a move within all-day keeps the span, because a drag in the
app keeps its length. Nothing clears a schedule.
¹¹ `useTimedDrag` / `useTimedResize` / `useAllDayDrag` short-circuit on `scheduleLocked`, and
`PageBlock` also suppresses the grab/resize *affordances* so the cursor never advertises a move
that can't happen (`PageBlock.tsx`).
¹² Synced pages *are* in a page list: their calendar folder's, plus search and Today. The
list-to-calendar drag and the Today-nav drop both filter locked pages through
`useThreePanelDnD`'s `unlockedIds` before calling `scheduleOnce`, and the ghost preview is
suppressed for a locked drag so no drop is advertised. A mixed multi-select still schedules its
unlocked members. A detached page schedules normally.
¹³ Reminders are user-owned and stay editable on every **timed** synced event, one-off and
recurring alike (`MetadataHeader.tsx` and `PageBlockPopover`, both gated on `isTimedIso`
alone). An all-day event takes the day-before lead instead, on every origin. See §3. The CLI
writes reminders through `reminders add / rm`, which take a raw minutes value and apply none of
the timed-only gate the UI does: a lead written onto an all-day page is a row no query will
ever serve. Lead selection is origin-blind: explicit reminder if the page has one, global
default otherwise, silent on the `-1` "never" sentinel, the same on every origin. Provider
alarms are never ingested.

Three firing behaviors are worth knowing about, because none of them is visible from the
page that produced them. **No explicit lead** is the common case, not an edge one. A
page with zero `page_reminders` rows still reminds, at the global default; the query serving
it differs by origin (device-local for native, detached and *zone-less* synced; absolute for
a zoned mirror), so it needs checking on each. **Several leads** on one page each fire in
their own tick. Dedup is per-(schedule, lead), so a per-schedule key would let the earliest
lead swallow the rest. **Re-timing** clears the fired anchor so the reminder arms again at
the new time. Every gesture that moves an event: drag, popover re-pick, `pikos update --due`,
moving one occurrence of a detached series, and a provider-side time edit (§9). A live mirror
can't be moved from Pikos at all (⁴), so its only re-arm path is upstream.
¹⁴ Only a *timed* synced event is absolute. An all-day one carries `timezone: None` from both
providers (`caldav/ics.rs`, `google/events.rs`), since a date has no meaningful zone, so it
floats exactly like a native all-day page and every viewer sees the same date. §3.
¹⁵ Detaching spends the source-zone stamp rather than dropping it: `detach_sync` rewrites every
stored wall-clock (base, override rows, the denorm) into the device zone and clears the stamp,
so the page keeps the instant it was rendered at and floats natively from there. Display and
the naive reminder paths, which a detached page falls back to since they exclude only
*active*-synced rows, are then right by construction. **One refusal:** a recurring series whose
base conversion crosses midnight keeps its raw wall-clock, because the shifted date would
invalidate `completed_set`, `skip_set`, `rrule_exdates` and each override's `original_date`
while the rule's BYDAY named the old weekday. Needs a non-local calendar *and* a start within
the zone offset of midnight.

## 3. All-day pages

An all-day page is one whose `scheduled_start` is **date-only** (`YYYY-MM-DD`). Shape is the
discriminator everywhere. `isAllDayIso` (`packages/core/src/utils/dates.ts`); there's no
flag column. Ends are stored **inclusive**: the last day the event covers. All-day is
orthogonal to origin *and* to recurrence, so every row here stacks on top of §1–§2.

| Functionality | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Create as all-day | ✅ click / drag the all-day strip ¹⁶ | 🚫 ¹ | 🚫 ¹ | ✅ date-only NL date ¹⁷ | ○ |
| Convert timed ↔ all-day | ✅ date picker ¹⁸ | 🚫 locked ⁴ | ✅ | ✅ `--all-day` / a timed `--due` ¹⁰ ¹⁷ | ○ |
| Multi-day span | ✅ | ✅ | ✅ | ✅ `add`, or `update --end` ¹⁷ | ○ |
| Drag across days | ✅ | 🚫 locked ¹⁹ | ✅ | — | ○ |
| Edge-resize the span | ⚠️ not while recurring ²⁰ | 🚫 locked ¹⁹ | ⚠️ same ²⁰ | — | ○ |
| Extend past the week edge | ⚠️ popover only ²⁰ | 🚫 locked ¹⁹ | ⚠️ same ²⁰ | — | ○ |
| Stored end convention | inclusive | inclusive; provider's exclusive end decremented once ²¹ | inclusive, frozen at detach | inclusive | ○ |
| Timezone semantics | floats | floats ¹⁴ ²² | floats | floats ²² | ○ |
| Set / change per-page reminder | ✅ day-before lead only ²³ | ✅ same | ✅ same | ⚠️ `add` only ²³ | ○ |
| Counted in the daily summary | ✅ ²⁴ | ✅ ²⁴ | ✅ ²⁴ | — | ○ |
| Overdue / Today classification | ✅ date compare ²⁵ | ✅ same | ✅ same | ✅ same | ○ |
| Recurring all-day series | ✅ one bar per day ²⁶ | ✅ same | ✅ same | — | ○ |

¹⁶ A click in the all-day strip creates a single-day page; a drag across columns creates a span
(`useAllDayCreate`). Quick Add with a date-only date does the same.
¹⁷ `cmd_add` passes the parser's `scheduled_start` / `scheduled_end` through untouched
(`main.rs`), so a date-only NL date ("friday") yields an all-day page and a range ("from Mon to
Fri") yields a multi-day span (`parser.ts`). `pikos add` can therefore produce **either**
shape. `update` reaches both too, but only when asked: `--all-day` drops a time (and with it a
timed end, which an all-day page can't hold), a timed `--due` collapses an all-day span to that
instant, and `--end` builds or edits a span in whichever shape the page already is. The app's
own transition table (¹⁸) keeps the date extent across timed → all-day where the CLI clears it;
the CLI's flag *is* the request, so it does what it was told and nothing more.
¹⁸ `computeScheduleTransition` (`shared/utils/schedule.ts`) owns all four transitions: all-day
→ timed collapses to a single day; timed → all-day keeps the date extent and drops the time.
¹⁹ Same lock as timed. `useAllDayDrag` short-circuits on `scheduleLocked` for both move and
edge-resize, and `AllDayBar` suppresses the affordances so the cursor never advertises them
(`AllDayBar.tsx`).
²⁰ Edge handles are hidden on a **recurring** bar (native included, not just locked) and on a
continuation boundary, so a span crossing out of the visible week has no handle on that side.
Extending it goes through the popover's date picker (`AllDayBar.tsx`).
²¹ Providers send an **exclusive** end (`DTEND` / `end.date`); the reconciler decrements it
exactly once and is the single owner of that conversion. Stored ends re-enter the reconciler
raw, so the two directions are separate constructors: `InclusiveEnd::from_provider` decrements,
`InclusiveEnd::from_stored` cannot (`reconciler.rs`, `mod allday_end`). A double decrement,
which silently shortens every multi-day span by a day, is now a missing method rather than a
reachable path.
²² All-day floats regardless of the stored `timezone` column: the renderer branches on the
date-only *shape* (`isAllDayIso` → `parse(iso, "yyyy-MM-dd")`, `dates.ts`) and never reads the
zone. The CLI stamps `local_tz()` on every schedule it writes, all-day included (`main.rs`); it
has no effect on display.
²³ An all-day page carries exactly one reminder shape: the `-2` sentinel, "the day before at
09:00 local", which `due_day_before_reminders` resolves against the event's *date*.
Minutes-before leads stay excluded on every origin. `due_explicit_reminders` skips date-only
starts, since "N minutes before" would land at midnight-minus-N. `ReminderDropdown` therefore
swaps its whole option list in all-day mode rather than filtering the timed one, so the only
offer is the one that can fire. The CLI reaches the sentinel through `pikos add`'s parser but
not through `reminders add`, which refuses anything below `-1` on the grounds that a hand-typed
`-2` is likelier a typo than the sentinel.
²⁴ The daily summary counts all-day pages alongside timed ones (`scheduler.rs`). The only
notification an all-day page can produce.
²⁵ Overdue is a date-string compare against today (`scheduled_start < todayStr`,
`pageFilters.ts`), not an instant compare: an all-day page stays in Today until the date rolls
over, where a timed one goes overdue at its start time.
²⁶ A recurring all-day series renders one bar per occurrence day rather than collapsing into a
span, because virtual occurrences share the head's page id (`allDayLayout.ts`). Dragging one
passes `originalDate`, so it keys an override exactly like a timed virtual (§6).

## 4. Recurrence rule (the series itself)

| Functionality | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Add a recurrence rule | ✅ | 🚫 calendar-owned ²⁷ | ✅ | ✅ `add` NL ²⁸ | ○ |
| Edit cadence (freq/interval/weekdays) | ✅ | 🚫 ²⁷ read-only label | ⚠️ ²⁹ | — | ○ |
| Remove the rule | ✅ | 🚫 calendar-owned ²⁷ | ✅ | — | ○ |
| Rule source of truth | user | provider (wholesale rewrite each sync) | frozen at detach | user | ○ |
| Head derivation | `oldest_open_occurrence` | `oldest_open_occurrence` ³⁰ | same | same | ○ |

²⁷ `ensure_rule_row_unlocked` (`crates/pikos-db/src/schedules.rs`) guards update / delete rule
and both exdate paths. **Create is guarded separately**. It calls
`ensure_page_schedule_unlocked` on the page directly, because the rule row it would look up
doesn't exist yet. Same outcome, different guard. The editor byline and calendar popover render
the cadence as a read-only label.
²⁸ Recurring NL input creates rule + anchor in one go (`cmd_add`, `ParseResult::Recurring`).
The CLI cannot edit or remove a rule afterwards.
²⁹ Editable once unlocked, **except** a rule that wouldn't survive the editor:
`rruleEditWouldDegrade` locks iff `buildRrule(parseRrule(r))` differs from `r` term by term, so
the lock is derived from the loss rather than from a list someone maintains.
`RecurrenceOptions` carries every term the engine enumerates, so what still locks is the tail
outside that envelope (BYWEEKNO, BYYEARDAY, sub-daily BY*), plus rules that don't parse.
**BYDAY ordinals ("3rd Tuesday"), BYMONTH ("15 March, annually"), BYMONTHDAY and BYSETPOS are
all editable**, and survive a freq-preserving edit (interval, end condition) intact; so is the
RFC's optional `+` on any ordinal, which the carrier drops without changing the rule. **End
condition:** compared, against the one form the editor rebuilds. Floating end-of-day. A
date-only UNTIL and a legacy `Z`-suffixed end-of-day one both collapse to it and stay editable,
so finite provider series don't all lock; a UNTIL at any other time-of-day is the provider's
own cut-off and **locks**, because rebuilding it as end-of-day would gain the final occurrence
it excluded. Rejected: excluding the end condition entirely (it made that gain silent), and
locking every timed UNTIL (would lock every rule the editor itself had already saved). The
residual is a non-conformant date-only UNTIL on a *timed* series, which gains that day's
occurrence; RFC 5545 pairs a date-only UNTIL with an all-day DTSTART, where it is lossless.
Locked or not, provider rules still *expand* correctly. A **freq change** still drops what the
new freq can't carry, by `optionsForFreq`'s whitelist. Including the BYDAY ordinal and BYMONTH,
which no frequency the editor offers can carry meaningfully. The head-drag realign
(`alignWeeklyRuleToAnchor`) consults the same lock and skips a locked rule rather than rebuild
it.
³⁰ Both kinds run the same `recompute_recurring_schedule`. For synced, the reconciler writes
the provider base as a **floor** then recomputes, so the head lands on oldest-open rather than
the raw base. The completed/skip sets survive a wholesale rule rewrite and push it forward.

## 5. The head page (materialized)

| Functionality | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Move the head (drag / date edit) | ⚠️ snaps to rule ³¹ | 🚫 locked ⁴ ¹¹ | ⚠️ ³¹ | 🚫 refused ¹⁰ ³¹ | ○ |
| Complete head, on time or future | ✅ fast path ³² | ✅ same command ³² | ✅ | ✅ `done` | ○ |
| Complete head, overdue | ✅ scope dialog ³³ | ✅ same dialog ³⁴ | ✅ same dialog | ⚠️ one occurrence, no prompt ³⁵ | ○ |
| … scope *Just this one* | ✅ head's own day; the rest stay open ³³ | ✅ same | ✅ | ✅ the only CLI behavior ³⁵ | ○ |
| … scope *This and everything before today* | ✅ a done clone per open day ³³ | ✅ same, bounded by the connect day ³⁴ | ✅ bounded the same ³⁴ | 🚫 ³⁵ | ○ |
| Uncomplete (uncheck a done clone) | ✅ ³⁶ | ✅ ³⁶ | ✅ | — | ○ |
| Delete the head | ✅ series stops ³⁷ | ⚠️ soft + tombstone ⁷ ³⁷ | ✅ ³⁷ | ✅ soft ⁹ ³⁷ | ○ |
| Restore the head | ✅ series returns ³⁸ | ✅ ³⁸ | ✅ | — | ○ |
| Terminal state (series exhausted) | ✅ head marked done, no clone | ✅ same, and **un-marked** if the provider re-extends | ✅ | ✅ | ○ |

³¹ The sets model can't represent a head parked on a date the rule can't yield, and the heal
would silently revert it on relaunch (decided 2026-07-03), so an off-pattern move lands on a
rule-valid date. Date edit and drag converge on the **same client-side snap**: the edit snaps
in the popover (`snapAnchorToRule`, also Quick Add); a head drag carries no `originalDate`, so
`handleReschedule` routes it to `PagesContext.scheduleOnce`, which snaps, and realigns a weekly
rule (`alignWeeklyRuleToAnchor`), before the optimistic update. Reading the drag hooks alone
suggests otherwise, since neither `useTimedDrag` nor `useAllDayDrag` calls the snap; the shared
commit path is where it happens. There is therefore no frame in which the block lands on the
wrong day. The backend `recompute_recurring_schedule` stays the backstop for what the client
snap can't resolve. A date the rule yields but the skip-set excludes. A detached series moves
like a native one. The CLI refuses `--due` on a recurring page outright ("move the series in
the Pikos app"). The old silently-inert anchor-row write is gone.
³² One command for both kinds (`complete_recurring_page_impl`): done clone at the occurrence +
`completed_set` entry + recompute. No head-advance, no EXDATE merge. Native derives the
occurrence from the head server-side; **synced passes the client-rendered occurrence**,
validated against the raw rule (`synced_occurrence_is_valid`, `pages.rs`).
³³ Open occurrences before today open `RecurringGapDialog`, which asks scope only: *Just this
one* resolves the gestured occurrence and leaves the rest open; *This and everything before
today* completes each open day as its own done clone, repeating the ordinary single completion
until the head reaches today. Nothing goes to the skip-set. Dismissal is the delete gesture's
(§6). **The backlog is what summons it**: no open day before today, or a gesture on today's/a
future occurrence, and the tick commits with no dialog at all. Which occurrence a gesture names
differs by origin, and that's the whole native/synced split. Native funnels every tick to its
head, so only the head can open this; a synced series opens it from the head, a virtual, or a
moved block, each naming its own date (§6).
³⁴ The same dialog as native, on purpose: a synced head floors at the **connect day**
(`synced_head_floor`), so an occurrence that passed while the user was away is a genuine missed
occurrence rather than provider history. A head tick names its own occurrence, a rendered
occurrence names itself; `completeRecurringPage` then supplies the occurrence date and
zone-converted wall-clocks that a locked head needs (the reconciler pins
`pages.scheduled_start` at the base, so the backend can't derive them). Occurrences from before
the connect day sit below the floor. The backfill fetches them, but the render floor
(`syncedSince`) keeps them off the calendar and they never open a freshly connected series as
overdue.
³⁵ `pikos done` completes one occurrence and never asks about a backlog. The scope question is
the app's. On an **active-synced** recurring page it refuses outright with "complete it in the
Pikos app" (`main.rs`). The CLI has no expansion engine to name the occurrence.
³⁶ Drops the `completed_set` entry, deletes the clone via its back-link, un-marks a `done`
head, recomputes. **Pre-0.4.0 native completions have no back-link and are not uncompletable**.
Stated boundary, not a regression.
³⁷ Deleting the head stops the series: no virtuals render. Existing done clones and detached
clones survive as history. Never cascade-deleted.
³⁸ Restore re-derives from the preserved completed/skip sets (they are keyed by `page_id` and
survive soft-delete). Skipped for an active-synced head, whose cache is reconciler-owned.

## 6. A single occurrence

| Functionality | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Render a virtual occurrence | ✅ repeat glyph, no checkbox | ✅ checkbox | ✅ checkbox | — no expansion; real rows only | ○ |
| Open a virtual occurrence | ✅ opens the head | ✅ | ✅ | — | ○ |
| Delete a single virtual | ✅ skip-set + undo toast ³⁹ | ✅ skip-set survives sync ³⁹ | ✅ | — | ○ |
| Delete an occurrence with a backlog behind it | ✅ scope dialog ³⁹ | ✅ same, copy reads local-only ³⁹ | ✅ plain delete copy ³⁹ | — | ○ |
| … scope *Just this one* | ✅ that date to the skip-set | ✅ same | ✅ | — | ○ |
| … scope *This and everything before today* | ✅ every open day to the skip-set, no clones ³⁹ | ✅ same, bounded by the connect day ³⁴ | ✅ bounded the same ³⁴ | — | ○ |
| Move a single virtual | ✅ detached clone ⁴⁰ | 🚫 locked ⁴¹ | ✅ mints an override ⁴² | — | ○ |
| Complete a single virtual | 🚫 head-only ⁴³ | ✅ that occurrence ⁴³ | ✅ ⁴³ | — | ○ |
| Tick an occurrence with a backlog behind it | — head-only ⁴³ | ✅ the same scope dialog ³³ ⁴³ | ✅ ⁴³ | — | ○ |
| Render a materialized override | — synced series only ⁴⁴ | ✅ locked block at the moved slot ⁴² | ✅ same block, unlocked ⁴² | — | ○ |
| Move a materialized override | — synced series only ⁴⁴ | 🚫 provider-owned | ✅ moves the row in place ⁴² | — | ○ |
| Delete a materialized override | — synced series only ⁴⁴ | ✅ skip-set, series intact ³⁹ | ✅ same ³⁹ | — | ○ |
| Complete a materialized override | — synced series only ⁴⁴ | ✅ keyed on `original_date` ⁴² | ✅ same key ⁴² | — | ○ |
| Re-link after moving a detached override | — | — | ⚠️ provider's time wins ⁴² | — | ○ |
| Move / complete / delete a done clone | ✅ independent | ✅ independent (native page) | ✅ | ✅ ⁹ | ○ |
| Per-occurrence reminder fires (lead, multi-lead, re-arm: §2 ¹³) | ✅ device-local wall-clock | ✅ source-zone → absolute | ⚠️ device-local ¹⁵ | — | ○ |
| Per-occurrence body / notes | 🚫 body is series-wide ⁴⁵ | 🚫 same | 🚫 same | — | ○ |

³⁹ Dismissals go to `skip_set`, **not** rule EXDATEs. That's what makes a synced dismissal
survive a wholesale provider rule rewrite: the reconciler never writes the skip-set
(`pages.rs`). With open occurrences before today behind it, the gesture opens
`RecurringGapDialog` for scope: *Just this one*, or *This and everything before today*, which
writes the whole backlog to the skip-set. That arm is where "not doing these" lives now;
completion never dismisses anything (§5 ³³). A moved occurrence deletes on the same path, keyed
to its `original_date`, so the block that reads as one event can't take the whole series with
it. The popover is shaped from the series page, and a page-level delete there trashed every
occurrence. On an active mirror the copy reads local-only ("Remove from Pikos"): read-first,
nothing is written upstream.
⁴⁰ Spawns an independent real page at the new time and EXDATEs the original date, in one
transaction. Re-homing this to a `page_schedules` override is deliberately deferred past 0.4.0,
except a **detached** series, which materializes an override row instead; native keeps the
clone.
⁴¹ Blocked at the backend (`reschedule_virtual_occurrence_impl` → `ensure_rule_row_unlocked`)
and unreachable from the UI: `VirtualPageBlockPopover` renders the synced schedule as a
read-only label when the series is locked, matching `PageBlockPopover`. Drag and resize on the
same block are suppressed too (§2 ¹¹).
⁴² A moved synced instance renders as a real, completable block (checkbox + sync icon),
deliberately **not** a `VirtualOccurrence`, carrying the page's own lock state. Checking it
records the **original** occurrence date, so it agrees with the reminder derivation
(`useRecurrenceExpansion.ts`). The block is gated on sync *origin* (`syncState`), not on the
lock, since only a synced series has override rows at all. Gating on the lock erased a
**detached** series' moved instance from the calendar entirely, because the original slot
stays suppressed either way. A detached override therefore
renders unlocked, completes on the same key, and fires its reminder on the native
device-local path (detach floats the row via `float_wall_clock`).

**Moving any occurrence of a detached series writes an override row**. The provider's own
already exists and moves in place, a plain virtual mints one. `original_date` is preserved
either way, so a later re-link reclaims the occurrence and **overwrites the user's time with
the provider's**. The mirror wins; that is the read-only invariant, not a bug. Cloning instead
would leave the occurrence to be re-mirrored *beside* the clone: one occurrence, two blocks,
permanently, which is why the plain-virtual half stopped cloning too (the arm is chosen by sync
*origin*, not by whether a row happens to exist). A native series has no upstream to reclaim
the date, so it keeps clone + EXDATE and the occurrence leaves the series for good.
⁴³ The checkbox follows sync **origin** (`useRecurringActions.showsCheckbox`). A synced-origin
virtual, active or detached, renders one and completes that instance: the event may be a
birthday rather than a meeting, so "done" means resolved, and the record belongs to the day it
names. Its popover carries the matching Status row. A **native** virtual keeps the repeat glyph
and no checkbox: a task series funnels to its head, which is the next thing due. To complete a
specific future native occurrence, materialize it first, then complete the resulting real page.
⁴⁴ Override rows exist only on synced series, whichever side authored them. A native move
produces a clone + EXDATE instead. Why, and what a re-link does to them: ⁴² above.
⁴⁵ Content lives on the head and applies to every occurrence. Per-occurrence notes happen
naturally: write in the head before completing, and the clone captures them.

## 7. External-calendar folders

| Functionality | Regular folder | External-calendar folder | CLI | Mobile |
| --- | --- | --- | --- | --- |
| Create | ✅ | 🚫 sync enable path only | ✅ `folders create` | ○ |
| Rename | ✅ | 🚫 sync-owned, follows the calendar ⁴⁶ | — | ○ |
| Recolor | ✅ | ✅ Pikos palette, user pick wins ⁴⁷ | — | ○ |
| Reparent / nest | ✅ | 🚫 both directions ⁴⁸ | — | ○ |
| Delete | ✅ | 🚫 disconnect in settings ⁴⁸ | — | ○ |
| Enable / disable (per-calendar) | — | ⚠️ sync teardown, not hide ⁴⁹ | — | ○ |
| Default page-list sort | ✅ manual | ⚠️ date ⁵⁰ | — | ○ |
| Grouped under an account heading | — | ✅ with >1 account ⁵¹ | — | ○ |

⁴⁶ The sidebar item offers no rename. Sync owns the name end to end. Every re-discovery
reconciles the folder to `sync_calendar.display_name` (`upsert_sync_calendar_impl` →
`reconcile_folder_to_calendar`, guarded so an unchanged pass doesn't churn `updated_at`), and
the re-enable arm re-asserts it onto the folder it reclaims. `update_folder_impl` still doesn't
guard the name, so a programmatic rename lands. It is simply reverted on the next pass.
⁴⁷ Provider colors are mapped into the Pikos palette on discovery, not inherited raw
(`nearest_palette_color`; per-provider default when the source is achromatic). Sync keeps
following the provider's color until the user picks one from either surface (the sidebar
context menu or the Calendar Sync panel row), after which `color_user_set` latches and
re-discovery leaves it alone. **Both surfaces write `sync_calendar.color`**; the folder's
column is a derived copy, so they cannot show different colors.
⁴⁸ `EXTERNAL_FOLDER_LOCKED_MSG`: "use the Calendar Sync settings to disconnect"
(`crates/pikos-db/src/folders.rs`). Color stays editable.
⁴⁹ The Calendar Sync panel's per-calendar switch **enables/disables the sync itself. It is not
a visibility toggle**. Disable runs a full teardown (`disable_sync_calendar` →
`teardown_calendar`): bare mirrors are hard-deleted, owned pages detach in place, the sync
cursor clears. The folder is deleted only when nothing survives; with owned survivors it's
**de-flagged and stays in the sidebar as a regular folder**. Re-enable backfills fresh.
Owned pages re-link by `ical_uid`, bare mirrors are recreated under new page ids. Both
directions confirm: turning **off** always asks, since it always deletes something; turning
**on** asks only when detached pages are waiting to be reclaimed. Ruled 2026-08-16.
Per-calendar *hide* stays unbuilt, and the off-confirm is what stops the switch reading as
one (`matrix-intent-review.md` §fourth round).
⁵⁰ An external folder's page list defaults to date order (`useActiveSortMode`). A calendar
mirror is chronology, not a hand-arranged list. A stored per-view sort choice always wins, and
native folders keep manual.
⁵¹ With calendars from more than one account, the sidebar groups them under per-account
headings (`useCalendarAccountGroups`); a single account renders headingless, and the heading
disappears again when a disconnect leaves one. Same-named calendars on different accounts stay
distinct. Rows are keyed by folder id, headed by account.

## 8. Cross-cutting surfaces

| Functionality | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Full-text search | ✅ | ✅ ⁵² | ✅ | ✅ `search` | ○ |
| Today / Inbox views | ✅ | ✅ ⁵³ | ✅ | ✅ `today` / `list` ⁵⁴ | ○ |
| Page linking (`[[`) + backlinks | ○ ⁵⁵ | ○ ⁵⁵ | ○ ⁵⁵ | — | ○ |
| Markdown / CSV / SQLite export | ✅ ⁵⁶ | ✅ ⁵⁶ | ✅ ⁵⁶ | — | ○ |
| Import (Markdown / CSV) | ⚠️ ⁵⁷ | — ¹ | — | — | ○ |
| Daily summary notification | ✅ ⁵⁸ | ✅ same | ✅ same | — | ○ |
| Quiet hours suppress a reminder | ✅ dropped, not deferred ⁵⁸ | ✅ same | ✅ same | — | ○ |
| A fired reminder doesn't fire twice | ✅ ¹³ | ✅ ¹³ | ✅ ¹³ | — | ○ |
| Trash view: list, restore, empty now | ✅ ⁵⁹ | ⚠️ restore resumes sync ⁷ | ⚠️ ⁵⁹ | ⚠️ `restore` only | ○ |
| 30-day trash sweep | ✅ destroyed | ⚠️ kept, by design ⁵⁹ | ⚠️ kept, unintended ⁵⁹ | — | ○ |
| Search operators (`tag:` `folder:` `is:` `priority:` `due:`) | ✅ ⁶⁰ | ✅ ⁶⁰ | ✅ ⁶⁰ | ⚠️ flags, not operators ⁶⁰ | ○ |
| Command palette (`>` prefix) | ✅ ⁶¹ | — ⁶¹ | — ⁶¹ | — | ○ |
| Upcoming view (next 7 days, grouped) | ✅ | ✅ | ✅ | — | ○ |
| Move overdue → today (bulk) | ✅ | 🚫 locked ⁶² | ✅ | — | ○ |
| Month view | ✅ | ✅ | ✅ | — | ○ |
| `.ics` calendar export | ✅ ⁶³ | ✅ ⁶³ | ✅ ⁶³ | — | ○ |
| Notification history panel | ✅ ⁶⁴ | ✅ ⁶⁴ | ✅ ⁶⁴ | — | ○ |
| Notification click opens its page | ✅ ⁶⁵ | ✅ ⁶⁵ | ✅ ⁶⁵ | — | ○ |
| Day-before reminder lead (all-day) | ✅ ⁶⁶ | ✅ ⁶⁶ | ✅ ⁶⁶ | ✅ `add` ⁶⁶ | ○ |
| Focus timer on a page | ✅ ⁶⁷ | ✅ ⁶⁷ | ✅ ⁶⁷ | — | ○ |
| MCP tool surface (`pikos mcp`) | ✅ ⁶⁸ | ✅ same guards ⁶⁸ | ✅ ⁶⁸ | ✅ `mcp` ⁶⁸ | ○ |

⁵² Synced events are real pages, so they flow through `pages_fts` automatically. No origin
filtering anywhere in `search_pages_impl`; trashed pages never appear. A series' done clones
are `status = 'done'`, so extra same-title copies surface only under "Show completed". A
mirror's calendar-owned metadata is indexed too: the room and the attendee list live on
`page_sync`, so the reconciler projects them into `pages.mirror_search_text`. One column for
all of it, so a third field is a projection change and not a migration. Weighted like tags. The
projection is written only where the `page_sync` mirror columns are, and cleared where the link
is dropped without the page. A hit that lands only there quotes the projection as the row's
excerpt, so it highlights like a body match; the room and the attendees share one field, so a
hit carries its neighbours onto the row with it. Matching is FTS5 tokens, not substrings: the
query splits on runs of non-alphanumerics, the tokens are ANDed, and only the **last** one is a
prefix. So "meet ro" finds "meeting room" and "eeting" finds nothing. The affordance is
finish-the-word, not find-anywhere. The body column is the extracted `content_text`, never the
editor's stored JSON, so a query can't collide with mark-up. Ranking is bm25 over the five
columns at title 10, subtitle 5, tags 3, mirror metadata 3, body 1; 20 rows come back, and
completed matches are counted even when they're excluded, which is what lets "Show completed"
advertise a number before you ask.
⁵³ The Today predicate (`belongsToView`: `scheduledStart ≤ today`, open only) is origin-blind:
a past *synced one-off* stays until ticked, agreeing with the daily summary's `overdue_count`.
A synced *series* is listed at today's occurrence whenever it has one, so a series nobody has
ticked since the calendar was connected reads as today's meeting rather than as weeks overdue,
and the tick lands on the date shown. It stays one row: today's occurrence replaces the head's,
never joins it, and the days behind it are on the calendar rather than in the list. A native
series keeps funnelling to its head, which is the next thing due. Synced pages never appear in
Inbox: the reconciler always assigns their calendar folder.
⁵⁴ `pikos today` (`list_pages_today_impl`) computes the local day in Rust and reads the `pages`
denorm. Both halves of its old disagreement with the app (UTC day boundary; the never-advancing
`page_schedules` anchor join) are gone, as is the app's past-synced-one-off carve-out (⁵³). The
same set still reaches both, with one difference in what a row is dated: the denorm holds the
head, so a lapsed synced series prints its head's date here while the app shows it at today's
occurrence (⁵³). `pikos list --due` was always denorm-based.
⁵⁵ Not built. `pages.links` is a write-through JSON column nothing populates or renders;
there's no `[[` editor affordance and no backlink computation anywhere (the only Tiptap link
extension is external URLs). Markdown import preserves `[[wikilinks]]` as plain text.
⁵⁶ The UI's three exports are Markdown, **CSV** and a SQLite backup. A JSON export command
exists in Rust with no UI caller and takes no origin filter. Markdown/CSV read `pages` minus
trash (done included) and drop a live mirror the user never actioned, on the same ownership
predicate teardown uses (`sync::PAGE_OWNED_SQL`); an off-by-default "include synced calendar
events" toggle, shown only once a calendar folder exists, brings them back. Owned and detached
pages export either way, with no origin marker; a recurring series is one row, so it exports as
its head. The SQLite backup is `VACUUM INTO`: a full file copy including trash and the sync
bookkeeping tables (`page_sync`, cursors; credentials stay in the OS keychain, never in the
DB).
⁵⁷ Import matches folders **by name** but skips external-calendar folders when reusing
(`ImportProvider`): a vault folder named like a synced calendar gets a sibling *regular* folder
with the same name (names carry no UNIQUE constraint) and the batch survives.
⁵⁸ Both summary counts enumerate a recurring page's rule over their window rather than reading
`pages.scheduled_start`, so a series whose head lapsed days ago still counts on each day it
yields. Skipped, completed, EXDATE'd and moved-away occurrences are excluded; a moved instance
counts at its new date off its override row; a synced series floors at its connect day; the
stale pre-rule anchor row counts for neither. `overdue_count` counts any open timed page from
the last 24 h regardless of origin.

The two notifications treat a quiet window differently, which is why they are separate rows.
The **summary defers**. `should_fire_daily_summary` returns false while quiet and fires on
the first non-quiet tick after `summaryTime`, so a daytime focus block delays it rather than
losing it. A **per-reminder notification is dropped**: the tick returns before any `due_*`
query runs, and nothing catches up afterwards, because a fire instant is only ever matched
inside its own 60-second window. So an event whose lead lands inside quiet hours produces no
notification at all. It is no longer traceless, though: migration 012 admits
`notification_log.type = 'suppressed'`, and the tick writes one of those rows so the history
panel can render "silenced by quiet hours". Previously "why didn't Pikos tell me?" had no
answer anywhere in the app. The vocabulary sits in `type` rather than `action` because
`action` records what the *user* did with a notification and nothing was delivered to act on;
keeping them apart also leaves every dedup predicate (all of which read `type = 'reminder'`)
matching exactly the rows it matched before, so suppression stays bookkeeping and not a
re-timing. Both halves still precede every query, so origin can't enter into it; no dedup row
is written either, leaving the reminder armed if the event is later moved to a non-quiet time.

⁵⁹ The trash is a view in the page-list column, not a dialog: restoring several pages one at a
time is the normal case, and a modal makes that a sequence of reopenings. It is a smart view
id, so nothing can file a page into it. **Restore re-homes a page whose folder is still
deleted.** Deleting a folder soft-deletes its pages, so restoring one alone used to return it
to a folder that was itself in the trash: not in the Inbox (`folder_id` was set), not in any
listed folder, and the page came back invisible. It now clears `folder_id`, which is also what
the trash row already displayed, since that list resolves the folder name through a subquery
that skips deleted folders. Active mirrors keep their folder: the reconciler owns their
placement.

The 30-day sweep (`purge_trashed_pages_older_than`) routes every eligible row through
`delete_page_impl` rather than issuing its own `DELETE`, so the trash inherits that path's
sync divert and the sweep reports how many rows it declined. An **active mirror is kept on
purpose**: destroying it would take its `page_sync` row by FK cascade, and with it the
tombstone suppressing the upstream event, so the next poll would re-create the page the user
deleted. A **detached page is kept by accident**. `delete_page_impl` diverts on
`EXISTS(page_sync …)`, any link row, while `sync::hard_delete_would_resurrect` reads
`sync_state <> 'detached'` and would let it go. The two predicates disagree and the broader
one is the one the sweep reaches, so detached pages never leave the trash.
⁶⁰ Operators parse in `@pikos/core` and narrow the same `PageFilter` the adapter already takes,
so they compose with the free-text term rather than replacing it, and every origin is matched
identically. `is:` reads status, never sync state. The CLI reaches the same filter through
**flags** (`--tag`, `--priority`, `--folder`), not the operator grammar: the operators are a
palette-input affordance, and `list` had typed flags before they existed.
⁶¹ A leading `>` switches the palette from searching pages to running commands; the command
list is derived from the keyboard registry, so a shortcut and its palette entry cannot drift.
Commands act on the app, not on a page, so the origin columns don't apply.
⁶² `planMoveOverdueToToday` skips a locked (active-synced) page and a recurring one before
building the plan, counting each as `syncedKept` / `recurringKept` so the confirmation names
what it will not touch. The skip is deliberate, not a failed write. A synced page's schedule is
calendar-owned, and a recurring head advances by its own rule.
⁶³ The `.ics` export shares `fetch_export_pages` with the CSV and Markdown exports, so it takes
the same `include_synced` toggle and the same ownership predicate (⁵⁶). A live mirror the user
never actioned is omitted unless the toggle is on. `VTIMEZONE` blocks are emitted for the zones
actually used, probed from the device zone rather than assumed.
⁶⁴ The history panel reads `notification_log` newest-first across every type, which the dedup
index cannot serve (it leads with `schedule_id`), so migration 012 adds
`idx_notif_log_fired_at`. Origin never enters: the log keys on `page_id` / `schedule_id`.
⁶⁵ **macOS only.** `tauri-plugin-notification` exposes no desktop click callback at all, so
Linux and Windows reminders stay one-way; macOS works because Pikos already bypasses the plugin
there and its `UNUserNotificationCenter` delegate gets a real click callback. Routing is
durable rather than in-memory. The OS notification identifier *is* the `notification_log` row
id, so a banner left overnight still opens the right page after a restart.
⁶⁶ Migration 012 widens `page_reminders.minutes_before` to admit `-2` beside 007's `-1`. Both
are anchor sentinels, not lead times: `-1` is "never remind for this page", `-2` is "the day
before, at 09:00 local". An all-day page has no start time for a minutes-before number to lead
off, so the scheduler resolves `-2` against the event's *date*. One row shape serves the UI,
the adapters, the CSV round-trip and the mock twin; a second column would have made every one
of them branch. The calendar popover now offers the lead on all-day pages, synced included.
⁶⁷ First writer for the `focus_sessions` table, which the schema carried unused. A session is
keyed by page id only, so origin is irrelevant. Timing a mirror is a Pikos-side annotation and
never touches the calendar-owned schedule.

## 9. Upstream events & sync accounts

Added 2026-08-08. §1–§8 are user gestures; this section is the other direction. What the
reconciler does when the *provider* changes something, and the account-level operations in
the Calendar Sync panel. Origin columns don't fit account ops, so that table is per
provider.

| Upstream event arrives | Native | Synced | Detached | CLI | Mobile |
| --- | --- | --- | --- | --- | --- |
| Edit (title / time / location) | — | ✅ mirror updates in place ⁶⁹ | — frozen ⁷⁰ | — | ○ |
| Rewrite of a series' rule | — | ✅ completed/skip sets survive ⁷¹ | — ⁷⁰ | — | ○ |
| Cancel of one instance | — | ✅ EXDATE — the slot empties ⁷² | — ⁷⁰ | — | ○ |
| Delete of the event / series | — | ⚠️ detach if owned, else hard-delete ⁷² | — ⁷⁰ | — | ○ |
| Description change | — | ⚠️ silent refresh vs notice ⁷³ | — ⁷⁰ | — | ○ |

⁶⁸ `pikos mcp` speaks Model Context Protocol on stdio so an agent can drive the workspace:
search / read / list / create / update pages, set status, complete, delete, restore, plus
reminders and folders. Every tool routes through the same `pikos-db` writer the CLI and the
desktop share, so the origin guards hold unchanged. An agent can no more retitle a live mirror
than the editor can. It is the CLI's surface rather than a second one: no recurrence expansion,
no notification runtime.
⁶⁹ Reconciler-only, mirror fields only. Body, tags and reminders are user-layer and never
touched. A poll with an unchanged etag writes nothing at all (no `updated_at` churn).
⁷⁰ A detached page is no longer tracked: nothing updates it until a calendar re-enable re-links
it by `ical_uid`, and then the provider's values win, which the re-enable toggle confirms first
when the calendar has detached pages waiting.
⁷¹ The rule is calendar-owned and rewritten wholesale; completions and skips live in Pikos-side
sets keyed by page, so they survive. On a Google master-only delta, stored exdates and override
rows carry across only while the pattern is unchanged. A pattern change drops them deliberately
(they key to dates the old rule yielded).
⁷² The wire shape is identical for "one instance cancelled" and "event deleted"; the recurrence
ref discriminates (`RECURRENCE-ID` / `recurringEventId` present → EXDATE on the series; absent
→ lifecycle removal). Ownership = completed, `user_modified`, or user content: owned detaches
in place, a bare mirror hard-deletes.
⁷³ A seeded body the user never edited refreshes silently (hash match on `content_text`); an
edited one gets a "calendar description changed" notice, the new text parked in
`pending_description`. Never overwritten. The notice resolves two ways, both clearing the
column via `clear_pending_description`: **Append** adds the parked text to the end of the body
through the editor's own insert path, **Dismiss** drops it. There is deliberately no replace
action, and dismiss is final. The next upstream change raises a fresh notice (ruled 2026-08-16,
`matrix-intent-review.md` §fourth round). Neither re-seeds `seeded_description_hash`: resolving
a notice is not a re-seed, and re-stamping it would make the *following* change overwrite the
body silently.

| Account operation | CalDAV | Google | Mobile |
| --- | --- | --- | --- |
| Connect | ✅ app password; discovery validates first | ✅ OAuth PKCE loopback ⁷⁴ | ○ |
| Reconnect the same account | ✅ reuses the row, re-links dormant pages ⁷⁵ | ✅ same ⁷⁵ | ○ |
| Disconnect | ⚠️ teardown per calendar, then dormant ⁷⁶ | ⚠️ same + token revoke ⁷⁶ | ○ |
| Manual resync ("Resync now") | ✅ incremental poll from the stored cursor ⁷⁷ | ✅ same; `410 Gone` → full re-enumerate | ○ |
| Full refresh ("Refresh from calendar") | ✅ re-enumerates + re-arms the deletion sweep ⁷⁷ | ⚠️ re-enumerates, sweep stays disarmed ⁷⁷ | ○ |
| Credentials expire / rotate | ⚠️ reconnect badge, polling stops ⁷⁸ | ⚠️ same ⁷⁸ | ○ |
| Offline / unreachable | ✅ stale dot, cursor kept, retries | ✅ same; rate limits map here too | ○ |
| Delete all data | ✅ keychain cleared, dormant swept | ✅ same + grant revoked ⁷⁹ | ○ |

⁷⁴ Needs build-time client credentials (`option_env!`). Without them the Google option is
disabled with "Not available in this build". Google's granular consent can withhold a scope;
connect then fails with "scopes withheld" rather than syncing empty calendars.
⁷⁵ Identity is `provider` + `display_name` (CalDAV's derived from username + host; Google's is
the primary calendar id, i.e. the signed-in email). Matching prefers a live row, so
reconnecting an active account reuses it instead of duplicating (Google's constant fallback
name can collide).
⁷⁶ Disconnect runs the per-calendar teardown (⁴⁹: mirrors delete, owned pages detach, folder
de-flags or deletes), marks the account dormant, and deletes its keychain entry. Revoke and
keychain delete are best-effort. An unreachable provider never blocks disconnecting.
⁷⁷ Two different polls, split into the two rows above. "Resync now" runs exactly what a
background pass runs, so with a cursor stored it cannot repair a drifted mirror. "Refresh from
calendar" clears `sync_token` + `ctag` first, which is what forces the re-enumerate, and for
CalDAV that arms the `authoritative_from` sweep. The only path that removes a mirror whose
event was deleted upstream while nothing was polling. A Google backfill still sets no
`authoritative_from`, so its refresh catches only deletions Google itself reports as `status:
cancelled`. Neither action tears anything down (unchanged etag → no write), and `fullResync`
stays false on a refresh: the engine reserves that flag for a cursor the
*provider* rejected.
⁷⁸ A dead credential is a state, not an error: the badge shows and the sync cursor survives.
The account **stops being polled**. `load_accounts` selects `WHERE reconnect_needed = 0`, so
the background pass skips it outright rather than spending a 401 per pass. "Resync now" runs
regardless of the flag and clears it on the first clean sync, so a manual retry is what takes
the badge down.
⁷⁹ `release_all_credentials` runs before the wipe, dormant accounts included. Their ids are the
keychain keys and the rows are about to go. `reset_db` (dev-only) misses the dormant sweep.

---

## Maintenance

- Add a row when a new user-facing operation lands; add the origin columns' behavior in the
  same session, not later. A blank cell reads as "works everywhere", which is how most of
  the defects this table has caught got in.
- Cite the guard by name, never a line number. Line anchors drift silently; a named
  function either exists or doesn't.
- Run `python3 scripts/check-doc-footnotes.py` after touching a footnote. Markers are
  sequential by first appearance, so inserting a section renumbers everything after it,
  the one edit here that's too error-prone to verify by eye. Two ways to trip it without
  adding a footnote at all: citing an existing marker from a **new row above** its current
  first reference, and citing a **higher-numbered** footnote from inside a lower-numbered
  one. Reference the section instead, or renumber the pair.
- This file is the *what*, per origin and surface. The *why* lives elsewhere:
  [`time-handling.md`](./time-handling.md) §7 for float vs absolute, and
  [`glossary.md`](./glossary.md) for the vocabulary every row assumes.
- Mobile column stays `○` until `apps/mobile` has a runtime. It exists now so the shape of
  the question is already in the table.
