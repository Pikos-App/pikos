# Resolved Decisions

Settled architectural and product decisions. Load this file only when you need context on a specific decision — don't load it wholesale.

- **App name**: Pikos (`productName` + `identifier` in `tauri.conf.json`), repo name is pkos.
- **src-tauri location**: `apps/desktop/src-tauri/` (sibling of frontend; `frontendDist: "../dist"`)
- **Package manager**: pnpm (already in tauri.conf.json — delete package-lock.json on migration)
- **Storage**: SQLite as source of truth for structured data. Images/attachments stored on filesystem (see Image uploads below).
- **State**: WorkspaceContext + UIContext (no Zustand)
- **Recent pages**: `last_opened_at` column in pages table — persists across restarts
- **New page UX (Cmd+N)**: Quick Add Modal (GOO-60) — small centered modal from anywhere, NL input, live metadata chips (date/priority/folder), Enter to create. No more "instantly create empty page". GOO-19 (NL parser) is a Phase 1 dependency of this, not Phase 5.
- **NL recurrence**: "run m/w/f at 3pm for 45m" creates multiple independent pages — one per day matched. Recurrence window defaults to next occurrence of each day unless a duration/count/through-date is specified.
- **No tabs**: Editor has no tab system, ever. Page list is the navigation mechanism. Opening a page replaces the current editor. J/K/Enter + Cmd+P are the navigation primitives.
- **Split view (GOO-81, low priority)**: Right panel can split into 2 panes (hard limit). L/R or T/B orientation, toggled post-split. `Cmd+Shift+\` toggle. Active pane receives page-list navigation. Calendar ignores split. `UIContext.splitMode + splitPageId`.
- **Task list vs page status**: Tiptap task list = inline checkboxes in document body; page `status` field = separate metadata — these are NOT linked.
- **Auto-save debounce**: 800ms (flush on blur/close/Mod+W)
- **Editor storage format**: Tiptap JSON in SQLite (`content` column). No markdown in the edit loop. `content_text` column holds extracted plain text for FTS. Markdown only at import/export boundary.
- **`tiptap-markdown` used at runtime** for paste support only (`transformPastedText: true`, `transformCopiedText: false`). Converts pasted markdown → Tiptap JSON. NOT used for import/export or in the edit loop.
- **Linear**: archived — `.agent/` is now the source of truth
- **Multi-workspace**: Each workspace = separate SQLite file. Workspace registry stored in `@tauri-apps/plugin-store` as `Workspace[]` (JSON). `Workspace` type has `id: string` + `lastOpenedAt: string | null`. No workspace_id column inside workspace DB — workspaces are self-contained. UI label: "Workspace". TypeScript type: `Workspace`. Hidden from default UI — most users have one and never see the concept. "Manage Workspaces" only in Settings.
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

- **Tags normalization (GOO-121)**: Tags are normalized to `tags(id, name UNIQUE)` + `page_tags(page_id, tag_id)` join table (migration 003). `pages.tags TEXT` is kept as a denorm JSON cache — FTS5 triggers continue reading it unchanged. `page_tags` is the source of truth; Rust `upsert_page_tags()` helper keeps both in sync on create/update. `search_tags(query)` command supports autocomplete (prefix match, case-insensitive, limit 20). `WorkspaceContext.searchTags()` exposes it to the frontend. Derived `Tag[]` (with pageIds) in WorkspaceContext still comes from in-memory pages array.
- **RRule / recurrence**: Two modes: finite ("m/w/f for 2 weeks") → N independent pages, no rrule; infinite ("every monday 1pm") → 1 template page with `rrule TEXT`, calendar expands via `rrule.js`.
- **Quick Add confirmation**: Shows confirmation when `ParseResult.type === 'recurring'` (always) or `type === 'finite' && count >= 3`. Single pages create immediately.
- **Undo/redo**: GOO-62. `CommandHistory` singleton (50-entry ring buffer). App-level undo for metadata + CRUD; Tiptap handles editor-internal undo. `Cmd+Z` / `Cmd+Shift+Z`. Toast with inline "Undo" link.
- **Inbox**: Pages with `folderId = NULL`. Pinned special row at top of sidebar (not a real DB folder). `UIContext.activeViewId = 'inbox'`.
- **New page folder assignment** (priority order): (1) active folder → use it; (2) inbox selected → inbox; (3) no sidebar context → `Settings.defaultFolderId` (defaults to null = inbox).
- **WorkspaceContext / UIContext split**: WorkspaceContext owns data + mutations. UIContext owns navigation state. Kept separate to avoid unnecessary re-renders.
- **Audience**: Broad — anyone wanting private notes + tasks + calendar. Not filtered to technical users. Never expose file paths, SQLite, or workspace internals in default UI.
- **Dual landing pages**: `/` (general, approachable) + `/open` (technical, architecture). (GOO-53)

- **Image uploads**: Images stored in a sibling `assets/` directory next to the workspace SQLite file (e.g. `~/Library/Application Support/pikos/assets/{uuid}.{ext}`). DB stores the relative path only (e.g. `assets/abc123.png`) — never an absolute path, so the workspace stays portable across machines and backups. Displayed via Tauri's `convertFileSrc()` which serves local files through the `asset://` protocol. Requires `"asset"` protocol listed under `security.assetProtocol.enable = true` and the assets dir added to `security.assetProtocol.scope` in `tauri.conf.json`. Editor integration: custom Tiptap `Image` extension — drop or paste triggers a Tauri `save_asset` command (Rust: copies file into assets dir, returns relative path), then inserts an image node. No BLOBs in SQLite — keeps DB small and reads fast.

- **Workspace auto-create**: On first launch, Pikos silently creates a default workspace DB at `{appDataDir}/default.sqlite` using Tauri's `app_data_dir()` — no file picker, no path exposed to the user. A brief welcome screen ("Welcome to Pikos" + "Get started") is shown once, then never again. On every subsequent launch the workspace with the most recent `lastOpenedAt` is opened automatically; the welcome screen is skipped. Multiple workspaces are a power-user feature accessible only via Settings → "Manage Workspaces". If the DB file is missing at its stored path (e.g. after a failed migration), recreate it at the same path rather than prompting — data loss is better surfaced via a dedicated recovery flow than a confusing file picker on startup.

- **Accessibility standard**: WCAG 2.1 AA. Every interactive element has a descriptive `aria-label` or visible label. Keyboard navigation is first-class — every action reachable without a mouse. Focus rings always visible (never `outline: none` without a replacement). Semantic HTML first; ARIA roles only when native semantics are insufficient. Color contrast minimum 4.5:1 for body text, 3:1 for large text and UI components. All modals trap focus and restore it on close. Screen reader announcements for dynamic content changes (toasts, badge counts, save state) via `aria-live` regions.

- **Monetization model**: Two separate payment lanes — App Store (one-time purchase, iCloud sync included) and direct download (free base, optional relay sync subscription). Mac App Store: $19.99 one-time. iPhone App Store (future): $9.99 one-time. Relay sync: $39.99/yr or $4.99/mo via Paddle/Lemon Squeezy. Self-hosted relay: free. No feature gating on the free tier — local-only is a complete product, not a demo.

- **Sync strategy**: iCloud first (Phase 4a), relay server second (Phase 4b). iCloud works for App Store users AND direct-download Mac users (only requires Apple ID). Relay sync targets cross-platform users (Windows, Android) and is the primary recurring revenue source. The iPhone App Store app is the natural paywall for Apple ecosystem users — iOS has no alternative distribution, so Mac+iPhone iCloud sync implicitly requires purchasing both apps. Don't build relay infrastructure until paying customers justify the operational overhead.

- **App Store pricing structure**: One-time purchase (not subscription) for base apps. Rationale: iCloud sync has no ongoing infra cost to justify a subscription; non-technical users trust "buy once" over recurring charges; relay sync already provides a recurring revenue line. Revisit if App Store subscription economics change significantly.
