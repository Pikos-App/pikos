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

**None of this Swift has been compiled yet.** It was written where no Swift
toolchain was available — and until `_ios.yml` landed, nothing anywhere built
it, so the first green run is likely to surface work. Most likely
strict-concurrency annotations on `EditorWebView.Coordinator`, which conforms
to two WebKit delegate protocols. `docs/ios/03-m0-spike.md` says what to expect
and why annotations were not added speculatively.

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
- **Dragging in the calendar.** The grid draws; moving and resizing a block by
  dragging is not wired. On a phone both compete with scrolling and want a
  design decision rather than a port of the desktop's gestures. Paging between
  days is a swipe; moving a one-off block is the long-press menu's "Change
  Date…", and moving one occurrence of a series is "Move this one…".
- **The scope question behind a backlog.** When a series has open occurrences
  before today, the desktop asks whether a skip means _just this one_ or
  _this and everything before today_. iOS always means the first.
- **The iPad UI.** Ships in the same universal binary, styled after the desktop
  app rather than the phone. Not started; `docs/ios/00-status.md` records the
  three things being kept true so that it stays a change of shell.
- **Filtering the Completed section.** The filter field narrows the open list
  only. The finished pages come from their own paginated query and a filter
  over the rows that happen to be loaded would search a fifth of the folder
  while looking like it searched all of it.
- **Repeats richer than a picker can hold.** "Every other Tuesday" is
  editable; "the last Friday of the month", "every 15 March", and one that
  stops after ten runs are shown and left alone. The workspace decides which is
  which — `repeat_from` is a narrower envelope than
  `rrule_edit_would_degrade`, and the difference is exactly the rule that
  round-trips fine but has nowhere to go in a frequency-and-weekdays form.
- **Moving a repeating page's date.** Every other page can be scheduled,
  moved, given an end or converted between timed and all-day from the context
  menu. A recurring head cannot: its date belongs to its rule, so moving it has
  to realign the anchor and snap onto a day the rule yields, and without that
  the next recompute silently reverts the edit. `resolveAnchorMove` in
  `@pikos/core` is the logic; it is not ported, so the workspace refuses rather
  than corrupting a series — the same line `pikos update --due` draws.
- **Google calendars, and background sync.** CalDAV accounts can be added,
  repaired, toggled and synced from the phone. Google cannot: its grant waits on
  a loopback TCP listener inside the app process, and leaving for the browser is
  what starts iOS suspending that process. And nothing polls — the desktop's
  scheduler is an in-process timer, so every sync here is one the user asked
  for. The screen says both out loud rather than leaving a day-stale calendar to
  be read as a bug.
- **Most of the desktop's settings.** Five tabs there, one screen here, on
  purpose: keyboard shortcuts, window state and an editor line width describe
  things a phone does not have, and the calendar's day count is an iPad
  question. What is on the screen is theme, list and calendar density, week
  start and the default folder — every one of them wired to something, because
  a settings row that does nothing is indistinguishable from one that is
  broken. Notifications and import are still missing entirely, not omitted by
  design; export is in Settings, through the share sheet.
- **Clearing a repeating page's date.** The context menu's "Clear Date" is
  left out on a repeating page, where it would remove the one-off schedule rows
  and change nothing the user can see — a page with a rule owns its
  `scheduled_start` directly. Ending the series is what is meant there, and
  that is "Stop Repeating" on the same menu, with an undo in the notice where
  the rule can be rebuilt.
- **Emptying the trash by hand.** "Recently Deleted" restores; it does not
  offer a permanent delete. The retention window already clears the trash, and
  a destructive control sitting next to a restore button on a phone is the same
  mis-tap the screen exists to undo. Worth revisiting only alongside a
  confirmation step.
- **Folder icons.** Colour and nesting are wired — the dot on each row is the
  colour picker, and "Move into…" is on the context menu. The `icon` column is
  not: the desktop does not offer it either, so there is no behaviour to match.
- **Images from anywhere but the photo library.** The formatting bar's photo
  button opens a `PhotosPicker`, writes the picture into the workspace's
  assets directory and inserts it. Anything not JPEG, PNG or GIF is
  re-encoded as JPEG on the way in, so a HEIC from the camera roll renders in
  the webview and on the desktop. Not wired: the Files picker, the camera, and
  pasting an image into the editor. And one convention worth knowing: the phone
  stores the asset path *relative to the assets directory*, which is what its
  scheme handler resolves, where the desktop stores an absolute path — so an
  image inserted on either device does not yet render on the other.
- **Share extension.** M4. Capturing a URL or a selection into a new page.
- **Notifications.** Not a port. The desktop fires reminders from a task that
  wakes every clock minute, and iOS suspends that within seconds of
  backgrounding — so nearly every reminder would silently never fire. The model
  has to invert: compute a rolling horizon and hand it to the OS in advance.
  `docs/ios/06-platform-audit.md` has the four complications that come with
  that.
