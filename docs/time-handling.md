# How Pikos handles time

The code is the source of truth for behavior (`packages/core/src/utils/dates.ts`,
`packages/core/src/utils/zoned.ts`, `crates/pikos-db/src/pool.rs`). This page holds the model
and the reasons for it.

## The model

Pikos is a **floating wall-clock** app. A time you enter is stored as the literal clock
reading you saw, such as `2026-06-15T09:00:00`, with no timezone, no UTC conversion and no
`Z`. "9am" means 9am on whatever wall clock the device shows, wherever you are. A person's
"9am standup" or "take pills at 8pm" is anchored to their day, not to an instant on the global
timeline.

Two exceptions:

- **Audit timestamps** (`created_at`, `updated_at`) are UTC. They are bookkeeping, not
  schedule data.
- **Synced calendar events are absolute.** They are real instants coordinated with other
  people, so they render in your current zone and shift when you travel: a 3pm PT standup
  shows 6pm in ET. Native pages still float. See [Synced events](#synced-events).

## Storage format

| Kind        | Format                        | Example               |
| ----------- | ----------------------------- | --------------------- |
| **All-day** | `YYYY-MM-DD`                  | `2026-06-15`          |
| **Timed**   | `YYYY-MM-DDTHH:MM:SS`, no `Z` | `2026-06-15T09:00:00` |

Frontend, `core`, CLI and the Rust writer all use this one convention. Two rules follow.

1. **The string's shape says all-day or timed, not a flag.** `isAllDayIso` is the only place
   that decides, so a format change has one site to update. It also matches iCal's `DATE`
   versus `DATE-TIME`, which calendar sync relies on.
2. **Never coerce one form into the other.** An all-day event is not "midnight on that day".
   Comparing the two without checking the shape first is a bug.

### Dates in code

`new Date("2026-06-15")` parses as UTC midnight and shows June 14 west of UTC.
`new Date().toISOString().slice(0, 10)` returns the UTC date, not the local one. Both shift
the date by a day, so stored strings are parsed and written with the helpers in `dates.ts`,
never `toISOString()`. Date math uses `date-fns`, and lint rejects mutating a `Date` in place.

### Two clocks in the Rust writer

- `now_iso()` is UTC with a trailing `Z`, for `created_at` and `updated_at`. UTC suits audit
  fields: comparable, and unambiguous across DST.
- `now_local_iso()` is local wall-clock, for user-facing instants compared against the local
  day, such as `scheduled_start` and `completed_at`. UTC there would break a check like
  `completed_at.slice(0, 10) === localToday()` for much of every day off-UTC.

The desktop app and the CLI use the same helpers, so timestamps from either match.

## Why not UTC for schedule data

UTC is right for servers coordinating an instant across many actors. Pikos is a single
user's local-first app, and for personal schedule data it is wrong.

1. **Intent is wall-clock.** "Gym at 7am" means 7am on your clock, not "14:00Z", which would
   slide to 6am if you crossed a zone.
2. **Off-by-one-day bugs live in the conversion layer.** Storing and rendering wall-clock
   strings removes the layer.
3. **All-day events have no UTC instant.** "June 15, all day" is not `2026-06-15T00:00:00Z`.
4. **The device clock is the authority.** There is no server reconciling instants, so a shared
   absolute reference buys nothing.
5. **DST round-trips through UTC are lossy.** Wall-clock storage keeps "9am every day"
   literally that.

The accepted cost is that a wall-clock string is not globally absolute: the same value means
different instants in different zones. For native data that is the point.

## Native data floats

There is no timezone math on the native path. A 9am task is `...T09:00:00` from creation to
display.

- **Travel is a no-op.** Set "standup, 9am", fly from Los Angeles to London, and it still
  shows 9am on the London clock. "Take medication at 8pm" stays 8pm local, rather than
  shifting to 4am to preserve an instant. `localToday()` and `nowLocalISO()` read the device
  clock, so "today", "now" and overdue follow you.
- **DST needs no handling.** A string has no offset to recompute, so "daily 9am" is 9am on
  March 8 and on March 9, even though those are 23 or 25 hours apart. Whether the user's zone
  observes DST is irrelevant to native rendering.
- **The `timezone` column on a recurrence rule is provenance for native pages.** It is stamped
  where the rule was authored and never read to render or expand a native series. It is read
  for synced ones.

**Limit:** native floating data cannot express "fire at this absolute instant wherever I am".
The common case for that, a meeting someone else owns, arrives through calendar sync, which is
zoned. A native page that needed it would need a per-page "anchor to timezone" flag that
consumes the stored zone.

### Where DST still bites

1. **Recurrence expansion across a boundary** is the most error-prone spot. The engine must
   enumerate in wall-clock terms, never through absolute instants. All RRULE logic goes
   through `pikos-recurrence`, and `scripts/seed-dst.py` seeds DST-edge fixtures for testing
   expansion changes.
2. **Multi-day timed spans** across a transition are an hour off if duration is computed by
   absolute subtraction instead of wall-clock.
3. **The nonexistent and doubled hour.** At spring-forward 02:00 to 02:59 doesn't exist, and at
   fall-back 01:00 to 01:59 happens twice. A wall-clock string can name either. Pikos renders
   the literal string and doesn't resolve it, because personal planning doesn't depend on
   "1:30am on fall-back night".

## Synced events

External calendars (CalDAV and Google) are zoned: every event carries a real timezone. Native
data floats. Both semantics are kept, split by origin, matching RFC 5545's floating
`DATE-TIME` versus `TZID` or UTC.

- **Native pages float.** A task is an intention on your clock.
- **Synced events are absolute.** A 3pm PT standup is a real instant coordinated with other
  people, and it must show as 6pm in ET or you miss it.

**The discriminator is origin, not the `timezone` column.** Native rows carry a populated
`timezone` too, stamped at authoring, which is provenance and not intent. So "has a zone"
can't mean "absolute". A page with a `page_sync` row renders zoned and a native page floats.

### Storage and rendering

- **Storage is wall-clock in the event's source zone, plus the IANA id** on the schedule and
  rule. It is not normalized to UTC: a recurring rule frozen to one UTC offset drifts an hour
  across DST, so the zone id is kept rather than an offset.
- **Rendering resolves `(source wall-clock, IANA id)` to an absolute instant, then formats it
  in the viewer's current device zone.** Travel re-renders. All-day synced events stay
  date-only and never shift, because a date isn't a zone.
- **The source-zone badge is a label on the already-shifted time**, shown when source and
  viewer zones differ, so the user sees why 3pm became 6pm.
- **Zone resolution.** Google returns IANA zones. CalDAV `TZID` plus `VTIMEZONE` is resolved
  by `calcard`, which also emits per-occurrence DST offsets. Windows zone names (Outlook)
  would need a mapping table.

Same source and viewer zone, the dominant case, makes the conversion an identity, so a
non-traveling user sees nothing change. Across zones the event shifts, and DST stays correct
per occurrence because the offset comes from the IANA id at each instant. An event at a
nonexistent wall-clock time (the spring-forward gap) has no unambiguous instant, so the
conversion picks a side. Rare, and the same edge as for native data.

### Why not the alternatives

- **Badge instead of shift.** A 3pm PT meeting rendered as "3pm plus a badge" in ET
  under-shifts it. You read 3pm and miss the 6pm meeting. A badge informs and doesn't prevent
  the miss.
- **Zoned everywhere, native included.** It breaks the floating model users rely on, and rests
  on a false premise: a stamped authoring zone says where you typed the time, not that the
  event is anchored to that instant.
- **A global floating or zoned settings toggle.** A whole settings mode (two-class rendering,
  a home-zone picker, mode-dependent bug reports) to serve one rare case: a floating-intent
  habit created while in another zone. A per-page anchor flag is the answer if real users
  hit it.

### Mapping from external calendars

| External concept                                                    | Pikos representation                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Recurring master (RRULE)                                            | `page_recurrence_rules` row: RRULE, base wall-clock, IANA zone  |
| Modified occurrence (`RECURRENCE-ID`; Google `originalStartTime`)   | `page_schedules` row pointing at the rule, with `original_date` |
| Cancelled occurrence                                                | RRULE `EXDATE` (`rrule_exdates`)                                |
| All-day (`VALUE=DATE`; Google `start.date`)                         | `YYYY-MM-DD`, never coerced to timed                            |
| Timed (`DATE-TIME` plus `TZID`; Google `start.dateTime`+`timeZone`) | `YYYY-MM-DDTHH:MM:SS` plus IANA zone                            |

CalDAV groups a recurring master and its overrides under one UID in one resource. Google ships
the master and each override as separate events, and its incremental delta can deliver a
single changed or cancelled instance with the master absent. So the provider-agnostic
`SyncDelta` carries both a series bundle and a first-class occurrence delta, and the
reconciler never re-fetches a whole series, which would defeat the sync token.

Enumeration doesn't change: synced occurrences are enumerated in source-zone wall-clock by the
same engine as native ones, so exclusions and overrides still match by string. The new step is
a render-time conversion of each occurrence, `(wall-clock, IANA) → absolute → viewer zone`, for
display and for reminder firing.

### One wall-clock basis for every recurrence instant

Because the engine matches occurrences by wall-clock string, all four instants of a synced
rule are normalized to the same source-zone wall-clock at reconcile:

- **dtstart** is source-zone wall-clock.
- **`UNTIL`** often arrives as a `Z` instant inside an otherwise floating rule. The RRULE stays
  raw for expansion, since round-tripping it through a parser drops BYSETPOS and BYMONTHDAY.
  The `UNTIL` token alone is rewritten to source-zone wall-clock, or a cross-zone viewer clips
  the last occurrences on the wrong day.
- **`EXDATE`** may carry `TZID` or `Z`. Stored raw it won't match the expansion, the
  cancellation silently no-ops, and a ghost occurrence reappears.
- **`RECURRENCE-ID` / `originalStartTime`** becomes `original_date`. A basis mismatch
  double-renders the original and the override, or orphans the override.

Every one of these failures is silent: wrong occurrences and no error. The test runner pins
`TZ=UTC`, so a zoned bug can pass CI while users in other zones break. The reconciler corpus
therefore asserts the wall-clock match per field.

## Invariants

1. Schedule and user-day data is local wall-clock ISO, with no `Z`. UTC is for audit
   timestamps only.
2. All-day is `YYYY-MM-DD` and timed is `YYYY-MM-DDTHH:MM:SS`. `isAllDayIso` decides, and
   nothing coerces.
3. Dates go through the `dates.ts` helpers and `date-fns`, never raw `Date` parsing or
   mutators.
4. Native data floats. Synced data is absolute, discriminated by origin.
5. Every recurrence instant of a synced rule is normalized to source-zone wall-clock before
   matching, and the viewer conversion happens after.
