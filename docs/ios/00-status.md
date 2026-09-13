# Pikos iOS — where things stand

Index for `docs/ios/`. Written 2026-09-12, against the architecture and
delivery plan.

| Doc                              | What it is                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `01-business-logic-inventory.md` | Every module classified rust / ts-portable / ui-only, with three addenda correcting the first pass                   |
| `02-ffi-surface.md`              | The Swift ↔ Rust boundary: what crosses it, and why dates cross as strings                                           |
| `03-m0-spike.md`                 | The editor-in-webview spike: how to run it, how to measure each item on the pass bar, what to do if it fails         |
| `04-parser-grammar.md`           | The quick-add parser: what it needed, what was built, and what differential fuzzing found that the corpora could not |

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

**Documents are version-stamped.** `pages.content_schema_version` (migration 010) closes the gap that open question 2 identified. A client finding a version
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
    the view it is applied to, and it sat *before* the frame that enlarged it —
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
  opening a *writable* handle to populate a picker, against the one-writer rule
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
     `Task`. `TimelineProvider` is not main-actor, so if those handlers are not
     `@Sendable` in the SDK, capturing them is an error. The fix is a sendable
     box around the handler, not a redesign.
  3. **`AppDependencyManager.shared.add { Route.shared }`** reads a main-actor
     singleton from a closure whose isolation depends on that API's signature.

  Note that both Swift packages declare `swift-tools-version: 5.9`, so they
  build in Swift 5 mode regardless of the app's setting — suspects 1 and 2 are
  warnings there and errors only where app code touches them.

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
   keeping true for a reason that is about to matter: the calendar's *layout*
   is shared and its *pixel mapping* is deliberately not, because density
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
