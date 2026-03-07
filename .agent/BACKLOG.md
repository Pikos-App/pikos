# Pikos Backlog — Archive

> Phase 1 + active Phase 2 tasks are in `BACKLOG_ACTIVE.md`.
> Grep this file by GOO number when you need a specific item's full spec.

Status: `[ ]` pending · `[-]` superseded/deferred

---

## Phase 2 — Navigation & Organization

_Goal: the app is fully usable day-to-day. Folders, filters, tags, DnD, import/export._

### Sidebar

- [ ] **GOO-81** Split view _(Low)_
      Two `EditorPane` instances in the right panel. Hard limit: 2 panes. Orientations: L/R (default) or T/B, toggled post-split. `⊟` on primary pane toggles orientation; `×` on secondary closes split. Divider draggable, ratio persisted to localStorage. Active pane (last clicked/focused) receives page-list navigation. Only active when `rightPanel === 'editor'`. State: `UIContext.splitMode: 'none' | 'horizontal' | 'vertical'` + `splitPageId: string | null`. Keyboard: `Cmd+Shift+\` toggle split, `Cmd+Shift+[`/`]` move focus between panes.

- [ ] **GOO-94** Page CRUD actions _(High)_
      "+" button in page list header creates a new page in the active view. Right-click context menu on page list items: Rename (focuses editor title), Delete (confirmation if non-empty), Move to folder (popover). Uses shadcn ContextMenu + AlertDialog. Implement alongside GOO-89.

- [ ] **GOO-16** Page completion + DnD reordering _(Medium)_
      Completed pages → strikethrough + muted → collapse into "Completed" accordion at bottom (UI toggle button). Drag handle for manual reordering (`@dnd-kit/core` via `reorderPages`). `completedAt` timestamp on done.

- [ ] **GOO-38** Pages list filters _(Medium)_
      Filter bar in Pages panel header. Status (all/active/done/in-progress), Scheduled (all/scheduled/unscheduled/today/this week), Priority (all/urgent/high/any), Tag (multi-select). Persist per session.

- [ ] **GOO-20** Tags system _(Medium)_
      Tags stored as JSON array in `pages.tags` column (no join table in v1 — derive counts/lists via `json_each()`). Tags panel in sidebar with page counts. Tag rollup view. Filter by tag in pages list. `#tag` syntax in editor body → sync to tags column on save. See `features/tags.md`.

### App Shell

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
  - Theme: [System | Light | Dark] — stored in localStorage, applied to `<html>`

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

- [-] **GOO-42** First-run + onboarding — **superseded by GOO-15**
      Original spec called for a "Create New Workspace" folder picker on first launch. This is superseded: GOO-15 auto-creates at `appDataDir` with a simple welcome screen. No folder picker, no path exposure.

### Import / Export

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

- [ ] **GOO-41** Obsidian workspace import — onboarding UI _(Medium)_
      UX wrapper around GOO-48. Flow: folder picker → scan preview ("Found 47 pages in 6 folders") → confirm → background import with progress → success summary. `.obsidian/` config dir ignored.

- [ ] **GOO-74** Extended export formats _(Low)_
  - **JSON backup** — full-fidelity workspace snapshot (pages, folders, time blocks). Schema version field required.
  - **CSV** — flat task list: title, status, priority, due date, tags, folder.
  - **HTML** — rendered pages as standalone `.html` files.
  - **ICS/iCal** — export all scheduled pages as calendar events. Import into Apple Calendar / Google Calendar.

- [ ] **GOO-75** Third-party app import _(Low)_
      Import from: Todoist (JSON backup), TickTick (CSV), Things 3 (TaskPaper), Evernote (ENEX), OPML.
      Each importer: pure function `(rawInput) => ImportResult` in `packages/core/src/importers/`. No Tauri deps. File reading handled by Tauri command layer above. Wizard UI with preview + progress.

---

## Phase 3 — Search & Performance

- [ ] **GOO-17** Command palette _(High)_
      `Cmd+P` → fuzzy page title search. `Cmd+P` twice (chord) → content search mode. `Cmd+K` → actions (new page, switch workspace, settings). Recent pages section.
      Title search: client-side fuzzy via `fuse.js` against `pages[]` in WorkspaceContext (immediate, no DB round-trip). Content search: FTS5 via `search_pages` Tauri command (debounced). See `features/search.md`.

- [ ] **GOO-62** Undo/redo _(High)_
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

- [ ] **GOO-18** FTS5 content search _(High)_
      FTS5 virtual table on `pages.content` + `pages.title` + `pages.tags`. Tauri command `search_pages(query)`. Updates on save. Highlighted excerpt snippets via FTS5 `snippet()`.

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

## Phase 4 — Calendar

- [ ] **GOO-21** Custom day/weekly calendar view _(High)_
      **v1: day view only.** Custom renderer with `date-fns`, no off-the-shelf calendar library.
  ```
  CalendarView
  ├── CalendarHeader (prev/next/today, [ / ] shortcuts)
  ├── TimeGutter (hour labels: 6am–11pm)
  ├── DayColumn
  │   ├── HourCells (drop targets, 15min increments)
  │   ├── PageBlocks (absolute position by time %)
  │   └── NowIndicator (current time red line, auto-scrolls on mount)
  ```
  Block click → `setActivePage()`. Resize bottom edge → update `scheduledEnd`. Toggle calendar/editor: `Cmd+Shift+C`. Jump to today: `t`.

- [ ] **GOO-39** Drag page → calendar to schedule _(High)_
      `@dnd-kit/core`. Drag handle on `PageListItem` hover. Drop → `createPageSchedule({ scheduledStart, scheduledEnd })`. 15min snap.

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

## Phase 5 — Power Features

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

- [ ] **GOO-58** Network activity monitor _(Medium)_
  Transparent log of every outbound request (CalDAV, AI, plugins, updater). Rust `NetworkLogger` wrapping all `reqwest` calls — logs host, bytes, status, duration. Never logs full URLs, bodies, or credentials.

  **UI**: pulsing dot in status bar during activity → opens log panel. Full view in Settings > Privacy > Network Activity.

- [ ] **GOO-61** Quick Add smart recommendations _(Medium)_
  History-based inline ghost text (fish shell style) in Quick Add Modal. Every submission saved to `quick_add_history` table. Ranking: `use_count / Math.log2(hoursSinceLastUse + 2)`. `Tab` or `→` to accept. Shown when input ≥ 2 chars and prefix matches history.

- [ ] **GOO-66** Write Pikos pages to external CalDAV calendar _(Medium)_
      Complement of GOO-22. Pages with `scheduled_start` pushed to user's designated CalDAV calendar as VEVENTs. iCal UID = Pikos page UUID. Creating/updating/completing/deleting a page syncs the event. No two-way conflict resolution in v1 — Pikos is always source of truth for events it created.
      Dependencies: GOO-22 (CalDAV infrastructure), GOO-34 (scheduled date picker).

- [ ] **GOO-67** i18n / localization foundation _(Low)_
      `react-i18next` + `i18next`. All user-visible strings behind `t('key')`. Source locale: `en`. Locale files: `packages/core/src/locales/`. NL parser (GOO-19) stays English-only for v1 — Settings note: "Natural language input is English-only for now."

- [ ] **GOO-12** Page parent/child relationships _(Medium)_
      `parentId` stored as DB column (already in schema). Max 3 levels of nesting. Children shown as indented list below parent in pages panel.
      **Open question**: when a parent page is marked `done`, should children auto-complete? Leaning yes (with undo toast) — common in task managers. Decide before implementing status toggle (GOO-33).

- [ ] **GOO-13** `[[wikilink]]` syntax + backlinks _(Medium)_
      Typing `[[` → autocomplete popup with matching page titles. Click wikilink → navigate to page. Backlinks panel shows inbound links. Extracted links stored in `page.links[]` JSON column.

---

## Phase 6 — Shipping & Growth

_See `.agent/GTM.md` for full strategy._

- [ ] **GOO-51** App branding _(Medium)_
      Icon, wordmark, color palette. Needed before any public presence. Tauri uses `apps/desktop/src-tauri/icons/` — multiple sizes required (32×32 to 512×512 + `.icns` for macOS).

- [ ] **GOO-52** Cross-platform builds + signing + GitHub Releases pipeline _(High — shipping blocker)_
      Required before sharing with anyone. `release.yml` triggered on `git tag v*`. Matrix: macOS (notarized via Apple Developer Program, `tauri-apps/tauri-action`), Windows (SmartScreen warning OK for Phase 2 beta), Linux (AppImage + deb, no signing needed).

- [ ] **GOO-50** Auto-updater _(Medium — shipping blocker)_
      `tauri-plugin-updater`. Check on launch → non-blocking banner ("Version X.X available — restart to update") → download + install + relaunch. Update server: GitHub Releases. Wire in before first external release.

- [ ] **GOO-53** Marketing site _(Medium — Phase 3 blocker)_
      Astro in `apps/marketing/`. Two pages: `/` (general audience, approachable, no technical jargon) + `/open` (architecture, local-first philosophy). Analytics: Plausible (privacy-aligned). See `BACKLOG.md` for full spec.

- [ ] **GOO-68** Page sharing — read-only public links _(Medium)_
      "Share page" → upload rendered HTML to Pikos sharing service → short URL. "Unshare" revokes + deletes server copy. Shared pages are static at time of sharing. Requires server infra (Cloudflare Worker + R2). Dependencies: GOO-52 (shipping), GOO-65 (per-page export).

- [ ] **GOO-54** Privacy policy _(Low — Phase 3 blocker)_
      Plain language, one page at `/privacy`. Cover: what stays on device (everything), what leaves only with opt-in, what is never collected (note content), how to export.

---

## Design decisions (not yet ticketed)

- [ ] **GOO-77** Subtitle field on pages _(Low)_
      Add `subtitle TEXT` column to `pages`. One-sentence summary shown in `PageListItem` (line 2, muted, truncated) and `PageBlock` in calendar (below title). Single-line input in metadata header — newlines blocked. Include in FTS. AI summarization is v2.
      **Schema**: `subtitle TEXT` in `pages`, updated FTS triggers.
      **Dependencies**: GOO-29 (done), GOO-32 (metadata header).

- [ ] **GOO-98** Nested folders _(Low)_
      **Decision needed before implementing folder CRUD.** Options:
      - **Flat only (v1)**: simplest, avoids tree complexity in sidebar + queries. Folders = namespaces.
      - **Nested (advanced setting, off by default)**: sidebar becomes a tree, `parent_folder_id` column needed (not in current schema). Max depth TBD (2–3 levels recommended). Off by default keeps the UI approachable.
      Leaning: **off by default, enable in Settings > General**. If nested is enabled, folder picker (GOO-94 Move to folder) becomes a tree picker. FTS and page list queries unaffected (filter by `folder_id` only — no recursive walk needed for listing). Schema: add `parent_folder_id TEXT REFERENCES folders(id)` migration.

- [ ] **GOO-78** Focus Timer built-in plugin _(Medium)_
      Sidebar panel: large timer display, Start/Stop button, optional "Attach to page" (defaults to active page). Session log: date, duration, page title link, trash icon. Daily total at top.
      Auto-discard: sessions <10s auto-removed. Sessions 10s–60s show inline "Remove?" prompt. Sessions >60s go directly to log.
      **Data**: `focus_sessions(id, page_id?, started_at, ended_at, duration_s)` (already in schema).
      **Dependencies**: GOO-29 (done), GOO-56 (plugin system), though can ship as a non-plugin panel first.

---

## Deferred — do not start

- [-] **GOO-25** Cross-platform sync — not until shipped to real users. Options: ElectricSQL, PowerSync, cr-sqlite. When implementing: re-evaluate TanStack Query as async state layer.
- [-] **GOO-46** Telemetry: PostHog + Sentry — not until real users. Two separate opt-ins, both off by default.
- [-] **GOO-47** Mobile: React Native placeholder — after desktop is solid. Create 3 divergent mobile UI variants for review before any migration.
- [-] **GOO-71** Mobile: Home Screen widget — after GOO-47. iOS WidgetKit, Android Glance.
- [-] **GOO-72** Mobile: Siri / system reminders integration — after GOO-47. `INAddTasksIntent` (iOS), Google Assistant intents (Android).
- [-] **GOO-69** Public REST API (CRUD) — requires server infra, after GOO-25 (sync).
- [-] **GOO-70** Automation integrations — webhooks, n8n, Zapier — after GOO-69.
- [-] **GOO-73** Collaboration — shared workspaces — far future, requires server + CRDT (cr-sqlite).
- [-] **GOO-56** Plugin system foundation — post Phase 4. See `features/extensibility.md`.
- [-] **GOO-57** AI agent / personal assistant — post GOO-56. See `features/extensibility.md`.
- [-] **GOO-63** Conversational / voice mode — post GOO-57. whisper.cpp sidecar + AVSpeechSynthesizer.
- [-] **GOO-82** Messaging bot platform (shared foundation) — post GOO-57.
- [-] **GOO-83** Telegram bot — post GOO-82.
- [-] **GOO-84** Discord bot — post GOO-82.
- [-] **GOO-85** WhatsApp / Signal integration — post GOO-84, approach TBD.
- [-] **GOO-86** Proactive notifications via messaging — post GOO-83.
- [-] **GOO-6** Component library repo — absorbed into `packages/ui` in monorepo.
