# Desktop business-logic inventory

**Purpose:** answer open question 1 of the iOS plan — *how much domain logic
lives in Rust vs TS today* — and thereby set M1 scope.

**Method:** every non-test module under `apps/desktop/src`, `packages/`, and
`crates/` classified as:

| Tag | Meaning |
|---|---|
| `rust` | Already in Rust, already Tauri-free, already shared. iOS consumes it via UniFFI — no port. |
| `ts-portable` | Pure logic, no DOM/React/Tauri. Both platforms need it → must move to Rust. |
| `ui-only` | Platform presentation. iOS reimplements natively; nothing to share. |

Counts are non-test lines. Measured 2026-09-12 at `a79d995`.

---

## Headline: the plan's M1 is roughly half-built already

The plan assumes `core-rs` is new. It isn't. `crates/pikos-db` is already the
Tauri-free shared data layer the plan describes, and it is already shared by two
consumers (the desktop app and `pikos-cli`).

Evidence that the split is real rather than nominal — the Tauri layer is a thin
wrapper, not a parallel implementation:

| Concern | `crates/pikos-db` | `src-tauri/src/db` (wrapper) |
|---|---|---|
| Pages | 1166 lines | 109 lines |
| Search (FTS5) | 362 lines | 16 lines |

`src-tauri/Cargo.toml` declares `pikos-db = { path = "../../../crates/pikos-db" }`,
and `src-tauri/src/error/error.rs` re-exports `pikos_db::{AppError, AppResult}`
as the app's own error type. There is no second writer.

So M1's "stand up `core-rs` with UniFFI: SQLite open/migrate, page CRUD, FTS5
search" is **not a port**. It is: add a UniFFI binding layer over a crate that
already exists and already has 244 Rust tests.

## Second finding: the TS→Rust dependency currently runs backwards

`packages/pikos-bridge` is **not** an editor bridge despite the name. It is a
one-shot Node subprocess that the *Rust CLI shells out to* for the two pieces of
logic that never got ported:

```
crates/pikos-cli/src/main.rs:203   Proc::new("node").arg(bridge.mjs) …
packages/pikos-bridge/src/bridge.ts   parse | next-occurrence  →  @pikos/core
```

The CLI carries an explicit `missing_node` error path for when `node` isn't
installed. That is the real shape of the problem: **NLP parsing and recurrence
math are single-sourced in TypeScript, and Rust already wants them.**

This is good news for sequencing. Porting the parser and recurrence to Rust is
not speculative iOS work — it pays off immediately by deleting a Node dependency
from the CLI. It can ship and be validated on desktop before any Swift exists.

---

## Inventory

### Already Rust — iOS consumes via UniFFI, no port

| Module | Lines | Notes |
|---|---:|---|
| `crates/pikos-db/pages.rs` | 1166 | Page CRUD, the single writer |
| `crates/pikos-db/search.rs` | 362 | FTS5 |
| `crates/pikos-db/schedules.rs` | 630 | Schedule rows, virtual-occurrence overrides |
| `crates/pikos-db/reminders.rs` | 100 | Due-reminder queries |
| `crates/pikos-db/folders.rs` | 295 | Folder CRUD |
| `crates/pikos-db/tags.rs` | 18 | Tag logic |
| `crates/pikos-db/notification_log.rs` | 337 | Daily-summary + fired-reminder log |
| `crates/pikos-db/pool.rs`, `tx.rs`, `error.rs` | 548 | Pool, WAL, transactions, shared error type |
| `src-tauri/src/markdown/` | 397 | Markdown export |
| `src-tauri/src/notifications/scheduler/` | 593 | Reminder scheduling; desktop-delivery half is platform-specific |

**iOS work:** UniFFI wrapper + App Group container path. No logic rewrite.
`src-tauri/src/notifications/macos.rs` is AppKit-specific and does not transfer —
iOS reimplements delivery on `UNUserNotificationCenter` against the same
scheduler queries.

### `ts-portable` — needed by both platforms, must move to Rust

Ordered by port priority. The first two are already blocking the CLI.

| Module | Lines | Why it must move |
|---|---:|---|
| `packages/core/nlp/parser.ts` | 861 | Quick-add NLP. CLI already shells to Node for it. Depends on `chrono-node`. |
| `packages/core/utils/recurrence.ts` | 510 | RRULE expansion + next-occurrence. Same; depends on `rrule`. |
| `features/calendar/utils/calendarLayout.ts` | 634 | Overlap/column packing. **Split required** — lines ~600-633 are a DOM drag helper (`window.addEventListener`), the rest is pure. |
| `features/calendar/utils/allDayLayout.ts` | 363 | All-day lane packing. Only impurity is a `CSSProperties` *type* import — trivial to strip. |
| `features/calendar/utils/calendarGeometry.ts` | 279 | Time↔pixel math. Zero DOM refs. |
| `packages/core/types.ts` | 227 | Domain types. Becomes the UniFFI type surface. |
| `packages/core/storage.ts` | 163 | Storage interface + input types. Becomes the UniFFI API shape. |
| `features/pages/utils/pageFilters.ts` | 131 | Smart-view filtering + sort modes. Zero DOM refs. |
| `features/layout/utils/buildPageListRows.ts` | 114 | Section grouping for the page list. Pure data→rows. |
| `features/import/parsers/csv.ts`, `markdown.ts`, `utils.ts` | ~200 | Import parsing. Zero DOM refs. Lower priority — import may stay desktop-only. |
| `shared/utils/schedule.ts` | 71 | All-day↔timed transitions. Pure date-string transforms. |
| `packages/core/utils/dates.ts` | 69 | Local ISO helpers. |
| `packages/core/utils/extractText.ts` | 63 | ProseMirror JSON → plain text. Needed for `docChanged` on iOS. |
| `shared/deep-link/parseDeepLink.ts` | 65 | `pikos://` URLs. iOS needs the same grammar for Shortcuts/widgets. |
| `shared/utils/formatDateRange.ts` | 36 | Range chip labels. Depends on `date-fns`. |
| `features/editor/utils/markdownPaste.ts` | 41 | Markdown detection heuristic. |
| `features/editor/utils/textSearch.ts` | 37 | Find-in-page matching. |
| `features/pages/utils/fuzzyMatchFolder.ts` | 17 | Folder name matching for parsed `folderQuery`. |
| `packages/core/utils/sort.ts` | 17 | Emoji-aware compare. Subtle; needs a parity corpus. |
| `packages/core/utils/page.ts` | 15 | `isDone` / `isOpen`. |

**Subtotal: roughly 3,900 non-test lines**, against which there are already 75 TS
test files — a ready-made parity corpus, which is what the plan's parity-test
requirement needs.

### Editor — shared as TypeScript, via the webview (not ported)

This is the plan's exception and the inventory agrees with it.

| Module | Lines | Disposition |
|---|---:|---|
| `features/editor/components/EditorPane.tsx` | 289 | Extract to `packages/editor`. See coupling note below. |
| `features/editor/components/SlashMenu.tsx` | 330 | Moves with the editor. |
| `features/editor/components/LinkPopover.tsx` | 328 | Moves; iOS may drive natively via `selectionChanged`. |
| `features/editor/components/FindContentPopover.tsx` | 240 | Moves. |
| `features/editor/components/FormatToolbar.tsx` | 212 | Desktop keeps; iOS replaces with a native keyboard toolbar. |
| `features/editor/components/TableToolbar.tsx` | 162 | Moves. |
| `features/editor/extensions/PikosImage.ts` | 226 | Moves. Image URL resolution is platform-specific — bridge it. |
| `features/editor/extensions/TabIndent.ts` | 180 | Moves. |
| `features/editor/extensions/PikosTable.ts` | 12 | Moves. |
| `shared/utils/jsonContent.ts` | 39 | Moves. Defines `EMPTY_TIPTAP_DOC` + defensive parse. |
| `features/editor/components/MetadataHeader.tsx` | 484 | **Stays desktop.** Page metadata chrome, not the editor. iOS builds this natively. |

**Extraction difficulty is moderate, not trivial.** `EditorPane.tsx` imports from
six desktop-local paths (`@/shared/context/*`, `@/shared/keyboard/*`,
`@/shared/constants/*`, `@/shared/components/EmptyState`). Those become
constructor options or bridge messages. TipTap v3.20.1 is pinned consistently
across 16 packages, which makes the extraction mechanical once the seams are cut.

### `ui-only` — iOS reimplements natively

No sharing, no port. Listed for completeness of scope.

| Area | Files | Lines |
|---|---:|---:|
| `shared/components/*` | 24 | 3,334 |
| `features/calendar/components/*` | 15 | 2,936 |
| `shared/context/*` (15 React contexts) | 15 | 2,635 |
| `features/settings/components/*` | 13 | 1,888 |
| `features/calendar/hooks/*` (drag/resize) | 11 | 1,534 |
| `components/ui/*` (Radix wrappers) | 11 | 1,416 |
| `features/layout/components/*` | 8 | 1,166 |
| `shared/keyboard/*` | 3 | 414 |
| `shared/hooks/*` | 10 | 467 |
| `shared/seeds/*` (dev fixtures — desktop-only, not shipped logic) | 8 | 3,569 |

Excluding seeds, that is roughly **15,800 lines of presentation** that iOS
reimplements from scratch. That number is the honest cost of the two-UI-codebase
decision, and it is worth stating plainly next to the decision rather than
leaving it as "the permanent cost is two UI codebases."

Plus `shared/adapters/TauriSQLiteAdapter.ts`, which is the desktop's
implementation of the `packages/core` storage interface. iOS writes its own
UniFFI-backed implementation of the same interface — that interface is the
portable part, not the adapter.

---

## What this changes about the plan

1. **M1 shrinks on the data side, holds on the logic side.** No `core-rs` to
   stand up — `pikos-db` is it. The real M1 is (a) UniFFI bindings over an
   existing crate, (b) porting parser + recurrence, which is ~1,400 lines of
   genuinely hard logic with `chrono-node` and `rrule` dependencies that have no
   drop-in Rust equivalents.

2. **The port order in the plan should be revised.** The plan says
   schema/migrations → page CRUD → search → tags → date parsing → calendar
   layout. The first four are done. The remaining order should be driven by the
   CLI's Node dependency: **parser → recurrence → calendar layout → filters**.
   Porting parser and recurrence lets `pikos-cli` drop its Node subprocess and
   its `missing_node` error path — a shippable desktop win that validates the
   port before iOS exists.

3. **Open question 2 is answered, and the answer is "not frozen."** There is no
   `schemaVersion` on pages anywhere in the codebase (the only match repo-wide is
   an unrelated FTS index-version check in `pool_tests.rs`). `jsonContent.ts`
   already anticipates the gap in a comment: *"a future schema bump that wasn't
   migrated."* Adding `schemaVersion` to every page is a prerequisite for M1, not
   a nice-to-have — two devices writing ProseMirror JSON with no version marker
   is exactly the corruption risk the plan's decision section cites as
   unacceptable.

4. **`packages/pikos-bridge` will need renaming.** It is a CLI↔TS bridge; the
   plan introduces an entirely different Swift↔JS editor bridge. Two things named
   "bridge" in one monorepo will cause confusion. Suggest `packages/cli-bridge`,
   and it gets deleted outright once parser and recurrence land in Rust.
