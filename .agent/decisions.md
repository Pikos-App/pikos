# Resolved Decisions

Settled architectural and product decisions. Load this file only when you need context on a specific decision — don't load it wholesale.

- **App name**: Pikos (`productName` + `identifier` in `tauri.conf.json`), repo name is pkos.
- **src-tauri location**: `apps/desktop/src-tauri/` (sibling of frontend; `frontendDist: "../dist"`)
- **Package manager**: pnpm (already in tauri.conf.json — delete package-lock.json on migration)
- **Storage**: SQLite as source of truth, no filesystem storage
- **State**: VaultContext + UIContext (no Zustand)
- **Recent pages**: `last_opened_at` column in pages table — persists across restarts
- **New page UX (Cmd+N)**: Quick Add Modal (GOO-60) — small centered modal from anywhere, NL input, live metadata chips (date/priority/folder), Enter to create. No more "instantly create empty page". GOO-19 (NL parser) is a Phase 1 dependency of this, not Phase 5.
- **NL recurrence**: "run m/w/f at 3pm for 45m" creates multiple independent pages — one per day matched. Recurrence window defaults to next occurrence of each day unless a duration/count/through-date is specified.
- **No tabs**: Editor has no tab system, ever. Page list is the navigation mechanism. Opening a page replaces the current editor. J/K/Enter + Cmd+P are the navigation primitives.
- **Split view (GOO-81, low priority)**: Right panel can split into 2 panes (hard limit). L/R or T/B orientation, toggled post-split. `Cmd+Shift+\` toggle. Active pane receives page-list navigation. Calendar ignores split. `UIContext.splitMode + splitPageId`.
- **Task list vs page status**: Tiptap task list = inline checkboxes in document body; page `status` field = separate metadata — these are NOT linked.
- **Auto-save debounce**: 800ms (flush on blur/close/Mod+W)
- **Editor storage format**: Tiptap JSON in SQLite (`content` column). No markdown in the edit loop. `content_text` column holds extracted plain text for FTS. Markdown only at import/export boundary.
- **`tiptap-markdown` not needed** at runtime — drop from dependencies
- **Linear**: archived — `.agent/` is now the source of truth
- **Multi-vault**: Each vault = separate SQLite file. Vault registry stored in `@tauri-apps/plugin-store` as `Vault[]` (JSON). `Vault` type gains `id: string` + `lastOpenedAt: string | null`. No vault_id column inside vault DB — vaults are self-contained.
- **Manual sort order**: `sort_order INTEGER` on both `folders` and `pages`. Assigned `max+1` on create. Batch-updated via `reorder_pages` / `reorder_folders` Tauri commands. `sortOrder` excluded from `NewPage`/`NewFolder`.
- **No nested folders in v1**: `parent_id` column stays in schema (no migration later) but always `NULL`. Not exposed in UI. Flat list like TickTick.
- **Product vision**: One app replacing Obsidian (content) + TickTick (tasks + scheduling). Every page is simultaneously a note and a task. Calendar is the primary scheduling surface.
- **Two modes, one layout**: Three panels always visible. Right panel toggles Editor ↔ Calendar (`Cmd+Shift+C`).
- **Smart views**: Today + Inbox pinned above folders. Today = `page_schedules` rows where date ≤ today AND status ≠ done. Inbox = `folder_id IS NULL`. Both show page count badges. (GOO-79)
- **UIContext**: `activeViewId: 'today' | 'inbox' | folderId`. `rightPanel: 'editor' | 'calendar'`. `sidebarCollapsed: boolean` (persisted to localStorage).
- **Sidebar collapse (GOO-80)**: Binary only — all-open OR both-left-collapsed. `Cmd+\` toggles. `SidebarToggle` always visible. framer-motion spring (stiffness 350, damping 35). J/K/Enter auto-expand if collapsed.
- **Multiple schedule occurrences**: `page_schedules(id, page_id, scheduled_start, scheduled_end, created_at)` table. Drag-to-schedule inserts a row; never overwrites. `pages.scheduled_start/end` = denorm. (GOO-76)
- **Completion model**: Always `pages.status`. Never on `page_schedules` rows. Can complete from page list checkbox OR calendar block hover quick-action (`✓ Done` + `✕ Remove block`).
- **Subtitle**: `subtitle TEXT` on pages. One-sentence summary. Shown in `PageListItem` + `PageBlock`. Included in FTS. (GOO-77)
- **Focus timer**: Built-in plugin (GOO-78). `focus_sessions` core table. Sessions <10s auto-discarded; 10–60s shows "Remove?" prompt.
- **Indexes**: `folder_id+sort_order`, `status`, `scheduled_start`, `priority`, `last_opened_at`, `parent_id`, `completed_at`, `rrule` (partial, WHERE NOT NULL) — see `features/storage.md` for full list.
- **RRule / recurrence**: Two modes: finite ("m/w/f for 2 weeks") → N independent pages, no rrule; infinite ("every monday 1pm") → 1 template page with `rrule TEXT`, calendar expands via `rrule.js`.
- **Quick Add confirmation**: Shows confirmation when `ParseResult.type === 'recurring'` (always) or `type === 'finite' && count >= 3`. Single pages create immediately.
- **Undo/redo**: GOO-62. `CommandHistory` singleton (50-entry ring buffer). App-level undo for metadata + CRUD; Tiptap handles editor-internal undo. `Cmd+Z` / `Cmd+Shift+Z`. Toast with inline "Undo" link.
- **Inbox**: Pages with `folderId = NULL`. Pinned special row at top of sidebar (not a real DB folder). `UIContext.activeViewId = 'inbox'`.
- **New page folder assignment** (priority order): (1) active folder → use it; (2) inbox selected → inbox; (3) no sidebar context → `Settings.defaultFolderId` (defaults to null = inbox).
- **VaultContext / UIContext split**: VaultContext owns data + mutations. UIContext owns navigation state. Kept separate to avoid unnecessary re-renders.
- **Audience**: Broad — anyone wanting private notes + tasks + calendar. Not filtered to technical users. Never expose file paths, SQLite, or vault internals in default UI.
- **Dual landing pages**: `/` (general, approachable) + `/open` (technical, architecture). (GOO-53)
