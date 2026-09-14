# The first device session

What to do with the phone once the app builds, in the order that fails fastest.
Everything here is a check the status doc lists as "needs a Mac"; the code is
arranged so each one is a row to read rather than an instrument to attach.
Written 2026-09-14.

## Before the phone

1. `bash scripts/build-ios-framework.sh`, `bash scripts/build-editor-bundle.sh`,
   `cd apps/ios/Pikos && xcodegen generate`.
2. Set `DEVELOPMENT_TEAM`, enable App Groups (`group.app.pikos`) on the app and
   the widget. `WorkspaceLocation` throws on launch if the group is unreachable,
   so a wrong team shows up as the first screen rather than as an empty widget
   three weeks later.
3. `swift test --package-path apps/ios/PikosCore` and the same for
   `PikosEditorBridge`. Both run on the Mac without a simulator.

Expect the first build to be strict-concurrency work. The three suspects the
status doc lists are addressed; what remains is whatever the SDK in use audits
differently.

## M0, the go/no-go

`docs/ios/03-m0-spike.md` has the method for each item on the pass bar. The
short version, on an iPhone 12-class device or slower, not the simulator:

| Check            | Where to look                                                                                                      | Pass                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Cold load        | Open a page. The debug toolbar shows the editor's ready time in ms beside the page menu.                           | Under 300 ms on the second open; the first open pays for the webview process. |
| Keyboard         | Tap into the document. The formatting bar should rise with the keyboard, and the hide-keyboard button put it away. | No gap between bar and keyboard; no bar left behind after dismissal.          |
| Scroll-in-scroll | A page longer than the screen: scroll to the end and past it.                                                      | The document scrolls; nothing behind it moves; no rubber-band on the shell.   |
| Typing latency   | Type a paragraph quickly.                                                                                          | No visible lag; the title in the list updates when you go back.               |
| Read-only        | There is no page a newer schema wrote yet. Skip, or hand-edit `content_schema_version` on one row to 999.          | The banner shows and the surface refuses the keyboard.                        |

A failed M0 stops the project rather than being worked around — the plan is
explicit about that, and the fallbacks are in `03-m0-spike.md`.

## The lock-screen check

The widget refreshes while the phone is locked, which is exactly when the
strictest data-protection class makes the database unreadable. The app sets
`.completeUntilFirstUserAuthentication` on the database and both sidecars after
every open; whether iOS honoured it has never been observed.

1. Settings → the **Diagnostics** section (debug builds only). Every file row
   should read "until first unlock ✓". A row reading "complete" is the bug the
   class exists to prevent; "absent" for `-wal` or `-shm` is normal before the
   first write.
2. Add the Today widget to the home screen. Lock the phone. Wait past the next
   hour boundary, or just leave it ten minutes.
3. Unlock. The widget should show today's pages, not "Can't read your notes".
   Then re-open Settings: the rows should be unchanged.

If step 3 fails while step 1 passed, the class is right and the widget's
container is wrong — check the App Group on the widget target, not the app.

## While the phone is out

Cheap, and each one has caught something on other apps:

- Rotate to landscape on the calendar and the editor.
- Settings → Accessibility → Larger Text at the largest accessibility size:
  the page list, the calendar's day header, and the formatting bar.
- VoiceOver on: swipe through the calendar. Blocks should read as one element
  each with their verbs on the rotor; the hour labels should not be visited.
- Say "Add a page to Pikos" to Siri, then open the app. The page should be
  there without a pull-to-refresh.
- Type `Dentist tomorrow at 3pm remind 30m before // bring the card` into quick
  add. The chips should show the time, the reminder and a note; the page's
  document should hold the note.
- Add the Today widget at the medium size with a page due today, then tap its
  ring from the home screen. The ring should fill without the app opening, and
  the row should be under Completed when the app is next opened. This is the
  one write the widget process makes (`PikosWidgets/CompletePageIntent.swift`);
  if it fails, the symptom is a ring that dims and springs back.
- Add "Today" to the lock screen in the rectangular slot. It should show the
  next two open pages with their times; the circular one the open count.
- Add the other four widgets: Next Up should count down to the next timed page
  and tick over by itself as the minutes pass; Inbox (small) should show a
  number; Upcoming (large) should have a heading per day starting tomorrow;
  New Page should open quick add on tap and, at medium, its three tiles should
  land on Today, Inbox and the calendar. Tick a ring on the app's list, then
  go back to the home screen: every widget showing that page should have
  updated within a second or two, not at the next hour.
- Settings › Your data › Back up to Files, then open the Files app: On My
  iPhone › Pikos › Backups should hold a dated folder with `pikos.sqlite` and,
  if a photo was inserted, `assets`. The "Last backup" line should say Today.
- Open a page, swipe the app away, reopen within a few minutes: it should land
  on that page. Reopen the next morning: it should land on Today.
- Open the calendar on a day view of today: the red line should be near the
  top of the screen, not the 7am rule.
- On a fresh install, the Inbox should hold "Welcome to Pikos" and Today should
  be empty with a "Try …" line under the New page button. Tapping it should
  open quick add with the chips already drawn.
- The floating `+` at the bottom right of Pages and Calendar: on iOS 26 it
  should be glass and bounce under the thumb; on 18 a frosted circle. Delete
  a page with a swipe: the notice bar should slide in _under_ the button and
  push it up, not cover it. Scroll a long list to the end: the last row
  should clear the button.
- iOS 26 only: scrolling a long list down should shrink the tab bar to a
  pill; tapping the Search tab should put the search field at the bottom
  where the tab bar was.
- Tick three rows quickly. They should stay ticked where they are for about
  a second and then move to Completed together. Untick one inside that
  second: it should simply stay.
- Settings → Accessibility → Motion → Reduce Motion on: paging the calendar
  should dissolve rather than slide, and the notice bar should fade in.
- ··· → Select Pages: the tab bar and the `+` should go, the rows should gain
  selection circles, and the bottom bar's four verbs should be disabled until
  a row is ticked. Select two and Delete: one confirmation, one notice with
  Undo, both pages back after it.
- Calendar, day view: a strip of seven days above the grid with a dot under
  any day holding a page; tapping one should switch the day. Hold a finger on
  an empty half-hour: a medium haptic, then quick add with that day and time
  already in its When chip. Type a title and Add: the block should appear at
  that slot.
- In a folder, ··· → Sort by → Priority: urgent rows first, undated rows of a
  tier after dated ones, "none" last. Switch to another folder and back: the
  choice should hold; Today should offer no Sort at all.
- Quick add: the Priority chip should show "Priority" until the line says
  `!high` or the chip is used, and the chip's choice should win over the
  line's.
- Search: with an empty field, the last searches should be listed under it
  (after at least one has been _submitted_ with the return key); typing
  `fol` should offer `folder:` completions naming real folders; `tag:` the
  tags on open pages.
- Pull down on the home screen and type a page's title: it should appear
  under Pikos within a few seconds of the page being written, and tapping it
  should open the page.
- iOS 18+: add "New Page" to Control Center. Tapping it should open the app
  on quick add.
- Open a page, tap the timer, lock the phone: the lock screen should show the
  session counting up; on a phone with a Dynamic Island, the island should
  show a timer glyph and the clock. Tap it: the page should open. Stop the
  timer: the island should clear at once.
- The first launch of the day should show one tip card at the top of the
  list; the next day the other. Neither should appear in a UI test run.

## What to write down

Cold-load times (first and second open), the device, and the iOS version, as a
results table under "The pass bar, and how to measure each item" in
`03-m0-spike.md`. There is no such table yet because nobody has had a phone
and a build at the same time.
