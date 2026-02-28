# Pikos Backlog

Full export from Linear (Goose Labs / GOO), 2026-02-28. Linear is now archived.
Status: `[ ]` pending · `[~]` in progress · `[x]` done · `[-]` superseded/deferred

**App name**: Pikos (update `productName` + `identifier` in `tauri.conf.json` during GOO-26)
**src-tauri location**: `apps/desktop/src-tauri/` — must be sibling of frontend dist; `frontendDist: "../dist"`

---

## Phase 0 — Foundation (blocks everything)

### Tooling — do first, all can run in parallel

- [ ] **GOO-7** Monorepo with Turborepo _(Medium)_

  ```
  pkos/
  ├── apps/
  │   ├── desktop/    # Tauri + React (current src/)
  │   ├── marketing/  # Astro marketing site (GOO-53)
  │   └── mobile/     # RN placeholder — don't build yet
  ├── packages/
  │   ├── core/       # Pure TS: types, parsers, storage interface — ZERO Tauri/React/DOM deps
  │   └── ui/         # shadcn React wrappers, design tokens
  ├── turbo.json
  └── package.json    # pnpm workspaces
  ```

  Tasks: init Turborepo, move app to `apps/desktop/`, create placeholder `apps/mobile/`, extract `packages/core`, configure `turbo.json` build pipeline, verify `tauri dev` still works.

- [ ] **GOO-43** Strict TypeScript _(High)_

  ```json
  {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedSideEffectImports": true
  }
  ```

  One `tsconfig.base.json` at root, extended by each package. Zero `// @ts-ignore` suppressions — fix errors, don't suppress.

- [ ] **GOO-8** Biome JS _(Medium)_
      Replaces ESLint + Prettier. Single `biome.json` at root. `biome check --apply` in pre-commit hook.
      `lefthook.yml` is already committed at repo root. Activate after monorepo setup: `pnpm add -D lefthook && lefthook install`.

- [ ] **GOO-40** shadcn/ui (React) + Tailwind CSS v4 _(High)_
      `npx shadcn@latest init` in `apps/desktop`. Style: `new-york`, base color: `zinc`, CSS variables.
      Tailwind v4: configured via `@theme` directive in CSS (no `tailwind.config.js`). Add `@tailwindcss/typography` for prose/editor content.
      Initial components: `button`, `input`, `textarea`, `dialog`, `popover`, `calendar`, `dropdown-menu`, `separator`, `badge`, `tooltip`, `scroll-area`, `accordion`.
      Dark mode: class-based (`dark:`), stored in localStorage, applied to `<html>`.

- [ ] **GOO-44** React Compiler _(Medium)_
      `babel-plugin-react-compiler` in Vite config from day 1. No manual `useMemo`/`useCallback`/`React.memo` — compiler handles it. Fix rule violations; don't disable the compiler.

- [ ] **GOO-45** Feature-based directory structure + dependency-cruiser _(Medium)_
      `src/features/<name>/{components,hooks,utils}` + `src/shared/`. `dependency-cruiser` in CI enforces: features don't import from other features; `packages/core` has no Tauri/React imports.
      When implementing: add a `depcruise` step to the `quality` job in `.github/workflows/ci.yml`.

- [x] **GOO-5** GitHub Actions CI _(unknown priority)_
      `.github/workflows/ci.yml` committed. Three jobs: `quality` (Biome + tsc) → `test` (Vitest + Playwright) → `build` (turbo build). Playwright report uploaded as artifact on failure.

### React Migration Core

- [ ] **GOO-26** Migrate Svelte → React + TypeScript _(Urgent)_
      Clean replacement, not incremental migration. Port structure, not Svelte idioms.
      **Remove:** `@sveltejs/kit`, `@sveltejs/adapter-static`, `svelte`, `svelte-check`, `@sveltejs/vite-plugin-svelte`, `bits-ui`, `prettier-plugin-svelte`
      **Install:** `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`
      **Files:** replace `vite.config.js` (remove SvelteKit plugin), `src/app.html` → `index.html`, create `src/main.tsx` + `src/App.tsx`, delete `svelte.config.js`, update `tsconfig.json` for React JSX.
      **Acceptance:** `tauri dev` boots with stub three-panel layout. No `.svelte` files in `src/`. Zero TS errors.

- [ ] **GOO-27** Core TypeScript types _(Urgent)_
      Lives in `packages/core/src/types.ts`. No `path` field — IDs are UUIDs. No frontmatter in core.

  ```ts
  export interface Vault {
    name: string;
    dbPath: string;
  }

  export interface Folder {
    id: string;
    name: string;
    parentId: string | null;
    color?: string;
    icon?: string;
    createdAt: string;
    updatedAt: string;
  }

  export type PageStatus = "not_started" | "in_progress" | "done";
  export type PagePriority = 0 | 1 | 2 | 3 | 4; // 0=none 1=urgent 2=high 3=medium 4=low

  export interface Page {
    id: string;
    folderId: string | null;
    title: string;
    content: string;
    status: PageStatus;
    priority: PagePriority;
    tags: string[];
    scheduledStart?: string;
    scheduledEnd?: string;
    completedAt?: string;
    durationMinutes?: number;
    links?: string[];
    parentId?: string | null;
    lastOpenedAt?: string; // updated on open → drives recent pages query
    createdAt: string;
    updatedAt: string;
  }

  export interface Tag {
    name: string;
    pageCount: number;
    pageIds: string[];
  }

  export interface SearchResult {
    id: string;
    title: string;
    excerpt: string; // highlighted snippet with <mark> tags, from FTS5 snippet()
  }

  export interface PageFilter {
    folderId?: string | null;
    status?: PageStatus;
    priority?: PagePriority;
    tags?: string[];
    query?: string;
    scheduledAfter?: string;
    scheduledBefore?: string;
  }
  ```

  Also: `buildFolderTree(folders: Folder[]): FolderNode[]` and `getFolderAncestors(folderId, folders)` in `packages/core/src/page.ts`.
  Add `zod` for runtime validation of Tauri command responses.

- [ ] **GOO-28** StorageAdapter _(High)_
      `packages/core/src/storage.ts` — interface + helper types:

  ```ts
  export type NewPage = Omit<Page, "id" | "createdAt" | "updatedAt">;
  export type PageUpdate = Partial<Omit<Page, "id" | "createdAt" | "updatedAt">>;
  export type NewFolder = Omit<Folder, "id" | "createdAt" | "updatedAt">;
  export type FolderUpdate = Partial<Omit<Folder, "id" | "createdAt" | "updatedAt">>;

  export interface StorageAdapter {
    getPage(id: string): Promise<Page | null>;
    createPage(data: NewPage): Promise<Page>;
    updatePage(id: string, updates: PageUpdate): Promise<Page>;
    deletePage(id: string): Promise<void>;
    listPages(filter?: PageFilter): Promise<Page[]>;
    searchPages(query: string): Promise<SearchResult[]>; // excerpts only, not full pages
    getFolder(id: string): Promise<Folder | null>;
    createFolder(data: NewFolder): Promise<Folder>;
    updateFolder(id: string, updates: FolderUpdate): Promise<Folder>;
    deleteFolder(id: string): Promise<void>;
    listFolders(): Promise<Folder[]>;
  }
  ```

  `TauriSQLiteAdapter` → `apps/desktop/src/shared/adapters/TauriSQLiteAdapter.ts` (calls `invoke()`)
  `MockStorageAdapter` → `packages/core/src/adapters/MockStorageAdapter.ts` (in-memory Maps, used in tests)
  Injection: `VITE_TEST_MODE=true` — adapter created once via lazy `useState` initializer inside `VaultProvider`

- [ ] **GOO-29** Rust SQLite schema + Tauri CRUD commands _(High)_
      See `features/storage.md` for full SQL schema and command signatures.
      `Cargo.toml`: `tauri-plugin-sql = { version = "2", features = ["sqlite"] }`, `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`, `uuid = { version = "1", features = ["v4"] }`
      Schema in `src-tauri/migrations/001_initial.sql`. FTS5 triggers for insert/update/delete.
      Commands in `src-tauri/src/db/pages.rs`, `folders.rs`, `search.rs`.

- [ ] **GOO-30** VaultContext _(High)_
      `apps/desktop/src/shared/context/VaultContext.tsx`

  ```ts
  interface VaultContextValue {
    vault: Vault | null;
    pages: Page[];
    folders: Folder[];
    tags: Tag[];
    activePage: Page | null;
    isLoading: boolean;
    selectVault(): Promise<void>;
    setActivePage(page: Page | null): void;
    createPage(opts: { title?: string; folderId?: string | null }): Promise<Page>;
    updatePage(id: string, patch: PageUpdate): Promise<void>;
    deletePage(id: string): Promise<void>;
    createFolder(opts: { name: string; parentId?: string; color?: string }): Promise<Folder>;
    updateFolder(id: string, updates: FolderUpdate): Promise<void>;
    deleteFolder(id: string): Promise<void>;
  }
  ```

  `selectVault` uses `@tauri-apps/plugin-dialog` folder picker. Persist last vault path via `@tauri-apps/plugin-store`. `updatePage` debounces 800ms. `tags` derived reactively in VaultContext from `pages` array (not stored separately). Adapter created once via lazy `useState(() => new TauriSQLiteAdapter())`.

- [ ] **GOO-31** Port keyboard system to React hooks _(High)_
      Keep `registry.ts` as framework-agnostic singleton. Add:
  - `useKeyboardShortcut(shortcut, handler, opts?)` — registers on mount, unregisters on unmount
  - `useKeyboardListener()` — mounted once in `App.tsx`, attaches global `keydown` listener
  - Chord support: double-tap (e.g. `Cmd+P → Cmd+P`) via 400ms timeout-based detector
  - `Keyboard.list()` returns all registered shortcuts (for a help modal)

### Import / Export / Onboarding

- [ ] **GOO-48** Import: Markdown → SQLite (+ Tiptap JSON conversion) _(Medium)_
      `packages/core/src/import/markdown-import.ts`. Uses `gray-matter`.

  ```ts
  export async function importMarkdownVault(dirPath: string, adapter: StorageAdapter): Promise<ImportResult>;
  // ImportResult: { imported: number; skipped: number; errors: Array<{file, reason}> }
  ```

  Frontmatter field map: `title`→title, `tags`→tags, `status`→status (maps "done"/"complete"→`done`), `priority`→priority, `scheduled`/`date`→scheduledStart, `created`/`createdAt`→createdAt. Unknown fields: ignored.
  Directory hierarchy → folder records (parentId tree). Malformed frontmatter: skip + log, don't crash.

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

- [ ] **GOO-41** Obsidian vault import — onboarding UI _(Medium)_
      UX wrapper around GOO-48. Flow: folder picker → scan preview ("Found 47 pages in 6 folders") → confirm → background import with progress → success summary ("47 imported, 2 skipped") → land in app with content. Wire into first-run experience (GOO-42). `.obsidian/` config dir ignored.

---

## Phase 1 — Editor & Metadata

### Page Editor

- [ ] **GOO-10** Tiptap WYSIWYG editor _(Urgent)_
      Replace CodeMirror. `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`, `@tiptap/extension-placeholder`. **Storage format: Tiptap JSON** (not markdown) — direct `getJSON()`/`setContent()`, no conversion layer. Extract plain text via `extractText()` util for FTS. Markdown only at import/export boundary. Support: headings, bold, italic, strikethrough, code, code block, lists, interactive checkboxes. Note: task list checkboxes are inline doc elements, NOT wired to page `status` field. See `features/editor.md`.

- [ ] **GOO-36** Auto-save + save indicator _(Urgent)_
      800ms debounce after last keystroke. Flush immediately on window blur, app close, and `Mod+W`. Save indicator: subtle icon state change (not a toast). No manual save ever required.

- **New page UX** (no GOO — part of GOO-26/VaultContext)
  `Cmd+N` → instantly creates page with empty title + content, opens it in editor, auto-focuses the title field in `MetadataHeader`. No modal. No "untitled" filename. Page gets a UUID. If a folder is selected, page is created in that folder; otherwise root.

- [ ] **GOO-12** Page parent/child relationships _(Medium)_
      `parentId` stored as DB column. Max 3 levels of nesting. Children shown as indented list below parent in pages panel. `parentId` field in `Page` type (GOO-27 already includes it).

- [ ] **GOO-13** `[[wikilink]]` syntax + backlinks _(Medium)_
      Typing `[[` → autocomplete popup with matching page titles. Click wikilink → navigate to page. Backlinks panel shows inbound links to current page. Extracted links stored in `page.links[]` JSON column.

- [-] **GOO-11** YAML frontmatter metadata layer — **superseded**
  Originally the metadata storage mechanism. Superseded by SQLite columns (GOO-27/29). Import/export (GOO-48/49) handles markdown↔SQLite conversion. Do not implement.

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

---

## Phase 2 — Sidebar, Navigation & App Shell

### Sidebar

- [ ] **GOO-15** Vault selection + persistence _(Urgent)_
      First-launch: welcome screen with "Create New Vault" + "Open Existing Vault". Tauri `dialog.open` folder picker. Config in Tauri app data dir. Remove hardcoded `/Users/alex/Documents/pikos`.

- [ ] **GOO-14** Resizable collapsible three-panel layout _(High)_
      Default: Folders 180px | Pages 280px | Editor flex. Drag handles between panels. Persist widths via Tauri store. Collapse left panel: button + `Cmd+\`. Right panel toggles Editor ↔ Calendar.

- [ ] **GOO-37** Folder CRUD _(High)_
      Create: right-click → "New Folder" or "+" button, inline rename auto-focused. Rename: double-click. Delete: context menu → confirm (warn if pages inside). Color picker in context menu. Nested folders with expand/collapse chevron.

- [ ] **GOO-16** Page completion + DnD reordering _(Medium)_
      Completed pages → strikethrough + muted → collapse into "Completed" accordion at bottom (UI toggle button, no keyboard shortcut — `Cmd+Shift+C` is reserved for calendar toggle). Drag handle for manual reordering (`@dnd-kit/core`). `completedAt` timestamp on done.

- [ ] **GOO-38** Pages list filters _(Medium)_
      Filter bar in Pages panel header. Status (all/active/done/in-progress), Scheduled (all/scheduled/unscheduled/today/this week), Priority (all/urgent/high/any), Tag (multi-select). Persist per session.

- [ ] **GOO-42** First-run + onboarding _(Low)_
      No vault configured: welcome screen (full window). "Create New Vault" → folder picker. "Open Existing Vault" → Obsidian import (GOO-41). Empty state: friendly prompt + keyboard shortcut hints.

### App Shell

- [ ] **GOO-23** Design system: typography, color, dark mode _(High)_
      Dark mode first. Minimal, Linear/Arc/Obsidian inspired. CSS custom properties in `app.css` via `@theme`. System font stack (no custom fonts — keeps bundle lean, looks native). No gradients, minimal shadows.

- [ ] **GOO-24** Native menu bar + window management _(High)_
      macOS menu bar via Tauri menu API. File: New Page, Open/Switch Vault, Export Vault, Close Window. Edit: standard. View: Toggle Sidebar, Toggle Calendar, Focus Mode. `Cmd+W` closes active page (already in Rust).

- [ ] **GOO-50** Auto-updater _(Medium — shipping blocker)_
      `tauri-plugin-updater` (Rust) + JS update check on startup. Flow: check for update on launch → if available, show non-blocking banner ("Version X.X available — restart to update") → user confirms → download + install + relaunch. Update server: GitHub Releases (JSON endpoint Tauri expects). Do not implement until first external release, but wire in before shipping to avoid forcing manual downloads forever.

---

## Phase 3 — Search & Testing

- [ ] **GOO-17** Command palette (upgrade from PageSwitcher) _(High)_
      `Cmd+P` → fuzzy page title search. `Cmd+P` twice (chord) → content search mode. `Cmd+K` → actions (new page, switch vault, settings). NL input pre-fills metadata. Recent pages section. See `features/search.md`.
      Title search: client-side fuzzy via `fuse.js` against `pages[]` in VaultContext (immediate, no DB round-trip). Content search: FTS5 via `search_pages` Tauri command (debounced). Two separate code paths, cleanly split.

- [ ] **GOO-18** FTS5 content search _(High)_
      FTS5 virtual table on `pages.content` + `pages.title` + `pages.tags`. Tauri command `search_pages(query)`. Updates on save (not file watch — supersedes original file-watcher approach). Highlighted excerpt snippets in results.

- [ ] **GOO-9** Testing: Vitest + Playwright _(Medium)_
      `packages/core` → Vitest (pure TS, jsdom, coverage via v8). `apps/desktop` → Playwright (real Chromium, `VITE_TEST_MODE=true` swaps in `MockStorageAdapter`, no Tauri binary in CI). Wire both into `turbo.json` + GOO-5.
      Also install `@testing-library/react` + `@testing-library/user-event` in `apps/desktop` — for component-level Vitest tests (e.g. MetadataHeader renders correct status icon, tag autocomplete filters). Separate concern from Playwright E2E: RTL for unit/component behaviour, Playwright for full user flows.

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

  **Deduplication rule:** connect directly to the calendar source (Fastmail: `https://caldav.fastmail.com/dav/`). Never subscribe via a re-exporting intermediary like TickTick — re-exporters can change UIDs and cause duplicates. One CalDAV account per source.

  **What users can do with external events:**
  - View them as distinct blocks in the day view (separate visual style — muted, no drag handle)
  - **Dismiss**: local-only flag, hides the event from the calendar view. Never writes back to the CalDAV server. Recoverable via Settings > Calendars > "Show dismissed".
  - **"Convert to page"**: creates a Pikos page pre-filled with the event title, time, and description. It might be worth considering that we remove the original event when converting to a page. Tbd.
  - Nothing else — no editing, no rescheduling, no deletion of the external event.

  **SQLite schema** (new tables in `001_initial.sql` or a new migration):

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

---

## Phase 5 — Tags & Natural Language

- [ ] **GOO-20** Tags system _(Medium)_
      Tags stored as JSON array in `pages.tags` column (no join table in v1 — derive counts/lists via `json_each()`). Tags panel in sidebar with page counts. Tag rollup view. Filter by tag in pages list. `#tag` syntax in editor body → sync to tags column on save (Phase 2 of this ticket). See `features/tags.md`.

- [ ] **GOO-19** NL page creation parser _(Medium)_
      `packages/core/src/nlp/`. Parse in command palette input: `@today`, `@tomorrow`, `9pm for 1hr`, `#tag`, `~folder`, `!priority`. Pre-fills page metadata on creation.
      Dependency: `chrono-node` for natural language date parsing. Pure TS, no DOM/Tauri deps — fits in `packages/core`.

---

## Phase 6 — Shipping & Growth
*See `.agent/GTM.md` for full strategy. These are the concrete tasks it generates.*

- [ ] **GOO-51** App branding *(Medium)*
  Icon, wordmark, color palette. Needed before any public presence. The icon appears in macOS Dock, Finder, GitHub, and the marketing site — worth getting right before Phase 2 (friends beta).
  Tauri uses `apps/desktop/src-tauri/icons/` — multiple sizes required (32×32 to 512×512 + `.icns` for macOS).

- [ ] **GOO-52** Cross-platform builds + signing + GitHub Releases pipeline *(High — Phase 2 blocker)*
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
      tags: ['v*']
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
            releaseName: 'Pikos ${{ github.ref_name }}'
            # macOS secrets wired in env
  ```

  - GitHub Release artifact layout Tauri expects for the auto-updater (GOO-50) JSON endpoint — generated automatically by `tauri-action`
  - Test full install flow on a clean machine (or VM) for each platform before shipping

- [ ] **GOO-53** Marketing site *(Medium — Phase 3 blocker)*
  Astro in `apps/marketing/` (monorepo). Deploys to Vercel or Cloudflare Pages.

  **Analytics**: [Plausible](https://plausible.io) — self-hosted (Docker, ~1 hr setup) or cloud ($9/mo). Aligns with privacy positioning: no cookies, no personal data, GDPR-compliant. Add `<script defer data-domain="..." src="https://plausible.io/js/script.js"></script>` to Astro layout. Track: page views, download button clicks, referrer. Nothing else needed.

  Monorepo structure update:
  ```
  apps/
  ├── desktop/     (Tauri + React)
  ├── marketing/   (Astro)
  └── mobile/      (placeholder)
  ```
  Content: one-line pitch, app screenshot(s), download button (links to latest GitHub Release), brief "why I built this", privacy story. No sign-up, no email capture, no analytics beyond basic page views.
  Keep it fast and minimal — the app is the product, not the site.

- [ ] **GOO-54** Privacy policy *(Low — Phase 3 blocker)*
  Plain language, one page. No legal boilerplate walls. Cover:
  - What data stays on device (everything — notes, tasks, calendar)
  - What leaves device only with explicit opt-in (crash reports, usage analytics — GOO-46)
  - What Pikos never collects (note content, always)
  - How to export your data (File → Export Vault)
  Lives at `/privacy` on the marketing site (Astro page).

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
- [-] **GOO-6** Component library repo — absorbed into `packages/ui` in monorepo.
