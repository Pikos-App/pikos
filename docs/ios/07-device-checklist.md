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

| Check                                             | Where to look                                                                                                      | Pass                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Cold load                                         | Open a page. The debug toolbar shows the editor's ready time in ms beside the page menu.                            | Under 300 ms on the second open; the first open pays for the webview process. |
| Keyboard                                          | Tap into the document. The formatting bar should rise with the keyboard, and the hide-keyboard button put it away. | No gap between bar and keyboard; no bar left behind after dismissal.          |
| Scroll-in-scroll                                  | A page longer than the screen: scroll to the end and past it.                                                      | The document scrolls; nothing behind it moves; no rubber-band on the shell.   |
| Typing latency                                    | Type a paragraph quickly.                                                                                          | No visible lag; the title in the list updates when you go back.               |
| Read-only                                         | There is no page a newer schema wrote yet. Skip, or hand-edit `content_schema_version` on one row to 999.          | The banner shows and the surface refuses the keyboard.                        |

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

## What to write down

Cold-load times (first and second open), the device, and the iOS version, as a
results table under "The pass bar, and how to measure each item" in
`03-m0-spike.md`. There is no such table yet because nobody has had a phone
and a build at the same time.
