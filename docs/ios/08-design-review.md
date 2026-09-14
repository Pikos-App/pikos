# Pikos iOS — a design review, and the pass it led to

Written 2026-09-14, against the `rc` branch merged with the widget and
reminder work. Two halves: what a productivity app on an iPhone is expected
to feel like in 2026, and how the phone app measured against it. The pass
that followed is recorded at the end, with what it left alone and why.

The research underneath this — Apple's WWDC25/26 sessions on the new design
system, the App Store accessibility criteria, and the help pages of Things,
Todoist, Reminders, Notes, Fantastical and Structured — is summarised here
rather than reproduced; the sources are listed at the bottom.

## 1. What "modern" means on an iPhone this year

### The platform moved the primary actions to the bottom

iOS 26 is the first redesign of the system since 7, and the part of it that
matters to a task app is not the glass but the _layout_ that came with it.
Search is at the bottom in Mail, Notes and Messages. Compose is in the bottom
bar. The tab bar shrinks to a pill as a list scrolls and grows back on the way
up, so the content is what fills the screen. The reason is stated plainly in
the sessions: the bottom third of a modern phone is the only third a thumb
reaches without shifting grip, and the top corners are the farthest points
from it.

The APIs that express this are all `iOS 26` only — `Tab(role: .search)` putting
the search field where the tab bar was, `.tabBarMinimizeBehavior`,
`.glassEffect` for a custom floating control, `.buttonStyle(.glassProminent)`,
`ToolbarSpacer` and `.searchToolbarBehavior(.minimize)` — and Apple's own
adoption advice is to build with the new SDK, remove custom backgrounds behind
bars and sheets, and reserve glass for the navigation layer: never on content,
never glass on glass. The system handles Reduce Transparency, Increase
Contrast and Reduce Motion for its own glass; an app that draws its own has to.

### The peers agree on a small set of patterns

Read together, Things, Todoist, Reminders, Notes, Fantastical and Structured
converge on the same answers:

| Question                 | The consensus                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where is "new"?          | A floating `+` bottom-right (Things' Magic Plus, Todoist), or beside the minimized tab pill (Structured, Apple's iOS 26 layouts). Never only in a top corner.                                      |
| What does a row carry?   | Title and one line of metadata — a date chip, a project or folder, a flag. Everything else is on the detail. Checkbox glyph ~28pt inside a 44pt target.                                            |
| What happens on a tick?  | A spring fill, one `.success` haptic, and the row _lingers_ — about a second in Things, until the list is left in Reminders — so the tick can be seen and a mis-tap taken back. Then an Undo path. |
| Swipes?                  | Leading = complete (or flag); trailing = schedule and delete, with full-swipe on the primary one. Todoist lets people reassign them.                                                               |
| Dates?                   | Quick rows (Today, Tomorrow, This weekend, Next week) above a compact month grid, in a medium-detent sheet. A wheel only for the time.                                                             |
| Several at once?         | A select mode with a bottom bar of verbs — Move, When, Tags, Delete in Things; the same four in Mail.                                                                                              |
| Teaching?                | No onboarding. Empty states with a call to action; gestures taught in place, once.                                                                                                                 |
| Search?                  | Bottom-aligned on iOS 26; recents and completion tokens under the field.                                                                                                                           |
| The calendar's day view? | A tappable week strip with dots above the day column (Apple Calendar, Fantastical's DayTicker, Todoist's Upcoming); long press on an empty slot creates there.                                     |
| The editor?              | A horizontally scrolling formatting bar above the keyboard, one "Aa" for the rarer controls, chrome that hides while reading (Notes 26, Bear, Notion).                                             |

### The system surfaces that count

Ranked by what they return for a task-and-calendar app: App Intents (one
intent powers Shortcuts, Spotlight, widgets, controls and the Action button),
App Shortcuts, interactive widgets with lock-screen sizes, a Control Center
control for "new", Live Activities only for something _bounded_ (a focus
timer, a meeting starting), Spotlight indexing so the home screen's search
finds pages, and Focus filters. Watch and CarPlay only if there is a Watch app.

### The accessibility bar has a label on the store page

App Store listings now carry Accessibility Nutrition Labels, with published
criteria per feature. The ones a list app trips on: every icon-only button
labelled; swipe- and long-press-only verbs also exposed as rotor actions; text
scaling past 200% without truncating what the detail does not show; 4.5:1 text
contrast tested with Increase Contrast and Reduce Transparency both ways;
Reduce Motion replacing slides with dissolves; and a second cue beside every
colour that carries meaning.

## 2. Where Pikos mobile stood

The app was read screen by screen against the table above. It was in better
shape than most first phone apps: native by construction, and most of the
platform's idioms already in place.

**Already right.**

- The title is the view switcher, the way Files and Notes do it; the list has
  swipes on both edges with the right verbs on each; every row has a context
  menu mirroring the desktop's right-click; the ring is a 44pt target tinted by
  priority; a tick is felt (`.sensoryFeedback(.success)`); the Inbox swipes
  straight to Today or Tomorrow.
- One notice bar for every "done — undo?" moment, announced to VoiceOver.
- Quick add parses as you type, shows what it understood as chips, and keeps
  native pickers beside the sentence. The empty states teach the grammar with
  a sentence that opens the sheet already filled in. No onboarding, by design,
  with a welcome page in the reader's own product's voice.
- The editor's formatting bar rides the keyboard, shows the five controls a
  phone reaches for, and puts the rest behind "Aa" with the active one ticked;
  the metadata strip folds away while typing.
- The calendar pages by swipe with the same moves on the rotor, tints blocks
  by folder colour, and its long press offers the per-occurrence verbs the
  desktop has — including the backlog scope question.
- Five widgets with interactive rings, three lock-screen sizes, App Intents
  and Siri phrases, reminders as planned local notifications, background
  refresh, and a debug diagnostics screen for the first device session.
- Dynamic Type is respected where it bites (the hour height scales; day
  headers shrink before wrapping); the hour gutter is hidden from VoiceOver;
  blocks are one element each with their verbs as actions.

**Where it fell short of the table.**

| Gap                                                                                                                | Severity                     | Why it matters                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| "New page" was a pencil in the top-right corner.                                                                   | High                         | The headline feature lived at the farthest point from the thumb. Every peer puts it at the bottom.                       |
| The tab shell was the iOS 17 form: no search role, no minimize, top-of-screen search on the Search tab.            | Medium                       | On iOS 26 the app would look like a port; on 18 it looks fine. Fixable without dropping 17.                              |
| A ticked row vanished the instant it was tapped.                                                                   | Medium                       | Nothing to confirm the tick by eye, no beat to take a mis-tap back; a run of ticks reshuffled the list under the finger. |
| No select mode.                                                                                                    | Medium                       | Clearing an inbox of twenty captures was twenty swipes. Things, Mail and Reminders all have the bottom-bar verbs.        |
| The day view had no way to a specific day but paging, and no way to create _at a time_.                            | Medium                       | The desktop's "click a slot to create" had no phone equivalent, and Apple's own day view has a week strip.               |
| Search remembered nothing and completed nothing.                                                                   | Medium                       | Operators were on a legend nobody would read twice; the reader's own folders and tags were not offered back.             |
| Quick add had no priority control.                                                                                 | Low                          | The line could say `!high`; a person who did not know that had no chip. Todoist's row has one.                           |
| Reduce Motion was never read.                                                                                      | Low (but on the store label) | The calendar's push transition and the list's slides played regardless.                                                  |
| No in-place teaching of the two invisible gestures.                                                                | Low                          | Swipes and the title menu have no affordance; the platform's own answer is one TipKit card each.                         |
| Pages were not in Spotlight; no Control Center control; the focus timer was invisible once the phone was put down. | Low each                     | The three cheapest system surfaces for this kind of app, all missing.                                                    |

Not gaps, and left alone: the formatting bar (already the Notes 26 shape),
the notice bar's single implementation, the empty states, the swipe verbs,
the priority ring (colour _plus_ the accessibility value names the level,
which satisfies "not by colour alone"), and pull-to-refresh (there is a sync
now, so it earns its place).

## 3. What the pass changed

Everything below is Swift only; the FFI did not move.

1. **A floating create button** (`Support/NewPageButton.swift`) bottom-trailing
   on Pages and Calendar, replacing the corner pencil. Liquid Glass with the
   interactive bounce on iOS 26, a material circle before that. It shares the
   bottom of the screen with the notice bar through one overlay
   (`bottomChrome`), so a notice pushes the button up rather than hiding under
   it, and the lists keep a bottom margin so the last row scrolls above it.
2. **The modern tab shell.** `Tab(...)` on iOS 18 with the search tab in the
   search role — on iOS 26 that is what puts the search field where the tab
   bar was — and `.tabBarMinimizeBehavior(.onScrollDown)`. The `tabItem` form
   remains for iOS 17. Every iOS 26 API sits behind
   `#if compiler(>=6.2)` _and_ `#available(iOS 26)` (`Support/Platform.swift`),
   so the tree builds in Xcode 16 and 26 alike.
3. **The completion hold.** A ticked row stays, ticked, for about 850ms before
   the list re-reads; a run of ticks holds once and moves together. Any other
   write refreshes at once and cancels the hold.
4. **Reduce Motion.** The calendar's push becomes a dissolve, the list's row
   slides stop, the notice fades, the week strip's selection does not animate.
5. **Select mode.** "Select Pages" under a new corner menu (which also took
   Manage Folders and Recently Deleted from the title menu, so the title menu
   only switches views). Rows gain the list's selection circles, the tab bar
   and the floating button step aside, and a bottom bar offers Complete,
   Schedule (Today / Tomorrow / Clear), Move (Inbox or a folder) and Delete,
   each one store call that refreshes once and says what it did. Delete asks
   first; its notice carries an Undo for the whole batch.
6. **The day view's week strip** (`Calendar/WeekStrip.swift`): seven days,
   one tap each, a dot under any day holding something, the reader's own week
   start, today in the accent, the selection filled. And a **long press on
   empty grid** opens quick add already set to that slot, snapped down to the
   half hour — the desktop's "click a slot" on a phone. The snapping is in
   `PikosSupport.CalendarGeometry` with host tests.
7. **Quick add** gained a priority chip beside When and Folder, and accepts a
   prefilled time from the calendar that counts as a choice already made.
8. **Search** offers the last eight searches back (remembered only when a
   search is run, kept in the App Group with a clear action, host-tested) and
   completes `tag:`, `folder:`, `is:`, `priority:` and `due:` from what
   actually exists — the reader's folders and the tags on their open pages.
9. **Two TipKit cards** at the top of the list — swipe a row; the title is a
   menu — one a day, dismissable, hidden under the UI tests.
10. **Spotlight** indexes every open page's title, subtitle, tags and date a
    few seconds after any write; a result opens the page through the same
    `pikos://page/<id>` link a widget uses; "Delete all data" clears it.
11. **A Control Center "New Page" control** (iOS 18) that opens the app on
    quick add through the `pikos://quick-add` link, in the widget bundle under
    `#available`.
12. **The focus timer is a Live Activity**: the Dynamic Island and lock screen
    count the session up from the same start instant the in-app clock uses,
    and a tap opens the page. No stop button on the island, by the one-writer
    rule; it ends with the session.

## 4. Left for another pass, and why

- **Drag-to-place on the create button** (Things' Magic Plus dragging into a
  list position or onto a day). A delighter, not a baseline, and it needs a
  drop-target model the list does not have.
- **Reordering by drag** in a folder. `sort_order` is on the summary but no
  reorder call crosses the FFI yet; iOS 27's `.reorderable()` makes this
  cheap once it does.
- **A "This Evening" bucket** in Today. Things' pattern; it needs a rule for
  what "evening" means that the desktop does not have either.
- **Deadline as distinct from scheduled date.** A data-model question for both
  apps, not a phone one.
- **Rich `IndexedEntity` App Intents** (Spotlight _actions_ on pages, iOS 26).
  The Core Spotlight index covers finding; actions can follow the intents.
- **Focus filters** and a **share extension**: both new targets rather than
  refinements.
- **Widget accented rendering mode** for iOS 26's tinted home screens: worth a
  glance on a device before deciding whether the rings need
  `.widgetAccentedRenderingMode`.

## 5. For the first build

None of this has seen a compiler. Beyond the suspects `00-status.md` already
lists, the new code adds these to check first:

- `Support/Platform.swift` — the `#if compiler(>=6.2)` blocks are the only
  place iOS 26 symbols appear. In Xcode 16 they are skipped entirely; in Xcode
  26 they must resolve (`glassEffect(_:in:)`, `.glassProminent`,
  `tabBarMinimizeBehavior`, `searchToolbarBehavior`).
- `RootView` — `Tab(value:role:)` and `Tab(_:systemImage:value:)` under
  `#available(iOS 18)`; the `tabItem` branch under it.
- `PageListScreen` — `List(selection:)` with `.tag` on rows that also carry an
  invisible `NavigationLink`; the `editMode` environment set from state.
- `CalendarGrid.slotPress` — a `LongPressGesture` sequenced with a
  zero-distance `DragGesture` for the location; check the scroll view still
  wins a vertical pan.
- `FocusTimer` — `Activity.request` under strict concurrency; the activity is
  held in `@State` on the main actor.
- `PikosWidgetBundle` — `if #available` around the control relies on
  `WidgetBundleBuilder.buildLimitedAvailability`; `NewPageControl` returns
  `OpenURLIntent`, iOS 18.
- `SpotlightIndexer` — `CSSearchableItemAttributeSet(contentType: .text)` needs
  `UniformTypeIdentifiers`, imported.

## Sources

Apple: WWDC25 219 _Meet Liquid Glass_, 323 _Build a SwiftUI app with the new
design_, 356 _Get to know the new design system_, 278 _What's new in widgets_,
260 and 275 on App Intents; WWDC26 269 _What's new in SwiftUI_; App Store
Connect accessibility evaluation criteria (VoiceOver, Larger Text, Sufficient
Contrast, Reduced Motion). Peers: Things support and blog (Magic Plus,
gestures, the August 2026 repeating change), Todoist help (Quick Add, swipes,
Upcoming, Controls), Apple Reminders and Notes iOS 26 coverage, Flexibits'
Fantastical help, Structured's iOS 26 post, Bear and Notion help. Method:
NN/g on empty states, thumb-zone research after Hoober, LogRocket on touch
targets.
