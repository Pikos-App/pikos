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

### Tags

- [ ] **GOO-20** Tags system _(Medium)_
  Tags stored as JSON array in `pages.tags` column (no join table in v1 — derive counts/lists via `json_each()`). Tags panel in sidebar with page counts. Tag rollup view. Filter by tag in pages list. `#tag` syntax in editor body → sync to tags column on save. See `features/tags.md`.

### Sidebar

- [ ] **GOO-81** Split view _(Low)_
  Two `EditorPane` instances in the right panel. Hard limit: 2 panes. Orientations: L/R (default) or T/B, toggled post-split. `⊟` on primary pane toggles orientation; `×` on secondary closes split. Divider draggable, ratio persisted to localStorage. Active pane (last clicked/focused) receives page-list navigation. Only active when `rightPanel === 'editor'`. State: `UIContext.splitMode: 'none' | 'horizontal' | 'vertical'` + `splitPageId: string | null`. Keyboard: `Cmd+Shift+\` toggle split, `Cmd+Shift+[`/`]` move focus between panes.

---

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

_For long-term power features and deferred items — see `BACKLOG_P3.md`._
