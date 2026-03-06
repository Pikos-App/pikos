# Pikos — Active Backlog

Next-up items only (Phase 0 remaining + Phase 1). For full history and later phases, grep `BACKLOG.md` by GOO number — **never load it whole (86KB)**.

Status: `[ ]` pending · `[~]` in progress · `[x]` done

---

## Phase 1 — Foundation

- [ ] **GOO-90** App-level error boundary _(Medium)_ — **do before GOO-15**
  Wrap `<AppShell>` in a React error boundary. GOO-15 introduces real vault I/O paths; if VaultContext throws, the app goes blank with no recovery UI. Minimum: catch render/mount errors and show "Something went wrong — please relaunch" with a reset button. Use `react-error-boundary` or a simple class component ErrorBoundary in `apps/desktop/src/shared/`. One boundary around `<AppShell>` is sufficient for Phase 1.

- [ ] **GOO-15** Workspace auto-create + persistence _(Urgent)_
  **First launch**: silently create workspace DB at `appDataDir/default.sqlite` (Tauri `appDataDir()`). Show a simple welcome/onboarding screen (app name + "Get started") — not a file picker. User never sees file paths.
  **Persistence**: workspace registry stored via `@tauri-apps/plugin-store` as `Workspace[]` JSON.
  **Auto-reopen**: on subsequent launches, find workspace with most recent `lastOpenedAt`, call `connectDb(path)` (already stubbed in WorkspaceContext) then `loadWorkspaceData()`. Skip welcome screen entirely.
  **Stale path**: if DB file no longer exists at stored path, recreate at same path (or show minimal error with "Reset" option).
  **Multiple workspaces**: Settings → "Manage Workspaces" only — not exposed in main UI.

---

## Phase 2 — Editor & Metadata

- [ ] **GOO-14** Resizable three-panel layout _(High)_
  Left 180px | Pages 280px | Right flex. Drag to resize. Persist widths to localStorage.
  **Also wire App.tsx**: replace the three empty `<div>`s with real panel components (`<Sidebar>`, `<PageListPanel>`, `<EditorPanel>`). Without this, Phase 2 UI tasks have nowhere to render.

- [ ] **GOO-91** `list_pages_today` Rust command _(High)_ — **do before GOO-89**
  `src-tauri/src/db/pages.rs`. The Today view cannot be served by `list_pages` — it filters `pages.scheduled_start` (the denorm), not the actual `page_schedules` table. Need a JOIN: `SELECT DISTINCT pages.* FROM pages JOIN page_schedules ON page_schedules.page_id = pages.id WHERE date(page_schedules.scheduled_start) <= date('now') AND pages.status != 'done'`. New command: `list_pages_today`. Register in `lib.rs`. Add to `StorageAdapter` interface, `TauriSQLiteAdapter`, and `MockStorageAdapter`.

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

- [ ] **GOO-92** Derive `activePage` from `activePageId` in UIContext _(High)_ — **do before GOO-10**
  UIContext stores `activePage: Page | null` as a snapshot. Once the editor is live, `VaultContext.updatePage` (debounced) will leave UIContext holding stale data — the editor reads old content. Fix: store `activePageId: string | null` instead; derive the page via `useVault().pages.find(...)` or a `useActivePage()` convenience hook. Update call sites. Breaking change to UIContext shape — must land before GOO-10 builds on the current API.

- [ ] **GOO-93** Foundation micro-fixes _(Medium)_ — **do before GOO-10 / GOO-36**
  Three small bugs found in audit, each <10 lines:
  1. **Timer leak**: `VaultContext.deletePage` doesn't cancel the pending debounce timer — `adapter.updatePage` fires ~800ms after deletion. Fix: clear `debounceTimers` + `pendingPatches` for the ID in `deletePage`.
  2. **`content_text` NOT NULL**: `createPage` in VaultContext passes no `contentText`; Rust binds NULL to a `NOT NULL` column. Fix: pass `contentText: ""` explicitly in the `createPage` call.
  3. **`reorder_pages` folder guard**: Rust command ignores `folder_id` — sorts any IDs regardless of folder, risking cross-folder corruption. Fix: add `WHERE folder_id = ?` (or `WHERE folder_id IS NULL`) to each UPDATE.

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
