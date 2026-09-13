# The calendar on iOS

Written alongside the build. What follows is the part that is not obvious from
the code: which half of a calendar is shared, which half cannot be, and what
was found while wiring the two together.

## The split, and why it falls where it does

`crates/pikos-core/src/calendar/` decides **structure** and stops:

| Shared                                            | Per platform                                   |
| ------------------------------------------------- | ---------------------------------------------- |
| overlap clustering, sweep-line column assignment  | hour ↔ point mapping                            |
| all-day row packing, bar coalescing               | density, block minimum heights                  |
| continuation flags, midnight crossing             | the cascade's visual inset and its cap          |
| which occurrences exist in a range at all         | the text-collision heuristic                    |

The line is not arbitrary. The desktop's `HOUR_HEIGHT` of 64px makes a
15-minute slot 16px, which is fine for a mouse and less than half the 44pt a
finger needs. Its `CASCADE_MIN_TOP_GAP_PX` and density tables encode one
renderer's font metrics. Inheriting any of it would be a bug dressed as reuse,
so `PikosSupport/CalendarGeometry.swift` makes those calls for iOS — and, being
pure string arithmetic over wall clocks, is tested on the host in under a
second.

Two deliberate differences from the desktop are worth naming:

- **Short events keep their position and gain a minimum height.** The
  alternative — an hour tall enough that a 15-minute block is tappable — puts
  about six hours on a phone screen.
- **There is no "+N more" overflow pill.** The desktop folds cascade depths
  past 1 into one. Building it needs the cluster's membership and the shared
  Rust reports only a per-event depth, so the inset stops growing instead. The
  honest cost is that events past the cap sit at the same inset and the deeper
  covers the shallower. Revisit if dense days turn out to be common; the fix is
  to report cluster identity across the boundary, not to guess at it in Swift.

## A calendar cannot draw the pages it queried

This is the thing that shapes everything else. A recurring page is stored
**once** — a head row plus a rule — and its other occurrences are projected at
display time rather than written out. Query the pages in a week and a weekly
standup anchored three months ago returns nothing, and an empty calendar looks
exactly like an empty calendar.

So `Workspace::calendar_range` does the merge, once, in Rust:

1. Pages whose schedule **overlaps** the range — not merely starts in it, or a
   conference that began on Sunday vanishes on Tuesday. That needed a new query
   (`list_pages_overlapping_impl`); `scheduled_after`/`scheduled_before` bound
   `scheduled_start` alone.
2. Every recurrence rule, **and the head page of each**, whether or not the head
   is in the range. It usually is not — that is what a series is.
3. Materialised override rows in the range, whose dates are folded into each
   rule's exclusions so an overridden occurrence is not also projected.

The merge itself (`calendar::occurrences`) is ported from the desktop's
`useRecurrenceExpansion`, and its tests are that hook's own test cases rather
than ones invented here: the point is to agree with the desktop, and its suite
is the statement of what it does.

Its whole content is one rule, and it is worth stating because half of it is
easy to miss. **Suppress every occurrence at or before the head's own date.** On
the head's date, the head is already drawn and a projection would stack a
second block on it. *Before* the head's date, the rule still emits dates the
user has moved past — drag the head from Monday to Wednesday and Monday
reappears. Filtering on the head's exact date fixes only the first.

## Identity runs two ways at once

The all-day packer and the timed grid want opposite things from an id, which is
a real constraint rather than an accident:

- **Timed blocks key on the occurrence** (`CalendarEntry.key`, the page id plus
  the occurrence's date). Two occurrences of one series can land on one day, and
  a shared id would leave the layout unable to tell them apart.
- **All-day bars key on the page.** The row packer identifies a span by id and
  *relies* on every occurrence of a series sharing one, so a Mon/Wed/Fri series
  claims three separate days in a single row rather than a contiguous block
  through Tuesday and Thursday. The Rust says so in a comment; it is load
  bearing.

`CalendarGrid` therefore builds two `LayoutPage` arrays from one entry list.

## What the tests bit on

Every decision above was mutation-tested. Three are worth recording because
they passed first try and only the mutation showed they were being checked:

- Removing the head-suppression fails two tests; weakening it to `==` rather
  than `<=` fails one. The subtle half is genuinely covered.
- Not pulling rule heads into the expansion input fails two.
- Turning the overlap query back into a start-bound fails one.

And one test caught a real bug on the way in rather than after: pulling head
pages in for expansion had them **drawn** as well, so a March-anchored standup
appeared in June *and* in March. Heads are inputs, not blocks.

## Known gaps

- **An override row is not drawn.** It suppresses the projection, correctly, but
  both apps read one block per page from `pages.scheduled_start`, and for an
  rrule-backed page that column is owned by the recurring logic —
  `refresh_schedule_denorm` returns early rather than letting a new schedule row
  move the head. Drawing overrides is a change to both apps.
- **Tapping a projected occurrence opens the head page.** Editing one occurrence
  on its own has to materialise a row first, which is a feature rather than a
  side effect of a tap.
- **No drag to move or resize.** The desktop has both; on a phone they compete
  with scrolling and want a design decision, not a port.
- **Errors are silent here.** `calendarRange` sets `store.errorMessage`, and the
  only alert presenting it lives on the page list.

## iPad

The grid takes a list of days, so a week is not a different view — it is the
same one with seven columns. `CalendarSpan` picks its default from the width
class and then leaves the choice to the user, because the useful default and
the useful *option* are different questions: a week is cramped on a phone and
perfectly usable when someone deliberately asks for it, and an iPad in a narrow
split view is a phone-shaped screen on a large device.

What remains for iPad is the shell, not this screen.
