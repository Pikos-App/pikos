# Pikos Backlog — Full Archive

> **DO NOT LOAD THIS FILE WHOLE — it is 86KB.**
> Use `BACKLOG_ACTIVE.md` for next-up tasks.
> Grep this file by GOO number when you need a specific item's full spec.

Full export from Linear (Goose Labs / GOO), 2026-02-28. Linear is now archived.
Status: `[ ]` pending · `[~]` in progress · `[x]` done · `[-]` superseded/deferred

**App name**: Pikos (update `productName` + `identifier` in `tauri.conf.json` during GOO-26)
**Repo name**: pkos
**src-tauri location**: `apps/desktop/src-tauri/` — must be sibling of frontend dist; `frontendDist: "../dist"`

### Page Editor

- [ ] **GOO-19** NL page creation parser _(High)_ — moved from Phase 5, now powers GOO-60
      `packages/core/src/nlp/parser.ts`. Pure TS, zero DOM/Tauri deps. Parses a raw input string
      into structured `ParsedInput` — everything that isn't a recognised token becomes the title.

  ```ts
  // packages/core/src/nlp/parser.ts
  export interface ParsedInput {
    title: string; // remaining text after tokens are extracted
    scheduledStart?: string; // ISO 8601
    scheduledEnd?: string; // ISO 8601 (derived from start + duration)
    durationMinutes?: number;
    tags: string[]; // from #tag tokens
    folderQuery?: string; // from ~folder (caller fuzzy-matches against folders[])
    priority?: PagePriority; // from !urgent !high !medium !low
    recurrence?: RecurrenceRule; // when set, caller creates one page per expanded date
  }

  export type ParseResult =
    | { type: "single"; input: ParsedInput }
    | { type: "finite"; inputs: ParsedInput[]; count: number } // expand to N pages
    | { type: "recurring"; input: ParsedInput; rrule: string }; // store rule on one page

  // Single entry point — returns one of the three result shapes.
  export function parseInput(raw: string, now?: Date): ParseResult;
  ```

  **Two recurrence modes — the key architectural decision:**

  | Recurrence type                       | Example                                  | Output              | Storage                   |
  | ------------------------------------- | ---------------------------------------- | ------------------- | ------------------------- |
  | **Finite** — has a natural end        | `run m/w/f for 2 weeks`                  | N independent pages | N rows in `pages` table   |
  | **Infinite/ongoing** — no natural end | `daily standup every monday 1pm for 15m` | 1 template page     | 1 row, `rrule` column set |

  The distinction is whether the NL implies a bounded window. "for 2 weeks", "3 times",
  "through march 15" → finite. "every monday", "daily", "every weekday" with no bound → infinite.

  **Infinite recurrence — stored as RRULE:**
  The template page gets `rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=13;BYMINUTE=0"` and
  `duration_mins = 15`. Its `scheduled_start` = first occurrence. The calendar view uses
  `rrule.js` to expand virtual instances for the visible date range — these instances are
  not stored in the DB, just rendered. Clicking an instance opens the template page.

  **Token syntax:**
  | Token | Examples | Result |
  |---|---|---|
  | Date | `@today` `@tomorrow` `@monday` `@march5` | `scheduledStart` |
  | Time | `9pm` `at 3:30pm` `14:00` | sets time on scheduledStart |
  | Duration | `for 1h` `for 30min` `for 2 hours` | `durationMinutes` → `scheduledEnd` |
  | Finite recurrence | `m/w/f` `mon/wed/fri` `weekdays` | days, expands to N pages |
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

  **Default finite window** (no window specified, days present, no "every"):
  create the next single occurrence of each day — "m/w/f" → 3 pages. Least surprising; prevents
  runaway creation.

  **Libraries:**
  - `rrule` (npm) — parses and expands RRULE strings. Replaces the custom recurrence logic
    and ensures CalDAV compatibility (external events also use RRULE — GOO-22).
  - `chrono-node` — natural language date/time parsing for the non-recurrence tokens.

  Both are pure TS, zero DOM/Tauri deps — fit in `packages/core`.

- [ ] **GOO-91** `list_pages_today` Rust command _(High)_ — **do before GOO-89**
      `src-tauri/src/db/pages.rs`. The Today smart view requires a JOIN against `page_schedules` — `list_pages` cannot serve it because it filters `pages.scheduled_start` (the denorm), not the actual schedule rows. Correct query: `SELECT DISTINCT pages.* FROM pages JOIN page_schedules ON page_schedules.page_id = pages.id WHERE date(page_schedules.scheduled_start) <= date('now') AND pages.status != 'done' ORDER BY pages.sort_order ASC`. New Tauri command `list_pages_today`. Register in `lib.rs`. Add method to `StorageAdapter` interface in `packages/core/src/storage.ts`, implement in `TauriSQLiteAdapter` and `MockStorageAdapter`.

- [ ] **GOO-92** Derive `activePage` from `activePageId` in UIContext _(High)_ — **do before GOO-10**
      UIContext currently stores `activePage: Page | null` as a full snapshot. Once GOO-10 (editor) is live, debounced `VaultContext.updatePage` calls will leave UIContext stale — the editor will render outdated content. Fix: store `activePageId: string | null` in UIContext instead; expose a `useActivePage()` hook in `apps/desktop/src/shared/hooks/` that reads `useVault().pages.find(p => p.id === activePageId) ?? null`. Update `setActivePage` to accept `Page | string | null` for backwards DX. This is a breaking interface change to UIContext — must land before GOO-10 builds on the current shape.

- [ ] **GOO-93** Foundation micro-fixes _(Medium)_ — **do before GOO-10 / GOO-36**
      Three small bugs identified in codebase audit, each <10 lines:
      1. **Timer leak in deletePage**: `VaultContext.deletePage` doesn't cancel the pending debounce timer for the deleted page. ~800ms later, `adapter.updatePage` fires on a deleted row (unhandled error). Fix: clear `debounceTimers.current.get(id)` and `pendingPatches.current.delete(id)` at the top of `deletePage`.
      2. **`content_text` NOT NULL violation**: `VaultContext.createPage` doesn't pass `contentText`; Rust deserializes as `None` and binds NULL to the `NOT NULL DEFAULT ''` column. Fix: pass `contentText: ""` in the `createPage` call in VaultContext.
      3. **`reorder_pages` missing folder guard**: The Rust command receives `folder_id` and discards it (`let _ = folder_id`), updating sort_order for any IDs regardless of folder — silent corruption if caller passes wrong IDs. Fix: add `AND folder_id = ?` (or `AND folder_id IS NULL`) to each UPDATE inside the transaction.

- [ ] **GOO-10** Tiptap WYSIWYG editor _(Urgent)_
      Replace CodeMirror. `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/extension-placeholder`. **Storage format: Tiptap JSON** (not markdown) — direct `getJSON()`/`setContent()`, no conversion layer. Extract plain text via `extractText()` util for FTS. Markdown only at import/export boundary. Support: headings, bold, italic, strikethrough, code, code block, lists, interactive checkboxes. Note: task list checkboxes are inline doc elements, NOT wired to page `status` field. See `features/editor.md`.

- [ ] **GOO-36** Auto-save + save indicator _(Urgent)_

  No manual save, no save button. Strategy varies by field — see `features/editor.md` Auto-save for
  the full spec. Summary:

  **Debounced fields** (text input — user is mid-thought):
  - Editor content: 800ms → `updatePage({ content, contentText })`
  - Title: 500ms → `updatePage({ title })`
  - Subtitle: 500ms → `updatePage({ subtitle })`
  - All flush immediately on: `window.blur`, page switch (`activePage` change), app close, `Mod+W`

  **Immediate fields** (discrete actions — user intent is complete):
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

  Used by `EditorPane`, `TitleField`, `SubtitleField`. Immediate-save fields call `updatePage`
  directly — they don't use this hook.

  **Save indicator** (in `MetadataHeader`, next to title):
  - Clean: nothing shown
  - Pending/saving: `●` dot (covers all fields as one signal)
  - Just saved: `✓` fades out after 1.5s
  - Error: `⚠` sticky; click → retry. Never silently drops data.

- [ ] **GOO-60** Quick Add Modal _(Urgent)_
      `Cmd+N` from anywhere opens a small centered modal — the single entry point for new page
      creation. No more "instantly create empty page". The modal is always the first step.

  **Visual design** (matches provided screenshot):

  ```
  ┌──────────────────────────────────────────────────────────────┐
  │  What would you like to do?                                  │
  ├──────────────────────────────────────────────────────────────┤
  │  📅 Today   🚩   ⬇ Inbox                          [  Add  ] │
  └──────────────────────────────────────────────────────────────┘
  ```

  - Small modal, vertically centered, ~600px wide. Dark overlay behind.
  - Single text input, auto-focused on open. No other inputs.
  - Bottom row: live metadata chips + Add button.
  - `Enter` or `Add` → create page. `Esc` or click-outside → cancel (no page created).
  - Empty input → shake animation, no create.

  **Metadata chips** (bottom row):
  - **📅 Date** — defaults to Today (matches TickTick convention for a tasks-first app).
    NL input overrides live. Click → shadcn calendar popover + time input. Click active chip → clear.
  - **🚩 Priority** — defaults to None (icon shown muted). NL `!high` etc. overrides.
    Click → priority picker (None / Low / Medium / High / Urgent).
  - **⬇ Folder** — defaults to `UIContext.activeFolderId` ("Inbox" if null, folder name otherwise).
    NL `~folder` overrides (fuzzy-matched against `folders[]`). Click → folder picker dropdown.
    Shows "Inbox" with inbox icon, or folder name with colored dot.

  **NL parsing** (powered by GOO-19, runs on every keystroke):
  As the user types, tokens are extracted and chips update live:

  ```
  "Design review @tomorrow 2pm for 1h #work ~Projects !high"
       │               │        │      │       │         │
     title        tomorrow   14:00  60min  tag:work  Projects  priority:high
  ```

  Parsed metadata reflected immediately in chips. Unrecognised tokens stay in the title.
  If `~Projects` doesn't match any folder name → chip shown in amber (no match).

  **On submit:**
  1. `parseInput(raw)` → returns `ParseResult` (single | finite | recurring)
  2. Fuzzy-match `folderQuery` against `folders[]` → resolve to `folderId`
  3. **Confirmation step** (shown before any writes):
     - `type: 'recurring'` → always show: _"This will create a repeating event. [FREQ=WEEKLY;BYDAY=MO,WE,FR — every M/W/F]. [Confirm] [Cancel]"_
     - `type: 'finite'` with `count ≥ 3` → show: _"This will add 5 pages to your calendar. [Confirm] [Cancel]"_
     - `type: 'single'` or `type: 'finite'` with `count < 3` → no confirmation, create immediately
  4. On confirm (or no confirmation needed):
     - `type: 'single'`: `createPage(input)` → 1 page
     - `type: 'finite'`: `createPage(input)` for each of N inputs → N pages (sequential, in a loop)
     - `type: 'recurring'`: `createPage({ ...input, rrule })` → 1 template page; calendar renders recurrences dynamically
  5. Close modal
  6. `UIContext.setActivePage(newPage)` → opens the page (or first page for finite) in editor

  **Folder chip default logic** (matches `UIContext.activeFolderId`):
  - Active folder in sidebar → chip pre-set to that folder
  - Inbox selected → chip shows "Inbox"
  - No folder context (calendar, shortcut with no sidebar selection) → `Settings.defaultFolderId`

  **Progressive enhancement:**
  - Phase 1: ships without folder chip (folders don't exist yet — chip hidden, all pages go to inbox)
  - Phase 2: folder chip added when GOO-37 (Folder CRUD) ships

  Component: `apps/desktop/src/features/pages/components/QuickAddModal.tsx`
  Registered as a global shortcut in `App.tsx` via `useKeyboardShortcut('Mod+N', ...)`.

### Metadata Header

- [ ] **GOO-32** Collapsible metadata header _(Urgent)_

  ```
  ┌──────────────────────────────────────────┐
  │ ● My Page Title                  [↑ hide]│  ← collapsed
  ├──────────────────────────────────────────┤
  │ ○ Status  ↑ Priority  📅 Mar 3 · 3pm  #tag│  ← expanded row 1
  │ Parent: / Project Alpha                  │  ← expanded row 2
  └──────────────────────────────────────────┘
  ```

  Title always visible, inline-editable. Expand/collapse: CSS `grid-template-rows: 0 → 1fr` (no layout jump). Persist state per-page in localStorage. `Cmd+Shift+M` toggle. `Tab` through fields. `Esc` returns focus to editor. Rendered by `EditorPanel`, not the editor itself. Frontmatter title is canonical (not H1).

- [ ] **GOO-33** Page status toggle _(High)_
      `not_started` (○) → `in_progress` (◑) → `done` (✓). Click cycles. Done: strikethrough + muted in pages list. Writes to `status` DB column.

- [ ] **GOO-34** Scheduled date/time picker _(High)_
      shadcn Popover with mini calendar + time input. Quick chips: Today, Tomorrow, Monday, Next week. Duration shortcuts: 15min, 30min, 1h, 2h. Writes `scheduledStart`/`scheduledEnd`.

- [ ] **GOO-35** Priority selector _(Medium)_
      Icon-based: None (— muted), Urgent (!! red), High (! orange), Medium (·· yellow), Low (· blue). Linear-inspired. Writes `priority` column (0–4).

- [-] **GOO-11** YAML frontmatter metadata layer — **superseded**
  Originally the metadata storage mechanism. Superseded by SQLite columns (GOO-27/29). Import/export (GOO-48/49) handles markdown↔SQLite conversion. Do not implement.

---

## Phase 2 — Navigation & Organization

_Goal: the app is fully usable day-to-day. Folders, filters, tags, DnD, onboarding, import/export._

### Sidebar

- [ ] **GOO-14** Resizable three-panel layout _(High)_
      Default: Left 180px | Pages 280px | Right flex. Drag handles between panels (rendered inside each panel's motion.div so they animate away on sidebar collapse). Persist widths to localStorage. Right panel toggles Editor ↔ Calendar (`Cmd+Shift+C`) — left and pages panels remain visible in both modes.

- [ ] **GOO-80** Sidebar collapse + navigation keyboard shortcuts _(High)_
      Two states only — all-open or both-left-collapsed (no partial). `Cmd+\` toggles. `SidebarToggle` button in top-left of right panel header (always visible): `PanelLeftClose`/`PanelLeftOpen` lucide icons, tooltip shows shortcut. Both panels animate via framer-motion spring (stiffness 350, damping 35, width+opacity). State persisted to `localStorage`.

      Navigation shortcuts (`allowInInputs: false`):
      - `J` / `K` — next/previous page in current list (highlights but doesn't auto-open)
      - `Enter` — open the highlighted page in editor
      - `Escape` (from editor) — return focus to page list
      - `Cmd+Shift+C` — toggle editor ↔ calendar (right panel)
      - `Cmd+\` — toggle sidebar

      When sidebar is collapsed and `J`/`K`/`Enter` fires, sidebar auto-expands first.

- [ ] **GOO-81** Split view _(Low)_
      Two `EditorPane` instances in the right panel. Hard limit: 2 panes, no further splitting. Orientations: L/R (default) or T/B, toggled post-split. `⊟` on primary pane toggles orientation; `×` on secondary pane closes split. Divider draggable, ratio persisted to localStorage. Active pane (last clicked/focused) receives page-list navigation. Only active when `rightPanel === 'editor'` — split is ignored in calendar mode. State: `UIContext.splitMode: 'none' | 'horizontal' | 'vertical'` + `splitPageId: string | null`. Keyboard: `Cmd+Shift+\` toggle split, `Cmd+Shift+[`/`]` move focus between panes. See `features/editor.md`.

- [ ] **GOO-79** Today smart view + Inbox smart view _(High)_
      Two pinned smart views at the top of the left panel above user folders. Today: pages with any `page_schedules` row where `date(scheduled_start) <= date('now')` and `status != 'done'`; grouped in page list as Overdue (collapsed) + Today sections; badge = total count. Inbox: pages where `folder_id IS NULL`; badge = count (hidden when 0). Both read-only sidebar entries — no delete/rename/reorder. `UIContext.activeViewId: 'today' | 'inbox' | folderId`.

- [ ] **GOO-37** Folder CRUD _(High)_
      v1: flat list of folders — no nesting. Create: right-click → "New Folder" or "+" button, inline rename auto-focused. Rename: double-click. Delete: context menu → confirm (warn if pages inside). Color picker in context menu. Drag to reorder (`@dnd-kit/core` via `reorderFolders`).

- [ ] **GOO-16** Page completion + DnD reordering _(Medium)_
      Completed pages → strikethrough + muted → collapse into "Completed" accordion at bottom (UI toggle button, no keyboard shortcut — `Cmd+Shift+C` is reserved for calendar toggle). Drag handle for manual reordering (`@dnd-kit/core` via `reorderPages`). `completedAt` timestamp on done.

- [ ] **GOO-38** Pages list filters _(Medium)_
      Filter bar in Pages panel header. Status (all/active/done/in-progress), Scheduled (all/scheduled/unscheduled/today/this week), Priority (all/urgent/high/any), Tag (multi-select). Persist per session.

- [ ] **GOO-20** Tags system _(Medium)_
      Tags stored as JSON array in `pages.tags` column (no join table in v1 — derive counts/lists via `json_each()`). Tags panel in sidebar with page counts. Tag rollup view. Filter by tag in pages list. `#tag` syntax in editor body → sync to tags column on save (Phase 2 of this ticket). See `features/tags.md`.

### App Shell

- [ ] **GOO-59** Settings infrastructure + day-1 panels _(High)_
      The settings scaffold must exist before other features can add their own panels. Ship in Phase 2.

  **Container**: `Cmd+,` opens a modal with a left nav (like Linear / VSCode). Not a separate window
  — a full-screen overlay modal is simpler and sufficient. `Esc` closes. Accessible from:
  native menu (Pikos > Preferences), `Cmd+,`, command palette (`Cmd+K` → "Settings").

  **Nav structure at launch:**

  ```
  General
  Appearance
  Editor
  Vaults
  Keyboard Shortcuts
  ─────────────────
  (panels below added by their feature ticket when they ship:)
  Calendars          ← GOO-22
  Performance        ← GOO-55
  Privacy            ← GOO-58, GOO-46
  Assistant          ← GOO-57
  Plugins            ← GOO-56
  ```

  **General panel:**
  - Default folder for new pages: [Inbox (default) | <folder picker>]
    Only applies when there is no active folder context (e.g. `Cmd+N` from calendar view or
    command palette). When a folder is active in the sidebar, new pages always go there.
    When inbox is active, new pages always go to inbox. This setting is the fallback only.
  - On startup: [Open last vault | Show vault picker]
  - Date format: [System default | MM/DD/YYYY | DD/MM/YYYY | YYYY-MM-DD]
  - Time format: [System default | 12-hour | 24-hour]

  **Appearance panel:**
  - Theme: [System | Light | Dark]
    Stored in localStorage (`prefers-color-scheme` media query drives "System"). Applied to `<html>`.
  - (Future: accent color — defer until brand is finalized)

  **Editor panel:**
  - Spell check: [On | Off] — off by default for technical/multilingual users who find it noisy
  - Spell check language: [System | English | ...] — only shown when spell check is on
  - Line width: [Narrow ~60ch | Default ~72ch | Wide ~88ch | Full] — controls `max-width` of
    the editor prose area. Persisted in localStorage. Does not affect the metadata header.

  **Vaults panel:**
  The authoritative place to manage all known vaults (the `Vault[]` array in plugin-store).

  ```
  My Vault         ~/Documents/Pikos/my-vault    [Open]  [···]
  Work Notes       ~/Documents/Pikos/work        [Open]  [···]
  ───────────────────────────────────────────────────────────
  [+ Add Vault]   [+ Create New Vault]
  ```

  `[···]` context menu: Rename, Show in Finder, Remove from list (does NOT delete the SQLite file).
  "Remove from list" is safe — the vault file stays on disk, user can re-add it via "Add Vault".
  Active vault is highlighted. Switching vaults reloads VaultContext with the new adapter.

  **Keyboard Shortcuts panel:**
  Read-only reference list generated from `Keyboard.list()` (GOO-31). Groups: Navigation,
  Editor, Calendar, View. No editing in v1 — just discoverability. Future: editable bindings.

  **Implementation notes:**
  - Settings state lives in `@tauri-apps/plugin-store` (same as vault config) under a `settings`
    key. Shape: `{ theme, spellCheck, spellCheckLang, lineWidth, defaultFolderId, startup, dateFormat, timeFormat }`.
  - A `useSettings()` hook in `apps/desktop/src/shared/hooks/useSettings.ts` reads/writes this.
    Other features read from `useSettings()` — no prop drilling.
  - Each feature adds its panel via a `SettingsRegistry` (simple array of `{ id, label, icon, component }`).
    The settings modal iterates this array to build its nav. Same extension point pattern as the
    plugin system's UI registration.

- [ ] **GOO-24** Native menu bar + window management _(High)_
      macOS menu bar via Tauri menu API. File: New Page, Open/Switch Vault, Export Vault, Close Window. Edit: standard. View: Toggle Sidebar, Toggle Calendar, Focus Mode. `Cmd+W` closes active page (already in Rust).

- [ ] **GOO-42** First-run + onboarding _(Medium)_
      No vault configured: welcome screen (full window). "Create New Vault" → folder picker → land in empty app. "Import from Obsidian" → Obsidian import flow (GOO-41). Empty state: friendly prompt + keyboard shortcut hints. No technical jargon — no mention of SQLite or vault paths in the UI.

### Import / Export

- [ ] **GOO-48** Import: Markdown → SQLite (+ Tiptap JSON conversion) _(Medium)_
      `packages/core/src/import/markdown-import.ts`. Uses `gray-matter`.

  ```ts
  export async function importMarkdownVault(
    dirPath: string,
    adapter: StorageAdapter
  ): Promise<ImportResult>;
  // ImportResult: { imported: number; skipped: number; errors: Array<{file, reason}> }
  ```

  Frontmatter field map: `title`→title, `tags`→tags, `status`→status (maps "done"/"complete"→`done`), `priority`→priority, `scheduled`/`date`→scheduledStart, `created`/`createdAt`→createdAt. Unknown fields: ignored.
  Directory hierarchy → folder records (flat in v1 — nested dirs collapsed to top-level folders). Malformed frontmatter: skip + log, don't crash.

- [ ] **GOO-49** Export: SQLite (Tiptap JSON) → Markdown _(Medium)_
      `packages/core/src/export/markdown-export.ts`.

  ```ts
  export async function exportToMarkdown(
    adapter: StorageAdapter,
    options: ExportOptions
  ): Promise<{ exported: number }>;
  // ExportOptions: { outputDir: string; includeMetadata?: boolean; filenameFrom?: 'title' | 'id' }
  ```

  Output: standard YAML frontmatter + markdown body, Obsidian-compatible. Filename sanitization (special chars, duplicates). Accessible via File → Export Vault in app menu. Progress indicator.

- [ ] **GOO-65** Per-page export _(Low)_
      Export a single page without exporting the entire vault. Accessible from the page's right-click context menu and the `•••` overflow in the metadata header.

  **Formats:**
  - **Markdown** — same YAML frontmatter + body as GOO-49's vault export. Reuse `exportToMarkdown` with a single-page overload.
  - **PDF** — rendered HTML → PDF via Tauri's `tauri-plugin-pdf` or webview print API. Preserve heading styles, task checkboxes, code blocks. No Pikos chrome (sidebar, header) in output.

  **UX:** Native save dialog opens to `~/Desktop` by default. Filename pre-filled as the page title (sanitized). No progress indicator needed — single page is fast.

- [ ] **GOO-41** Obsidian vault import — onboarding UI _(Medium)_
      UX wrapper around GOO-48. Flow: folder picker → scan preview ("Found 47 pages in 6 folders") → confirm → background import with progress → success summary ("47 imported, 2 skipped") → land in app with content. Wire into first-run experience (GOO-42). `.obsidian/` config dir ignored.

- [ ] **GOO-74** Extended export formats _(Low)_
      Expand beyond markdown to give users full data ownership and interop. Accessible from File → Export, with a format picker.

  **Formats to add:**
  - **JSON backup** — full-fidelity vault snapshot: all pages (id, title, body, metadata, tags), folders, and time blocks. This is the canonical backup format. Use for restore (import path TBD). Schema version field required for future migrations.
  - **CSV** — flat task list export: title, status, priority, due date, tags, folder. For spreadsheets, Airtable, migration targets. Per-folder or full vault.
  - **HTML** — rendered pages as standalone `.html` files. Clean output, no app chrome. Useful for archiving or pasting into external tools.
  - **ICS/iCal** — export all scheduled pages and time blocks as calendar events. Import into Apple Calendar, Google Calendar, Fantastical. Events include page title, dates, and a link back to the page (deep-link via custom URL scheme).

  **UX:** Same export dialog as GOO-49 with a "Format" dropdown added. JSON and ICS are vault-level exports; CSV and HTML can be per-folder or full vault. Per-page HTML and PDF already handled by GOO-65.

  **Dependencies:** GOO-49 (vault export base), GOO-65 (per-page export, reuse HTML renderer)

- [ ] **GOO-75** Third-party app import _(Low)_
      "Switch to Pikos in 30 seconds." Import data from major todo/notes apps. Accessible from File → Import or first-run onboarding (GOO-42). Each importer maps the source format to Pikos pages + folders.

  **Sources to support:**
  - **Todoist** — JSON backup (Settings → Backups). Rich: projects → folders, tasks → pages, due dates, priorities, labels → tags, subtasks → child pages, comments → page body footnotes.
  - **TickTick** — CSV export (Settings → Backup). Flat: list → folder, task title/notes/dates/priority/tags → page metadata.
  - **Things 3** — TaskPaper (`.taskpaper`) via File → Export. Projects → folders, tasks → pages, tags, notes, scheduled dates.
  - **Evernote** — ENEX (`.enex`) XML export. Notebooks → folders, notes → pages (body converted from ENML to markdown via unified/rehype). Large user base actively looking to migrate.
  - **OPML** — generic outliner format (WorkFlowy, Dynalist, OmniOutliner). Outline nodes → page hierarchy.
  - **Markdown folder** — already covered by GOO-41/GOO-48 (Obsidian interop).

  **UX:** Import wizard — "What app are you coming from?" picker → file/folder picker → preview ("Found 124 tasks in 8 projects") → confirm → background import with progress → success summary. Duplicate detection by title+date to prevent re-importing.

  **Implementation note:** Each importer is a pure function `(rawInput: string | object) => ImportResult` in `packages/core/src/importers/`. No Tauri deps — fully testable in Vitest. File reading handled by the Tauri command layer above.

  **Dependencies:** GOO-49 (storage layer), GOO-42 (first-run onboarding hook)

---

## Phase 3 — Search & Performance

- [ ] **GOO-17** Command palette (upgrade from PageSwitcher) _(High)_
      `Cmd+P` → fuzzy page title search. `Cmd+P` twice (chord) → content search mode. `Cmd+K` → actions (new page, switch vault, settings). NL input pre-fills metadata. Recent pages section. See `features/search.md`.
      Title search: client-side fuzzy via `fuse.js` against `pages[]` in VaultContext (immediate, no DB round-trip). Content search: FTS5 via `search_pages` Tauri command (debounced). Two separate code paths, cleanly split.

- [ ] **GOO-62** Undo/redo _(High)_

  App-level command history for metadata mutations and CRUD — separate from Tiptap's own undo.

  **Scope split:**
  - **Tiptap handles editor-internal undo**: `Cmd+Z` inside the editor body undoes typing, formatting, etc. Tiptap's `History` extension owns this. No changes needed.
  - **App-level undo** handles everything outside the editor body: metadata changes (status, priority, dates, tags), folder changes, and page CRUD (create/delete/rename). Activated when focus is outside the editor, or on `Mod+Z` from a non-editor surface.

  **Pattern** — `CommandHistory` in `packages/core/src/history/CommandHistory.ts`:

  ```ts
  export interface Command {
    execute(): Promise<void>; // already done — only used to re-do
    undo(): Promise<void>; // revert the mutation
    label: string; // human-readable, shown in undo toast: "Undo: Deleted 'Design review'"
  }

  export class CommandHistory {
    static shared: CommandHistory; // singleton, lives in VaultContext
    push(cmd: Command): void; // call AFTER a mutation completes; clears redo stack
    undo(): Promise<void>; // Cmd+Z
    redo(): Promise<void>; // Cmd+Shift+Z
    canUndo: boolean;
    canRedo: boolean;
    readonly undoLabel: string | null; // e.g. "Undo: Deleted 'Design review'"
    readonly redoLabel: string | null;
  }
  ```

  **Mutations that push a Command:**
  | Action | Undo |
  |---|---|
  | Create page | `deletePage(id)` |
  | Delete page | `createPage(snapshot)` — snapshot captured before delete |
  | Rename page | `updatePage(id, { title: oldTitle })` |
  | Move page to folder | `updatePage(id, { folderId: oldFolderId })` |
  | Change status | `updatePage(id, { status: oldStatus })` |
  | Change priority | `updatePage(id, { priority: oldPriority })` |
  | Change scheduled date | `updatePage(id, { scheduledStart: old, scheduledEnd: old })` |
  | Create folder | `deleteFolder(id)` |
  | Delete folder | `createFolder(snapshot)` |
  | Rename folder | `updateFolder(id, { name: oldName })` |

  **Bulk undo** (Quick Add Modal creates N pages): wrap N creates in a single `Command` → undo deletes all N in one step.

  **UI feedback:**
  - `Cmd+Z` / `Cmd+Shift+Z` from non-editor surface trigger undo/redo.
  - Toast notification (bottom-right, 2s): _"Deleted 'Design review' · Undo"_ — tapping "Undo" in the toast also triggers undo.
  - No persistent undo history UI — just the keyboard shortcuts and toast.

  **History limit:** 50 entries (ring buffer). Older entries are dropped silently.

  **Dependencies:** GOO-29 (SQLite — undo needs the adapter), GOO-28 (StorageAdapter — all undo ops go through it).

- [ ] **GOO-18** FTS5 content search _(High)_
      FTS5 virtual table on `pages.content` + `pages.title` + `pages.tags`. Tauri command `search_pages(query)`. Updates on save (not file watch — supersedes original file-watcher approach). Highlighted excerpt snippets in results.

- [ ] **GOO-55** Local performance monitor _(Medium)_

  **Purpose — two distinct goals:**
  1. **Development confidence**: catch performance regressions early, stress-test with large vaults (thousands of pages, long content), verify indexes are working.
  2. **User trust**: let users see the app is fast regardless of how much data they have. Opt-in only, entirely local — zero data leaves the device.

  **What gets measured** — instrument these call sites with `performance.mark()` / `performance.measure()`:

  | Metric              | Start mark               | End mark                 | Budget (target / acceptable) |
  | ------------------- | ------------------------ | ------------------------ | ---------------------------- |
  | `page.open`         | user clicks page in list | editor content rendered  | <50ms / <150ms               |
  | `page.save`         | debounce flush fires     | DB write acknowledged    | <100ms / <300ms              |
  | `search.fts`        | FTS Tauri command issued | results rendered         | <50ms / <200ms               |
  | `search.fuzzy`      | title search keypress    | results rendered         | <16ms / <50ms                |
  | `vault.load`        | VaultProvider mount      | pages + folders in state | <300ms / <1000ms             |
  | `pages.list.render` | folder selected          | list fully painted       | <32ms / <100ms               |
  | `folder.switch`     | folder clicked           | page list updated        | <16ms / <50ms                |

  Budget colors: green = at target, yellow = acceptable, red = over budget.

  **Storage — two layers:**
  - **In-memory ring buffer** (last 200 samples per metric) — no DB, no overhead unless monitor is active. Powers the realtime overlay.
  - **SQLite aggregate log** (optional, written daily when monitor is enabled) — p50, p95, sample count, vault page count, date. Powers the settings trend view.

  ```sql
  -- New table in a migration (not 001_initial.sql — add separately)
  CREATE TABLE IF NOT EXISTS perf_log (
    id          TEXT PRIMARY KEY,
    metric      TEXT NOT NULL,       -- e.g. 'page.open'
    date        TEXT NOT NULL,       -- ISO 8601 date (YYYY-MM-DD)
    p50_ms      REAL NOT NULL,
    p95_ms      REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    vault_page_count INTEGER,        -- snapshot of pages table count at time of write
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_perf_log_metric_date ON perf_log(metric, date);
  ```

  **`PerfMonitor` — `packages/core/src/perf/PerfMonitor.ts`**
  Pure TS, no DOM/Tauri deps (uses `performance` global — available in both browser and Tauri WebView).

  ```ts
  export class PerfMonitor {
    static shared: PerfMonitor; // singleton
    enabled: boolean; // false by default; toggled via settings
    mark(name: string): void; // performance.mark(`pikos:${name}:start`)
    measure(name: string): number | null; // performance.measure → returns duration ms, pushes to ring buffer
    getSamples(metric: string): Sample[]; // last N samples
    getStats(metric: string): { p50: number; p95: number; last: number; count: number } | null;
    flush(): DailyAggregate[]; // called once/day, returns rows to write to perf_log
  }
  ```

  **Overlay UI — `apps/desktop/src/features/perf/PerfOverlay.tsx`**
  - Small semi-transparent panel, bottom-right corner (outside content area)
  - Toggle: `Cmd+Shift+.` (or Settings toggle — both work)
  - Shows one row per metric: `metric name | last Xms | p50 Xms | p95 Xms` color-coded by budget
  - Only renders when `PerfMonitor.shared.enabled === true` — zero overhead otherwise
  - Does NOT show in production builds by default; enabled via Settings > Performance

  **Settings page — `Settings > Performance`**
  - Toggle: "Show performance overlay" (off by default)
  - Toggle: "Log daily performance history" (off by default; enables `perf_log` writes)
  - When history is enabled: sparkline chart per metric showing p95 trend over last 30 days
    — the user can see "my vault has 2,000 pages and page open is still 40ms"
  - "Clear history" button

  **Stress test mode — dev only (hidden behind `VITE_DEV_TOOLS=true` env var)**
  Accessible via `Cmd+Shift+T` or Settings > Performance > Stress Test.
  Generates N pages with configurable content size (titles, tags, long body text) into a temp folder, runs the full open/save/search/list cycle against them, reports all metrics. Cleans up after itself.
  Good for validating indexes hold up at 500, 1000, 5000 pages before shipping.

  **Implementation notes:**
  - `PerfMonitor.shared.enabled` gates all `mark()`/`measure()` calls — when disabled, they're no-ops (single boolean check, negligible overhead).
  - Wire `mark`/`measure` calls into `VaultContext`, `TauriSQLiteAdapter`, and the editor save path — not into individual components.
  - The daily aggregate flush can be triggered from `VaultContext` on a `setInterval` or on vault close. Don't write per-sample — aggregates only.
  - Do not implement until GOO-29 (SQLite) and GOO-30 (VaultContext) are done — needs both to instrument the right call sites.

---

## Phase 4 — Calendar

- [ ] **GOO-21** Custom day/weekly calendar view _(High)_
      **v1: day view only.** No off-the-shelf calendar library — custom renderer with `date-fns`.
      Component tree:

  ```
  CalendarView
  ├── CalendarHeader (prev/next/today, [ / ] shortcuts)
  ├── TimeGutter (hour labels: 6am–11pm)
  ├── DayColumn
  │   ├── HourCells (drop targets, 15min increments)
  │   ├── PageBlocks (absolute position by time %)
  │   └── NowIndicator (current time red line, auto-scrolls on mount)
  ```

  Block click → `setActivePage()`. Resize bottom edge → update `scheduledEnd`. Toggle calendar/editor: `Cmd+Shift+C`. Jump to today: `t` (when not focused in input).

- [ ] **GOO-39** Drag page → calendar to schedule _(High)_
      `@dnd-kit/core`. Drag handle on `PageListItem` hover. Drop → `updatePage({ scheduledStart, scheduledEnd })`. 15min snap.

- [ ] **GOO-22** CalDAV external calendar sync (read-only) _(Medium)_
      Pull external calendar events into the day view as read-only blocks. Protocol: **CalDAV** — works with Fastmail, Google, Apple, Proton, etc.
      _Write-back (pushing Pikos pages to CalDAV as events) is a separate item — see GOO-66._

  **Deduplication rule:** connect directly to the calendar source (Fastmail: `https://caldav.fastmail.com/dav/`). Never subscribe via a re-exporting intermediary like TickTick — re-exporters can change UIDs and cause duplicates. One CalDAV account per source.

  **What users can do with external events:**
  - View them as distinct blocks in the day view (separate visual style — muted, no drag handle)
  - **Dismiss**: local-only flag, hides the event from the calendar view. Never writes back to the CalDAV server. Recoverable via Settings > Calendars > "Show dismissed".
  - **"Convert to page"**: creates a Pikos page pre-filled with the event title, time, and description. It might be worth considering that we remove the original event when converting to a page. Tbd.
  - Nothing else — no editing, no rescheduling, no deletion of the external event.

  **SQLite schema** (new tables in a migration):

  ```sql
  CREATE TABLE external_calendar_accounts (
    id           TEXT PRIMARY KEY,  -- UUID
    display_name TEXT NOT NULL,
    caldav_url   TEXT NOT NULL,     -- base URL, e.g. https://caldav.fastmail.com/dav/
    username     TEXT NOT NULL,
    -- password stored in OS keychain (keyring crate), NOT in SQLite
    color        TEXT,              -- hex, for block rendering
    last_synced_at TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE external_events (
    id          TEXT PRIMARY KEY,   -- UUID
    account_id  TEXT NOT NULL REFERENCES external_calendar_accounts(id) ON DELETE CASCADE,
    uid         TEXT NOT NULL,      -- iCal UID field — authoritative dedup key
    title       TEXT NOT NULL,
    start_at    TEXT NOT NULL,      -- ISO 8601
    end_at      TEXT,               -- ISO 8601
    is_all_day  INTEGER DEFAULT 0,
    description TEXT,
    location    TEXT,
    dismissed   INTEGER DEFAULT 0,  -- local only, never synced back
    dismissed_at TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(account_id, uid)         -- one entry per event per account
  );
  ```

  **Rust implementation:**
  - `reqwest` for CalDAV HTTP requests (PROPFIND to discover calendars, REPORT to fetch events)
  - `ical` crate to parse iCalendar format
  - `keyring` crate for OS keychain credential storage (macOS Keychain / Windows Credential Manager)
  - New Tauri commands: `add_caldav_account`, `remove_caldav_account`, `sync_caldav`, `dismiss_external_event`, `list_external_events(date_range)`
  - Recommend app-specific passwords (Fastmail supports these) over main account passwords

  **Sync timing:**
  - On app launch: background sync all accounts
  - On app focus (if last sync > 5 min ago): re-sync
  - Manual: refresh button in CalendarHeader
  - Minimum 5-minute interval to avoid hammering CalDAV servers

  **Frontend:**
  - `ExternalEventBlock` component — visually distinct from `PageBlock` (muted color from account color, no drag handle, lock icon)
  - Right-click context menu: "Dismiss", "Convert to page"
  - Settings > Calendars: add/remove accounts, toggle "Show dismissed events"

- [ ] **GOO-64** Timezone-aware scheduling + DST handling _(Medium)_
      All `scheduled_start` / `scheduled_end` / `completed_at` values are stored as UTC ISO 8601 in SQLite. Display is converted to the user's local timezone on read. The UI always shows local time; the DB always stores UTC. This is the correct pattern — do not store local times.

  **DST:** `date-fns-tz` (already pair well with `date-fns`) handles DST transitions correctly when converting. Edge cases to test: events that straddle a DST boundary (2am → 3am spring forward), all-day events (date-only, no timezone), recurring events where the wall-clock time drifts by an hour after DST.

  **Settings > General:** "Time zone" picker — defaults to system timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). User can override (useful for traveling, or managing tasks in a different timezone). Stored in Settings table. Affects all time display throughout the app.

  **CalDAV sync (GOO-22):** External events already arrive with timezone info in the iCal VTIMEZONE block — parse and store as UTC, same pattern.

  **Implementation notes:**
  - Replace any bare `new Date()` calls with timezone-aware equivalents from the start — retrofit is painful
  - `formatInTimeZone(date, userTz, 'h:mm a')` for display, `zonedTimeToUtc(localDate, userTz)` for storage
  - Add a `timezone` column to the `settings` table (nullable, defaults to NULL = use system)

---

## Phase 5 — Power Features

_These are depth features for power users. Not needed for core value. Build after the app is stable and dogfooded._

- [ ] **GOO-58** Network activity monitor _(Medium)_

  **Why**: Every feature that touches the network (CalDAV sync, AI cloud model, plugins with
  `network: true`, auto-updater) should be visible to the user. This makes the privacy promise
  concrete — not just "we don't send your data" but "here's a log of every request the app made."
  It also helps debug network issues and builds trust with privacy-conscious users.

  **What gets logged** — one entry per outbound request, recorded in Rust before the request fires:

  | Field            | Example                                            | Notes                                                                       |
  | ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
  | `timestamp`      | `2026-03-01T14:32:01Z`                             | ISO 8601                                                                    |
  | `source`         | `caldav`, `ai-agent`, `plugin:pomodoro`, `updater` | Which feature triggered it                                                  |
  | `direction`      | `outbound` / `inbound`                             | Always outbound for requests; inbound for responses                         |
  | `host`           | `caldav.fastmail.com`                              | Host only — never full URL (could contain tokens/paths with sensitive info) |
  | `bytes_sent`     | `1240`                                             | Request body size                                                           |
  | `bytes_received` | `8430`                                             | Response body size                                                          |
  | `status`         | `200`, `timeout`, `error`                          | HTTP status or failure reason                                               |
  | `duration_ms`    | `340`                                              | Round-trip time                                                             |

  **What is never logged**: full URLs, query parameters, request/response bodies, credentials,
  API keys. Host-level visibility only.

  **Storage**: In-memory ring buffer (last 500 entries) — same pattern as GOO-55. No persistent
  log by default; optional "Keep network history" toggle writes daily summaries to SQLite.

  ```sql
  -- Optional persistent log (separate migration, only written when setting is on)
  CREATE TABLE IF NOT EXISTS network_log (
    id           TEXT PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    source       TEXT NOT NULL,  -- 'caldav' | 'ai-agent' | 'plugin:<id>' | 'updater'
    host         TEXT NOT NULL,
    bytes_sent   INTEGER,
    bytes_received INTEGER,
    status       TEXT,           -- HTTP status code or 'error' / 'timeout'
    duration_ms  INTEGER,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_network_log_ts ON network_log(timestamp);
  ```

  **Implementation — Rust layer**
  All outbound HTTP in the app uses `reqwest`. Wrap it in a `NetworkLogger` that intercepts
  every request/response pair before dispatching:

  ```rust
  // src-tauri/src/network/logger.rs
  pub struct NetworkLogger { /* Arc<Mutex<VecDeque<NetworkEntry>>> */ }

  impl NetworkLogger {
    pub async fn request(&self, source: &str, url: &Url) -> RequestHandle { ... }
    // RequestHandle.finish(status, bytes_sent, bytes_received) → logs the completed entry
    pub fn recent(&self) -> Vec<NetworkEntry> { ... }
  }
  ```

  Wire `NetworkLogger` as Tauri state (`.manage()`). Each feature (CalDAV, AI, updater) passes
  the logger when making requests. Plugin network calls go through `PluginContext.fetch()` which
  wraps `reqwest` + logger — plugins never call `reqwest` directly.

  **New Tauri command:**

  ```rust
  #[tauri::command]
  async fn get_network_log(logger: State<'_, NetworkLogger>) -> Result<Vec<NetworkEntry>, String>
  ```

  **UI — two surfaces:**
  1. **Status bar indicator** (always visible when network activity occurs)
     A small dot in the window's bottom status bar that pulses briefly on any outbound request.
     Color: neutral (not alarming — network activity is expected for CalDAV/AI). Clicking it
     opens the full log panel.

  2. **Settings > Privacy > Network Activity**
     Full log view. One row per entry, grouped by source. Filters: by source, by date.
     Shows the ring buffer (last 500) plus optional persistent history.

     ```
     Settings > Privacy > Network Activity

     ● caldav.fastmail.com     CalDAV sync    200  340ms  8.4KB  just now
     ● api.anthropic.com       AI assistant   200  1.2s   2.1KB  2 min ago
     ● github.com              Auto-updater   304  89ms   —      1 hr ago

     [ ] Keep network history (writes daily summaries to vault)
     [ ] Show indicator in status bar
     ```

  **Dependency order**: Build alongside or just after the first feature that uses the network
  (GOO-22 CalDAV). The `NetworkLogger` Rust struct should be wired in during GOO-22 so CalDAV
  requests are logged from day one. The UI surface can follow in the same phase.

- [ ] **GOO-61** Quick Add smart recommendations _(Medium)_

  History-based autocomplete for the Quick Add Modal (GOO-60) — like fish shell's inline
  suggestions or browser autocomplete, but aware of your NL patterns.

  **v1 — history-based (build this first):**

  Every successful Quick Add submission is saved to a local history table:

  ```sql
  CREATE TABLE IF NOT EXISTS quick_add_history (
    id          TEXT PRIMARY KEY,
    raw_input   TEXT NOT NULL,      -- exactly what the user typed
    page_count  INTEGER NOT NULL,   -- how many pages were created (1 for normal, N for recurrence)
    use_count   INTEGER DEFAULT 1,  -- incremented each time same input is reused
    last_used_at TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_qa_history_last_used ON quick_add_history(last_used_at DESC);
  ```

  Deduplication: on submit, check if an identical `raw_input` already exists — if so, increment
  `use_count` and update `last_used_at` rather than inserting a new row.

  **Ranking score** (computed in TS, no SQL needed — history table is small):

  ```ts
  score = use_count / Math.log2(hoursSinceLastUse + 2);
  // Recent + frequent = highest. Old + rare = lowest.
  ```

  **UI — inline ghost text** (fish shell / GitHub Copilot style):
  - As the user types, the highest-scoring prefix match appears as ghost text to the right
    of the cursor, greyed out
  - `Tab` or `→` to accept the full suggestion
  - Continue typing to ignore it
  - No dropdown — keeps the modal clean and focused

  ```
  ┌──────────────────────────────────────────────────────────────┐
  │  run [m/w/f at 3pm for 45m #fitness]                        │
  │      └── ghost text, greyed out                             │
  └──────────────────────────────────────────────────────────────┘
  ```

  Ghost text only shown when:
  1. The prefix matches at least one history entry
  2. The input has ≥ 2 characters (avoid triggering on a single keystroke)
  3. The ghost text would add something beyond what's already typed

  **v2 — pattern-aware (future, don't build yet):**
  Beyond raw history matching, detect contextual patterns:
  - Day-of-week patterns: you always create "standup at 10am" on weekdays → suggest it
    proactively when the modal opens on a weekday morning
  - Tag/folder co-occurrence: you often combine `#work ~Projects` → after typing either,
    suggest the other
  - Time-of-day patterns: "morning run at 7am" gets suggested more often before 9am

  v2 is a data mining problem on `quick_add_history` + current datetime. Defer until enough
  history exists to be meaningful (real users, multiple weeks of data).

  **Privacy**: entirely local — history lives in the vault's SQLite file, never leaves device.
  "Clear quick add history" button in Settings > General.

  **Dependencies**: GOO-60 (Quick Add Modal), GOO-19 (NL parser), GOO-29 (SQLite).

- [ ] **GOO-66** Write Pikos pages to external CalDAV calendar _(Medium)_
      The complement of GOO-22. When a page has a `scheduled_start`, push it to the user's CalDAV calendar as a VEVENT. This closes the loop: you can see Pikos tasks in Apple Calendar / Google Calendar / Fantastical alongside your other events.

  **Scope:**
  - User designates one CalDAV calendar as the "Pikos write calendar" per account (Settings > Calendars)
  - Pages with `scheduled_start` are synced as VEVENTs. Title → SUMMARY, body plain text → DESCRIPTION, tags → CATEGORIES
  - Creating a page → PUT new event. Updating title/time → PUT updated event. Completing a page → update STATUS:COMPLETED or optionally delete the event (user preference). Deleting a page → DELETE the event
  - iCal UID = Pikos page UUID — same dedup key, stable across updates
  - **No two-way conflict resolution in v1** — Pikos is always the source of truth for events it created. External edits to Pikos-created events in the external calendar are overwritten on next sync

  **What does NOT sync:** inbox pages (no scheduled time), recurring templates (complex — defer), pages the user explicitly marks "don't sync" (per-page toggle in metadata)

  **Dependencies:** GOO-22 (CalDAV infrastructure, `reqwest`, `ical` crate, keychain), GOO-34 (scheduled date picker)

- [ ] **GOO-67** i18n / localization foundation _(Low)_
      Pikos should work in languages beyond English. Not needed for early adopters (mostly English-speaking techies), but build the foundation before strings proliferate across the codebase — retrofitting i18n is painful.

  **Approach:** `react-i18next` + `i18next`. All user-visible strings behind `t('key')`. Source locale: `en`. Locale files: `packages/core/src/locales/{en,es,fr,de,ja,...}.json`. Language picker in Settings > General (auto-detected from `navigator.language` as default).

  **NL parser (GOO-19):** The NL date/time parser is English-only and would need locale-specific grammars. This is significant scope — track as a sub-task. For v1 i18n, the UI strings are translated but NL input stays English-only; add a Settings note that says "Natural language input is English-only for now."

  **What NOT to do:** Don't add i18n infra as part of a feature ticket mid-build. Establish it early (Phase 5 is fine), then all new strings go through it from that point on.

- [ ] **GOO-12** Page parent/child relationships _(Medium)_
      `parentId` stored as DB column. Max 3 levels of nesting. Children shown as indented list below parent in pages panel. `parentId` field in `Page` type (GOO-27 already includes it).

- [ ] **GOO-13** `[[wikilink]]` syntax + backlinks _(Medium)_
      Typing `[[` → autocomplete popup with matching page titles. Click wikilink → navigate to page. Backlinks panel shows inbound links to current page. Extracted links stored in `page.links[]` JSON column.

---

## Phase 6 — Shipping & Growth

_See `.agent/GTM.md` for full strategy. These are the concrete tasks it generates._

- [ ] **GOO-51** App branding _(Medium)_
      Icon, wordmark, color palette. Needed before any public presence. The icon appears in macOS Dock, Finder, GitHub, and the marketing site — worth getting right before Phase 2 (friends beta).
      Tauri uses `apps/desktop/src-tauri/icons/` — multiple sizes required (32×32 to 512×512 + `.icns` for macOS).

- [ ] **GOO-52** Cross-platform builds + signing + GitHub Releases pipeline _(High — shipping blocker)_
      **Required before sharing with anyone.** Set up a release CI workflow (`release.yml`) triggered on `git tag v*`. Matrix across macOS, Windows, Linux.

  **macOS — notarization required (moderate complexity, one-time setup)**
  - Apple Developer Program enrollment ($99/yr) — credit card + ~24hr approval wait
  - In Xcode/Apple portal: create Developer ID Application certificate + export as `.p12`
  - Add secrets to GitHub repo: `APPLE_CERTIFICATE` (base64 p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`
  - `tauri-apps/tauri-action` GitHub Action handles the rest: builds `.dmg`, signs, submits to Apple notarization service, staples ticket, uploads to GitHub Releases
  - First-time cert setup: ~2-3 hours. After that: fully automated on every release tag
  - **Why it matters**: unsigned apps trigger Gatekeeper ("app is damaged") — friends can't install without running a terminal command to bypass it

  **Windows — signing optional for Phase 2**
  - Without signing: Windows Defender SmartScreen shows "Unknown publisher" warning. Technically runnable — click "More info → Run anyway"
  - With signing: OV code signing cert from a CA (DigiCert, Sectigo) — ~$300–500/yr. Eliminates SmartScreen warning
  - Decision: skip for Phase 2 (friends who are technical enough), add cert before wide public distribution
  - Tauri builds `.msi` + `.exe` installer automatically via `tauri-apps/tauri-action` on Windows runner

  **Linux — no signing required**
  - Tauri builds `.AppImage` (portable, runs anywhere) + `.deb` (Debian/Ubuntu)
  - No cert, no review process — just add `ubuntu-latest` to the CI matrix

  **Release workflow sketch**:

  ```yaml
  # .github/workflows/release.yml
  on:
    push:
      tags: ["v*"]
  jobs:
    release:
      strategy:
        matrix:
          os: [macos-latest, windows-latest, ubuntu-latest]
      runs-on: ${{ matrix.os }}
      steps:
        - uses: tauri-apps/tauri-action@v0
          with:
            tagName: ${{ github.ref_name }}
            releaseName: "Pikos ${{ github.ref_name }}"
            # macOS secrets wired in env
  ```

  - GitHub Release artifact layout Tauri expects for the auto-updater (GOO-50) JSON endpoint — generated automatically by `tauri-action`
  - Test full install flow on a clean machine (or VM) for each platform before shipping

- [ ] **GOO-50** Auto-updater _(Medium — shipping blocker)_
      `tauri-plugin-updater` (Rust) + JS update check on startup. Flow: check for update on launch → if available, show non-blocking banner ("Version X.X available — restart to update") → user confirms → download + install + relaunch. Update server: GitHub Releases (JSON endpoint Tauri expects). Do not implement until first external release, but wire in before shipping to avoid forcing manual downloads forever.

- [ ] **GOO-53** Marketing site _(Medium — Phase 3 blocker)_
      Astro in `apps/marketing/` (monorepo). Deploys to Vercel or Cloudflare Pages.

  **Two pages, one codebase:**
  - `/` — General audience. Headline: _"Your notes, tasks, and calendar. Private by default."_ Visual, task-focused, approachable. App screenshot. Download button above the fold. No technical jargon (no SQLite, no Tauri, no file paths). Privacy story in plain language: "Nothing leaves your device."
  - `/open` — Technical audience. Architecture, local-first philosophy, SQLite data ownership. "Why I built this" story. Links to GitHub. Mentions Homebrew. Speaks to the Obsidian+TickTick pain point with technical specifics.

  **Analytics**: [Plausible](https://plausible.io) — self-hosted (Docker, ~1 hr setup) or cloud ($9/mo). Aligns with privacy positioning: no cookies, no personal data, GDPR-compliant. Add `<script defer data-domain="..." src="https://plausible.io/js/script.js"></script>` to Astro layout. Track: page views, download button clicks, referrer. Nothing else needed.

  Monorepo structure update:

  ```
  apps/
  ├── desktop/     (Tauri + React)
  ├── marketing/   (Astro)
  └── mobile/      (placeholder)
  ```

  Keep both pages fast and minimal — the app is the product, not the site.

- [ ] **GOO-68** Page sharing — read-only public links _(Medium)_
      Share a single page as a read-only URL. The shared version renders as a clean web page (no app chrome). Requires server infrastructure — a relay or hosted service to serve the HTML. Pikos is local-first so sharing is inherently an explicit opt-in that pushes data to a server.

  **Scope v1:**
  - "Share page" action in the `•••` overflow / right-click menu
  - On first share: upload the rendered page HTML + metadata to a Pikos sharing service (simple CDN-backed endpoint)
  - Generates a short URL (e.g. `share.pikos.app/p/abc123`)
  - "Unshare" revokes the link and deletes the server copy
  - Shared page is static at time of sharing — it does NOT auto-update when the page changes (show a "last updated" timestamp). Auto-sync is v2
  - Shared pages are stripped of private metadata (status, priority, folder name) — only title + body shown unless user opts in to show metadata

  **Privacy:** Sharing is always explicit and per-page. No page leaves the device unless the user actively chooses to share it. The share button has a lock icon when unshared, chain-link when shared.

  **Server:** A lightweight Cloudflare Worker + R2 is sufficient. Upload encrypted (page content encrypted with a key that's part of the URL fragment `#key` — server never sees plaintext). This is a stretch goal for v1 — v1 can be plaintext on the server if the complexity is too high early on.

  **Dependencies:** GOO-52 (shipping blocker), GOO-65 (per-page export), server infra (new — not yet tracked)

- [ ] **GOO-54** Privacy policy _(Low — Phase 3 blocker)_
      Plain language, one page. No legal boilerplate walls. Cover:
  - What data stays on device (everything — notes, tasks, calendar)
  - What leaves device only with explicit opt-in (crash reports, usage analytics — GOO-46)
  - What Pikos never collects (note content, always)
  - How to export your data (File → Export Vault)
    Lives at `/privacy` on the marketing site (Astro page).

---

---

## Design decisions captured (not yet ticketed)

- [ ] **GOO-76** Multiple schedule occurrences per page (`page_schedules` table) _(Medium)_

  Add `page_schedules(id, page_id, scheduled_start, scheduled_end, created_at)` table. One page can
  appear as multiple calendar blocks (e.g. "work on this task Tuesday AND Thursday"). Drag-to-schedule
  inserts a new row; never overwrites. Deleting a block deletes the row, not the page.

  `pages.scheduled_start/end` become denorms = earliest future `page_schedules` row. Calendar queries
  `page_schedules JOIN pages` for block rendering. `pages.rrule` remains separate — for infinite
  recurring templates that expand virtually via rrule.js (weekly standup etc.).

  **Schema change:** Add table to `001_initial.sql`, add index `idx_page_schedules_start`.
  **Tauri commands:** `create_page_schedule`, `delete_page_schedule`, `list_page_schedules(page_id)`,
  `list_page_schedules_range(start, end)` for calendar day/week rendering.
  **Dependencies:** GOO-29 (SQLite), GOO-21 (calendar — drag-to-schedule inserts here instead of updating pages)

- [ ] **GOO-77** Subtitle field on pages _(Low)_

  Add `subtitle TEXT` column to `pages`. One-sentence summary shown in `PageListItem` (line 2, muted,
  truncated) and `PageBlock` in calendar (below title). Single-line input in metadata header — newlines
  blocked. Optional: most pages won't have one. Include in FTS (shift content_text to column index 2).
  AI summarization is V2 (via AI assistant plugin writing to this field).

  **Schema change:** `subtitle TEXT` in `pages`, updated FTS triggers.
  **Dependencies:** GOO-29 (SQLite), GOO-32 (metadata header)

- [ ] **GOO-78** Focus Timer built-in plugin _(Medium)_

  Sidebar panel: large timer display, Start/Stop button, optional "Attach to page" (defaults to active
  page). Session log below: date, duration, page title link, trash icon to delete. Daily total at top.

  Auto-discard: sessions < 10s auto-removed on stop. Sessions 10s–60s show inline "Remove?" prompt.
  Sessions > 60s go directly to log.

  **Data:** `focus_sessions(id, page_id?, started_at, ended_at, duration_s)` core table (not plugin
  settings — needs indexing and reporting). Plugin reads/writes via `PluginContext.vault` methods or
  direct Tauri commands for sessions.
  **Dependencies:** GOO-29 (SQLite), GOO-56 (plugin system), though can ship as a non-plugin panel first

---

## Deferred — do not start

- [-] **GOO-25** Cross-platform sync _(Low)_ — not until shipped to real users. Options: ElectricSQL, PowerSync, cr-sqlite.
  When implementing: re-evaluate **TanStack Query** as the async state layer. Local SQLite doesn't need its cache invalidation overhead, but sync introduces external writes, real latency, and optimistic-update-with-rollback patterns — exactly where TanStack Query earns its cost.
- [-] **GOO-46** Telemetry: PostHog + Sentry _(Low)_ — not until real users.

  **Two separate opt-ins, both disabled by default.** Framed as "Help improve Pikos" in Settings.

  **Sentry (crash reporting)**
  - Add first — more useful immediately, less controversial with users
  - Captures: Rust panics (`sentry-rust` crate) + JS unhandled errors (Sentry JS SDK)
  - Strip all file paths and content before sending — configure `before_send` hook
  - What gets sent: exception type, stack trace (scrubbed), app version, OS

  **PostHog (product analytics)**
  - Add after Sentry, once there are enough external users to generate signal
  - **Self-hosted option**: deploy PostHog on home server — full data control, no third-party, no cost at low volume. Reasonable choice given the privacy-focused positioning.
  - **Cloud option**: PostHog free tier (1M events/month) — less setup, same privacy controls if configured correctly
  - Recommendation: self-hosted if the server is reliable; cloud if maintenance overhead is a concern. Decision can be deferred until this ticket is active.
  - What gets sent: feature events (`page_created`, `editor_opened`, `calendar_view_toggled`), app version, OS, country-level geo only
  - What never gets sent: note content, titles, tags, file paths, vault name/location

  **Settings UI**
  Two separate toggles under Settings > Privacy:
  - [ ] Send crash reports (Sentry)
  - [ ] Send anonymous usage data (PostHog)
        Both off by default. Each links to a "What's collected?" disclosure.

- [-] **GOO-47** Mobile: React Native placeholder _(Medium)_ — after desktop is solid.
  **IMPORTANT — start here before any mobile migration:** Create 3 divergent mobile UI variants first. Each should have different menus, different interaction modes, and different scroll behavior. Present them for review, let the user pick and choose features, then build the chosen combination into the main app. Do not do a full migration without this design exploration step first.
- [-] **GOO-71** Mobile: Home Screen widget _(Medium)_ — after GOO-47 (mobile app exists). Show today's agenda / overdue tasks on the iOS/Android Home Screen. iOS uses WidgetKit (Swift), Android uses Glance (Kotlin). Needs a native bridge from React Native to the widget data layer.
- [-] **GOO-72** Mobile: Siri / system reminders integration _(Medium)_ — after GOO-47. "Hey Siri, remind me to walk the dog at 6pm" → creates a Pikos page with the reminder text + time. iOS: `INAddTasksIntent` (SiriKit Tasks domain). Android: Google Assistant intents. Both require a native extension, not doable in pure React Native — plan for bridging.
- [-] **GOO-69** Public REST API (CRUD) _(Medium)_ — requires server infrastructure, after GOO-25 (sync). A lightweight authenticated API over the user's vault: `GET/POST /pages`, `GET/PUT/DELETE /pages/:id`, `GET /folders`. Auth: API keys (not OAuth — simpler for automation use cases). Rate-limited. The sync infrastructure (GOO-25) is a prerequisite — the API needs a server-side representation of the vault.
- [-] **GOO-70** Automation integrations — webhooks, n8n, Zapier _(Medium)_ — after GOO-69 (public API). Outbound webhooks: user configures a URL, Pikos POSTs a payload on `page.created` / `page.updated` / `page.completed` events. n8n and Zapier both support inbound webhooks and use the public API for reads/writes — no bespoke integration code needed for those. A generalized webhook mechanism (per-event, configurable URL + secret + payload template) covers all three use cases.
- [-] **GOO-73** Collaboration — shared vaults and folders _(Low)_ — far future, requires server + conflict resolution. Multi-user access to a shared vault or folder. Real-time presence, CRDT-based merging (cr-sqlite is the likely path — see GOO-25). Distinct from page sharing (GOO-68) which is read-only public links; this is full collaborative editing. Not before GOO-25 is proven at single-user sync.
- [-] **GOO-6** Component library repo — absorbed into `packages/ui` in monorepo.
- [-] **GOO-56** Plugin system foundation _(Deferred — post Phase 4)_
  See `features/extensibility.md` for full design. Core pieces: `PluginContext` API in `packages/core/src/plugin/`, local plugin loader (reads `~/.pikos/plugins/*/plugin.json`), permission approval UI, VaultContext event emitter (lightweight listener array on createPage/updatePage/deletePage). The event emitter is the only piece worth wiring in early — costs ~10 lines in VaultContext, makes plugins reactive when they eventually land.

- [-] **GOO-57** AI agent / personal assistant _(Deferred — post GOO-56)_
  See `features/extensibility.md` for full design. `AgentService` in `packages/core/src/agent/`, `vaultTools` wrapping StorageAdapter, swappable model provider (Ollama local + cloud via user's own API key stored in OS keychain), agent panel UI (`Cmd+Shift+A`), inline confirmation for write operations. Implemented as a built-in plugin so third-party plugins can register additional agent tools.

- [-] **GOO-63** Conversational / voice mode _(Deferred — post GOO-57)_

  Talk to Pikos like a human. Natural-language queries and mutations spoken aloud — no typing required.

  **Example interactions:**
  - _"When's my next appointment?"_ → reads scheduled pages, answers conversationally
  - _"When's the last time I mentioned Sarah?"_ → FTS search across all content, returns date + excerpt
  - _"Add a task: call the dentist tomorrow at 2pm"_ → creates page via `vaultTools`, confirms aloud
  - _"What did I work on last week?"_ → `list_pages` filtered by last week's date range, summarised
  - _"Mark the API refactor as done"_ → fuzzy-matches page title, calls `update_page`

  **Architecture:**

  Built as a built-in plugin on top of GOO-57's `AgentService` — voice is just a new input/output
  channel for the same tool-using agent loop. Three new pieces:
  1. **Speech-to-text (STT)**: transcribes microphone input to text, feeds into `AgentService`
     - Local: `whisper.cpp` sidecar (Tauri sidecar binary) — fully offline, private by default
     - Cloud fallback: user's own OpenAI Whisper API key (same key-in-keychain pattern as GOO-57)
  2. **Text-to-speech (TTS)**: speaks the agent's response back
     - macOS: `AVSpeechSynthesizer` via Tauri Rust command — zero extra deps, works offline
     - Cross-platform fallback: Web Speech API (`window.speechSynthesis`) — built into Chromium/WebView
  3. **Voice session UI**: minimal overlay, not the full agent panel
     ```
     ┌─────────────────────────────────────┐
     │  ●  Listening...            [Done]  │  ← push-to-talk or wake word
     │  "When's my next appointment?"      │  ← live transcript
     │  ✦  You have a dentist appt Fri 2pm │  ← agent response (also spoken)
     └─────────────────────────────────────┘
     ```
     Triggered by `Cmd+Shift+V` or a configurable wake word (e.g. "Hey Pikos").
     Push-to-talk: hold shortcut → speak → release. Wake word: always-on mic (opt-in, disclosure required).

  **Privacy model:**
  | Mode | Audio leaves device? |
  |---|---|
  | Local STT (whisper.cpp) + local TTS | Never |
  | Cloud STT (OpenAI Whisper) | Only the current utterance, not stored |
  | Cloud LLM (GOO-57) | Same as GOO-57 — only relevant context, not full vault |

  Wake word detection (if enabled) runs entirely locally — only the post-wake-word audio is
  processed. Explicit opt-in with clear disclosure before enabling always-on mic.

  **Dependencies:** GOO-57 (AI agent — voice is its input channel), GOO-56 (plugin system).
  `whisper.cpp` sidecar: Tauri `sidecar` config in `tauri.conf.json`, bundled binary per platform.

- [ ] **GOO-87** Native desktop notification system _(High)_
  See `features/notifications.md` for full design.

  Remind users of scheduled pages via OS notifications (macOS Notification Center,
  Windows Toast, Linux libnotify) plus in-app banners when the window is focused.
  Fully local — zero network required.

  **Notification types:**
  - **Pre-event reminder** — N minutes before `scheduled_start` (default 10 min, configurable per-page)
  - **Overdue alert** — fires once per day per page when `scheduled_end` is past and `status ≠ done`
  - **Focus session end** — when GOO-78 timer expires (opt-in)
  - **Daily digest** — morning summary of today's pages (opt-in, default 8am)

  **Schema additions** (add to `001_initial.sql` migration or a new `002_notifications.sql`):
  ```sql
  CREATE TABLE page_reminders (
    id             TEXT PRIMARY KEY,
    page_id        TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    minutes_before INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE notification_log (
    id            TEXT PRIMARY KEY,
    page_id       TEXT,
    schedule_id   TEXT,
    type          TEXT NOT NULL,  -- 'reminder' | 'overdue' | 'digest' | 'focus'
    fired_at      INTEGER NOT NULL,
    snoozed_until INTEGER,
    action        TEXT            -- 'dismissed' | 'done' | 'snoozed' | 'opened'
  );
  ```

  **Scheduler:** Rust Tokio background task (not JS `setInterval` — JS timers can be
  throttled when the webview is backgrounded). Polls every 30 seconds. Registered in
  `lib.rs` via `tauri::async_runtime::spawn`. Source: `src-tauri/src/notifications/`.

  **Tauri dep:** `tauri-plugin-notification` (add to `Cargo.toml` + `tauri.conf.json`
  permissions). Wraps `UNUserNotificationCenter` on macOS.

  **Action buttons (macOS/Windows):** `[Done]` marks page complete without opening the
  app. `[Snooze]` sub-menu: 15 min / 1 hour / tomorrow morning. `[Open]` focuses the
  window and navigates to the page.

  **In-app banner:** When Pikos window is focused, suppress the OS notification and
  show a slide-in toast (top-right, Framer Motion, 8s auto-dismiss) instead.

  **Per-page config:** Bell icon in metadata header (GOO-32) → popover with reminder
  time options. Supports multiple reminders per page (e.g. 1h before + 10min before).

  **Settings panel:** Enable/disable, default lead time, quiet hours, digest time,
  notification style (banner vs alert on macOS).

  **Dependencies:** GOO-29 (SQLite), GOO-34 (scheduled date picker), GOO-76
  (`page_schedules`), GOO-32 (metadata header for bell icon UI).

- [-] **GOO-82** Messaging bot platform — shared foundation _(Medium — Deferred, after GOO-57)_

  Talk to your vault from any chat app. The same `AgentService` from GOO-57 powers the responses;
  this ticket is the infrastructure that bridges a chat platform to it.

  **The core problem:** Pikos is a local desktop app. Discord and WhatsApp deliver messages via
  outbound webhook to a public URL — impossible without a server. Two strategies:

  | Strategy | Works for | Tradeoff |
  |---|---|---|
  | Long-polling | Telegram (official), Discord (via gateway WS) | Runs inside Tauri, no server needed |
  | Relay server | All platforms | Small Cloudflare Worker or Fly.io instance forwards webhooks to the local app |

  Recommend **long-polling first** (zero infra, privacy-preserving). Relay is an optional advanced
  path users who want WhatsApp or want guaranteed delivery can opt into.

  **Shared pieces (all platforms build on these):**

  1. **`MessagingAdapter` interface** — `packages/core/src/messaging/adapter.ts`
     ```ts
     interface MessagingAdapter {
       platform: 'telegram' | 'discord' | 'whatsapp'
       start(): Promise<void>   // begin polling or webhook listen
       stop(): Promise<void>
       send(chatId: string, text: string, options?: MessageOptions): Promise<void>
     }
     ```
     Each platform ships its own implementation. The rest of the system only talks to this interface.

  2. **Identity & auth** — Only the vault owner can use the bot. Binding flow:
     - User opens Settings → Messaging → "Link Telegram account"
     - Pikos generates a one-time token, user sends `/bind <token>` to the bot
     - Pikos stores `(platform, platform_user_id)` in SQLite — all future messages verified against this
     - No token = no response. The bot silently ignores unrecognised senders.

  3. **Session context** — Conversation state stored in memory (ring buffer, last 20 turns per platform).
     Feeds into `AgentService` as the chat history so the model has conversation context.
     Cleared after 30 min of inactivity.

  4. **Rate limiting** — Max 30 messages/min per bound account. Excess → "Slow down a bit." response.
     Prevents accidental loops from automation.

  5. **Notification dispatch** — Shared scheduler that sends proactive messages (reminders, digests)
     through whichever adapters are active. See GOO-86.

  6. **Privacy model** — No vault content leaves the device in long-polling mode. In relay mode,
     messages transit through the relay encrypted (user's own relay → user's own device). Relay sees
     ciphertext only if user follows the E2E relay setup. Disclosure shown in onboarding.

  **Settings UI** — New "Messaging" section in Settings (sidebar tab). Per-platform cards: status
  (linked / unlinked), "Link account" / "Unlink" button, notification toggles.

  **Dependencies:** GOO-57 (AgentService — messaging is another I/O channel, same pattern as voice).

- [-] **GOO-83** Telegram bot integration _(Medium — Deferred, after GOO-82)_

  Most practical first platform: Telegram Bot API supports **long-polling** natively, so no server or
  relay is needed — the bot runs entirely inside Tauri as a background task.

  **Setup:** User creates a bot via @BotFather → pastes token into Pikos Settings → Pikos starts
  polling `getUpdates`. Takes < 2 min. No coding required.

  **Command surface (slash commands + free-form NL):**

  | Input | Behaviour |
  |---|---|
  | `/today` | Sends today's scheduled pages + overdue tasks as a formatted list |
  | `/inbox` | Lists Inbox (unscheduled, unfiled) pages |
  | `/add Buy oat milk tomorrow 9am` | NL parse via GOO-19 → creates page, confirms with inline keyboard |
  | `/done <title fragment>` | Fuzzy-matches page, marks `status = done`, confirms |
  | `/find <query>` | FTS search, returns top 5 results with excerpt |
  | `/note` | Starts a capture session — next message becomes a new page body |
  | Free-form text | Routed through AgentService (GOO-57) for full conversational response |
  | Photo / file | Attachment saved as page with image embedded; title extracted from caption |

  **Message formatting:** Telegram supports MarkdownV2. Task lists render as:
  ```
  ✅ Review PRs — done
  ⏳ Write tests — in progress  @2pm today
  ○  Deploy staging
  ```
  Dates shown in user's local timezone (stored UTC, formatted at send time).

  **Inline keyboard on `/add`:** After NL parse, reply includes:
  `[✓ Create]  [Edit date]  [Set priority]  [Cancel]`
  Tap to confirm or adjust before writing to vault. Confirmation required for any write.

  **Notifications:** When GOO-86 is active, this adapter delivers the scheduled dispatches.

  **Implementation:** `TelegramAdapter` in `apps/desktop/src/features/messaging/telegram/`.
  Uses `node-telegram-bot-api` or raw `fetch` to `api.telegram.org`. Polling runs in a `setInterval`
  inside a Tauri background window (or just the main window — no separate process needed).

  **Dependencies:** GOO-82 (shared foundation), GOO-57 (AgentService), GOO-19 (NL parser).

- [-] **GOO-84** Discord bot integration _(Medium — Deferred, after GOO-82)_

  Talk to your vault from a personal Discord server or DM-to-self. Useful for users who live in
  Discord all day — capture a task without leaving the app.

  **Architecture choice:** Discord's bot API uses a persistent **WebSocket gateway** (not HTTP
  webhooks) — so like Telegram, this can run locally inside Tauri without a public server.
  `discord.js` or raw WebSocket to `gateway.discord.gg`.

  **Setup:** User creates a Discord Application + Bot token at discord.com/developers → pastes token
  into Pikos Settings. Bot should be added to a private personal server (not shared) — this is the
  privacy boundary. DM-to-bot also works.

  **Channel scope:** Pikos only responds in channels it's explicitly granted access to (configured in
  Settings). Default: respond only to DMs to the bot. This prevents accidental leaks to shared servers.

  **Command surface:** Same as Telegram (GOO-83) — slash commands registered via Discord's
  Application Commands API so they autocomplete in the Discord UI:
  - `/today`, `/inbox`, `/add`, `/done`, `/find`, `/note`
  - Free-form DMs routed to AgentService

  **Rich embeds:** Discord supports embeds for structured output:
  ```
  ┌──────────────────────────────────┐
  │ 📋 Today — 3 items               │
  │──────────────────────────────────│
  │ ⏰ 9:00am  Review PRs            │
  │ ⏰ 2:00pm  Deploy staging        │
  │ ⚠️  Overdue  Write tests          │
  └──────────────────────────────────┘
  ```
  Buttons on task embeds: `✓ Done` | `Reschedule` | `Open in Pikos`

  **"Open in Pikos" deep link:** `pikos://page/<uuid>` — Tauri custom scheme handler focuses the
  app and navigates to that page. Same mechanism as GOO-68 share links.

  **Implementation:** `DiscordAdapter` in `apps/desktop/src/features/messaging/discord/`.
  Dependency: `discord.js` (or lighter `@discordjs/ws` + `@discordjs/rest`).

  **Privacy note:** Discord messages transit Discord's servers by design. The bot response content
  (task titles, note excerpts) will appear in Discord. Users should be aware of this — shown in
  onboarding. Recommend using a private server or DM-to-bot.

  **Dependencies:** GOO-82 (shared foundation), GOO-57 (AgentService), GOO-19 (NL parser).

- [-] **GOO-85** WhatsApp integration _(Low — Deferred, after GOO-84, approach TBD)_

  WhatsApp is the world's most-used messenger but has no official bot API for personal accounts.
  Options, in order of viability:

  | Approach | Viability | Notes |
  |---|---|---|
  | WhatsApp Business Cloud API | Medium | Free tier, requires Meta business account + phone number verification. Messages go through Meta's servers. Personal use is technically allowed for small volumes. |
  | Unofficial clients (`whatsapp-web.js`) | Low | Scrapes WhatsApp Web. ToS violation. Account ban risk. Not suitable for a productivity app. |
  | Signal instead | High (alternative) | Signal has an unofficial but stable bot lib (`signal-cli`). Same privacy positioning as Pikos. Worth considering as a WhatsApp substitute. |
  | Matrix bridge | Medium | Matrix + WhatsApp bridge (via `mautrix-whatsapp`) — self-hosted, routes WA messages into a Matrix room that Pikos can read via Matrix client. High setup complexity. |

  **Recommended path:** Implement Signal support under this ticket (same user intent — "chat app I
  use daily"), with WhatsApp Business Cloud API as a secondary option for users who set it up.

  **Signal (`signal-cli` sidecar):** `signal-cli` is a Java CLI that can run as a Tauri sidecar
  (like `whisper.cpp` in GOO-63). Register a separate phone number (e.g. a free Google Voice number)
  for the bot. User links their Signal account to that number. No server needed — runs entirely local.

  **WhatsApp Business Cloud API:** Meta provides free-tier webhook access. Requires a relay (small
  Cloudflare Worker) to forward webhooks to the local app. User must create a Meta Business account,
  set up a phone number, and agree to Meta's messaging policies. Document this setup clearly.

  **Both share the same `MessagingAdapter` interface** — the rest of the system doesn't care which.

  **Scope note:** Defer until GOO-83 (Telegram) and GOO-84 (Discord) are stable and there's real
  user demand for WhatsApp/Signal. This is a "nice to have" for users whose primary communication
  lives in WhatsApp.

  **Dependencies:** GOO-82 (shared foundation), GOO-84 (Discord done first to prove the pattern).

- [-] **GOO-86** Proactive notifications via messaging _(Medium — Deferred, after GOO-83)_

  The reverse direction: Pikos reaching out to you, not you reaching out to Pikos. Scheduled
  dispatches sent through whichever messaging adapter(s) the user has linked.

  **Notification types:**

  | Type | Trigger | Content |
  |---|---|---|
  | Morning digest | Daily at user-configured time (default 8am) | Today's scheduled pages, overdue carry-overs |
  | Due reminder | N minutes before `scheduled_start` | "Reminder: _Review PRs_ in 15 min" |
  | Overdue alert | Page past `scheduled_end` with `status ≠ done` | "Overdue: _Write tests_ (was 2pm)" with `[Done]` / `[Reschedule]` buttons |
  | Completion summary | End of day (default 6pm) | Count done/total for the day, streak if applicable |
  | Focus session end | When focus timer (GOO-78) expires | "25min done! Take a break 🎉" |

  **Interaction:** Notification messages include inline action buttons where the platform supports them
  (Telegram: inline keyboard, Discord: message components). `[Done]`, `[Snooze 1h]`, `[Open]`.
  Tapping `[Done]` marks the page complete without opening the app.

  **User control:**
  - Per-type toggles in Settings → Messaging → Notifications
  - Quiet hours: "Don't notify between 10pm – 8am"
  - Per-page opt-out: `remind: false` flag in page metadata (toggle in metadata header)
  - Max 1 overdue alert per page per day — no spam for chronically deferred tasks

  **Implementation:** `NotificationScheduler` service in `packages/core/src/messaging/scheduler.ts`.
  Runs as a `setInterval` (check every minute) inside the Tauri window. On match, calls
  `MessagingAdapter.send()` on all linked adapters. Scheduler state persisted in SQLite
  (`notification_log` table — prevents duplicate sends on app restart).

  ```sql
  CREATE TABLE notification_log (
    id TEXT PRIMARY KEY,
    page_id TEXT,          -- NULL for digest/summary types
    type TEXT NOT NULL,    -- 'digest' | 'reminder' | 'overdue' | 'summary' | 'focus'
    platform TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  );
  ```

  **Privacy:** No external service required in long-polling mode. Messages stay between the local
  app and the user's own bot token/chat. Same privacy story as GOO-83/84.

  **Dependencies:** GOO-83 (Telegram adapter — first delivery target), GOO-82 (shared scheduler
  dispatch), GOO-78 (focus timer — for focus session notifications).
