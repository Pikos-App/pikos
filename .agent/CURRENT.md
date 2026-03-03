# Current Focus

## Active Task

**GOO-7** — Turborepo + pnpm monorepo setup (first task of Phase 0).

### Progress

- [x] Switched package manager from npm to pnpm (v10.30.3)
  - Deleted `node_modules/` + `package-lock.json`, generated `pnpm-lock.yaml`
  - Added `"packageManager": "pnpm@10.30.3"` + `pnpm.onlyBuiltDependencies: ["esbuild"]` to `package.json`
  - Added `.npmrc` with `engine-strict=true`
  - Added `package-lock.json` to `.gitignore`
  - Ran `cargo update` — Rust crates now aligned with npm packages (tauri 2.10.2, tauri-plugin-opener 2.5.3)
  - Deleted `tailwind.config.js` (Flowbite leftover, unused with Tailwind v4)
- [x] Restructure into Turborepo monorepo
  - `apps/desktop/` — all Svelte/Tauri app files moved here, package named `@pikos/desktop`
  - `apps/mobile/` — placeholder
  - `packages/core/` — placeholder (`@pikos/core`)
  - `packages/ui/` — placeholder (`@pikos/ui`)
  - `pnpm-workspace.yaml` created, 5 workspace projects resolved
  - `turbo.json` created with `build`, `dev`, `typecheck`, `lint` tasks
  - Root `package.json` is now lean workspace root (turbo as only devDep)
  - Verified `pnpm tauri dev` works from `apps/desktop/`

**GOO-7 complete.** Next: GOO-26 (remove Svelte, wire React into `apps/desktop/`).

## Repo Audit Summary (2026-03-01)

- Fully Svelte. No React, no monorepo, no Biome, no tests.
- npm + `package-lock.json` — switching to pnpm in GOO-7.
- CI committed but broken (references infra that doesn't exist yet).
- `components.json` is Svelte shadcn — delete in GOO-26.
- Tailwind v4 installed; old `tailwind.config.js` is Flowbite leftover — delete in GOO-26.
- Rust: minimal, serde/serde_json already present.

## Phase 0 Execution Order

1. **GOO-7** Turborepo + pnpm monorepo ✓
2. **GOO-26** Remove Svelte, wire React in `apps/desktop/` ✓
3. **GOO-43** Strict TS base config ✓
4. **GOO-8** Biome + activate lefthook ✓
5. **GOO-44** React Compiler (Vite plugin) ✓
6. **GOO-40** shadcn (React) + Tailwind v4
7. **GOO-45** Feature dirs + dependency-cruiser
8. **GOO-9** Vitest + Playwright
9. **GOO-5** Fix CI

## Resolved Decisions

- **App name**: Pikos (productName + identifier in tauri.conf.json), repo name is pkos.
- **src-tauri location**: `apps/desktop/src-tauri/` (sibling of frontend; `frontendDist: "../dist"`)
- **Package manager**: pnpm (already in tauri.conf.json — delete package-lock.json on migration)
- **Storage**: SQLite as source of truth, no filesystem storage
- **State**: VaultContext + UIContext (no Zustand)
- **Recent pages**: `last_opened_at` column in pages table — persists across restarts
- **New page UX (Cmd+N)**: Quick Add Modal (GOO-60) — small centered modal from anywhere, NL input, live metadata chips (date/priority/folder), Enter to create. No more "instantly create empty page". GOO-19 (NL parser) is a Phase 1 dependency of this, not Phase 5.
- **NL recurrence**: "run m/w/f at 3pm for 45m" creates multiple independent pages — one per day matched. Recurrence window defaults to next occurrence of each day unless a duration/count/through-date is specified.
- **No tabs**: Editor has no tab system, ever. Page list is the navigation mechanism. Opening a page replaces the current editor. J/K/Enter + Cmd+P are the navigation primitives.
- **Split view (GOO-81, low priority)**: Right panel can split into 2 panes (hard limit). L/R or T/B orientation, toggled post-split. `Cmd+Shift+\` toggle. Active pane receives page-list navigation. Calendar ignores split. `UIContext.splitMode + splitPageId`.
- **Task list vs page status**: Tiptap task list = inline checkboxes in document body; page `status` field = separate metadata — these are NOT linked
- **Auto-save debounce**: 800ms (flush on blur/close/Mod+W)
- **Editor storage format**: Tiptap JSON in SQLite (`content` column). No markdown in the edit loop. `content_text` column holds extracted plain text for FTS. Markdown only at import/export boundary.
- **`tiptap-markdown` not needed** at runtime — drop from dependencies
- **Linear**: archived — `.agent/` is now the source of truth
- **Multi-vault**: Each vault = separate SQLite file. Vault registry stored in `@tauri-apps/plugin-store` as `Vault[]` (JSON). `Vault` type gains `id: string` + `lastOpenedAt: string | null`. No vault_id column inside vault DB — vaults are self-contained.
- **Manual sort order**: `sort_order INTEGER` added to both `folders` and `pages`. Assigned `max+1` on create. Batch-updated via `reorder_pages` / `reorder_folders` Tauri commands (full ordered ID list → single transaction). `sortOrder` added to `Folder` and `Page` TS types; excluded from `NewPage`/`NewFolder`.
- **No nested folders in v1**: `parent_id` column stays in `folders` schema (no migration needed later) but is always `NULL` in v1. Not exposed in UI. Product is tasks/calendar-first with a flat list of folders (like TickTick, not Obsidian).
- **Product vision**: One app replacing both Obsidian (content) and TickTick (tasks + scheduling). Every page is simultaneously a note and a task. Calendar is the primary scheduling surface, not an add-on.
- **Two modes, one layout**: Three panels always visible. Right panel toggles Editor ↔ Calendar (`Cmd+Shift+C`). No separate "notes mode" vs "tasks mode" — it's all one coherent interface.
- **Smart views**: Today + Inbox pinned above folders in left panel. Today = `page_schedules` rows where date ≤ today AND status ≠ done. Inbox = `folder_id IS NULL`. Both show page count badges. GOO-79.
- **UIContext updated**: `activeViewId: 'today' | 'inbox' | folderId` replaces `activeFolderId`. Added `rightPanel: 'editor' | 'calendar'`. Added `sidebarCollapsed: boolean` (persisted to localStorage). See BACKLOG GOO-30.
- **Sidebar collapse (GOO-80)**: Binary only — all-open OR both-left-collapsed, no partial. `Cmd+\` toggles. `SidebarToggle` in top-left of right panel header, always visible. framer-motion spring (stiffness 350, damping 35). Navigation shortcuts: `J`/`K` = next/prev page (global, no auto-open), `Enter` = open selected, `Escape` from editor = focus page list, `Cmd+Shift+C` = toggle editor/calendar. J/K/Enter auto-expand sidebar if collapsed.
- **Multiple schedule occurrences**: `page_schedules(id, page_id, scheduled_start, scheduled_end, created_at)` table. Drag-to-schedule inserts a row; never overwrites. `pages.scheduled_start/end` = denorm. `rrule` on pages = infinite virtual recurrence (separate concern). GOO-76.
- **Completion model**: Always `pages.status`. Never on `page_schedules` rows. Can complete from page list checkbox OR calendar block hover quick-action (`✓ Done` + `✕ Remove block`).
- **Subtitle**: `subtitle TEXT` on pages. One-sentence summary. Shown in `PageListItem` (line 2, muted) and `PageBlock` (below title). Single-line input in metadata header. Included in FTS. GOO-77.
- **Focus timer**: Built-in plugin (GOO-78). Sidebar panel with timer, start/stop, optional page association. `focus_sessions` core table. Sessions <10s auto-discarded; 10–60s shows "Remove?" prompt.
- **Product direction**: Tasks + calendar first, notes first-class but secondary. Flat folders = "buckets" for tasks. No nested folders until explicitly prioritized as an advanced feature.
- **Inbox**: Pages with `folderId = NULL` are "inbox" pages — the unfiled default state. Inbox is a pinned special row at the top of the sidebar (not a real folder in the DB). `UIContext.activeViewId = 'inbox'` means inbox is selected.
- **New page folder assignment** (priority order): (1) active folder in sidebar → use it; (2) inbox selected → inbox; (3) no sidebar context (calendar, command palette) → `Settings.defaultFolderId` (defaults to null = inbox). The settings fallback only fires in context-free situations.
- **VaultContext / UIContext split**: VaultContext owns data + mutations (`pages`, `folders`, `createPage`, etc.). UIContext owns navigation state (`activePage`, `activeFolderId`). Kept separate so data mutations don't trigger unnecessary re-renders of navigation-only consumers.
- **Audience**: Broad — anyone who wants private notes + tasks + calendar. NOT filtered to technical users. Default UX targets the general user; power-user depth is progressively disclosed, never required. Never expose file paths, SQLite, or vault internals in the default UI.
- **Dual landing pages**: `/` (general: approachable, no jargon) + `/open` (technical: architecture, SQLite, local-first). Same app, different pitch. Handled in GOO-53.
- **Indexes**: Added for `folder_id+sort_order`, `status`, `scheduled_start`, `priority`, `last_opened_at`, `parent_id`, `completed_at`, `rrule` (partial, WHERE NOT NULL) — see `features/storage.md` for full list.
- **RRule / recurrence**: Two modes: finite ("m/w/f for 2 weeks") → N independent pages with no rrule; infinite ("every monday 1pm") → 1 template page with `rrule TEXT` column, calendar expands dynamically via `rrule.js`. `Page.rrule?: string` added to type and SQL schema.
- **Quick Add confirmation**: GOO-60 shows a confirmation step before writing when `ParseResult.type === 'recurring'` (always) or `type === 'finite' && count >= 3`. Single pages and finite < 3 create immediately.
- **Undo/redo**: GOO-62 in Phase 3. `CommandHistory` singleton (50-entry ring buffer). App-level undo for metadata + CRUD; Tiptap handles editor-internal undo independently. `Cmd+Z` / `Cmd+Shift+Z`. Toast feedback with inline "Undo" link.

## Open Questions

None currently.

## Blockers

None currently.
