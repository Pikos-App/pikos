# Pikos — Active Backlog

Next-up items only (Phase 0 remaining + Phase 1). For full history and later phases, grep `BACKLOG.md` by GOO number — **never load it whole (86KB)**.

Status: `[ ]` pending · `[~]` in progress · `[x]` done

---

## Phase 0 — Tooling (remaining)

- [x] **GOO-40** shadcn/ui (React) + Tailwind CSS v4 _(High)_

- [x] **GOO-45** Feature-based directory structure + dependency-cruiser _(Medium)_
  `src/features/<name>/{components,hooks,utils}` + `src/shared/`. Dependency-cruiser in CI: features don't import from other features; `packages/core` has no Tauri/React imports.

- [ ] **GOO-9** Testing: Vitest + Playwright _(Medium)_
  `packages/core` → Vitest (jsdom, coverage via v8). `apps/desktop` → Playwright (Chromium, `VITE_TEST_MODE=true` swaps in `MockStorageAdapter`). Also `@testing-library/react` + `@testing-library/user-event` for component tests. Wire into `turbo.json`.

- [~] **GOO-5** Fix GitHub Actions CI _(Medium)_ — fix last, after all Phase 0 tasks done
  Three jobs: `quality` (Biome + tsc) → `test` (Vitest + Playwright) → `build` (turbo build).

---

## Phase 1 — Foundation

- [ ] **GOO-27** Core TypeScript types _(Urgent)_
  `packages/core/src/types.ts`. Types: `Vault`, `Folder`, `Page`, `PageStatus`, `PagePriority`, `Tag`, `SearchResult`, `PageFilter`. No `path` field — IDs are UUIDs. See full type definitions in `BACKLOG.md` at GOO-27.

- [ ] **GOO-28** StorageAdapter interface _(High)_
  `packages/core/src/storage.ts`. Interface + `NewPage`/`PageUpdate`/`NewFolder`/`FolderUpdate` helpers.
  `TauriSQLiteAdapter` → `apps/desktop/src/shared/adapters/`. `MockStorageAdapter` → `packages/core/src/adapters/` (in-memory, for tests). Injection via `VITE_TEST_MODE`.

- [ ] **GOO-29** Rust SQLite schema + Tauri CRUD commands _(High)_
  `Cargo.toml`: add `tauri-plugin-sql` (sqlite feature), `uuid` (v4). Schema in `src-tauri/migrations/001_initial.sql` with FTS5 triggers. Commands in `src-tauri/src/db/{pages,folders,search}.rs`. See `features/storage.md` for full spec.

- [ ] **GOO-30** VaultContext + UIContext _(High)_
  VaultContext owns data + mutations (pages, folders, createPage, etc.) + lightweight event emitter (`page:created/updated/deleted`, `vault:loaded`).
  UIContext owns navigation: `activePage`, `activeViewId: 'today'|'inbox'|folderId`, `rightPanel: 'editor'|'calendar'`, `sidebarCollapsed`. See `BACKLOG.md` GOO-30 for full interface definitions.

- [ ] **GOO-31** Port keyboard system to React hooks _(High)_
  Keep `registry.ts` as framework-agnostic singleton. Add `useKeyboardShortcut(shortcut, handler)` + `useKeyboardListener()` (mounted once in `App.tsx`). Chord support via 400ms timeout detector.

- [ ] **GOO-23** Design system: typography, color, dark mode _(High)_
  Before any UI components. Dark mode first. Linear/Arc/Obsidian inspired. CSS custom properties via `@theme` in `app.css`. System font stack. No gradients, minimal shadows.

- [ ] **GOO-15** Vault selection + persistence _(Urgent)_
  First-launch welcome screen: "Create New Vault" + "Open Existing Vault". Tauri `dialog.open` folder picker. Config in Tauri app data dir via `@tauri-apps/plugin-store`. Remove any hardcoded paths.

---

## Phase 1 — Editor & Metadata

- [ ] **GOO-19** NL page creation parser _(High)_
  `packages/core/src/nlp/parser.ts`. Pure TS, zero DOM/Tauri deps. Returns `ParseResult`: `single | finite | recurring`. Tokens: date (`@today`), time (`9pm`), duration (`for 1h`), recurrence (`m/w/f`, `every monday`), tag (`#work`), folder (`~Projects`), priority (`!urgent`). Deps: `rrule` + `chrono-node`. See `BACKLOG.md` GOO-19 for full spec.

- [ ] **GOO-10** Tiptap WYSIWYG editor _(Urgent)_
  `@tiptap/react`, `@tiptap/starter-kit`, task-list, task-item, placeholder extensions. Storage format: Tiptap JSON in SQLite. Extract plain text via util for FTS. Markdown only at import/export boundary. Task-list checkboxes NOT wired to page `status`. See `features/editor.md`.

- [ ] **GOO-36** Auto-save + save indicator _(Urgent)_
  No manual save. Debounce 800ms on content changes; flush on blur/close/`Mod+W`. See `features/editor.md` for full strategy.

- [ ] **GOO-60** Quick Add Modal _(Urgent)_
  Small centered modal from anywhere (`Cmd+N`). NL input → `parseInput()` (GOO-19 required first). Live metadata chips (date/priority/folder). Confirmation step for recurring or finite ≥3 pages. Enter to create.

- [ ] **GOO-32** Collapsible metadata header _(Urgent)_
  Above editor. Fields: status toggle, priority selector, scheduled date, tags, subtitle, folder. Collapsed by default unless metadata is set. See `features/metadata.md`.

- [ ] **GOO-33** Page status toggle _(High)_
  Three-state cycle: `not_started → in_progress → done`. Checkbox/icon in page list + metadata header. Completing sets `completedAt`.

- [ ] **GOO-34** Scheduled date/time picker _(High)_
  Calendar popover + time input in metadata header. Updates `page_schedules` row (GOO-76 — multiple occurrences per page).

- [ ] **GOO-35** Priority selector _(Medium)_
  Dropdown in metadata header. 5 levels: none / urgent / high / medium / low. Shown as colored badge in page list.

---

## Phase 1 — Layout & Navigation

- [ ] **GOO-14** Resizable three-panel layout _(High)_
  Left 180px | Pages 280px | Right flex. Drag to resize. Persist widths to localStorage.

- [ ] **GOO-80** Sidebar collapse + navigation keyboard shortcuts _(High)_
  Binary collapse (all-open OR both-left-collapsed). `Cmd+\` toggles. framer-motion spring (stiffness 350, damping 35). `J`/`K` = prev/next page, `Enter` = open, `Escape` from editor = focus page list, `Cmd+Shift+C` = toggle editor/calendar. J/K/Enter auto-expand if collapsed.

- [ ] **GOO-79** Today smart view + Inbox smart view _(High)_
  Pinned above folders in left panel. Today = `page_schedules` rows where date ≤ today AND status ≠ done. Inbox = `folder_id IS NULL`. Both show page count badges.

- [ ] **GOO-37** Folder CRUD _(High)_
  Create / rename / delete folders. Left panel folder list. Drag to reorder (via `reorderFolders`). No nesting in v1.

---

_For Phase 2+ (calendar, search, settings, import/export, etc.) — grep `BACKLOG.md`._
