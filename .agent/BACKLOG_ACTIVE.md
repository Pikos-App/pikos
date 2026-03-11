# Pikos — Active Backlog

Next-up items only (Phase 1 + Phase 2). For Phase 3+ specs — grep `BACKLOG.md` by GOO number.

Status: `[ ]` pending · `[~]` in progress · Delete task when done.


---

## Phase 2 — Editor & Metadata


- [ ] **GOO-103** Slash command menu _(High)_
  Type `/` in the editor to open a filterable command palette for inserting block types. Powered by `@tiptap/suggestion` (free). Items: Heading 1/2/3, Bullet list, Ordered list, Task list, Code block, Blockquote, Horizontal rule. Keyboard navigable (↑/↓/Enter/Esc). Fuzzy filter on typing. Renders as a floating popover anchored to the cursor. Component: `apps/desktop/src/features/editor/components/SlashMenu.tsx`.

- [ ] **GOO-104** Bubble menu on text selection _(High)_
  Select text to show a floating toolbar with Bold, Italic, Strikethrough, Code, Underline, Link. Uses `@tiptap/extension-bubble-menu` (free). Appears above selection, disappears on deselect. Buttons show active state (e.g. bold button highlighted when cursor is in bold text). Minimal, dark-themed, compact. Component: `apps/desktop/src/features/editor/components/BubbleToolbar.tsx`.

- [ ] **GOO-105** Editor drag handle _(Medium)_
  Hover left of any block to show a grip icon for drag-reorder. Custom ProseMirror NodeView plugin (the official `@tiptap/extension-drag-handle` is paid). Grip appears on hover with subtle fade-in. Drag creates a drop indicator line between blocks. Works with all block types (paragraphs, headings, lists, code blocks). Component: `apps/desktop/src/features/editor/components/DragHandle.tsx`. Before you get started on this one - are you intending to build this functionality from scratch since the dep is paid? How complex would this task be? Worth building in its current task priority?

- [ ] **GOO-106** Editor keyboard scope integration _(Medium)_
  Wire editor focus/blur into the keyboard registry: `pushScope('editor')` on focus, `popScope('editor')` on blur. Global shortcuts (`Cmd+P`, `Cmd+N`, `Cmd+W`) remain active in all scopes. Editor-specific shortcuts only fire when the editor scope is active. Prevents conflicts between editor key combos and app-level shortcuts. Also we should update command + \ to work when editor is focused so we can rapidly switch into full editor/calendar.

- [ ] **GOO-107** Cmd+A scoped to editor _(High)_
  When the editor is focused, `Cmd+A` should select all content within the editor only — not the entire page/app. ProseMirror handles this natively when focused, but if focus leaks or the event bubbles, the browser's default select-all kicks in and highlights the sidebar/page list too. Ensure the editor traps `Cmd+A` when it has focus. If the editor is NOT focused (e.g. focus is on page list or sidebar), `Cmd+A` should do nothing or select within that context — never cross panel boundaries.

- [ ] **GOO-111** Escape key exits editor focus _(High)_
  Pressing `Esc` when the editor is focused should blur the editor and return focus to the page list panel. This is the primary "exit" gesture — users should never feel trapped in the editor. Considerations:
  - If a slash menu, bubble menu, or any popover is open, first `Esc` closes the popover; second `Esc` exits the editor.
  - If text is selected, first `Esc` deselects (collapses to cursor); second `Esc` exits.
  - On exit: `editor.commands.blur()`, then focus the active page item in the page list (so `J`/`K` navigation works immediately).
  - `Enter` on a page list item should re-focus the editor (round-trip: Esc out → navigate → Enter back in).
  - Wire via ProseMirror keymap (`Escape` handler) inside `EditorPane`, not the global keyboard registry (avoid conflict with modal/popover Esc handling).

- [ ] **GOO-108** Tab key behavior in editor _(High)_
  Tab inside the editor should indent list items / task items (standard editor behavior), NOT move focus to the next focusable DOM element. Currently Tab may be bubbling to the browser's default tab-index navigation. Fix: intercept Tab/Shift+Tab in the editor's ProseMirror keymap. In lists: indent/outdent. In code blocks: insert tab character (2 spaces). Outside lists/code: either indent the paragraph or do nothing (NOT move focus). Shift+Tab in lists: outdent. `Esc` should be the explicit way to leave the editor and return focus to the app shell (page list).

- [ ] **GOO-36** Save indicator UI _(Urgent)_ — **requires GOO-109**
  The `useAutosave` hook and editor content debounce are already shipped (GOO-10). What remains:
  - **Save indicator component** — visual feedback next to title in MetadataHeader (requires GOO-109/GOO-32 first)
  - States: (nothing) = clean, `●` = pending/saving, `✓` = saved (fades 1.5s), `⚠` = error (sticky, click → retry)
  - Consolidates all fields (title + content + subtitle) into one signal
  - Wire title/subtitle `useAutosave` instances (done as part of GOO-109)
  - Toast is NOT used — too noisy for continuous autosave
  - Error state must be sticky — silent data loss is unacceptable

  Before implementing this - let's check in - it might not be worth having a save indicator since if we don't lose people's content we won't have trust loss and need a signal for success states. We should have an error state though.

- [ ] **GOO-32** Collapsible metadata header _(Urgent)_
  ```
  ┌──────────────────────────────────────────┐
  │ ● My Page Title                  [↑ hide]│  ← collapsed (title always visible)
  ├──────────────────────────────────────────┤
  │ ○ Status  ↑ Priority  📅 Mar 3 · 3pm  #tag│  ← expanded row 1
  │ Parent: / Project Alpha                  │  ← expanded row 2
  └──────────────────────────────────────────┘
  ```
  Title always visible, inline-editable. Expand/collapse: CSS `grid-template-rows: 0 → 1fr` (no layout jump). Persist state per-page in localStorage. `Cmd+Shift+M` toggle. `Tab` through fields. `Esc` returns focus to editor. Rendered by `EditorPanel`, not the editor itself. See `features/metadata.md`.

- [ ] **GOO-112** Link editing UI _(Medium)_
  Link extension is installed (`@tiptap/extension-link`) with autolink + link-on-paste, but there's no interactive UI to add/edit/remove links. Users need: (1) a way to add a link to selected text (bubble menu button, GOO-104 dependency), (2) clicking an existing link shows a small popover with URL + edit/unlink buttons, (3) `Cmd+K` shortcut to insert/edit link (standard across Google Docs, Notion, Obsidian). Component: `apps/desktop/src/features/editor/components/LinkPopover.tsx`.

- [ ] **GOO-113** Editor accessibility _(High)_
  The editor needs WCAG 2.1 AA compliance per project standards. Currently missing: `role="textbox"` and `aria-label` on the editor container, `aria-live` region for save state announcements, visible focus indicator on the editor container, keyboard-accessible task list checkboxes, placeholder text announced to screen readers (currently CSS-only). Should be done alongside or right after GOO-106 (keyboard scope).

- [ ] **GOO-33** Page status toggle _(High)_
  Three-state cycle: `not_started` (○) → `in_progress` (◑) → `done` (✓). Click cycles. Done: strikethrough + muted in pages list, `completedAt` set. Writes to `status` DB column. Icon in both page list + metadata header. I actually don't think we need the in_progress status - thoughts?

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

- [ ] **GOO-99** Enhanced folder delete modal _(Medium)_ — **requires GOO-37 ✓**
  When deleting a folder that contains pages, replace the current fixed "move to Inbox" confirmation with two explicit choices:
  - **Move pages** (default) — folder selector dropdown pre-filled with "Inbox"; user can pick any other existing folder. On confirm: moves all pages in the deleted folder to the chosen destination (`updatePage({ folderId })` for each), then deletes the folder.
  - **Archive pages** — moves all pages to a hidden `archived` status (`status = 'archived'`) rather than deleting them. Pages disappear from all normal views but are recoverable via a future Archive view (GOO-TBD). On confirm: bulk-updates `status = 'archived'` for all pages in folder, then deletes the folder.

  Modal structure (shadcn `AlertDialog` + `Select` + `RadioGroup` or two `Button` variants):
  ```
  Delete "Project Alpha"?
  ○ Move pages to: [Inbox ▾]
  ○ Archive pages  (recoverable)
  [Cancel]  [Confirm]
  ```
  `FolderDeleteDialog` component in `apps/desktop/src/features/folders/components/`. `WorkspaceContext` may need a `bulkUpdatePages` or `archiveFolder` helper if individual `updatePage` calls are too chatty.

---

## UX — Completed Items

- [ ] **GOO-102** Completed items in folder/inbox views — design decision _(Medium)_
  Today view has a "Completed" accordion (GOO-101 ✓). Need to decide how completed items behave in folder and inbox views. Current: shown inline with strikethrough. Options under consideration:
  - Per-folder opt-in accordion (task-oriented folders get accordion, knowledge-base folders stay inline)
  - Global "Hide completed" toggle in sort menu
  - Automatic: folders with >N completed items get the accordion
  Key constraint: must stay simple and serve both task-manager and knowledge-base users without forcing a "task vs note" type distinction (TickTick's approach feels bolted-on). Every page is both. The UX should emerge from folder-level behavior, not page-level categorization.

---

## Developer Tooling

- [ ] **GOO-95** Dev: seed command — reset UI preferences _(Low)_
  Script or Tauri dev command to wipe `localStorage` and plugin-store settings keys back to defaults. Useful when testing first-run flows or settings panels. Can be a `pnpm dev:reset-ui` script that opens the app with a `?resetUI=1` query param cleared on startup, or a hidden `Cmd+Shift+Option+R` chord in dev builds only.

- [ ] **GOO-96** Dev: seed command — populate workspace _(Low)_
  Script that inserts a realistic dataset (folders, pages with varied status/priority/tags/schedules) into the active SQLite workspace. Goal: fill the UI for screenshot/demo/dev without manual entry. Invoke via `pnpm dev:seed`. Should be idempotent (no-op if seed marker page exists). ~20 pages across 4 folders + a few page_schedules rows.

---

## Phase 2 — Appearance

- [ ] **GOO-97** Theme selector _(Medium)_ — **do before GOO-59**
  Lightweight standalone theme toggle, ships before the full Settings modal (GOO-59). Three options: System / Light / Dark. Store in `localStorage` under `pikos:theme`. Apply to `<html data-theme="...">`. Render as a `ToggleGroup` or segmented control in the right-panel header (top-right, small icon row). `useTheme()` hook in `apps/desktop/src/shared/hooks/useTheme.ts`. GOO-59 Appearance panel will wire into the same key — no migration needed.

---

_For Phase 3+ full specs — grep `BACKLOG.md` by GOO number._
