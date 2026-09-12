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

## Not yet bridged: the database

`pikos-ffi` currently exposes pure logic only. `pikos-db` is async (sqlx over
tokio) and UniFFI supports async exports, so this is not a technical blocker;
it is blocked on two decisions that belong to the Swift side and should not be
guessed at from here:

1. **Where the database file lives.** It has to be in the App Group container
   so WidgetKit extensions can read it. That means an App Group identifier,
   which means a provisioning profile — neither of which exists yet.
2. **Who writes.** The plan's rule is one writer in the app process, widgets
   read-only, WAL mode. That wants enforcing in the binding's shape — a
   read-only handle type for extensions — rather than by convention, and the
   shape should be designed once the container path is known.

Sequencing suggestion: do the M0 editor-in-webview spike first. It needs no
database — a page can be loaded from a file — and if it fails, the plan says
stop, and none of the database bridging would have been worth building.

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
