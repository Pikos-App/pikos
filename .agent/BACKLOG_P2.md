# Pikos — Phase 2 Post-Launch Backlog

Items shipping in the months after public launch. V1 polish, navigation, org, import/export, calendar depth.

Status: `[ ]` pending · `[-]` superseded/deferred

---

## Navigation & Organization

### Page List

- [ ] **GOO-16** Page completion + DnD reordering _(Medium)_
  Completed pages → strikethrough + muted → collapse into "Completed" accordion at bottom (UI toggle button). Drag handle for manual reordering (`@dnd-kit/core` via `reorderPages`). `completedAt` timestamp on done.

- [ ] **GOO-100** Multi-select pages + bulk actions _(Medium)_
  Checkbox appears on hover on each page list item (or when any item is already selected). Click checkbox or `Cmd+click` a page to enter selection mode. `Cmd+A` selects all in current view. `Esc` clears selection.

  **Action bar**: sticky strip at the bottom of the page list panel while items are selected. Shows count ("3 selected") + actions:
  - **Move to folder** — folder picker popover → `updatePage({ folderId })` for each
  - **Status** — status picker → `updatePage({ status })` for each
  - **Priority** — priority picker → `updatePage({ priority })` for each
  - **Delete** — confirmation dialog → `deletePage()` for each (with undo toast, single undo entry via `CommandHistory`)

  Selection state is local to the page list component (`useState<Set<string>>`). Does not affect `activePageId` — opening a page from the editor while items are selected clears selection.

  Dependencies: GOO-33 (status toggle), GOO-35 (priority selector), GOO-94 (CRUD actions).

- [ ] **GOO-38** Pages list filters _(Medium)_
  Filter bar in Pages panel header. Status (all/active/done/in-progress), Scheduled (all/scheduled/unscheduled/today/this week), Priority (all/urgent/high/any), Tag (multi-select). Persist per session.

### Sidebar

- [ ] **GOO-81** Split view _(Low)_
  Two `EditorPane` instances in the right panel. Hard limit: 2 panes. Orientations: L/R (default) or T/B, toggled post-split. `⊟` on primary pane toggles orientation; `×` on secondary closes split. Divider draggable, ratio persisted to localStorage. Active pane (last clicked/focused) receives page-list navigation. Only active when `rightPanel === 'editor'`. State: `UIContext.splitMode: 'none' | 'horizontal' | 'vertical'` + `splitPageId: string | null`. Keyboard: `Cmd+Shift+\` toggle split, `Cmd+Shift+[`/`]` move focus between panes.

---


- [] GOO-60 Phase 2b: Recurring & Batch Page Confirmation

## Summary

When the NLP parser returns a recurring or finite-batch result, show a confirmation step before creating pages. Currently the Quick Add submit flow only handles `type: 'single'`. This task adds support for `type: 'recurring'` and `type: 'finite'` results with an intermediate confirmation dialog.

Note to self - when doing recurring scheduling with NLP, what should we show on the schedule button? The date picker doesn't account for recurring events yet. This is a big ol topic with a lot of UI/UX concerns. So maybe better to hold off on recurring until I get further along in the calenar.

---

## Current state

In `handleSubmit` and `runParseAndStrip`, the parsed result is extracted with a fallback that collapses everything to single:

```typescript
const parsed =
  result.type === "single"
    ? result.input
    : result.type === "finite"
      ? result.inputs[0]  // ← only takes the first, ignores the rest
      : result.input;
```

This needs to handle all three types properly.

---

## Parse result types

Check the actual return type of `parseInput` in the codebase. Based on the existing code, it returns a discriminated union roughly like:

```typescript
type ParseResult =
  | { type: "single"; input: ParsedInput }
  | { type: "finite"; inputs: ParsedInput[]; count: number }
  | { type: "recurring"; input: ParsedInput; rrule: string }
```

Verify the exact shape — the `rrule` field name and any additional metadata on the recurring type may differ.

---

## Confirmation rules

| Result type | Condition | Behavior |
|---|---|---|
| `single` | always | Create immediately, no confirmation (unchanged) |
| `finite` | `count < 3` | Create immediately, no confirmation |
| `finite` | `count >= 3` | Show confirmation dialog |
| `recurring` | always | Show confirmation dialog |

---

## Confirmation dialog

When confirmation is required, show a secondary dialog (or replace the Quick Add content) with:

### For finite batch (`count >= 3`):

```
┌──────────────────────────────────────────────────────────────┐
│  Create multiple pages?                                      │
│                                                              │
│  This will create 5 pages:                                   │
│                                                              │
│  · "Morning run" — Mon Mar 16                                │
│  · "Morning run" — Tue Mar 17                                │
│  · "Morning run" — Wed Mar 18                                │
│  · "Morning run" — Thu Mar 19                                │
│  · "Morning run" — Fri Mar 20                                │
│                                                              │
│                              [ Cancel ]  [ Create 5 pages ]  │
└──────────────────────────────────────────────────────────────┘
```

- Show the list of pages that will be created with their titles and dates.
- If the list is long (>10), show the first 5 and last 2 with "... and N more" in between.
- "Cancel" returns to the Quick Add input (don't close the modal, don't lose input state).
- "Create N pages" creates all of them.

### For recurring:

```
┌──────────────────────────────────────────────────────────────┐
│  Create recurring page?                                      │
│                                                              │
│  "Morning run"                                               │
│  Every weekday at 7:00 AM                                    │
│  Starting Mon Mar 16                                         │
│                                                              │
│                              [ Cancel ]  [ Create ]          │
└──────────────────────────────────────────────────────────────┘
```

- Display the RRULE in human-readable form. Use `rrule.js`'s `toText()` method if available, or write a simple formatter for common patterns (daily, weekly, weekdays, monthly).
- Show the start date.
- "Cancel" returns to the Quick Add input.
- "Create" creates the recurring page.

### Dialog implementation

Use a shadcn `AlertDialog` (or similar confirmation pattern) that overlays on top of the Quick Add dialog. The Quick Add stays open underneath — if the user cancels, they're right back where they were.

---

## Updated submit flow

```typescript
async function handleSubmit() {
  const finalValue = inputValue.trim();
  if (!finalValue) { /* shake, return */ }

  const result = parseInput(finalValue);

  // Check if confirmation is needed
  if (result.type === "recurring") {
    setConfirmation({ type: "recurring", result });
    return; // Don't create yet — wait for confirmation
  }

  if (result.type === "finite" && result.count >= 3) {
    setConfirmation({ type: "finite", result });
    return;
  }

  // Single or finite with count < 3 — create immediately
  await createFromResult(result);
}
```

### Confirmation state

```typescript
const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);

type ConfirmationState =
  | { type: "recurring"; result: RecurringParseResult }
  | { type: "finite"; result: FiniteParseResult };
```

When confirmation is dismissed: `setConfirmation(null)` — returns to Quick Add input.
When confirmed: call `createFromResult(confirmation.result)` then close everything.

---

## Page creation for each type

Extract a shared `createFromResult` function:

```typescript
async function createFromResult(result: ParseResult) {
  if (result.type === "single" || (result.type === "finite" && result.count < 3)) {
    const inputs = result.type === "single" ? [result.input] : result.inputs;
    for (const input of inputs) {
      await createSinglePage(input);
    }
    // Navigate to the first created page
  }

  if (result.type === "finite" && result.count >= 3) {
    for (const input of result.inputs) {
      await createSinglePage(input);
    }
    // Navigate to the first created page
  }

  if (result.type === "recurring") {
    // Create a single page with recurrence rule attached.
    // Check how PageRecurrenceRule is created in the codebase —
    // there may be an adapter method like createRecurrenceRule().
    // The page gets one PageRecurrenceRule row; the calendar expands
    // virtual occurrences via rrule.js at render time.
    await createRecurringPage(result.input, result.rrule);
  }

  setConfirmation(null);
  setOpen(false);
  setActivePage(firstCreatedPage.id);
}
```

### `createSinglePage` helper

Encapsulates the existing create → updatePage → scheduleOnce flow:

```typescript
async function createSinglePage(parsed: ParsedInput): Promise<Page> {
  const resolvedFolderId = /* folder resolution logic, same as current */;
  const page = await createPage({ title: parsed.title, folderId: resolvedFolderId });

  const patch: PageUpdate = {};
  if (priorityValue !== 0) patch.priority = priorityValue;
  if (parsed.tags.length > 0) patch.tags = [...new Set([...tagsValue, ...parsed.tags])];
  if (parsed.durationMinutes) patch.durationMinutes = parsed.durationMinutes;
  if (Object.keys(patch).length > 0) updatePage(page.id, patch);

  if (parsed.scheduledStart) {
    await scheduleOnce(page.id, parsed.scheduledStart, parsed.scheduledEnd);
  }

  return page;
}
```

### `createRecurringPage` helper

Check the codebase for how `PageRecurrenceRule` rows are created. There's likely an adapter method. The recurring page is a single page with a recurrence rule — the calendar expands virtual occurrences. If no adapter method exists yet, this may need to be added to the `WorkspaceContext` (flag it and ask rather than implementing a new adapter method blindly).

---

## Chip preview for recurring/finite

During the debounce preview and space-parse, if the result is `recurring` or `finite`:

- DateChip should show the **first** scheduled date (same as current behavior).
- Consider showing a small indicator that this is recurring/batch — e.g., a repeat icon (🔁) next to the date chip, or the date chip text could say "Every weekday" instead of a single date. Keep it simple — this is a nice-to-have, not a blocker.

---

## Testing checklist

- Type `run every weekday at 7am` → Enter → recurring confirmation dialog appears with RRULE summary.
- Cancel on confirmation → returns to Quick Add, input preserved.
- Confirm → recurring page created, modal closes, editor opens page.
- Type `run mon tue wed thu fri` (or whatever syntax produces finite with 5 entries) → Enter → batch confirmation shows 5 pages listed.
- Cancel → returns to Quick Add.
- Confirm → 5 pages created, editor opens the first one.
- Type `run mon tue` (finite, count=2, below threshold) → Enter → creates immediately, no confirmation.
- Type `run tomorrow` (single) → Enter → creates immediately, no confirmation (unchanged).
- Verify chip state (priority, tags, folder) is correctly applied to ALL pages in a batch create.

## App Shell

- [ ] **GOO-59** Settings infrastructure + day-1 panels _(High)_

  `Cmd+,` opens a full-screen overlay modal with left nav (like Linear / VSCode). `Esc` closes. Also accessible from native menu (Pikos > Preferences) and command palette (`Cmd+K` → "Settings").

  **Nav structure at launch:**
  ```
  General
  Appearance
  Editor
  Workspaces
  Keyboard Shortcuts
  ─────────────────
  Calendars          ← GOO-22
  Performance        ← GOO-55
  Privacy            ← GOO-58, GOO-46
  Assistant          ← GOO-57
  Plugins            ← GOO-56
  ```

  **General panel:**
  - Default folder for new pages: [Inbox (default) | folder picker] — fallback only when no sidebar folder is active
  - Date format: [System default | MM/DD/YYYY | DD/MM/YYYY | YYYY-MM-DD]
  - Time format: [System default | 12-hour | 24-hour]

  **Appearance panel:**
  - Theme: [System | Light | Dark] — stored in localStorage, applied to `<html>` (wire to GOO-97 key)

  **Editor panel:**
  - Spell check: [On | Off] — off by default
  - Line width: [Narrow ~60ch | Default ~72ch | Wide ~88ch | Full]

  **Workspaces panel:**
  The authoritative place to manage all known workspaces (`Workspace[]` array in plugin-store).
  ```
  My Workspace     ~/Library/Application Support/pikos/default.sqlite    [Open]  [···]
  Work Notes       ~/Library/Application Support/pikos/work.sqlite        [Open]  [···]
  ──────────────────────────────────────────────────────────────────────────────────────
  [+ Create New Workspace]
  ```
  `[···]` context menu: Rename, Show in Finder, Remove from list (does NOT delete the SQLite file).
  Active workspace highlighted. Switching workspaces reloads WorkspaceContext with the new adapter.

  **Keyboard Shortcuts panel:**
  Read-only reference list from `Keyboard.list()` (GOO-31). Groups: Navigation, Editor, Calendar, View.

  **Implementation notes:**
  - Settings state in `@tauri-apps/plugin-store` under a `settings` key. Shape: `{ theme, spellCheck, lineWidth, defaultFolderId, dateFormat, timeFormat }`.
  - `useSettings()` hook in `apps/desktop/src/shared/hooks/useSettings.ts`.
  - Each feature adds its panel via a `SettingsRegistry` array of `{ id, label, icon, component }`.

- [ ] **GOO-24** Native menu bar + window management _(High)_
  macOS menu bar via Tauri menu API. File: New Page, Open/Switch Workspace, Export Workspace, Close Window. Edit: standard. View: Toggle Sidebar, Toggle Calendar, Focus Mode. `Cmd+W` closes active page.

---

## Import / Export

- [ ] **GOO-48** Import: Markdown → SQLite _(Medium)_
  `packages/core/src/import/markdown-import.ts`. Uses `gray-matter`.
  ```ts
  export async function importMarkdownWorkspace(
    dirPath: string,
    adapter: StorageAdapter
  ): Promise<ImportResult>;
  // ImportResult: { imported: number; skipped: number; errors: Array<{file, reason}> }
  ```
  Frontmatter field map: `title`→title, `tags`→tags, `status`→status, `priority`→priority, `scheduled`/`date`→scheduledStart, `created`/`createdAt`→createdAt. Directory hierarchy → folder records (flat in v1). Malformed frontmatter: skip + log.

- [ ] **GOO-41** Obsidian workspace import — onboarding UI _(Medium)_ — **requires GOO-48**
  UX wrapper around GOO-48. Flow: folder picker → scan preview ("Found 47 pages in 6 folders") → confirm → background import with progress → success summary. `.obsidian/` config dir ignored.
  - other import considerations (todoist, ticktick, apple notes, reminders, others?)

- [ ] **GOO-49** Export: SQLite (Tiptap JSON) → Markdown _(Medium)_
  `packages/core/src/export/markdown-export.ts`.
  ```ts
  export async function exportToMarkdown(
    adapter: StorageAdapter,
    options: ExportOptions
  ): Promise<{ exported: number }>;
  // ExportOptions: { outputDir: string; includeMetadata?: boolean; filenameFrom?: 'title' | 'id' }
  ```
  Output: standard YAML frontmatter + markdown body, Obsidian-compatible. Accessible via File → Export Workspace.

- [ ] **GOO-65** Per-page export _(Low)_
  Export a single page from right-click context menu or `•••` overflow in metadata header.
  - **Markdown** — YAML frontmatter + body (reuse `exportToMarkdown` with single-page overload)
  - **PDF** — rendered HTML → PDF via webview print API. Native save dialog, filename pre-filled from title.

- [ ] **GOO-74** Extended export formats _(Low)_
  - **JSON backup** — full-fidelity workspace snapshot (pages, folders, time blocks). Schema version field required.
  - **CSV** — flat task list: title, status, priority, due date, tags, folder.
  - **HTML** — rendered pages as standalone `.html` files.
  - **ICS/iCal** — export all scheduled pages as calendar events. Import into Apple Calendar / Google Calendar.

- [ ] **GOO-75** Third-party app import _(Low)_
  Import from: Todoist (JSON backup), TickTick (CSV), Things 3 (TaskPaper), Evernote (ENEX), OPML.
  Each importer: pure function `(rawInput) => ImportResult` in `packages/core/src/importers/`. No Tauri deps. File reading handled by Tauri command layer above. Wizard UI with preview + progress.

---

## Calendar Depth

- [ ] **GOO-22** CalDAV external calendar sync (read-only) _(Medium)_
  Pull external calendar events as read-only blocks. Protocol: CalDAV (Fastmail, Google, Apple, Proton).
  **Schema** (new migration):
  ```sql
  CREATE TABLE external_calendar_accounts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, caldav_url TEXT NOT NULL,
    username TEXT NOT NULL, color TEXT, last_synced_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE external_events (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES external_calendar_accounts(id) ON DELETE CASCADE,
    uid TEXT NOT NULL, title TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT,
    is_all_day INTEGER DEFAULT 0, description TEXT, location TEXT,
    dismissed INTEGER DEFAULT 0, dismissed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(account_id, uid)
  );
  ```
  **Rust deps**: `reqwest` (CalDAV HTTP), `ical` crate (parse iCalendar), `keyring` crate (OS keychain — credentials never in SQLite).
  **Sync**: on launch + on app focus (if >5 min since last sync) + manual refresh button.
  **User actions**: View, Dismiss (local flag, never synced back), "Convert to page".
  **Dedup rule**: connect directly to the calendar source (e.g. Fastmail CalDAV URL) — never via a re-exporting intermediary.

- [ ] **GOO-64** Timezone-aware scheduling + DST handling _(Medium)_
  All `scheduled_start` / `scheduled_end` stored as UTC ISO 8601 in SQLite. Display converted to user's local timezone. `date-fns-tz` for DST-correct conversion. Settings > General: timezone picker (defaults to system). Add `timezone` column to `settings` table.

---

## Performance

- [ ] **GOO-55** Local performance monitor _(Medium)_

  **Metrics** (instrument with `performance.mark()` / `performance.measure()`):

  | Metric | Budget (target / acceptable) |
  |---|---|
  | `page.open` | <50ms / <150ms |
  | `page.save` | <100ms / <300ms |
  | `search.fts` | <50ms / <200ms |
  | `search.fuzzy` | <16ms / <50ms |
  | `workspace.load` | <300ms / <1000ms |
  | `pages.list.render` | <32ms / <100ms |

  **`PerfMonitor`** (`packages/core/src/perf/PerfMonitor.ts`): singleton, in-memory ring buffer (last 200 samples/metric), optional daily SQLite aggregate log. `PerfMonitor.shared.enabled` gates all calls — no-ops when disabled.

  **Overlay UI**: `Cmd+Shift+.` toggle, small semi-transparent panel bottom-right, color-coded by budget. Off by default; enabled via Settings > Performance.

  **Stress test mode** (dev only, `VITE_DEV_TOOLS=true`): generate N pages, run full open/save/search/list cycle, report metrics.

---

## Notifications

- [ ] **GOO-87** Native desktop notification system _(High)_
  See `features/notifications.md` for full design. OS notifications (macOS Notification Center, Windows Toast, Linux libnotify) + in-app banners when window is focused.

  **Notification types:**
  - **Pre-event reminder** — N minutes before `scheduled_start` (default 10 min, configurable per-page)
  - **Overdue alert** — fires once per day per page when past `scheduled_end` and `status ≠ done`
  - **Focus session end** — when GOO-78 timer expires (opt-in)
  - **Daily digest** — morning summary of today's pages (opt-in, default 8am)

  **Scheduler**: Rust Tokio background task (not JS `setInterval` — JS timers throttle in background). Polls every 30s. Source: `src-tauri/src/notifications/`.
  **Tauri dep**: `tauri-plugin-notification`. Action buttons: `[Done]`, `[Snooze]`, `[Open]`.
  **In-app banner**: suppress OS notification when window is focused, show framer-motion slide-in toast (8s auto-dismiss) instead.

---

## Quick Wins

- [ ] **GOO-61** Quick Add smart recommendations _(Medium)_
  History-based inline ghost text (fish shell style) in Quick Add Modal. Every submission saved to `quick_add_history` table. Ranking: `use_count / Math.log2(hoursSinceLastUse + 2)`. `Tab` or `→` to accept. Shown when input ≥ 2 chars and prefix matches history.

- [ ] **GOO-78** Focus Timer built-in panel _(Medium)_
  Sidebar panel: large timer display, Start/Stop button, optional "Attach to page" (defaults to active page). Session log: date, duration, page title link, trash icon. Daily total at top.
  Auto-discard: sessions <10s auto-removed. Sessions 10s–60s show inline "Remove?" prompt. Sessions >60s go directly to log.
  **Data**: `focus_sessions(id, page_id?, started_at, ended_at, duration_s)` (already in schema).
  **Dependencies**: GOO-29 (done). Can ship as a non-plugin panel before plugin system (GOO-56) exists.

---

- [ ] **GOO-95** Dev: seed command — reset UI preferences _(Low)_
  Script or Tauri dev command to wipe `localStorage` and plugin-store settings keys back to defaults. Useful when testing first-run flows or settings panels. Can be a `pnpm dev:reset-ui` script that opens the app with a `?resetUI=1` query param cleared on startup, or a hidden `Cmd+Shift+Option+R` chord in dev builds only.

_For long-term power features and deferred items — see `BACKLOG_P3.md`._


To Document:
- Marketing Site
  - help content - create new folders, pages, quick add dialog and NLP, keyboard shortcuts

- Editor
  - when searching in a file, show highlighted word / partial word, also show occurrence in scroll bar (like arc / vscode)
  - word count / character count / links / backlinks / etc
  - right clicking to show context menu in editor
  - bubble menu should be one tab index with left and right arrow movement
  - highlighting text
  - additional metadata hover section at bottom right of content (word count, character count, creation/updated dates)
- Settings
  - disable bubble menu above text on highlight + disable slash commands (markdown editor version)
  - Configurable metadata fields on the page, scheduled date, start date, end date, location, etc
  - sync with reminders
  - hide weekends on calendar
  - start week on sunday
- Questions
  - How does sharing work w/ icloud sync?
  - Can I have the code be open without showing my commit history? Why would I want this? Don't want to fully show how its made... or that I'm comparing it to other products directly?
  - Pikos name, meaning, copyright, etc. Is it a good name for a notes/tasks/calendar app? So far looks good. Got good domain (pikos.app), no copyrights in software.
- Calendar
  - when on the ticktick calendar, opening a task shows a small modal, can't search content, and when I switch to a different app (like my browser, the modal closes) (although this doesn't seem consistent, sometimes it stays open).
  - Page editor should be first class, not a small modal that is pretty inconvenient for content management.
  - pressing escape on page block creation (cancel) jumps calendar to top of scroll
- List View
  - Navigate items with up and down keyboard, enter to open editor
  - Should I auto focus editor on enter key press? What about the checkbox on the UI - reachable? Too focused on keyboard navigation? Probably.
  - Ticktick allows manual sorting when a sort order is applied (ie date), and allows a reset to default date sort order. I wonder if there's benefit in that type of functionality?
- Reflections
  - Editor functionality (indent, outdent, link popover, link behavior) is tough for Claude - lots of rate limi consumed to progress a little bit at a time.
  - Upgrade to claude max?
- Performance
  - How do I handle querying and pagination? Does the app need all data at all times? List views, completed states, calendar view, searching, etc. TickTick does 30 completed w/ view more - not sure about huge directories with hundreds of incomplete. 
- Observability
  - I'd like to track how many downloads have occurred through the site. And how many downloads have occurred through the app store. No tracking should be invasive or go against the privacy policy (tbd).
- Marketing site
  - Optimize marketing site for AI surfacing / recommendations - AEO (answer engine optimization). AI can pull the right meaning from your site.
  - balance phrasing and terminology - don't want to risk legal troubles with claims / encouraging things.
  - comparison page for similar products? 
- For Later
  - Further down the road - habit tracking, maybe a habits folder where you can set habits and their schedule through the normal UI - maybe using rrule. Then provide basic visuals on completion rates. Low priority.
  - Add password protection / biometric access? How would that work with no recovery code?
  - Under "Today" could do a "Priority" list, which shows items in priority order. Maybe not valuable enough for the prime real estate. Could conditionally render it if any items have priority.
  - page location? Like a Google Calendar item.



# De-prioritized For Post Launch (Move to P2 or P3)

- [ ] **GOO-62** Undo/redo _(High — public launch blocker)_
  App-level command history for metadata mutations and CRUD — separate from Tiptap's own undo. `CommandHistory` singleton in `packages/core/src/history/CommandHistory.ts`.

  ```ts
  export interface Command {
    execute(): Promise<void>; // re-do only
    undo(): Promise<void>;
    label: string; // e.g. "Deleted 'Design review'"
  }
  export class CommandHistory {
    static shared: CommandHistory;
    push(cmd: Command): void; // call AFTER mutation; clears redo stack
    undo(): Promise<void>;    // Cmd+Z
    redo(): Promise<void>;    // Cmd+Shift+Z
    canUndo: boolean;
    canRedo: boolean;
    readonly undoLabel: string | null;
    readonly redoLabel: string | null;
  }
  ```

  Mutations that push a Command: create/delete/rename page, move page to folder, change status/priority/scheduled date, create/delete/rename folder.
  **Bulk undo**: Quick Add Modal creating N pages wraps all creates in one Command.
  **UI**: `Cmd+Z` / `Cmd+Shift+Z`. Toast: "Deleted 'Design review' · Undo". History limit: 50 entries (ring buffer).

- [ ] **GOO-99** Enhanced folder delete modal _(Medium)_
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

- [ ] **GOO-105** Editor drag handle _(Medium)_
- NOTE: we can deprioritize this for post launch.
  Hover left of any block to show a grip icon for drag-reorder. Custom ProseMirror NodeView plugin (the official `@tiptap/extension-drag-handle` is paid). Grip appears on hover with subtle fade-in. Drag creates a drop indicator line between blocks. Works with all block types (paragraphs, headings, lists, code blocks). Component: `apps/desktop/src/features/editor/components/DragHandle.tsx`. Before you get started on this one - are you intending to build this functionality from scratch since the dep is paid? How complex would this task be? Worth building in its current task priority?