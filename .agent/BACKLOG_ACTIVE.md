# Pikos — Active Backlog

Next-up items only (Phase 1 + Phase 2). For Phase 3+ specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · `[~]` in progress · Delete task when done.


---

## Phase 2 — Editor & Metadata


- [ ] **GOO-94** Page CRUD actions _(High)_ — **requires GOO-37, implement alongside GOO-89**
  Inline create and context menu for page list items.
  - **"+" button** in page list panel header → `createPage({ folderId: activeViewId if folder, else null })` → sets new page as active, opens editor. Skips NL parsing.
  - **Context menu** (right-click on any `PageListItem`):
    - **Rename** → focuses the title field in the editor (just calls `setActivePage` + emits a `focus-title` event that the metadata header listens for). No inline rename in the list itself.
    - **Delete** → if `content` is non-empty or page has any `page_schedules` rows: show confirmation modal "Delete [title]? This cannot be undone." Primary: "Delete". Cancel: no-op. Empty pages delete immediately with no prompt.
    - **Move to folder** → popover showing folder list + "Inbox" option. Selecting calls `updatePage({ folderId })`. Active folder pre-selected.
  - Context menu implemented with shadcn `ContextMenu`. Confirmation modal reuses shadcn `AlertDialog`.
  Component lives in `apps/desktop/src/features/pages/components/`.

- [ ] **GOO-89** Page list panel _(High)_ — **requires GOO-14**
  Middle column. Renders pages for the active view (`UIContext.activeViewId`):
  - `'today'` → call `listPagesToday()` (GOO-91)
  - `'inbox'` → pages where `folderId === null`
  - `folderId` → pages where `folderId === id`
  Sorted by `sortOrder`. Each item shows title, subtitle, status badge, priority indicator. Clicking a page calls `setActivePage`. Active page highlighted. Empty state per view. Keyboard nav (J/K/Enter) wired via `useKeyboardShortcut`.

- [ ] **GOO-37** Folder CRUD _(High)_
  v1: flat list of folders — no nesting. Create: right-click → "New Folder" or "+" button, inline rename auto-focused. Rename: double-click. Delete: context menu → confirmation (GOO-88). Color picker in context menu. Drag to reorder (`@dnd-kit/core` via `reorderFolders`).

- [ ] **GOO-88** Folder delete confirmation dialog _(High)_ — implement alongside GOO-37
  When deleting a non-empty folder: count pages in that folder, show modal: "Delete [name]? X pages will be moved to Inbox." Primary action: "Delete & Move to Inbox". Cancel aborts. Empty folders delete immediately with no prompt.

- [ ] **GOO-79** Today smart view + Inbox smart view _(High)_ — **requires GOO-37**
  Two pinned smart views at top of left panel above user folders. Today: pages with any `page_schedules` row where `date(scheduled_start) <= date('now')` and `status != 'done'`; grouped in page list as Overdue (collapsed) + Today sections; badge = total count. Inbox: pages where `folder_id IS NULL`; badge = count (hidden when 0). Both read-only sidebar entries — no delete/rename/reorder.

- [ ] **GOO-80** Sidebar collapse + navigation keyboard shortcuts _(High)_ — **requires GOO-79**
  Two states only — all-open or both-left-collapsed (no partial). `Cmd+\` toggles. `SidebarToggle` button in top-left of right panel header (always visible): `PanelLeftClose`/`PanelLeftOpen` lucide icons, tooltip shows shortcut. Both panels animate via framer-motion spring (stiffness 350, damping 35, width+opacity). State persisted to `localStorage`.

  Navigation shortcuts (`allowInInputs: false`):
  - `J` / `K` — next/previous page in current list (highlights but doesn't auto-open)
  - `Enter` — open the highlighted page in editor
  - `Escape` (from editor) — return focus to page list
  - `Cmd+Shift+C` — toggle editor ↔ calendar (right panel)
  - `Cmd+\` — toggle sidebar

  When sidebar is collapsed and `J`/`K`/`Enter` fires, sidebar auto-expands first.

- [ ] **GOO-92** Derive `activePage` from `activePageId` in UIContext _(High)_ — **do before GOO-10**
  UIContext currently stores `activePage: Page | null` as a full snapshot. Once GOO-10 (editor) is live, debounced `WorkspaceContext.updatePage` calls will leave UIContext stale — the editor renders outdated content. Fix: store `activePageId: string | null` in UIContext instead; expose a `useActivePage()` hook in `apps/desktop/src/shared/hooks/` that reads `useWorkspace().pages.find(p => p.id === activePageId) ?? null`. Update `setActivePage` to accept `Page | string | null` for backwards DX. Breaking interface change to UIContext — must land before GOO-10.

- [ ] **GOO-93** Foundation micro-fixes _(Medium)_ — **do before GOO-10 / GOO-36**
  Three small bugs in WorkspaceContext/Rust, each <10 lines:
  1. **Timer leak in deletePage**: `WorkspaceContext.deletePage` doesn't cancel the pending debounce timer. ~800ms later, `adapter.updatePage` fires on a deleted row. Fix: `debounceTimers.current.get(id)` clear + `pendingPatches.current.delete(id)` at top of `deletePage`.
  2. **`content_text` NOT NULL violation**: `WorkspaceContext.createPage` doesn't pass `contentText`; Rust binds NULL to a `NOT NULL DEFAULT ''` column. Fix: pass `contentText: ""` in the `createPage` call.
  3. **`reorder_pages` missing folder guard**: Rust command discards `folder_id`, updating sort_order for any IDs regardless of folder. Fix: add `AND folder_id = ?` (or `AND folder_id IS NULL`) to each UPDATE inside the transaction.

- [ ] **GOO-10** Tiptap WYSIWYG editor _(Urgent)_
  Install: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/extension-placeholder`. **Storage format: Tiptap JSON** (not markdown) — direct `getJSON()`/`setContent()`, no conversion layer. Extract plain text via `editor.getText()` for FTS — write to `content_text` on every autosave (piggyback on 800ms debounce, no separate debounce needed). Support: headings, bold, italic, strikethrough, code, code block, lists, interactive checkboxes. Task-list checkboxes are inline doc elements — NOT wired to page `status` field. Editor subscribes to `activePageId` (GOO-92) to know what to load/save. See `features/editor.md`.

- [ ] **GOO-36** Auto-save + save indicator _(Urgent)_ — **requires GOO-10**
  No manual save, no save button. Strategy varies by field:

  **Debounced fields** (user is mid-thought):
  - Editor content: 800ms → `updatePage({ content, contentText })`
  - Title: 500ms → `updatePage({ title })`
  - Subtitle: 500ms → `updatePage({ subtitle })`
  - All flush immediately on: `window.blur`, page switch (`activePageId` change), app close, `Mod+W`

  **Immediate fields** (discrete action — intent is complete):
  - Status, priority, folder: save on click/select
  - Tags: save on Enter/comma/blur (add) or × click (remove)
  - Schedule: save on picker confirm/close (inserts/deletes `page_schedules` row)

  **`useAutosave` hook** (`packages/core/src/hooks/useAutosave.ts`):
  ```ts
  function useAutosave<T>(
    value: T,
    saveFn: (val: T) => Promise<void>,
    options?: { delay?: number } // default 800ms
  ): { isDirty: boolean; isSaving: boolean; saveError: Error | null };
  ```
  Used by `EditorPane`, `TitleField`, `SubtitleField`. Immediate-save fields call `updatePage` directly.

  **Save indicator** (in `MetadataHeader`, next to title):
  - Clean: nothing shown
  - Pending/saving: `●` dot (covers all fields as one signal)
  - Just saved: `✓` fades out after 1.5s
  - Error: `⚠` sticky; click → retry. Never silently drops data.

- [ ] **GOO-32** Collapsible metadata header _(Urgent)_ — **requires GOO-10**
  ```
  ┌──────────────────────────────────────────┐
  │ ● My Page Title                  [↑ hide]│  ← collapsed (title always visible)
  ├──────────────────────────────────────────┤
  │ ○ Status  ↑ Priority  📅 Mar 3 · 3pm  #tag│  ← expanded row 1
  │ Parent: / Project Alpha                  │  ← expanded row 2
  └──────────────────────────────────────────┘
  ```
  Title always visible, inline-editable. Expand/collapse: CSS `grid-template-rows: 0 → 1fr` (no layout jump). Persist state per-page in localStorage. `Cmd+Shift+M` toggle. `Tab` through fields. `Esc` returns focus to editor. Rendered by `EditorPanel`, not the editor itself. See `features/metadata.md`.

- [ ] **GOO-33** Page status toggle _(High)_
  Three-state cycle: `not_started` (○) → `in_progress` (◑) → `done` (✓). Click cycles. Done: strikethrough + muted in pages list, `completedAt` set. Writes to `status` DB column. Icon in both page list + metadata header.

- [ ] **GOO-35** Priority selector _(Medium)_
  Icon-based: None (— muted), Urgent (!! red), High (! orange), Medium (·· yellow), Low (· blue). Linear-inspired. Dropdown in metadata header. Shown as colored badge in page list. Writes `priority` column (0–4).

- [ ] **GOO-19** NL page creation parser _(High)_ — **required by GOO-60**
  `packages/core/src/nlp/parser.ts`. Pure TS, zero DOM/Tauri deps.

  ```ts
  export interface ParsedInput {
    title: string;           // remaining text after tokens extracted
    scheduledStart?: string; // ISO 8601
    scheduledEnd?: string;   // ISO 8601 (derived from start + duration)
    durationMinutes?: number;
    tags: string[];
    folderQuery?: string;    // caller fuzzy-matches against folders[]
    priority?: PagePriority;
  }

  export type ParseResult =
    | { type: 'single'; input: ParsedInput }
    | { type: 'finite'; inputs: ParsedInput[]; count: number }  // N independent pages
    | { type: 'recurring'; input: ParsedInput; rrule: string }; // 1 template page

  export function parseInput(raw: string, now?: Date): ParseResult;
  ```

  **Two recurrence modes:**

  | Type | Example | Output | Storage |
  |---|---|---|---|
  | Finite — bounded window | `run m/w/f for 2 weeks` | N independent pages | N rows in `pages` |
  | Infinite/ongoing | `daily standup every monday 1pm` | 1 template page | 1 row, `rrule` set |

  "for 2 weeks", "3 times", "through march 15" → finite. "every monday", "daily", "every weekday" with no bound → infinite (stored RRULE).

  **Token syntax:**

  | Token | Examples | Result |
  |---|---|---|
  | Date | `@today` `@tomorrow` `@monday` `@march5` | `scheduledStart` |
  | Time | `9pm` `at 3:30pm` `14:00` | sets time on scheduledStart |
  | Duration | `for 1h` `for 30min` `for 2 hours` | `durationMinutes` → `scheduledEnd` |
  | Finite recurrence | `m/w/f` `mon/wed/fri` `weekdays` | expands to N pages |
  | Finite window | `for 2 weeks` `3 times` `through march 15` | bounds the expansion |
  | Infinite recurrence | `every monday` `daily` `every weekday` | → stored RRULE |
  | Tag | `#work` `#design` | `tags[]` |
  | Folder | `~Projects` `~inbox` | `folderQuery` |
  | Priority | `!urgent` `!high` `!medium` `!low` | `priority` |

  **Examples:**

  | Input | Result |
  |---|---|
  | `run m/w/f at 3pm for 45m` | finite: 3 pages (next Mon/Wed/Fri, 15:00, 45min) |
  | `gym m/w/f for 1h through march 31` | finite: all Mon/Wed/Fri until Mar 31 |
  | `daily standup every monday 1pm for 15m` | recurring: 1 page, `FREQ=WEEKLY;BYDAY=MO` |
  | `morning run daily at 7am for 30m` | recurring: 1 page, `FREQ=DAILY` |
  | `review sprint weekdays at 9am 3 times` | finite: 3 pages (next 3 weekdays, 9am) |

  **Default finite window**: no window specified + days present + no "every" → next single occurrence of each day. "m/w/f" → 3 pages. Prevents runaway creation.

  **Libraries**: `rrule` (npm) for RRULE parsing/expansion (CalDAV compatible); `chrono-node` for NL date/time.

- [ ] **GOO-60** Quick Add Modal _(Urgent)_ — **requires GOO-19**
  `Cmd+N` from anywhere opens a small centered modal. Single entry point for new page creation.

  **Visual design:**
  ```
  ┌──────────────────────────────────────────────────────────────┐
  │  What would you like to do?                                  │
  ├──────────────────────────────────────────────────────────────┤
  │  📅 Today   🚩   ⬇ Inbox                          [  Add  ] │
  └──────────────────────────────────────────────────────────────┘
  ```
  Small modal, vertically centered, ~600px wide. Dark overlay. Single text input, auto-focused. `Enter` or `Add` → create. `Esc` or click-outside → cancel (no page created). Empty input → shake animation, no create.

  **Metadata chips** (bottom row, update live from NL parsing):
  - **📅 Date** — defaults to Today. NL input overrides. Click → shadcn calendar popover + time input. Click active chip → clear.
  - **🚩 Priority** — defaults to None. NL `!high` etc. overrides. Click → priority picker.
  - **⬇ Folder** — defaults to active folder from `UIContext.activeViewId` (when it's a folderId), else "Inbox". NL `~folder` overrides (fuzzy-matched against `folders[]`). Click → folder picker.

  **On submit:**
  1. `parseInput(raw)` → `ParseResult`
  2. Fuzzy-match `folderQuery` against `folders[]` → resolve to `folderId`
  3. **Confirmation step** (before any writes):
     - `type: 'recurring'` → always confirm (show RRULE summary)
     - `type: 'finite'` with `count ≥ 3` → confirm ("This will add X pages to your calendar.")
     - `type: 'single'` or finite `count < 3` → create immediately
  4. On confirm: `createPage()` for each result (single → 1, finite → N, recurring → 1 template)
  5. Close modal. `setActivePage(newPage)` → open page in editor.

  **Progressive enhancement**: Phase 1 ships without folder chip (hidden until GOO-37 ships).
  Component: `apps/desktop/src/features/pages/components/QuickAddModal.tsx`
  Registered globally in `App.tsx` via `useKeyboardShortcut('Mod+N', ...)`.

- [ ] **GOO-34** Scheduled date/time picker _(High)_ — **requires GOO-76**
  shadcn Popover with mini calendar + time input. Quick chips: Today, Tomorrow, Monday, Next week. Duration shortcuts: 15min, 30min, 1h, 2h. Writes `scheduledStart`/`scheduledEnd` via `create_page_schedule` / `delete_page_schedule`.

---

_For Phase 3+ full specs — grep `BACKLOG.md` by GOO number._
