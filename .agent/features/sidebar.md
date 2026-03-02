# Feature: Sidebar Navigation

## Status
Not started. Depends on: VaultContext (GOO-30), React migration (GOO-26).

## Three-Panel Layout (GOO-14)
```
[Folders 180px] | [Pages 280px] | [Editor OR Calendar — flex]
```
- All panels resizable via drag handles
- Persist widths via Tauri store
- Left panel (Folders) collapsible — button + `Cmd+\` shortcut
- Right panel toggles between Editor and Calendar view

## Vault Selection (GOO-15)
- First-launch: welcome screen (full window, no panels) with three options:
  - "Create New Vault" → folder picker → creates `pikos.db` in that folder → open app
  - "Open Existing Vault" → folder picker → opens an existing Pikos `pikos.db` → open app
  - "Import from Obsidian" → triggers GOO-41 import flow → open app with content
- Vault list stored in `@tauri-apps/plugin-store` (see multi-vault design in `features/storage.md`)

## Inbox

The Inbox is the default landing zone for new pages. It is not a real folder — it is the unfiled
state: pages where `folderId IS NULL` in the database.

```
┌─────────────────────────┐
│ ⬇ Inbox           (3)  │  ← always pinned at top; badge = count of unfiled pages
├─────────────────────────┤
│ ● Work                  │
│ ● Personal              │
│ ● Projects              │
└─────────────────────────┘
```

- Pinned at top of the folders panel — cannot be deleted, renamed, or reordered
- Distinct icon (inbox/tray, not a folder icon) to signal it's a special concept
- Badge shows count of unfiled pages; hidden when inbox is empty
- Selectable like any folder: click → pages panel shows `WHERE folder_id IS NULL`
- "Capture fast, organize later" — the inbox is deliberately frictionless

**UIContext tracks `activeFolderId: string | null`** where `null` = inbox is selected.

## Folder CRUD (GOO-37)

v1: **flat list only** — no nesting. `parent_id` stays in the schema for future use but is never
populated. Folders are "buckets" — a flat, ordered list of named lists.

- **Create**: right-click sidebar background or "+" button in panel header →
  inline rename field auto-focused on creation
- **Rename**: double-click folder name → inline edit → Enter to confirm, Esc to cancel
- **Delete**: right-click → confirm dialog (warn if folder has pages — offer to move to inbox first)
- **Color**: color picker in right-click context menu → updates the folder's indicator dot
- **Reorder**: drag-and-drop via `@dnd-kit/core`, calls `reorderFolders(orderedIds[])`

## New Page UX (GOO-60)

`Cmd+N` from anywhere → opens the Quick Add Modal. This is the single, consistent entry point
for new page creation regardless of where in the app you are.

The modal defaults its folder chip to `UIContext.activeFolderId`. Folder priority:
1. Active folder in sidebar → chip pre-set to that folder
2. Inbox selected → chip shows "Inbox"
3. No folder context (e.g. triggered from calendar view) → `Settings.defaultFolderId`

See GOO-60 in BACKLOG.md for full modal spec and NL syntax.

## Pages List

Shows pages in the selected folder (or inbox). Controlled by `UIContext.activeFolderId`.

- **GOO-16** Completion: completed pages → strikethrough + muted → collapsed into
  "Completed" accordion at bottom. UI toggle button.
- **GOO-16** Drag-to-reorder: `@dnd-kit/core`, drag handle on hover, calls `reorderPages(folderId, orderedIds[])`
- **GOO-38** Filters bar in panel header:
  | Filter | Values |
  |--------|--------|
  | Status | All / Active / Done / In Progress |
  | Scheduled | All / Scheduled / Unscheduled / Today / This Week |
  | Priority | All / Urgent / High / Any |
  | Tag | Multi-select |
  Filters persist per session.

## First-Run Onboarding (GOO-42)
- New vault: empty state — inbox shown, friendly prompt + keyboard shortcut hints
- Obsidian import: progress bar → lands in app with content in inbox (unfiled) or folders
  (if import preserved directory structure as folders)
