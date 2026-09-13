# Pikos iOS — where things stand

Index for `docs/ios/`. Written 2026-09-12, against the architecture and
delivery plan.

| Doc                              | What it is                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `01-business-logic-inventory.md` | Every module classified rust / ts-portable / ui-only, with three addenda correcting the first pass           |
| `02-ffi-surface.md`              | The Swift ↔ Rust boundary: what crosses it, and why dates cross as strings                                   |
| `03-m0-spike.md`                 | The editor-in-webview spike: how to run it, how to measure each item on the pass bar, what to do if it fails |

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
the one that writes the pages. See `04-parser-grammar.md`, which records both
the original measurement and what was actually built.

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
