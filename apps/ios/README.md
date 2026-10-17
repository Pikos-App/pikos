# Pikos for iOS

Three pieces:

| Directory           | What it is                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `PikosCore`         | Swift package over the shared Rust logic (`crates/pikos-ffi`). Generated bindings, committed. |
| `PikosEditorBridge` | The WKWebView host for the shared Tiptap editor, and the generated wire protocol.             |
| `Pikos`             | The app. SwiftUI, generated Xcode project.                                                    |

## First run

Two of the inputs are build artifacts and are not committed — a multi-megabyte
binary and a bundled web page. Produce them first:

```bash
# 1. The XCFramework PikosCore links against. macOS only: cross-compiling to
#    Apple targets needs the Apple linker, and create-xcframework has no Linux
#    equivalent. Also regenerates the Swift bindings so they match the build.
bash scripts/build-ios-framework.sh

# 2. The editor. Runs anywhere Node runs.
bash scripts/build-editor-bundle.sh

# 3. The Xcode project, from project.yml.
brew install xcodegen        # once
cd apps/ios/Pikos && xcodegen generate
```

Then set `DEVELOPMENT_TEAM` in Xcode (deliberately blank in `project.yml`, since
it is a local setting) and enable the **App Groups** capability with
`group.app.pikos` on every target. `WorkspaceLocation` throws rather than
falling back to the app's private container if that group is unreachable — a
silent fallback would work perfectly in the app and leave widgets reading an
empty database, which looks like a widget bug for weeks before anyone suspects
provisioning.

## Tests

```bash
swift test --package-path apps/ios/PikosCore
swift test --package-path apps/ios/PikosEditorBridge
```

Both run on the host, in seconds, rather than through a simulator — which took
a little arranging and is worth knowing so it does not get undone. `swift test`
builds for macOS, so `PikosCore`'s XCFramework carries macOS slices alongside
the device and simulator ones (`scripts/build-ios-framework.sh`), and
`EditorWebView` — the only UIKit-bound file in `PikosEditorBridge` — is behind
`#if canImport(UIKit)`. Nothing under test touches a webview: the controller
talks to an `EditorMessageSink`, which the coordinator conforms to and a test
double stands in for.

Step 1 of **First run** is a prerequisite for the first and step 2 for the
second — `Bundle.module` will not compile against a resource that is not there
yet, and the failure names the file rather than the reason.

`PikosCore` has two targets: `PikosCore` (generated bindings, overwritten by
`scripts/gen-swift-bindings.sh`) and `PikosSupport` (hand-written, shared by the
app and the widget — it is where the App Group path is decided, and the app and
its extensions disagreeing about that would mean a widget reading a different
database).

`PikosCore`'s tests cover the FFI boundary — optionals that must stay nil,
unsigned counts that must not wrap, enum payloads, UTF-8, and the workspace's
async and read-only behaviour. `PikosEditorBridge`'s cover the wire protocol's
encoding and the scheme handler's path handling, including traversal attempts.

`PikosSupport` also holds `DayLabel`, which names a `YYYY-MM-DD` for a reader —
and the trap its tests exist for: a `YYYY-MM-DD` is always proleptic Gregorian
because that is what SQLite holds, so a device set to the Buddhist calendar must
not write 2569 into a key that then matches no row.

`PikosSupport`'s need nothing linked at all — no XCFramework, no database, no
device — which is why the arithmetic worth testing is put there rather than in
the app: `CalendarGeometry` (a stored wall clock to a position on screen) and
`StorageTimestamp` (the UTC instant columns, which are _not_ the same format as
the scheduling ones, and were briefly read as if they were).

The editor's own behaviour is tested separately and more thoroughly, in a real
browser: `pnpm --filter @pikos/editor-mobile test:e2e`.

## Testing

Three layers, and the cheapest one carries the most:

| Layer                                        | Where                                            | Needs                         |
| -------------------------------------------- | ------------------------------------------------ | ----------------------------- |
| The logic under the Swift                    | `crates/`                                        | nothing — runs on any machine |
| `swift test` for the packages                | `PikosCore`, `PikosSupport`, `PikosEditorBridge` | a Mac; **no simulator**       |
| `xcodebuild test -only-testing:PikosUITests` | the tier-1 flows                                 | a Mac and a simulator         |

`PikosSupport` exists partly for the middle row. Anything that is arithmetic
rather than appearance goes there — `CalendarGeometry`, `DayLabel`,
`StorageTimestamp`, `Preferences` — and runs in seconds against the macOS slice
`build-ios-framework.sh` produces, which is why that script builds Darwin
targets at all.

`PikosUITests` is XCUITest, the native analogue of the desktop's Playwright
suite: it launches the real app and queries the **accessibility tree**. The
labels scattered through the screens — `Mark as done`, `New page`, the
navigation title that is also the view switcher, the combined row labels — are
what it selects on, so they are contract rather than decoration.

It is deliberately five flows, matching the desktop's `@tier1` set: the app
launches, a page can be made, ticked, found and opened. A UI suite earns its
keep by being fast enough that nobody skips it; detail belongs in the two rows
above.

Each test gets its own empty workspace. `XCUIApplication` can set the
environment of the process it launches but cannot reach inside it, so
`WorkspaceLocation.workspaceOverrideKey` is the seam — a **debug-only**
environment variable naming a directory. That buys isolation between tests and
keeps CI out of the provisioning question, since the app then never opens the
App Group container. A release build ignores it: storage location is not an
input.

CI runs the first two on every push (`.github/workflows/_ios.yml`); the UI
flows are behind a `run-ui-tests` input because a simulator takes minutes to
boot.

## Status

Compiled, and the three suites run green: the packages on the host, the app for
device and simulator, the tier-1 flows in a simulator. Xcode 26.6, Swift 6.3.

The first compile cost less than the plan feared. `EditorWebView.Coordinator`
needed nothing; the concurrency work was elsewhere — a Live Activity held as an
object across an actor hop, notification identifiers inheriting a class's
main-actor isolation, and `ActivityKit` importing on macOS while every type in
it is unavailable there, so `canImport` was the wrong test.

Two things were broken in ways only a running app shows. The rows in the page
list carried a selection binding at all times, so tapping a page selected it
instead of opening it. And the launch screen and orientations were written as
`INFOPLIST_KEY_…` build settings against a target that supplies its own
Info.plist, where Xcode ignores them — the app ran letterboxed on every modern
iPhone. `docs/ios/07-device-checklist.md` is what to do with the phone next.

Everything beneath the Swift _is_ tested: the Rust is graded against a corpus
generated from the TypeScript it replaces, and the editor against a browser
suite.

## What is deliberately missing

- **A phone-designed app icon.** `Sources/Assets.xcassets/AppIcon.appiconset`
  holds the desktop's icon flattened onto its own background — App Store
  Connect refuses an icon with alpha, and the desktop's has rounded
  transparent corners. It is the right mark and the wrong medium: a home
  screen icon wants a full-bleed composition, not a rounded tile inside the
  system's rounding. Replace the PNG when there is one; the slot needs
  nothing else.
- **Resizing blocks on the calendar.** A page is scheduled by holding its row
  and dropping it on an hour of the day under the list, and a one-off block
  already on the grid is held and moved to another hour the same way. Dragging
  a block's edge to change its length is not wired: on a phone it competes with
  scrolling the grid. A length is set in the When sheet, and one occurrence of
  a series moves through "Move this one…".
- **The rest of the iPad.** A full-screen iPad gets the desktop's three panels
  from the phone's own surfaces, but not yet pointer hover, keyboard shortcuts
  or a second window, and its type is the phone's 1.15× scale rather than the
  desktop's. Each waits on living with the split view.
- **Controls for every part of a repeat.** The phone locks the rules the
  desktop locks and edits the rest, but its form has nothing for "every 15
  March", the fifth Friday or a rule spelled with `BYSETPOS`. Such a rule shows
  its pattern as a label and keeps it while the interval or the end changes;
  choosing a new frequency replaces it.
- **Google calendars.** CalDAV accounts can be added, repaired, toggled and
  synced from the phone. Google cannot: its grant waits on a loopback TCP
  listener inside the app process, and leaving for the browser is what starts
  iOS suspending that process. It needs an iOS OAuth client in the Google
  Cloud project and an `ASWebAuthenticationSession`; the code exchange itself
  is transport-agnostic. Sync is not polled — an in-process timer is what iOS
  suspends — but runs on return to the foreground when the last pass is over
  fifteen minutes old and inside the background refresh the OS grants, which
  is what every calendar app without push has here. The screen says so.
- **Most of the desktop's settings.** Five tabs there, one screen here, on
  purpose: keyboard shortcuts, window state and an editor line width describe
  things a phone does not have, and the calendar's day count is an iPad
  question. What is on the screen is theme, list and calendar density, week
  start and the default folder — every one of them wired to something, because
  a settings row that does nothing is indistinguishable from one that is
  broken. Notifications and import are still missing entirely, not omitted by
  design; export is in Settings, through the share sheet.
- **Clearing a repeating page's date.** The hold menu's When › No Date is
  left out on a repeating page, where it would remove the one-off schedule rows
  and change nothing the user can see — a page with a rule owns its
  `scheduled_start` directly. Ending the series is what is meant there, and
  that is "Stop Repeating" on the same menu, with an undo in the notice where
  the rule can be rebuilt.
- **Emptying the trash by hand.** "Trash" restores; it does not
  offer a permanent delete. The retention window already clears the trash, and
  a destructive control sitting next to a restore button on a phone is the same
  mis-tap the screen exists to undo. Worth revisiting only alongside a
  confirmation step.
- **Folder icons and nesting.** Colour is wired — the dot on each row is the
  colour picker. The `icon` column is not, and folders don't nest: the desktop
  offers neither, so there is no behaviour to match.
- **Images from anywhere but the photo library.** The formatting bar's photo
  button opens a `PhotosPicker`, writes the picture into the workspace's
  assets directory and inserts it. Anything not JPEG, PNG or GIF is
  re-encoded as JPEG on the way in, so a HEIC from the camera roll renders in
  the webview and on the desktop. Not wired: the Files picker, the camera, and
  pasting an image into the editor. And one convention worth knowing: the phone
  stores the asset path _relative to the assets directory_, which is what its
  scheme handler resolves, where the desktop stores an absolute path — so an
  image inserted on either device does not yet render on the other. That is
  iCloud sync's to settle: the sync layer carries the assets directory with the
  database, and the path convention is the one thing the two apps have to
  agree on before it lands.
- **Share extension.** M4. Capturing a URL or a selection into a new page. The
  App Group and the read-only workspace it needs are in place; what is missing
  is the target itself. The capture surfaces that _are_ here: two widgets and
  two Control Center buttons (`PikosWidgets/`), and Siri takes "Add a page to
  Pikos". Now shows what's happening, how long until the next thing and the
  page to do in the gap, with a Focus button; its large size is the rest of
  today by the hour, where an empty hour opens quick add at that time. List
  shows Today, Upcoming, the Inbox or a folder, chosen in its settings, with a
  plus that adds to that list and a button that moves a page to tomorrow. The
  controls are New Page, which can start with words like `#home`, and Start
  Focus. Every ring on every widget is a button that finishes the page in
  place. They share one row and one way of opening the workspace
  (`WidgetSupport.swift`), so a change to how a page is drawn is one change.
- **Onboarding.** Deliberately. Nothing to sign up for means nothing to ask. A
  brand-new workspace starts with the desktop's Start here folder, three
  undated pages that say where the data lives and what to type; each empty view offers a
  sentence the parser understands and opens quick add with it filled in. The
  gestures with no affordance get one tip each, a day apart, until dismissed:
  a card at the top of the list for swiping and dragging a row, and a popover
  on the title for switching views.
- **Liquid Glass everywhere.** The bottom bar, the select-mode verbs and the
  notice bar are glass on iOS 26 and system materials before it. Nothing in the content layer is glass, on purpose,
  and every iOS 26 symbol sits behind `#if compiler(>=6.2)` so the tree still
  builds with Xcode 16.
- **A way to see the file.** Settings › Your data says how big the workspace
  is and copies it — database and images — into Pikos › Backups in the Files
  app, where a person can hold it, move it or send it on. The live database
  stays in the App Group container, which Files never shows.
- **The desktop's notification extras.** Reminders ring on the phone: the
  workspace is asked what will fire over the next fourteen days and each
  answer becomes a local notification, re-planned on every write, on the way
  to the background, and by a background refresh (`Notifications/`). What is
  not here is the desktop's daily overdue summary and its quiet hours — the
  first is what the Now and List widgets are for, and the second is a Focus mode on
  iOS. Two limits worth knowing: the OS keeps sixty-four pending
  notifications, so the phone plans sixty soonest-first; and background
  refresh is a request the system grants on its own schedule, which is why the
  horizon is two weeks rather than two days.
