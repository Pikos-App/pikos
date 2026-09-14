# Pikos iOS — where things stand

Index for `docs/ios/`. Written 2026-09-12, against the architecture and
delivery plan.

| Doc                              | What it is                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `01-business-logic-inventory.md` | Every module classified rust / ts-portable / ui-only, with three addenda correcting the first pass                   |
| `02-ffi-surface.md`              | The Swift ↔ Rust boundary: what crosses it, and why dates cross as strings                                           |
| `03-m0-spike.md`                 | The editor-in-webview spike: how to run it, how to measure each item on the pass bar, what to do if it fails         |
| `04-parser-grammar.md`           | The quick-add parser: what it needed, what was built, and what differential fuzzing found that the corpora could not |
| `05-calendar.md`                 | The calendar: which half is shared, why a calendar cannot draw the pages it queried, and what the mutations caught   |
| `06-platform-audit.md`           | What iOS breaks regardless of the UI layer, carried over from the Tauri spike and re-read against Swift              |
| `07-device-checklist.md`         | The first device session: M0, the lock-screen check, and what to write down — each one a row to read on screen       |
| `08-design-review.md`            | What a phone productivity app is expected to feel like in 2026, where this one stood, and the pass that followed     |

## Based on `feat/external-calendar-sync`, not `main`

This branch was cut from `main` and has since been merged onto
`feat/external-calendar-sync`, which is 295 commits ahead of main and nearing
merge. Doing it late would have cost more than doing it early, and three things
had already drifted:

- **Migration 010 was claimed twice.** Sync took 010–012 independently; this
  branch's `content_schema_version` is now **013**. `sqlx` records a checksum
  per version, so two files claiming one number means a database that ran either
  refuses to open with the other — loud, but total.
- **There were two Rust recurrence engines.** `pikos-core`'s has been deleted in
  favour of `crates/pikos-recurrence`, which is timezone-aware and graded
  against rrule.js goldens. TypeScript already calls it through wasm.
- **The calendar's occurrence merge was a port of a superseded hook.** Rebuilt:
  see `05-calendar.md`.

## Done

**The shared core is real and tested against the TypeScript it replaces.**
`crates/pikos-core` now holds recurrence, calendar overlap and all-day layout,
text extraction, deep links, schedule transitions and date helpers — each graded
against a golden corpus generated from the TypeScript implementation, at pinned
reference times in a pinned timezone. Every parity suite was mutation-tested
rather than trusted for being green; two early versions were vacuous and were
replaced.

**The FFI boundary exists and produces real Swift.** `crates/pikos-ffi` exports
that logic through UniFFI, and `apps/ios/PikosCore` is the generated SwiftPM
package. Generating the bindings needs no Mac, so the API iOS will consume is
reviewable in a pull request and drift-checked in CI; only the XCFramework build
is platform-gated.

**Documents are version-stamped.** `pages.content_schema_version` (migration 013) closes the gap that open question 2 identified. A client finding a version
above its own must not save over the document — the corruption mode a second
writing client introduces, and the one the plan cites as its reason for
choosing TipTap-in-webview over a native editor.

**The document schema is shared, and doing that found a bug.** Two extensions
that read as behavioural — TabIndent and tiptap-markdown — contribute
attributes to every paragraph, heading and list. Mobile shipping without them
would have silently stripped indentation and list tightness from every document
on the next desktop save. A second instance of the same class of bug was found
in production: the markdown importer had its own drifted extension list, so
imported pages were rewritten wholesale on the first keystroke. Both fixed,
both with regression tests.

**M0 is scaffolded.** `packages/editor-mobile` and
`apps/ios/PikosEditorBridge` are complete and buildable. The bridge protocol is
declared once and generates both halves.

**The database is bridged.** `Workspace` and `ReadOnlyWorkspace` expose pages,
folders and search as async Swift. The read-only handle has no write methods,
so the plan's one-writer rule is enforced by the type an extension can hold
rather than by everyone remembering it.

**The app shell exists.** `apps/ios/Pikos` is a SwiftUI app — page list with
swipe actions and completion toggles, the editor screen wired to the workspace,
quick add, full-text search, deep-link routing, and a generated Xcode project
from `project.yml`. Unbuilt, like the rest of the Swift.

**Widgets and Shortcuts are written.** A Today widget reading the workspace
read-only, and App Intents for creating, searching and opening. The intents live
in the app target on purpose: intents declared there run in the app's process,
which is what keeps the one-writer rule intact — an intent writing from an
extension would be a second writer against a database whose WAL mode permits
one.

**Quick add parses natural language.** The whole of `parseInput` is ported —
the date engine (a port of the subset of chrono-node the parser reaches) and
the rest of it: cadence, tags, folders, priorities, durations, windows. Graded
against 2,219 corpus cases generated from the TypeScript reference, plus 1,628
recorded date-engine calls and 644 isolated expressions, and mutation-tested
throughout. `parse_quick_add` is the pure surface; `create_from_quick_add` is
the one that writes the pages, and the iOS sheet parses as you type with the
native pickers kept alongside.

**Every ported module is differentially fuzzed, and it mattered.** Passing all
2,219 parser cases turned out to mean less than it sounded: a fuzzer that
composes lines from fragments _in random order_ found six divergence classes the
corpus never reached, because every input in it exercises one feature at a time
and the parser is a pipeline whose ordering is load-bearing. Recurrence and
calendar layout now have the same treatment. Three seeds each, no divergences
left, and every generator is mutation-tested — twice a clean run turned out to
be clean for the wrong reason until an axis was added deliberately.
`04-parser-grammar.md` has the detail; the rule it ends on is worth carrying
elsewhere: _a clean fuzz run is evidence about the axes the generator varies and
nothing else._

**The backlog scope question is asked on the phone too.** Acting on one
occurrence of a series that has fallen behind is genuinely ambiguous — ticking
last Monday's standup when three earlier Mondays are also open could mean
either — and the desktop stops to ask. iOS now asks the same question, as an
action sheet:

> **Mark complete** — _3 earlier days are still open: Tue 5 May, Wed 6 May, and
> 1 more._ → **Complete just this one** · **Complete all 4 days** · Cancel

The shape is the one thing that differs, and deliberately. An action sheet's
buttons are bare labels with no room for the per-choice helper line the desktop
puts under each card, so the counts carry that instead. A custom sheet could
have reproduced the cards exactly; a hand-built modal for one question is not
worth it.

`Workspace::occurrence_backlog` decides whether to ask at all, and applies every
exclusion the desktop does: the rule's own exdates, days already completed or
skipped, a moved occurrence's original date, and the connect-day floor on a
synced series. Empty means no question — a series that is not behind, or a
gesture on today, commits on the first tap. It is a disambiguation, not a
confirmation.

Two of those exclusions took a second attempt to test honestly. The
moved-occurrence filter is unreachable on a **native** series, because a native
move writes an EXDATE and the rule stops yielding the date anyway; only a
detached series keeps the occurrence in-series as an override row with nothing
in the rule to say so. And the window's extra millisecond — it opens just before
the head's midnight rather than at it — only matters for an **all-day** head,
which _is_ midnight and would otherwise fall out of its own backlog. Both
mutations survived against timed, native fixtures and bite against the right
ones.

Three store methods went in the same change. `skipOccurrence`,
`unskipOccurrence` and `completeOccurrence` were each superseded by a plural
that takes the backlog, and leaving the singulars behind would have been three
pieces of public API nothing called.

**The focus timer works on the phone.** A button in the editor's toolbar, a
ticking clock beside it, and a row in `focus_sessions` when a session ends.

The 30-second floor and the two duration formats moved to `@pikos/core` and were
ported to `pikos-core::focus`, graded against it across every boundary the
formatters have — the floor, the minute rounding, the singular/plural switch, the
jump to `H:MM:SS`, and an exact hour where the trailing minutes are dropped.
Small functions with a lot of edges are exactly where two implementations agree
on everything anybody tried by hand and differ on the one the user hits.

Two things the phone needs that the desktop does not. The elapsed count is
recomputed from the start instant rather than incremented, because the tick stops
the moment the app is backgrounded and a counter adding one per tick would come
back minutes light while looking perfectly plausible; the same recomputation runs
on the way back to the foreground so the first second is not stale. And leaving
the page banks the session rather than dropping it, from `onDisappear` — the only
hook a back-swipe fires — with the write detached from the view's lifetime,
because a Task tied to a view that is going away is a Task that may not finish.

The FFI derives the duration from the two timestamps instead of taking it as an
argument, so a caller cannot report a length its own clock disagrees with, and a
backwards clock comes out short rather than long. A session against a page that
has since been deleted is refused as not-found rather than as a database failure:
that is routine on a phone — a widget, a deep link, a list one refresh behind —
and "the workspace could not be read" is the wrong sentence for it.

**The workspace can be exported, and wiped.** Four formats through the system
share sheet — Markdown, CSV, `.ics` and a database backup — plus Delete all data
in Settings.

Almost all of the work was a move. Every builder lived in the desktop's Tauri
crate, which is the wrong home for "what happens to my writing if I stop using
this": a phone that cannot produce these cannot answer it. They are now
`pikos_db::export` and `pikos_db::export_ics`, with the ProseMirror → Markdown
renderer in `pikos_core::markdown` beside `extract_text`. The 86 tests that
pinned the CSV columns and the frontmatter moved with the code, because a
contract with the importer tested in a crate that no longer owns it is one that
quietly stops being run. What stayed platform-side is where a file goes.

The move surfaced a bug that had always been there, and it is the kind only a
port finds. sqlx decodes a NULL SQLite column into `Ok("")` rather than an
error, so `try_get::<String, _>(col).ok()` — which reads as "None when absent"
and is not — yielded `Some("")` for every missing value. The Markdown export
therefore wrote **every unfiled page into an `Uncategorized/` directory**, and
put `scheduled_start: ""` in an unscheduled page's frontmatter. The
`Uncategorized` arm's real case is a folder id whose folder is gone, which a
foreign key makes impossible, so nothing had ever exercised it honestly; that
constraint is now a test of its own, so nobody deletes the arm as dead code
without seeing what holds it up.

The Markdown tree is zipped before sharing, via `NSFileCoordinator`'s
`.forUploading` — the one zip on the platform that needs no third-party code. A
share sheet handed a folder offers to save it and little else.

Delete all data disconnects the calendar accounts first, so credentials leave
the keychain where the database cannot reach them, and that half is best-effort
on purpose: a server that will not answer must not be able to stop somebody
wiping their own device.

**Folders can be coloured and nested, and calendar folders sit under their
account.** Three §7 rows, and the interesting part is what each one turned up.

The palette is now served by the workspace rather than written out in Swift.
It was already defined in `@pikos/core` and mirrored in
`pikos-calendar-sync::palette` for the provider-colour mapping; a Swift copy
would have been the fourth, and the failure mode is a folder coloured on the
phone in a shade the desktop's picker can neither show nor change. So
`pikos-core::colors` holds it, graded against the TypeScript entry for entry
_and in order_ — the rows are not arbitrary, and a shuffle that keeps every
value would still put an imported calendar in a colour that shouts.
`pikos-calendar-sync` keeps its own pastel eight, and the test that pins the
row boundary now says so instead of claiming a sharing that does not exist.

Reparenting needed a guard the data layer does not have. Nothing checks for a
cycle, and the result is silent: move a folder inside its own child and both
rows survive, neither is reachable from the top level, and the pair disappears
from the sidebar with no error and no way back short of editing SQL. The
workspace now refuses it at any depth — one level of checking passes the
grandchild case — and the picker leaves the impossible choices out as well.

The account headings follow the desktop's rule (`useCalendarAccountGroups`):
none with one account, one per account with more. The addition is a folder
whose account has gone, left behind by a disconnect — it stays listed under a
plain "Calendars" heading rather than dropping off a screen whose entire job
is to show what exists.

Colour also needed a hex parser, which is small enough to look untestable and
is not: every wrong answer is a plausible-looking colour, and a parser that
shrugs and returns black turns one mistyped character into a folder dot that
reads as deliberate. It refuses anything that is not six hex digits — no
three-digit form, no alpha — because the workspace only ever serves `#RRGGBB`.

**The overdue backlog clears in one tap.** "Move to today" sits on the Overdue
section's own heading rather than in the toolbar, because it acts on that
section and nothing else. `planMoveOverdueToToday` is ported to
`pikos-core::overdue` and graded against the TypeScript at all seven reference
times over one fixture set — the same page is days overdue from one reference,
dated today from another and in the future from a third, so the boundary this
gets wrong in only one direction is crossed in both.

Two kinds of page are left alone and _counted_: a recurring one, because an
overdue occurrence means the series has a gap and dragging the anchor forward
erases it rather than resolving it, and one a calendar owns. The count is the
part that needed care. Both are reported in the sentence shown afterwards, so
the set handed to the planner has to be the overdue section and nothing else —
a caller that passes every scheduled page still moves the right pages, because
the planner refuses a shift into the past, but reports "1 recurring left" about
a standup happening next Tuesday. Mutation testing is what found that: dropping
the overdue predicate changed no page's date and no test failed until one
existed for the counts.

One mutation is left alive with its answer written down. The reference reaches
for `addDays` rather than a seconds offset because a JavaScript `Date` is an
absolute instant and a DST change would move the wall clock an hour; these
values are `NaiveDateTime`, which carries no zone, so the two forms are
identical here and the corpus says so — including for the fixture placed astride
the EU change. `Duration::days` stays because it says what is meant, and the
comment now says that rather than claiming a safety it is not providing.

**Search takes operators, from the same grammar the desktop uses.** `tag:`,
`folder:`, `is:`, `priority:` and `due:` lived only in `@pikos/core`, so the
phone's search field was words and nothing else. `parseSearchQuery` is now
`pikos-core::search`, graded against the TypeScript over every query the TS
suite exercises plus a supplementary set — at all seven reference times,
because `due:` is the half that reads a clock and `due:week` names different
windows on a Sunday and a Wednesday.

What the corpus grades hardest is the _negative_ half. Every case records the
text left behind, so a port that recognises one token too many fails on the
text even when its filter looks right: `ratio:1.5` is a search for "ratio:1.5",
and `priority:9` is a search for "priority:9", because 9 is not a priority.
Mutation testing found two real holes in the first corpus — `is:DONE` and
`due:TODAY` were nowhere in it, so a port comparing values as typed passed
everything.

`Workspace::search` then takes the two paths the desktop palette takes: the
structured filter first, full-text search over whatever words are left second,
the two intersected, so a mixed query keeps FTS5's ranking and its excerpts
instead of degrading to a table scan. A folder name that matches nothing
returns nothing rather than falling through to the unfiltered set, and finished
pages stay out unless `is:done` asks for them.

**One occurrence at a time.** Long-pressing a calendar block completes or skips
_that_ occurrence. Before this the only verb a repeating page had on the phone
was the list's checkbox, which finishes whichever occurrence is next due — right
for a row that _is_ the next one due, wrong on a calendar the moment a series
falls behind, where the head sits on last Monday and the block on screen is this
Thursday's.

Skipping had no path at all. The primitives were in `pikos-db` and never reached
the FFI, so the nearest thing to "not this week" was trashing the head, which
takes the series: every occurrence behind it and every one ahead.

Two things the work turned up. `complete_recurring_occurrence` could not
actually complete a named occurrence — `pikos-db` refuses an occurrence date
supplied without the occurrence's own start, and the binding hard-coded both
extra fields to `None`, so any caller naming one was rejected at runtime with a
message about synced series. The three fields now travel as one `Occurrence`
record, which is what makes the broken call unrepresentable rather than
documented. And `CalendarEntry` gained two fields for questions the phone could
not otherwise answer: `is_recurring`, because a series' _own_ row draws as a
real block with no occurrence key and is the one most often on screen; and
`is_synced_origin`, because the desktop offers completion per-occurrence on an
imported series and withholds it from a native one, and that rule turns on where
the series came from rather than on whether it is still mirrored — a detached
series is unlocked and still an imported calendar.

Skip is offered on every kind of series, with an undo bar and no confirmation:
nothing is destroyed, so the way back is one call. What iOS does not ask is the
scope question the desktop asks behind a backlog (`RecurringGapDialog`) — it
always means _just this one_.

Moving one occurrence followed, on the same menu, and closed the last row of
that cluster. The desktop does it by dragging the block; on a phone a drag
competes with scrolling the grid, so the gesture is a long press and a picker
and the write underneath is the same one transaction. `CalendarEntry` gained
`rule_id` (the operation is keyed on the rule, not the page) and
`schedule_locked`, so the entry can be withheld on an active mirror rather than
offered and refused. The sheet says which of the two outcomes is coming before
it happens — a native occurrence leaves the repeat and becomes a page of its
own, an imported one stays a member pinned to its new time — because a reader
expecting the other one would read the result as a bug.

**A repeat can be changed or switched off.** Quick add could make a page repeat
and nothing could change it afterwards, so "every Monday" typed once was every
Monday forever and the only way out was deleting the page. The picker covers
frequency, interval and weekdays; anything richer is shown read-only.

Which is which took two guards, not one, and a test caught the difference.
`rrule_edit_would_degrade` asks whether a _full_ editor could round-trip the
rule — and "the last Friday of the month" passes, because `RecurrenceOptions`
carries `BYSETPOS`. A picker with nowhere to put it would then have offered it
for editing and saved back "every month on a Friday". `repeat_from` is the
second, narrower envelope, and the read and the write apply the identical test
so the UI cannot call a rule uneditable while the workspace edits it for anyone
asking directly.

**Priority and tags are editable too.** Both were creation-only for the same
reason the date was: quick add's line set them and nothing changed them
afterwards. Priority is a submenu beside Move to Folder — with "None" as a real
choice, because a page with a priority needs a way back to having none — and
tags get a sheet. Both are offered on a calendar's page, because tags and
priority are user-layer: the lock covers the title and the schedule, not what
somebody files a meeting under.

**A page can be put on a date, which it could not before.** Filling in the
matrix's iOS column made the largest gap obvious: a page took its date from
quick add's natural-language line and nothing could change it afterwards, so one
created without a date could never get one and a meeting that moved had to be
deleted and retyped. `set_page_schedule` replaces the one-off date rather than
adding beside it — `schedule_page` _adds_, and a page shows the earliest date
still ahead, so an edit built on that leaves the old one to resurface days
later. Start and end must be the same shape, because the storage format cannot
say "all day, ending at 3pm".

It refuses on a repeating page. That date belongs to the rule: moving it has to
realign the anchor and snap onto a day the rule can yield, and `resolveAnchorMove`
is not ported. Refusing is the honest version of that, and the same line the CLI
draws.

**CalDAV calendars sync from the phone, and the checker grew teeth.**
`pikos-calendar-sync` is a dependency of `pikos-ffi` for the first time, so
connecting an account, repairing a password, toggling a calendar and syncing on
demand all work on iOS. Google does not, and that is structural rather than
unfinished — the screen says so rather than letting a stale calendar read as a
bug. Background polling was structural too, and has since been replaced by what
iOS does allow: a sync on return to the foreground when the last one is over
fifteen minutes old, and one inside the reminders' background refresh. `WorkspaceError` gained a `Network` case so a
server that cannot be reached stops being reported as a damaged workspace.

Wiring it up exposed three instances of one bug that had been sitting in the
tree: `if case .notFound = error`. UniFFI spells an error case exactly as the
Rust variant is spelled — `NotFound`, capitalised — and Swift's own convention
is lowerCamelCase, so the wrong spelling is the one a Swift author writes from
habit, and it compiles nowhere. `scripts/check-swift-ffi-usage.py` now checks
enum-case spelling alongside argument labels; it found two more the moment it
ran.

**Settings exist.** Theme, list density, calendar density, week start and the
default folder for new pages, in the App Group's `UserDefaults` so the widget
and the intents read the same values the app does. Deliberately a fraction of
the desktop's five tabs — most of what is there describes a window, a keyboard
or a three-column calendar — and every row that did ship is wired to something:
theme and week start go into the environment at the root so sheets and every
`DatePicker` below pick them up, density reaches the calendar grid and the list
rows, and the default folder is honoured by quick add _and_ by the App Intent,
which is the path it mostly exists for since an intent has no picker to show.

**The two date views exist, and porting them found a dead link.** Today now
splits into overdue and due-today, and Upcoming — a whole smart view iOS did
not have — groups the next seven days. The membership, the overdue rule and the
ordering are ported into `pikos-core` and graded against the TypeScript on a
new corpus (`views.json`), because two of the ordering rules would look fine
while being wrong: an all-day item stays "today" until midnight while a timed
one slips the moment it passes, and an all-day item dated today sorts at _now_
so it lands between what has gone and what has not. The day _labels_ are
deliberately not ported — "Today" / "Tomorrow" / "Thu, 27 Aug" is locale work
the platform does better, so the date crosses the boundary and `DayLabel` names
it.

Two things fell out of that. The corpus rejected the first version of one test,
which asserted that no page could be in both date views — a page dated today is
in both, deliberately, because they ask different questions of it. And
`pikos://upcoming` had been a dead link on iOS since the port: the Rust arm read
`if head == "today" { Today } else { Inbox }`, so a third view had nowhere to
go, and the deep-link corpus never tried the URL. Both the arm and the corpus
are fixed; the arm is exhaustive now, so a fourth view is a compile error rather
than a link that quietly does nothing.

**Finished pages have somewhere to go, and a bug on the way there.** iOS was
inconsistent with itself: Today filtered `status != 'done'`, so ticking a page
made it vanish with no way back short of search; Inbox and folder views had no
status filter at all, so done pages sat inline with a strikethrough forever.
Neither matched desktop, whose every view lists open work and folds the rest
into a paginated Completed section. That section now exists, scoped the way each
view means it — Today asks "what did I finish today" across every folder, a
folder asks "what have I ever finished in here".

Building it surfaced a real bug in the write path rather than in the new code.
`set_page_status` went through `update_page_impl`, which writes `completed_at`
only when a caller supplies one — and nothing did. A page ticked on the phone
was done with no record of when: invisible in any Completed view, on the phone
and on the desktop reading the same file, with nothing logged. Fixed and
pinned, with the local-wall-clock convention the Completed view's date
comparison depends on.

**A page can be renamed, moved and un-dated without opening it.** The long
press menu is desktop's right-click menu: rename, move to folder, clear date,
delete. Two entries are withheld rather than shown and refused — all of the
first three on a page a calendar owns (`PageSummary` now carries
`schedule_locked` so a list can decide that per row without a round trip), and
clear-date on a repeating page, where the write is real but changes nothing
visible because the head's date belongs to the rule. Before this, folder and
priority were settable only in quick add, so a page was stuck in whatever
folder it was created in.

**A mis-swipe is recoverable from the phone.** Swipe-to-delete was wired with
no way back: the delete had been soft all along, but nothing on iOS listed or
restored a trashed page, so as far as the user could tell it was gone. The
workspace now exposes `list_trashed_pages()` and `trash_retention_days()`, and
"Recently Deleted" sits behind the view switcher with a restore on each row.
Two things it is deliberately careful about — it does not offer a permanent
delete (a destructive control next to a restore button on a small screen is the
same mis-tap the screen exists to undo), and it marks the rows that mirror a
calendar, because those are never purged and the retention sentence is not true
of them.

## The quality pass (2026-09-14)

A read of every hand-written Swift file against two questions: would this
compile, and would a person who uses the desktop app find the phone obvious. It
added no feature the phone did not already have; what it did was move the ones
it had to where a thumb expects them, and fix what the second adversarial pass
had left standing.

**Four things that would not have compiled**, found by reading rather than by a
compiler, so worth listing for the session that finally has one:

- `WorkspaceStore.setStatus` wrote its optimistic tick into `pages`, which is a
  computed projection of `sections` and cannot be assigned to. It writes into
  `sections` now, and the row stays put, ticked, for the beat before the
  refresh moves it to Completed — which is the visible confirmation the tick
  wanted anyway.
- `PageListScreen` had an orphaned `@ViewBuilder` sitting on a `private struct`
  after an earlier extraction moved the property it belonged to.
- `AppDependencyManager.shared.add { Route.shared }` read a main-actor static
  from a `@Sendable` closure. `Route.shared` is `nonisolated(unsafe)` now with a
  `nonisolated init`, which is honest: the reference is immutable and every
  member on it is still main-actor bound, so a caller off the actor can hold
  the router but not move it. That was suspect 3 in the list below.
- `TodayProvider` captured WidgetKit's completion handlers in a `Task`. They
  travel in an `@unchecked Sendable` box now, since each is called exactly once
  from the task that owns it. Suspect 2.

**Three things that would have compiled and been wrong on a device.** The
formatting toolbar was a `.keyboard` toolbar item, which attaches to the input
accessory of a SwiftUI text field; a webview brings its own responder and its
own accessory, so the bar would never have appeared above the editor. It is a
`safeAreaInset` at the bottom now, shown while the keyboard is up, with a
"hide keyboard" button at its end because a webview's keyboard has no Done of
its own. The calendar's week ignored the "week starts on" setting — the setting
went into the environment for `DatePicker`s and `CalendarSpan` was still
reading `Calendar.current`. And the error alert lived on the page list alone,
so a write that failed on the calendar waited for the user to come back.

**What moved, and why.** The view switcher was a filter-shaped icon in the
corner with Settings hidden under it; the title is the switcher now, which is
the platform's own idiom for "this screen can be one of several things", and
Settings has a gear. An open page could not be renamed, dated, filed or tagged
without going back to the list and finding it again — the list's long-press
menu is now also the editor's menu (`PageActionsMenu`, one declaration), and a
metadata strip above the document shows the date, folder, priority and tags
with each chip opening the sheet that changes it. Rows never showed priority;
the checkbox ring is tinted by it now, the way the desktop's is, and rows in the
date views name their folder. The calendar pages by swipe, tints blocks by
folder colour, and its long press on a one-off block offers the full page menu
rather than "Open" alone. Two copies of a six-second undo bar became one
`NoticeBar` fed by `WorkspaceStore.notice`, which also carries the one new
sentence: adding a page that lands outside the current view — "buy milk" typed
while looking at Today goes to the Inbox — says where it went and offers to go
there, instead of appearing to have failed. And the app re-reads the workspace
on return to the foreground, so a page dictated to Siri is there when the app
comes back rather than after a pull.

**Two ship-readiness items.** There was no asset catalog, so every native
control tinted system blue while the editor was terracotta; `AccentColor` now
carries the brand colour, `PikosSupport.Brand` hands the same hex to the editor
and the widget, and `AppIcon` holds the desktop's icon flattened onto its own
background (App Store Connect refuses alpha) until a phone-designed one exists.
And there was no privacy manifest, which App Store review now requires of any
binary calling `UserDefaults`; both the app and the widget have one, declaring
that one API and nothing collected.

**One FFI addition.** `Page` gained `is_recurring` and `schedule_locked`, the
two facts the editor's menu turns on and could not otherwise know — guessing
from the folder would have mis-read a detached calendar page. Bindings
regenerated; the 135 `pikos-ffi` tests pass.

**A second pass, the same day.** Four small closers, each of which had every
piece but one: a photo button on the formatting bar with a `PhotosPicker`
behind it, writing into the assets directory and re-encoding anything that is
not JPEG, PNG or GIF; a `setEditable` message on the bridge, so the
newer-schema banner locks the surface rather than only refusing to save;
"Deleted — Undo" through the notice bar, since the trash was two menus away
from a mis-swipe; and "Stop Repeating" on the page menu, with an undo where the
rule can be rebuilt. Then the TestFlight items: the app icon (the desktop's,
flattened, until a phone-designed one exists), a String Catalog with every
`String`-typed sentence routed through `String(localized:)` — the `Text`
literals were already covered, and `PikosSupport`'s two words ("Today",
"Tomorrow") still need the package's own catalog — and a VoiceOver pass on the
calendar: blocks carry their verbs as rotor actions, the hour gutter is not
visited, the day header is a header, and paging is on the rotor because the
swipe is not. And for the device session nobody has had yet, a debug-only
Diagnostics section in Settings that reads back the protection class of every
database file, with `07-device-checklist.md` saying what to look at and in what
order.

## One bug the merge exposed, worth its own note

`WorkspaceStore.setStatus` flipped `status` on every page, recurring ones
included. `pikos-db` warns about exactly that above `set_pages_status_impl` —
"a plain status flip would corrupt the series" — and the damage is invisible as
it happens: a recurring page is a head row plus a rule, and completing an
occurrence is supposed to clone the head at that date and advance it. Flipping
the head instead leaves it where it is and marks it done. The row reads exactly
as the user intended; every occurrence that had not happened yet is gone.

It was undetectable before the merge, because nothing on the iOS side knew a
page could repeat. `PageSummary` gained `is_recurring` with the sync work, and
that is what made the question askable. The first fix routed in Swift, reading `is_recurring` from the cached page list
and defaulting to false when the page was not in it. Correct for the list
screen, and a trap for everything else: a widget action or an App Intent
completing a page it never listed would take the corrupting path silently. The
routing now lives in `Workspace::set_page_status`, so the safe call is the only
call — `a_plain_status_flip_on_a_recurring_head_ends_the_series` records what
the wrong path does, and `the_status_toggle_routes_by_kind_without_being_told`
records that no caller has to know which kind it holds.

## What the screens showed once drawn

An HTML reconstruction of the five main screens, built from the SwiftUI as
written, made a few things visible that the code read fine. Each is a small
change and none touches Rust:

- **List rows carried too much on one line** — ring, title, meta, a tag chip
  at the trailing edge and a disclosure chevron. Tags moved into the meta line
  under the title, the chevron went (the link sits invisibly behind the row,
  as Reminders draws its rows), and the row inset tightened so the title sits
  where the platform's lists put it.
- **The editor lost too much height while typing.** The metadata strip now
  collapses while the keyboard is up.
- **The formatting bar's first screen showed the wrong six.** Bold, italic,
  bullet list, checklist and photo are on the bar; underline, strikethrough,
  inline code, heading, numbered list, quote and code block are behind an
  "Aa" menu that ticks whatever is active at the caret, the way Notes does.
- **Quick add did not fit at the medium detent with the keyboard up.** The
  When and Folder sections became one row of two menu buttons under the
  chips — Today, Tomorrow, No date, or the pickers on demand — so the
  summary is what fits and the pickers are for overriding it.
- **The calendar's toolbar was crowded in day view.** The chevrons went
  (swipe and the rotor page the grid); Today stays; the one-column day header
  that repeated the title is hidden in day view.
- **"Planned: 7 reminders" was a developer's number.** The row shows the next
  one instead, and the footer is one sentence.

And a second pass for what those turned up: the widget's rings take the same
priority tint as the list's, a successful quick add is felt as well as seen, a
trashed page can be swiped back as it was swiped away, an untitled page gets a
"Name this page" chip in the editor strip (the rename was otherwise a menu
away), and the notice bar is announced to VoiceOver, since a six-second bar at
the bottom of the screen is one a screen reader would only find by sweeping
down to it.

## Four more, read off the product vision

The README's pitch is local-first, no accounts, one-time purchase, capture in
a sentence, and "your data is a file". On a phone that is three tests: capture
is instant from anywhere, the promise about the file is visible rather than
asserted, and the whole thing stays calm. This pass is what those tests
turned up.

- **Capture without opening the app.** The Today widget's rings are buttons:
  a tap runs `CompletePageIntent` in the widget process and flips the page's
  status. That is the one write made outside the app, and it is the
  deliberate exception to the one-writer rule — the database layer's
  `retry_on_busy` and busy timeout were built for a desktop, a CLI and a sync
  poller sharing one file, and a single-row status flip is the smallest
  transaction there is. The same widget gained the three lock-screen sizes:
  the next two open pages with times, the open count, and one line beside
  the clock.
- **"Your data is a file", made checkable.** Settings › Your data shows the
  workspace's size on disk (database, sidecars and images together) and a
  "Back up to Files" button that writes a `VACUUM INTO` copy plus the assets
  directory into `Documents/Backups`, which `UIFileSharingEnabled` and
  `LSSupportsOpeningDocumentsInPlace` make visible in the Files app. The live
  database stays in the App Group container, which Files never shows. The
  privacy manifest gained the file-timestamp reason for the "Last backup"
  line.
- **The empty state teaches the grammar.** Today, Upcoming and the Inbox
  each offer a sentence under the New page button — "Call the dentist today
  at 3pm !high #health" and so on — that opens quick add with the line filled
  in, so the chips do the explaining. Every example was run through the Rust
  parser and lands in the view it is shown on. A brand-new workspace (the
  database file did not exist before the open) starts with one "Welcome to
  Pikos" page in the Inbox, in the product's voice. No onboarding screens:
  nothing to sign up for means nothing to ask.
- **Three fidelity fixes.** The calendar opens an hour above the red line
  when today is on screen, rather than at 7am. The page that was open when
  the app was put away comes back on the next launch, through
  `@SceneStorage`, within a four-hour window — after that the app keeps its
  promise to open on Today. Inbox rows swipe to Today or Tomorrow directly,
  since filing is the Inbox's job and a date picker per capture is not how
  an inbox gets cleared. (The hour height already scaled with Dynamic Type
  through `@ScaledMetric`; the recommendation that it should was wrong, and
  nothing changed there.)

Not done, and why: a share extension is a new target, not a refinement; and
the cross-device image path convention waits on iCloud sync, which will carry
the assets directory and settle it.

## Five widgets

One widget became five, each answering a question Today does not. Next Up
is the next scheduled page with a countdown that the system keeps current
(`Text(_:style: .relative)`), refreshed when that page's time arrives.
Inbox is a count at the small size and the pages at medium and large.
Upcoming is the week ahead from tomorrow, grouped by day at the large size.
New Page is a launcher: a `pikos://quick-add` button, with Today, Inbox and
Calendar tiles beside it at medium. All of them read through
`ReadOnlyWorkspace`, share one row, header and clock (`WidgetSupport.swift`),
and every ring is a `CompletePageIntent` button.

Two things surfaced doing it. The read-only workspace has no `listUpcoming`,
so the Upcoming and Next Up widgets run `listPages` with string bounds on the
schedule and sort by time themselves — the bounds are inclusive and an
all-day `2026-09-21` sorts before `2026-09-21T09:00`, so the upper bound is
the day after the last one wanted and the edge is trimmed in Swift. And the
app never asked WidgetKit to reload after its own writes — only the Siri
intent did — so a page ticked in the list stayed on the home screen until
the widget's hourly refresh. The debounced task that re-plans reminders on
every data version now reloads every timeline too, and the widget intent
reloads all timelines rather than only the tapped widget's, since the same
page can be on three of them.

A configurable per-folder widget was considered and left out: its background
tap would need a `pikos://folder/<id>` link, and the deep-link grammar is
shared with the desktop and pinned by a parity corpus, so that is a change
to both apps rather than to one widget.

## Reminders ring on the phone

The one parity gap that decided whether a task app is usable on a phone, and
the one the platform audit had said was "net-new logic on any path". Less new
than it sounded: the six `due_*` arms behind the desktop's scheduler already
took a window, they were just always handed a trailing 60-second one. Their
fixed windows are explicit `(lo, hi]` parameters now, behind the same
signatures the desktop calls, and `pikos_db::reminder_horizon` composes them
_forward_ over fourteen days and places every fire on the device's own clock —
a 15:00 Berlin meeting reminds a phone in New York at 08:30. Nine tests pin
the arithmetic, including that one.

The phone side is `ReminderScheduler`: one query, sixty requests at most
(the OS keeps sixty-four and drops the rest silently), rebuilt on every write,
on the way to the background, and by a `BGAppRefreshTask`. A tap opens the
page through the same `pikos://page/<id>` link a widget uses; a "Complete"
action writes through the same store method the checkbox does. Permission is
asked for the first time there is something to deliver, not at launch. Two
per-device preferences — on/off and the default lead, ten minutes like the
desktop — sit in the App Group with the others, and the settings row says
which of the two switches, ours or the system's, is the one that is off.

Two things are deliberately absent, both written down where they would be
looked for: quiet hours (Focus is the same control, system-wide) and the
desktop's fired log (the OS delivers without waking the app; the plan is
rebuilt from the workspace, so nothing needs the history).

One thing this found. `scripts/gen-swift-bindings.sh` reused whatever
`libpikos_ffi.so` was on disk, and `cargo test` never rebuilds a cdylib — so a
"regenerated" binding after a test-only session described the previous FFI,
and the call-site checker, which only ever inspected methods it knew, reported
every call matching while the Swift called two methods the bindings did not
declare. That was the state of the previous push. The script always builds
now, and the checker flags a `workspace.x(…)` it cannot find.

## The parser corpus is back on its reference

An earlier version of this section recorded that `parser.json` had been left as
a frozen capture of an older TypeScript, because regenerating it changed 238 of
2,219 cases and the work was on the Rust side. That work is done, and the
corpus is regenerated: 362 inputs, 2,534 cases, every one matching.

Three things were behind the gap, and all three are ported rather than
excluded:

- **RRULE serialisation.** The Rust wrote `FREQ;BYDAY;INTERVAL` and stamped
  `UNTIL` with a `Z`; the reference writes `FREQ;INTERVAL;BYDAY` and a floating
  `UNTIL`. Semantically identical, byte-different — and a rule the phone writes
  has to be byte-equal to the one the desktop would write for the same line,
  because a reconciler comparing them as text is the thing that notices.
  `to_rrule` follows `serializeRrule` field for field now, and says why.
- **The `//` body.** Everything after the first whitespace-delimited `//` is
  the page body, kept verbatim — no tag, folder, date or cadence is read out of
  it, so `#word` in a note stays literal. `ParsedInput` carries it as
  `content`, the FFI writes it as the page's document through the same builder
  the data layer uses for a synced description, and `Workspace::create_page`
  now derives the searchable text from any document it is handed, which it did
  not before: a page created with a body was a page full-text search could not
  see, on any path.
- **Reminders.** "remind 30m before", "remind me the day before", "!r1h". The
  phrase is stashed behind a control-character placeholder before the date
  engine runs, so a lead is never mistaken for the event's own date, and
  resolved afterwards against the schedule's shape: a timed page keeps the
  minutes, an all-day page collapses every lead onto the day-before sentinel,
  and a page with no date puts the words back into the title — a row on an
  unscheduled page could never fire. The sentinel is `pikos-db`'s; `pikos-core`
  cannot name it, so `pikos-ffi`, which depends on both, pins the two equal.
  The phone writes the rows; nothing on the phone fires them yet, which is the
  notifications work still ahead — but a reminder typed on the phone now rings
  on the desktop.

Two other corpora moved in the same regeneration. `views.json` changed only in
key order. `recurrence.json` changed one snap case, where the reference no
longer moves an anchor that names an hour and minute onto the rule's weekday;
the Rust agreed with the new answer already, so the case is a tightened pin
rather than a fix.

## The design pass (2026-09-14)

A read of the phone app against what the platform and its peers now expect —
`08-design-review.md` has the review itself and the sources. The short
version: the app already had most of the idioms right, and what it lacked
was _placement_ and _system reach_. Twelve changes, all Swift, no FFI:

- The create button floats at the bottom, in reach of the thumb, with
  Liquid Glass on iOS 26 and a material circle before it; the corner pencil
  is gone. It shares the bottom with the notice bar through one overlay.
- The tab shell is the `Tab` form on iOS 18, with the search tab in the
  search role and the bar minimizing on scroll where iOS 26 offers both;
  iOS 17 keeps `tabItem`. Every iOS 26 symbol is behind `#if compiler(>=6.2)`
  _and_ `#available`, so Xcode 16 and 26 both build the tree.
- A ticked row holds for a beat before the list re-reads, and a run of
  ticks holds once. Reduce Motion is read wherever something slides.
- Select mode: a corner menu (which also took Manage Folders and the trash,
  leaving the title menu to switching), selection circles, and a bottom bar
  of Complete, Schedule, Move and Delete, each one store call with one
  notice — Delete's with an undo for the batch.
- The day view has a week strip with dots, and a long press on empty grid
  opens quick add already set to that slot. Quick add has a priority chip.
- Search remembers the last eight searches and completes operators from the
  reader's own folders and tags.
- Two TipKit cards, one a day, for the two invisible gestures.
- Pages are in Spotlight; Control Center has a New Page button (iOS 18); the
  focus timer runs in the Dynamic Island as a Live Activity.
- A folder or the Inbox can be sorted — manual, date, title, priority — with
  the desktop's rules and per-view memory. The home page names sorting as a
  feature and the matrix had the phone at ⚠️ for it; the rules are in
  `PikosSupport.PageSort` with host tests. Changing a _manual_ order still
  waits on a reorder call across the FFI.

Left for later and written down in the review: drag-to-place on the button,
drag reordering (needs a reorder call across the FFI), an evening bucket, a
deadline distinct from the date, Spotlight _actions_, Focus filters, the
share extension.

## Needs a Mac

Nothing here is blocked on design — only on hardware.

1. `bash scripts/build-ios-framework.sh` — builds the XCFramework `PikosCore`
   needs. Also regenerates the bindings so they match the build.
2. `bash scripts/build-editor-bundle.sh` — builds the editor (runs anywhere,
   but the result is only useful with the rest).
3. `swift test --package-path apps/ios/PikosCore` and the same for
   `PikosEditorBridge` — the boundary tests, unrun.
4. **Run M0 on a physical device** and record the numbers. `03-m0-spike.md` has
   the method for each item on the pass bar, and `EditorScreen` shows the
   cold-load time in the navigation bar on debug builds so one of them needs no
   instrumentation at all.

## What to expect on the first build

Nothing here has seen a Swift compiler, so expect the first build to be a
session of its own. What has been done instead:

- **Call sites are checked against the bindings.** `pnpm check:ios-ffi` compares
  every `NewPage(…)`, `PageEdit(…)` and `workspace.x(…)` in the app against the
  generated Swift — labels must exist, and Swift requires them in declaration
  order. 53 call sites, all clean. It runs in CI, so it cannot rot.
- **The Swift was read adversarially instead of compiled.** Two passes now. The
  first found, among others: a `.sheet` whose `onDismiss` cannot be a second
  trailing closure because it is declared before `content`; two main-actor
  helpers called from non-isolated code; a missing `dismantleUIView` leaking a
  message handler; and a SwiftUI feedback loop where the parse writing to a
  control fired the same `onChange` that records a manual override.

  The second pass covered everything the first had not, and found seven more.
  Three were behavioural and would have shipped looking like something else:
  - **The scheme handler crashed on a cancelled load.** WebKit raises
    `NSInternalInconsistencyException` — not an ignored call — if a response is
    delivered to a task it has already stopped, and `stop` did nothing but
    carry a comment claiming the task was checked. Scrolling a page of images
    fast enough is all it takes. Live tasks are tracked now, and three tests
    cover it.
  - **The checkbox's 44pt touch target was inert.** `contentShape` describes
    the view it is applied to, and it sat _before_ the frame that enlarged it —
    so the hit area stayed the 17pt glyph. The comment above it was about
    exactly this and the order defeated it.
  - **"Open today" did nothing to an app already running.** `Route.showToday()`
    has no store to move — it runs from an intent's `perform()`, which has no
    view — so it records the request, and only the launch-time `.task` ever
    applied one. `RootView` watches `pendingScope` now.

  Two were correctness under the seams:
  - **Quick add parsed against one clock and saved against another.**
    `createFromQuickAdd` takes a reference time for the stated reason that a
    line typed at 23:59 must not resolve to a different day — and the sheet let
    it default. The parse's own reference is carried through now.
  - **The asset handler decoded percent-escapes twice.** `URL.path` decodes
    already, so an image named `50%.png` resolved to a file that does not
    exist, and `%252e%252e` survived the first pass to become `..` on the
    second — caught today only by the root check underneath it.

  Two were cost rather than correctness: a `DateFormatter` built two or three
  times per row per frame in the page list, and Shortcuts entity queries
  opening a _writable_ handle to populate a picker, against the one-writer rule
  the file they live in is entirely about. `ReadOnlyWorkspace` gained
  `listFolders` so the folder picker could use it.

- **The Swift tests now run on the host.** Both packages, in seconds, no
  simulator — see `apps/ios/README.md`. That is what made the controller
  testable at all: it talks to an `EditorMessageSink` rather than naming the
  representable's coordinator, so a test double can drive it.

- **What none of this can find** is the rest: wrong types, missing `await`, and
  strict concurrency. `SWIFT_VERSION: 6.0` with
  `SWIFT_STRICT_CONCURRENCY: complete` means those are errors, not warnings, so
  expect them to be most of the first build. Three suspects, written down so
  the session is a checklist rather than an exploration:
  1. **`EditorWebView.Coordinator`** conforms to `EditorMessageSink`
     (`@MainActor`) as well as `WKScriptMessageHandler` and
     `WKNavigationDelegate`. If WebKit's delegate protocols are audited as
     main-actor in the SDK in use, this lines up; if not, the conformances
     disagree and the coordinator needs `nonisolated` methods that hop.
  2. **`TodayProvider`** calls WidgetKit's completion handlers from inside a
     `Task`. _Addressed in the quality pass_: the handlers travel in a
     sendable box. If the SDK in use declares them `@Sendable` already, the box
     is redundant and harmless.
  3. **`AppDependencyManager.shared.add { Route.shared }`** reads a main-actor
     singleton from a closure whose isolation depends on that API's signature.
     _Addressed_: `Route.shared` is `nonisolated(unsafe)`.

  Note that both Swift packages declare `swift-tools-version: 5.9`, so they
  build in Swift 5 mode regardless of the app's setting — suspects 1 and 2 are
  warnings there and errors only where app code touches them.

  The design pass added a fourth set, listed at the end of
  `08-design-review.md`: the compiler-gated iOS 26 blocks in
  `Support/Platform.swift`, the two `Tab` initialisers under `#available(iOS
18)`, `List(selection:)` beside the row's invisible link, the sequenced
  long-press gesture on the calendar grid, `Activity.request` in the focus
  timer, and the `#available` around the Control Center control in the widget
  bundle.

## iPad is a later milestone, not a later decision

iPhone and iPad ship as one universal purchase, and the iPad build is meant to
feel like the desktop app rather than a stretched phone — a folder sidebar, a
list, and an editor beside it, with the calendar as the screen that gains most
from the width. None of that is being built yet. What matters now is only that
building it later stays a change of shell rather than a rewrite.

Three things follow, and they are the whole of it:

1. **The shell owns navigation; screens are content.** `PageListScreen` and
   `SearchScreen` hold no `NavigationStack` and declare no
   `navigationDestination` — `RootView` does, and the paths live on `Route`.
   The iPad build replaces `RootView` with a `NavigationSplitView` reading
   `pagesPath.last` as its detail selection, and both screens are untouched.
   This was not free-standing tidiness: a screen owning its own stack is also
   why `pikos://page/<id>` did nothing, since a deep link had no path to push
   onto. Fixing one fixed the other.
2. **`TARGETED_DEVICE_FAMILY` is `"1,2"`, explicitly.** It is the Xcode
   default, so stating it is redundant until someone narrows it to `"1"` on the
   reasonable-sounding grounds that the UI is phone-shaped. That would make the
   iPad build a new SKU instead of an update, which is the one mistake here
   that cannot be taken back.
3. **Nothing platform-specific goes in the Rust.** Already true, and worth
   keeping true for a reason that is about to matter: the calendar's _layout_
   is shared and its _pixel mapping_ is deliberately not, because density
   tables and text-collision heuristics encode one renderer's font metrics.
   iPad will want metrics closer to the desktop's than to the phone's, which
   is exactly why that line was drawn where it is.

What is explicitly **not** being done now: size-class branching, a split-view
shell, multi-window (`UISceneConfiguration`), keyboard shortcuts, pointer and
hover, `.systemExtraLarge` widgets, or Stage Manager. Adding any of them early
would be guessing at a design nobody has drawn.

## Next, in order

1. **M0.** It gates everything else, and the plan is explicit that a failed
   spike stops the project rather than being worked around. The work done so
   far was deliberately shaped so that a failure discards only
   `packages/editor-mobile` and `PikosEditorBridge` — the Rust port, the FFI
   boundary and the shared schema survive any of the three fallback options.
2. **Compile the Swift.** The app, both packages and their tests are written
   and unbuilt. Expect strict-concurrency work; `apps/ios/README.md` has the
   first-run sequence.

## Corrections made to the plan

Recorded so the plan can be updated rather than quietly diverged from.

- **`core-rs` already existed.** It is `crates/pikos-db` — Tauri-free and
  already shared with the CLI. M1's data half was a UniFFI binding, not a port.
- **The port order was backwards.** The plan led with schema, CRUD and search,
  all of which were done. It should have led with the parser and recurrence,
  which the Rust CLI was shelling out to Node for.
- **The portable surface was overstated.** Calendar layout was counted at
  ~1,270 lines; the genuinely portable half is ~500. Pixel mapping, density
  tables and the text-collision heuristic encode one renderer's font metrics
  and must not be shared.
- **Locale does not port.** `sort.ts` (Intl.Collator) and `formatDateRange.ts`
  (English month names) were listed as portable and are not. iOS has better
  answers to both.
