# The Swift ↔ Rust boundary

**Status:** Bindings generated and committed; XCFramework build scripted but
unrun (needs a Mac). **Crate:** `crates/pikos-ffi`. **Package:**
`apps/ios/PikosCore`.

## What exists

```
crates/pikos-ffi/              UniFFI exports over pikos-core
apps/ios/PikosCore/
  Package.swift                SwiftPM manifest, iOS 17+
  Sources/PikosCore/           generated Swift — committed, reviewable, diffed in CI
  generated/include/           generated C header + modulemap — inputs to the XCFramework
  Tests/PikosCoreTests/        boundary tests (type mapping, not logic)
  Frameworks/                  XCFramework lands here — gitignored
scripts/gen-swift-bindings.sh  runs anywhere
scripts/build-ios-framework.sh macOS only
```

The split between those two scripts is the important part. Generating the Swift
needs no Apple toolchain at all — `uniffi-bindgen` reads the compiled cdylib's
embedded metadata — so the API that iOS will consume can be produced, reviewed
and drift-checked on a Linux CI runner. Only the step that compiles for Apple
targets and fuses slices into an XCFramework needs a Mac. Keeping them apart
means a change to the Rust surface is caught in the pull request that makes it,
rather than as a link error on somebody's laptop a week later.

## What Swift sees

Idiomatic Swift, generated: `camelCase` functions, real `Optional`s, `[T]`
arrays, and enums with associated values.

```swift
func extractText(docJson: String) -> String
func parseDeepLink(url: String) -> DeepLink?
func nextOccurrenceAfter(rrule: String, scheduledStart: String,
                         afterDate: String, exdates: [String]) -> Occurrence?
func expandRecurrence(rrule: String, scheduledStart: String, scheduledEnd: String?,
                      exdates: [String], rangeStart: String,
                      rangeEnd: String) -> [Occurrence]
func layoutTimedDay(pages: [LayoutPage], day: String) -> [TimedBlock]
func layoutAllDay(pages: [LayoutPage], days: [String]) -> [AllDayBar]
func countCrossingMidnights(start: String, end: String) -> UInt32
func computeScheduleTransition(currentStart: String?, currentEnd: String?,
                               iso: String) -> ScheduleTransition
func normalizeEndInput(currentStart: String, endIso: String?) -> String?
func contentSchemaVersion() -> Int64
```

### Dates cross as `String`, deliberately

This is the design decision most likely to look like a mistake, so it is worth
stating plainly.

Pikos stores **local wall-clock** strings with no zone — `2026-03-16T09:00:00`,
never an instant. That is what keeps "09:00 every day" at 09:00 through a
daylight-saving transition. `Foundation.Date` is an instant. Converting at the
FFI boundary would force a timezone to be chosen on every single call, and the
wrong choice shifts events by an hour twice a year — silently, and only for
users in zones that observe DST.

Keeping the wire format identical to the storage format means Swift converts
exactly once, at the point of display, where the user's current calendar is
genuinely the right context. `PikosCoreTests` pins this with a DST fixture.

### Layout returns structure, not geometry

`layoutTimedDay` returns a cascade column per page, not a frame. The pixel half
of calendar layout stayed in the platform layer on purpose — the desktop's
`CASCADE_MIN_TOP_GAP_PX` and its density tables encode one renderer's font
metrics, and a phone's are different. iOS computes its own geometry from the
same column assignment. See the 2026-09-12 addendum in
`01-business-logic-inventory.md`.

## First-run instructions

The package does not build straight from a clone: `Package.swift` references an
XCFramework that is a gitignored build artifact. On a Mac:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
bash scripts/build-ios-framework.sh          # ~2 min; regenerates bindings too
swift test --package-path apps/ios/PikosCore # boundary tests
```

The alternative — committing a multi-megabyte binary — was rejected because the
thing worth reviewing is the Swift API, and that _is_ committed.

## The database

Bridged. `Workspace` is a read-write handle; `ReadOnlyWorkspace` is the one
extensions get.

```swift
let workspace = try await Workspace.open(path: containerURL.path)
let pages = try await workspace.listPages(query: PageQuery(folder: .inbox))
let page  = try await workspace.getPage(id: pageId)
_ = try await workspace.updatePage(
    id: page.id,
    edit: PageEdit(content: json, contentText: plainText))
let hits  = try await workspace.search(query: "invoice", limit: 20)
```

It wraps `pikos-db`, which is already the single writer behind the desktop app
and the CLI. Nothing is reimplemented here — a second implementation of storage
is how two clients end up disagreeing about what a page is.

### Where the file lives is the caller's business

`open` takes a path. On iOS that will be inside the App Group container so
widget extensions can read the same database, but the container identifier is a
provisioning concern, and baking a build setting into a Rust crate would be the
wrong place for it.

This was previously recorded here as a blocker. It was not one — the decision
belongs on the Swift side and never needed to reach the Rust API at all.

### One writer, enforced by the type

The plan's rule is one writer in the app process, extensions read-only, WAL
mode. `ReadOnlyWorkspace` has no write methods, so an extension holding one
cannot write however carelessly it is used. That matters because SQLite in WAL
mode permits exactly one writer: a widget refresh racing the app for it would
block the app, and the visible symptom is a keystroke that does not appear.

`ReadOnlyWorkspace.openExisting` also refuses to create a database, and never
migrates. A widget must not be the process that changes the schema, and one
that silently creates an empty workspace looks to the user exactly like their
notes disappearing.

### Two tri-states became enums

`PageFilter.folder_id` and `PageUpdate.folder_id` are `Option<serde_json::Value>`
in the data layer, where absent, JSON null and a string mean three different
things. That does not survive an FFI boundary and reads as a trap even in Rust,
so the binding uses named cases instead: `FolderScope` (`.any`, `.inbox`,
`.folder(id:)`) for narrowing a listing, and `FolderAssignment` (`.inbox`,
`.folder(id:)`) for assigning one, wrapped in an `Optional` that means "leave
alone".

Collapsing any of those cases is the obvious bug, and two of the first tests
written for them passed anyway — the fixtures could not tell the cases apart.
Both now start from data where the difference is visible.

### Known rough edge

`search`'s `limit` is applied after the query returns, because
`search_pages_impl` has no limit parameter and returns its own capped set. A
caller passing a large limit expecting more results will not get them; the fix
belongs in the data layer rather than here.

## Maintenance

- After changing anything `#[uniffi::export]`ed, run
  `scripts/gen-swift-bindings.sh` and commit the result. CI fails on a stale
  diff and tells you this.
- `CONTENT_SCHEMA_VERSION` now exists in three places: `pikos-db` (authority),
  `packages/core` (TypeScript), and `pikos-ffi` (so iOS can check it without
  linking a database engine). Two tests guard the two copies against the
  authority. Bump all three together, with a content migration.
- The generated Swift is not run through `swift-format` — it is unavailable on
  Linux, and skipping it keeps the output byte-identical across platforms,
  which is what makes the CI drift check trustworthy.
