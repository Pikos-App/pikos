# Pikos — Active Backlog

Next-up items only (Phase 0 remaining + Phase 1). For full history and later phases, grep `BACKLOG.md` by GOO number — **never load it whole (86KB)**.

Status: `[ ]` pending · `[~]` in progress · `[x]` done

---

## Phase 1 — Foundation

- [x] **GOO-27** Core TypeScript types _(Urgent)_
  `packages/core/src/types.ts`. Types: `Vault`, `Folder`, `Page`, `PageStatus`, `PagePriority`, `Tag`, `SearchResult`, `PageFilter`. No `path` field — IDs are UUIDs. See full type definitions in `BACKLOG.md` at GOO-27.

- [x] **GOO-28** StorageAdapter interface _(High)_
  `packages/core/src/storage.ts`. Interface + `NewPage`/`PageUpdate`/`NewFolder`/`FolderUpdate` helpers.
  `TauriSQLiteAdapter` → `apps/desktop/src/shared/adapters/`. `MockStorageAdapter` → `packages/core/src/adapters/` (in-memory, for tests). Injection via `VITE_TEST_MODE`.

- [x] **GOO-29** Rust SQLite schema + Tauri CRUD commands _(High)_
  `Cargo.toml`: add `tauri-plugin-sql` (sqlite feature), `uuid` (v4). Schema in `src-tauri/migrations/001_initial.sql` with FTS5 triggers. Commands in `src-tauri/src/db/{pages,folders,search}.rs`. See `features/storage.md` for full spec.

- [x] **GOO-30** VaultContext + UIContext _(High)_
  VaultContext owns data + mutations (pages, folders, createPage, etc.) + lightweight event emitter (`page:created/updated/deleted`, `vault:loaded`).
  UIContext owns navigation: `activePage`, `activeViewId: 'today'|'inbox'|folderId`, `rightPanel: 'editor'|'calendar'`, `sidebarCollapsed`. See `BACKLOG.md` GOO-30 for full interface definitions.

- [x] **GOO-31** Port keyboard system to React hooks _(High)_
  The `Keyboard` singleton in `registry.ts` is already done — do not modify it. This task adds two hooks:
  - `useKeyboardShortcut(combo, handler, opts?)` — registers/unregisters a binding on mount/unmount.
  - `useKeyboardListener()` — mounts `Keyboard.handle` on `window` keydown; call once in `App.tsx`.
  Chord support via 400ms timeout between keystrokes. Expose `Keyboard.pushScope`/`popScope` via a `useKeyboardScope(scope)` hook for modal/dialog use.

- [ ] **GOO-23** Design system: typography, color, dark mode _(High)_
  **Must come before GOO-15** (welcome screen has UI). Dark mode first. Linear/Arc/Obsidian inspired. CSS custom properties via `@theme` in `app.css` — shadcn's vars are the base, extend with dark-mode overrides + typography scale. System font stack. No gradients, minimal shadows.

- [ ] **GOO-15** Vault selection + persistence _(Urgent)_
  First-launch welcome screen: "Create New Vault".
  **Persistence**: vault registry stored via `@tauri-apps/plugin-store` as `Vault[]` JSON.
  **Auto-reopen**: on subsequent launches, find vault with most recent `lastOpenedAt`, call `connectDb(path)` (already stubbed in VaultContext) then `loadVaultData()`. Skip welcome screen entirely.
  **Stale path**: if DB file no longer exists at stored path, show "Vault not found" error with option to re-select location or remove from list.
  Only show welcome screen when no vaults are known.

---

## Phase 2 — Editor & Metadata

- [ ] **GOO-14** Resizable three-panel layout _(High)_
  Left 180px | Pages 280px | Right flex. Drag to resize. Persist widths to localStorage.
  **Also wire App.tsx**: replace the three empty `<div>`s with real panel components (`<Sidebar>`, `<PageListPanel>`, `<EditorPanel>`). Without this, Phase 2 UI tasks have nowhere to render.

- [ ] **GOO-89** Page list panel _(High)_ — **requires GOO-14**
  Middle column. Renders pages for the active view (`UIContext.activeViewId`):
  - `'today'` → pages with a `page_schedules` row where date ≤ today AND `status ≠ done`
  - `'inbox'` → pages where `folderId === null`
  - `folderId` → pages where `folderId === id`
  Sorted by `sortOrder`. Each item shows title, subtitle, status badge, priority indicator. Clicking a page calls `setActivePage`. Active page highlighted. Empty state per view. Keyboard nav (J/K/Enter) wired via `useKeyboardShortcut` once GOO-31 is done.

- [ ] **GOO-37** Folder CRUD _(High)_
  Create / rename / delete folders. Left panel folder list. Drag to reorder (via `reorderFolders`). No nesting in v1.
  **Delete UX (GOO-88)**: deleting a folder with pages must not silently destroy data. Current schema uses `ON DELETE SET NULL` — pages become inbox items, nothing is lost. UI should show a confirmation: "X pages will be moved to Inbox. Delete folder?" with a count. No "move to another folder" picker needed for v1.

- [ ] **GOO-88** Folder delete confirmation dialog _(High)_ — implement alongside GOO-37
  When deleting a non-empty folder: count pages in that folder, show modal: "Delete [name]? X pages will be moved to Inbox." Primary action: "Delete & Move to Inbox". Cancel aborts. Empty folders delete immediately with no prompt.

- [ ] **GOO-79** Today smart view + Inbox smart view _(High)_ — **requires GOO-37**
  Pinned above folders in left panel — completes the sidebar. Today = `page_schedules` rows where date ≤ today AND status ≠ done. Inbox = `folder_id IS NULL`. Both show page count badges. Sidebar is incomplete without these; build alongside or immediately after GOO-37.

- [ ] **GOO-80** Sidebar collapse + navigation keyboard shortcuts _(High)_ — **requires GOO-79**
  Binary collapse (all-open OR both-left-collapsed). `Cmd+\` toggles. framer-motion spring (stiffness 350, damping 35). `J`/`K` = prev/next page, `Enter` = open, `Escape` from editor = focus page list, `Cmd+Shift+C` = toggle editor/calendar. J/K/Enter auto-expand if collapsed. `sidebarCollapsed` is already live in UIContext.

- [ ] **GOO-10** Tiptap WYSIWYG editor _(Urgent)_
  `@tiptap/react`, `@tiptap/starter-kit`, task-list, task-item, placeholder extensions. Storage format: Tiptap JSON in SQLite (`content` column). Editor subscribes to `UIContext.activePage` to know what to load/save. On each save, extract plain text via `editor.getText()` and write to `content_text` for FTS — piggyback on the 800ms autosave, no separate debounce needed. Markdown only at import/export boundary. Task-list checkboxes NOT wired to page `status`. See `features/editor.md`.

- [ ] **GOO-36** Auto-save + save indicator _(Urgent)_
  No manual save. Debounce 800ms on content changes; flush on blur/close/`Mod+W`. See `features/editor.md` for full strategy.

- [ ] **GOO-32** Collapsible metadata header _(Urgent)_
  Above editor. Fields: status toggle, priority selector, scheduled date, tags, subtitle, folder. Collapsed by default unless metadata is set. See `features/metadata.md`.

- [ ] **GOO-33** Page status toggle _(High)_
  Three-state cycle: `not_started → in_progress → done`. Checkbox/icon in page list + metadata header. Completing sets `completedAt`.

- [ ] **GOO-35** Priority selector _(Medium)_
  Dropdown in metadata header. 5 levels: none / urgent / high / medium / low. Shown as colored badge in page list.

- [x] **GOO-76** Schedule + recurrence Tauri commands _(High)_
  `src-tauri/src/db/schedules.rs`. Two tables: `page_schedules` (explicit blocks) + `page_recurrence_rules` (rrule templates). All-day inferred from start format. Denorm refresh on every insert/delete.

- [ ] **GOO-19** NL page creation parser _(High)_
  `packages/core/src/nlp/parser.ts`. Pure TS, zero DOM/Tauri deps. Returns `ParseResult`: `single | finite | recurring`. Tokens: date (`@today`), time (`9pm`), duration (`for 1h`), recurrence (`m/w/f`, `every monday`), tag (`#work`), folder (`~Projects`), priority (`!urgent`). Deps: `rrule` + `chrono-node`. See `BACKLOG.md` GOO-19 for full spec.

- [ ] **GOO-60** Quick Add Modal _(Urgent)_ — **requires GOO-19**
  Small centered modal from anywhere (`Cmd+N`). NL input → `parseInput()`. Live metadata chips (date/priority/folder). Confirmation step for recurring or finite ≥3 pages. Enter to create.

- [ ] **GOO-34** Scheduled date/time picker _(High)_ — **requires GOO-76**
  Calendar popover + time input in metadata header. Updates `page_schedules` row via `create_page_schedule` / `delete_page_schedule`.

---

_For Phase 3+ full specs and later phases — grep `BACKLOG.md`._
