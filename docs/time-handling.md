# How Pikos handles time

> Status: reference guide. Source-of-truth for behavior is the code
> (`packages/core/src/utils/dates.ts`, `packages/core/src/utils/recurrence.ts`,
> `crates/pikos-db/src/pool.rs`). This doc explains the *model* and the *why* in
> one place.

## TL;DR

Pikos is a **floating wall-clock** app. A time you enter is stored as the literal
clock reading you saw: `2026-06-15T09:00:00`, with **no timezone, no UTC
conversion, no `Z`**. "9am" means 9am on whatever wall clock the device is
showing, wherever you are. This is the right model for a local-first personal
productivity app: a person's "9am standup" or "take pills at 8pm" is anchored to
their day, not to an absolute instant on the global timeline.

Two deliberate exceptions:
- **System audit timestamps** (`created_at` / `updated_at`) are stored in UTC:
  machine bookkeeping, not user-facing schedule data.
- **Synced calendar events are absolute, not floating**: they're real instants
  coordinated with other people, so they render in your *current* zone and shift
  when you travel (a 3pm PT standup shows 6pm in ET). Native pages you create still
  float. See §7.

Everything else a user *sees or schedules against their own day* is wall-clock.

---

## 1. The storage model

Defined in `packages/core/src/utils/dates.ts`. One firm convention, used
everywhere. Frontend, `core`, CLI, and the Rust writer.

| Kind | Format | Example | Meaning |
|------|--------|---------|---------|
| **All-day** | `YYYY-MM-DD` (date-only) | `2026-06-15` | An all-day event/task |
| **Timed** | `YYYY-MM-DDTHH:MM:SS` (no `Z`) | `2026-06-15T09:00:00` | A timed event/task |

Two load-bearing rules:

1. **All-day vs. timed is inferred from the string format, not a boolean flag.**
   The presence of `T` is the discriminator. `isAllDayIso(iso)` (`!iso.includes("T")`)
   is the **single source of truth**. All detection routes through it so a future
   format change has exactly one site to update. This also maps cleanly onto iCal's
   `DATE` vs `DATE-TIME`, which matters for calendar sync (§7).

2. **Never coerce one form into the other.** An all-day event is not "midnight on
   that day"; it's a different kind of thing. Mixing the two in a comparison
   without first checking `isAllDayIso` is a bug.

### The classic trap we avoid

```js
new Date("2026-06-15")               // parses as UTC midnight → shows Jun 14 west of UTC
new Date().toISOString().slice(0,10) // returns the UTC date, not the local date
```

Both shift the date by a day for users west of UTC. So we **never** construct or
serialize dates with raw `Date`/`toISOString()`. We go through the helpers in
`packages/core/src/utils/dates.ts`. The **canonical helper list** (which function
to use for detect / parse / format / today / now, and what *not* to use) lives with
the helpers themselves. This guide covers the *model and the why*, not the
per-function lookup.

Date math uses `date-fns` (`addDays`, `set`, `format`, `endOfDay`, …), never
hand-rolled arithmetic or raw `Date` mutators (`setHours`, `setDate`, …). The
only sanctioned raw use is `new Date()` for "now".

### Two timestamp kinds in the Rust writer (the nuance)

`crates/pikos-db/src/pool.rs` exposes **two** clocks, and the distinction is
deliberate:

- **`now_iso()` → UTC, millisecond precision, trailing `Z`.** This is the
  canonical format for **`created_at` / `updated_at`** across the workspace.
  These are system audit fields. When a row was written. Not part of the user's
  schedule. UTC is correct here: it's monotonic-ish, comparable, and never
  ambiguous across DST.

- **`now_local_iso()` → local wall-clock, no suffix** (`yyyy-MM-dd'T'HH:mm:ss`,
  mirrors the frontend's `nowLocalISO()`). This is for **user-facing instants
  that get date-compared against the local day**. `scheduled_start`,
  `completed_at`. Using UTC here would break a comparison like
  `completed_at.slice(0,10) === localToday()` for much of every day off-UTC (the
  UTC date and the local date differ).

So the rule is: **schedule/user-day data is wall-clock; pure audit metadata is
UTC.** Both the desktop app and the CLI use the same helpers, so timestamps
written by either match.

---

## 2. Why we avoid UTC (for schedule data)

UTC is the correct default for *servers* and *distributed systems* coordinating
an absolute instant across many actors. Pikos is neither. It's a single user's
local-first app, and for personal schedule data UTC is actively wrong:

1. **User intent is wall-clock, not absolute.** When someone schedules "gym at
   7am" they mean 7am on their clock. They do **not** mean "14:00Z" such that the
   event slides to 6am if they cross a timezone. Storing UTC forces a conversion
   that encodes an intent the user never had.

2. **Off-by-one-day bugs are the #1 date bug class.** `new Date("YYYY-MM-DD")` →
   UTC midnight → wrong day west of UTC. Storing and rendering wall-clock strings
   sidesteps the entire conversion layer where these bugs live. There is no
   "convert to local for display" step to get wrong, because it was never
   converted away.

3. **All-day events have no meaningful UTC instant.** "June 15, all day" is not
   `2026-06-15T00:00:00Z`. That's a lie that breaks the moment the user is east
   or west of UTC. A date-only string is the honest representation.

4. **Local-first means the device clock is the authority.** There's no server
   reconciling instants across clients, so there's no benefit to a common
   absolute reference. Only the cost of conversions.

5. **DST round-trips through UTC are lossy/ambiguous** (see §5). Wall-clock
   storage keeps "9am every day" literally "9am every day" without re-deriving an
   offset that changes twice a year.

The trade-off, accepted knowingly, is that wall-clock times are **not
globally absolute**: the same stored string can mean different absolute instants
in different zones. For *native* data that's a feature (your day stays your day
when you travel). It does **not** apply to synced calendar events. Those are
absolute and render in your current zone (§7). Floating is the native-only model.

---

## 3. How we handle timezones (native Pikos data)

**We don't convert them. We float.**

- A timed value is stored as the wall-clock reading at the moment of authoring,
  in the device's then-current zone. No zone is attached to native pages for
  rendering purposes.
- There **is** an IANA `timezone` column on recurrence rules, but today it's
  **authoring metadata only**: stamped at creation, **never consumed** at render
  or expansion. The recurrence engine (`packages/core/src/utils/recurrence.ts`)
  expands purely in wall-clock and ignores it. (Verified across the codebase.)
  Keeping the column means a future zoned-rendering
  upgrade is possible *without a data migration*. The information is already
  captured, just not yet used.
- `getLocalTimezone()` exists for the rare cases that need the device zone
  (e.g. stamping that authoring metadata, or the cross-zone badge for synced
  events), not for converting native times.

Net: there's no timezone math on the native path. A 9am task is the string
`...T09:00:00` from creation to display.

---

## 4. How we handle traveling between time zones

Because native times are floating wall-clock, **travel is a no-op for native
data, and that's the intended behavior.**

- You set "team standup, 9am." You fly from Los Angeles to London. The standup
  still shows at **9am** on your now-London clock. The stored string never
  changed; your device's wall clock did, and the app renders the literal string
  against it.
- "Take medication at 8pm" stays 8pm local wherever you land, which is what a
  personal reminder should do. It does **not** silently shift to 4am because an
  absolute instant was preserved.
- `localToday()` and `nowLocalISO()` both read the device clock, so "today,"
  "now," and overdue calculations all follow you to the new zone automatically.

This is the deliberate opposite of how a meeting-invite system (zoned, absolute)
behaves. For *your own* schedule, floating is correct. The one case where you'd
*want* absolute behavior. A meeting someone else owns in another zone. Comes in
through calendar sync, which is explicitly zoned (§7).

**Known boundary:** native floating data cannot express "this specific event
should fire at an absolute instant regardless of where I am." The common case for
that. A meeting someone else owns. Comes in through calendar sync, which is
zoned/absolute (§7). A *native* page that needs absolute behavior (a cross-zone
call you own) would need a per-page "anchor to timezone" flag that attaches and
*consumes* a zone on the native path. A future option, currently out of scope.
The column is already there if we add it.

---

## 5. How we handle DST

DST is where wall-clock storage pays off, and also where the few real hazards
live (recurrence and multi-day spans).

### The general rule

A floating wall-clock string has **no offset to recompute**, so an event simply
stays at its wall-clock reading across a DST transition. "Daily 9am" is 9am on
March 8 and 9am on March 9. Even though those two 9ams are 23 or 25 hours apart
in absolute time. That is exactly what the user wants for a daily routine, and it
needs **zero** special handling because we never stored an offset to begin with.

Contrast with UTC storage: "9am daily" would be frozen to one offset, then drift
to 8am or 10am after the clocks change, requiring per-occurrence offset
correction. We avoid that whole class of bug by construction.

### Where DST can still bite

1. **Recurrence expansion across a boundary.** `rrule.js` operates on JS `Date`
   objects, which *do* have absolute instants under the hood, so an expansion
   that crosses spring-forward/fall-back can drift by an hour or land on the wrong
   day if the math isn't kept in wall-clock terms. This is the single most
   error-prone spot. Mitigations:
   - Single-source all RRULE logic through `rrule.js` (both parsing in the Quick
     Add parser and expansion). Never hand-roll recurrence math.
   - `scripts/seed-dst.py` seeds DST-edge fixtures; use it when touching
     expansion logic and add coverage in `recurrence.test.ts`.
2. **Multi-day timed spans** crossing a transition can be off by an hour in
   duration if computed via absolute subtraction rather than wall-clock.
3. **The non-existent / doubled hour.** At spring-forward, 02:00–02:59 doesn't
   exist; at fall-back, 01:00–01:59 happens twice. A wall-clock string can name a
   time that didn't exist or is ambiguous. In practice we render the literal
   string and don't try to resolve the ambiguity, because for personal planning
   "1:30am on fall-back night" is close enough either way. We don't schedule
   absolute-instant-critical events.

### Zones that honor DST vs. zones that don't

This is mostly automatic *for native data* and a real consideration *for synced
data*:

- **Native data:** because we float and never apply an offset, **whether the
  user's zone observes DST is irrelevant** to native rendering. A user in Arizona
  or Tokyo (no DST) and a user in New York or London (DST) get identical,
  correct behavior: the wall-clock string is shown verbatim. There is no DST table
  lookup on the native path, so there's nothing to get wrong per-zone.

- **Synced data (zoned):** external calendars carry real IANA zones, and DST
  correctness *does* matter when expanding their recurrences. Some zones observe
  DST (`America/New_York`, `Europe/London`), some don't (`America/Phoenix`,
  `Asia/Tokyo`, most of `UTC`-aligned regions), and the transition dates differ
  by zone and by year. We rely on `calcard` (the ICS parser) to resolve
  `VTIMEZONE` → IANA and emit **correct per-occurrence DST offsets**. Spike-
  verified 2026-06-15 (e.g. `−05:00 → −04:00` across US spring-forward, plus
  EXDATE and RECURRENCE-ID overrides, zero errors). Google returns IANA zones
  directly. We store the **source-zone wall-clock + the IANA id** from those zoned
  instants (§7), then at render resolve each occurrence to an absolute instant in
  the viewer's zone. DST-correct because the offset comes from the IANA id per
  occurrence, not a frozen value. Cross-zone events shift and carry a source-zone
  badge. Windows zone names (Outlook, later) need a mapping table. Flagged for
  Microsoft Graph, not Google/CalDAV.

---

## 6. The recurrence model (where time handling concentrates)

Recurring pages are the densest time-handling surface, so a quick orientation
(full detail in `packages/core/src/utils/recurrence.ts`):

- A recurring page = one template page + a `PageRecurrenceRule` (RFC 5545 RRULE
  string). Occurrences are **computed, not all stored.**
- **Virtual occurrences** are expanded client-side from the rule for the visible
  range and rendered directly. Never persisted.
- **Materialized occurrences** are real `page_schedules` rows (with `ruleId`),
  created only when an occurrence is *overridden* (moved/edited). They represent a
  deviation from the rule.
- A date drops out of virtual expansion if it's an EXDATE (a skip) **or** already
  materialized as an override. Always pass existing schedules to
  `expandRecurrenceForRange` so skips/overrides aren't double-rendered.
- Completing a recurring page uses the **advance** policy: a completed clone is
  created and the head advances to the next occurrence. The CLI matches this.

All of this runs in wall-clock (§5), which is why DST fixtures matter when you
touch expansion.

---

## 7. Calendar sync and external data structures

> Summarized here for the time-handling angle; behavior per origin and surface is in
> [`functionality-matrix.md`](./functionality-matrix.md).

External calendars (CalDAV/Fastmail first, Google second) are **zoned**. Every
event carries a real timezone. Pikos native data is floating wall-clock. These are
two different *semantics*, and the decided model (**2026-06-16, supersedes the
2026-06-15 "source wall-clock + badge" plan**) keeps both, split by origin:

- **Native pages float** (§3–§4). A task is an intention on *your* clock.
- **Synced events are absolute**: a 3pm PT standup is a real instant coordinated
  with other people; it must show as **6pm if you're in ET**, or you miss it.
  RFC 5545 encodes exactly this split (floating `DATE-TIME` vs `TZID`/UTC).

**The discriminator is origin, not the `timezone` column.** Native rows already
carry a populated `timezone` (stamped at authoring: provenance, not intent), so
"has a tz" can't mean "absolute." Instead: **a page with a `page_sync` row renders
zoned; a native page floats.** Same column, two readings. Provenance for native,
consumed for synced.

### The bridge

- **Storage is unchanged from the floating plan:** store the event's time as the
  **wall-clock in its own source zone**, and keep the resolved IANA id on the
  schedule/rule (the column already exists; now synced rows give it a consumer).
  We do **not** normalize to UTC: a recurring rule frozen to one UTC offset drifts
  an hour across a DST boundary, so we keep the TZID, not an offset.
- **Rendering is what changed:** resolve `(source wall-clock, IANA id)` → absolute
  instant → format in the **viewer's current device zone**. Travel re-renders (the
  viewer zone follows the device). **All-day synced events stay date-only and never
  shift**. A date isn't a zone.
- **The badge is now a complement, not a substitute.** Show a small **"in `<IANA
  zone>`" label** beside the *already-shifted* time when the source zone ≠ the
  viewer's, so the user sees why 3pm became 6pm. (the old plan badged *instead of*
  shifting, which under-shifted synced meetings; that's the bug this supersedes.)
- **Resolution of the source zone:**
  - Google returns IANA zones directly.
  - CalDAV `TZID` + `VTIMEZONE` is resolved by `calcard`, which also emits correct
    per-occurrence DST offsets and groups RRULE/EXDATE/RECURRENCE-ID for you.
  - Windows zone names (Outlook, later) will need a mapping table.

### Consequences

- **Same source zone as the viewer (dominant case): exactly correct, incl. Across
  DST.** The wall-clock → absolute → viewer round-trip is identity when source =
  viewer, so a non-traveling user sees no change vs today.
- **Cross-zone (authored elsewhere, or you've traveled):** the event **shifts** to
  your current zone and carries the source-zone badge. DST stays correct per
  occurrence because the offset is resolved from the IANA id at each instant, not
  frozen.
- **Known edge:** an event at a *non-existent* wall-clock time (the spring-forward
  gap, e.g. 02:30 on transition day) has no unambiguous absolute instant, so the
  conversion picks a side. Rare in practice (sources don't schedule into the gap),
  and the same edge §5 notes for native data.

### Why not the alternatives

- **Badge instead of shift** (the superseded 2026-06-15 plan): rendering a 3pm PT
  meeting as "3pm + badge" in ET under-shifts it. You'd read 3pm and miss the 6pm
  meeting. A badge informs; it doesn't prevent the miss. The badge survives only as
  a *label on the already-shifted* time.
- **Zoned everywhere, native included:** regresses the floating model existing
  users rely on (their "9am standup" would start sliding on travel), and rests on a
  false premise. A stamped authoring zone is *provenance* (where you typed it), not
  a declaration that the event is anchored to that instant. Native intent is
  floating regardless of the zone we happened to stamp.
- **A global floating↔zoned settings toggle:** a whole settings *mode* (two-class
  rendering, a sticky home-zone picker, mode-dependent bug reports) to serve one
  rare case. A floating-intent habit created *while* in another zone. Not worth it;
  revisit as a per-page "anchor to timezone" flag only if real users hit it.

### Data-structure mapping (zoned external → Pikos)

The normalized `SyncDelta` is provider-agnostic; the shared reconciler turns it
into Pikos rows. The recurrence/timezone mapping:

| External concept | Pikos representation |
|------------------|----------------------|
| Recurring master (RRULE) | `page_recurrence_rules` row: RRULE + base wall-clock + IANA tz |
| Modified occurrence (Google `recurringEventId`+`originalStartTime`; CalDAV `RECURRENCE-ID` override VEVENT) | `page_schedules` row pointing at the rule with `original_date` |
| Cancelled occurrence | RRULE `EXDATE` (`rrule_exdates`) |
| All-day (`VALUE=DATE`; Google `start.date`) | `YYYY-MM-DD` form — **never** coerced to timed |
| Timed (`DATE-TIME`+`TZID`; Google `start.dateTime`+`timeZone`) | `YYYY-MM-DDTHH:MM:SS` + IANA tz |

A key structural fact: **CalDAV groups a recurring master and its overrides under
one UID in one resource (href ≠ UID)**, whereas **Google ships the master and
each override as separate event resources**. Google's incremental
`syncToken` delta can also deliver a *single* changed/cancelled instance with the
**master absent**. So the `SyncDelta` contract carries two upsert-item kinds: a
**series bundle** (`{ master RRULE + base wall-clock + IANA tz, [overrides:
original_date → modified instance], [exdates] }`) *and* a first-class
**occurrence delta** (`modify-occurrence` / `cancel-occurrence`, referencing the
series by `ical_uid`/`recurringEventId`, applied against the already-stored
rule). The reconciler **does not** re-fetch the whole series on a series-touching
delta (that would defeat `syncToken`). It also **does not** change recurrence
*enumeration*: synced occurrences are still enumerated in source-zone wall-clock
through the existing pure-wall-clock engine, so EXDATE/UNTIL/RECURRENCE-ID still
match by string (below). What's new is a **render-time conversion**. Each
enumerated synced occurrence is resolved `(wall-clock, IANA) → absolute → viewer
zone` for display *and* for reminder firing, the source-zone badge as a label.

### Normalize every recurrence instant to one source-zone wall-clock basis

This is the sharpest interaction between sync and the floating engine. Pikos
expands client-side in pure wall-clock and **matches occurrences by wall-clock
string**. So at reconcile, **all four** instants of a synced rule must be
normalized to the same source-zone wall-clock. Not just dtstart:

- **dtstart / base time** — source-zone wall-clock (already stated above).
- **`UNTIL`** — providers often send `DATE-TIME` `…Z` (an absolute instant) inside
  an otherwise-floating rule. Keep the RRULE string raw for expansion (never
  round-trip through `parseRrule`/`buildRrule`; it drops BYSETPOS/BYMONTHDAY and
  reduces UNTIL to date-only), but **rewrite the `UNTIL` token specifically** to
  source-zone wall-clock (drop the `Z`, resolve in the source zone) so it floats
  with dtstart. Otherwise a cross-zone viewer clips the last occurrence(s) on the
  wrong day. This is the one place "keep it raw" and "float consistently" conflict.
- **`EXDATE`** (may carry `TZID` or `Z`). If stored raw it won't string-match the
  wall-clock expansion → the cancellation silently no-ops → a **ghost occurrence
  reappears.**
- **`RECURRENCE-ID` / `originalStartTime` → `original_date`** — matched against the
  virtual occurrence it replaces; a zone-basis mismatch **double-renders**
  (original + override) or orphans the override.

Every failure here is **silent**. Wrong occurrences, no error. Because the test
runner pins `TZ=UTC`, a zoned bug can pass CI while users in other zones break, so
the reconciler corpus asserts the wall-clock match **per field**.

This also reuses what Pikos already has for free: recurrence is iCal-native, the
all-day/timed distinction already matches `DATE`/`DATE-TIME`, and FTS indexes
synced pages automatically. So a synced event is a real, searchable Pikos page
whose *schedule* is calendar-owned (locked, read-only) while its *content* is the
user's.

---

## 8. Quick reference: the invariants

1. Store **local wall-clock ISO strings** for schedule/user-day data. No `Z`, no
   UTC conversion.
2. **All-day = `YYYY-MM-DD`; timed = `YYYY-MM-DDTHH:MM:SS`.** Format is the
   discriminator; `isAllDayIso` is the only place that decides. Never coerce.
3. **UTC only for system audit timestamps** (`created_at`/`updated_at` via
   `now_iso()`). User-day instants use `now_local_iso()` / `nowLocalISO()`.
4. Always use the **helpers** (`parseLocalISO`, `formatLocalISO`, `localToday`,
   …) and **`date-fns`**. Never raw `Date` parsing/serialization or raw mutators.
   Only `new Date()` for "now" is allowed.
5. Native data **floats**: travel and DST need no conversion; the wall-clock
   string is rendered verbatim. Whether the user's zone observes DST is irrelevant
   to native rendering.
6. **DST hazards live in recurrence expansion and multi-day spans**. Single-
   source RRULE through `rrule.js` and cover with `scripts/seed-dst.py` fixtures.
7. **Synced (external) data is absolute, not floating**: store source-zone
   wall-clock + the IANA id, then **render in the viewer's current zone** (a 3pm PT
   event shows 6pm in ET); a source-zone badge labels the shift, all-day stays
   date-only. Discriminate by **origin** (`page_sync` row), not the tz column.
   Enumeration stays pure wall-clock, so still **normalize all four recurrence
   instants** (dtstart, `UNTIL`, `EXDATE`, `RECURRENCE-ID`) to source-zone
   wall-clock at reconcile, or the match silently clips / ghosts / double-renders;
   the viewer conversion happens after the match (§7).
