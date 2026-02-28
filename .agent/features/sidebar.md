# Feature: Sidebar Navigation

## Status
Not started. Depends on: VaultContext (GOO-30), React migration (GOO-26).

## Three-Panel Layout (GOO-14)
```
[Folders 180px] | [Pages 280px] | [Editor OR Calendar — flex]
```
- All panels resizable via drag handles
- Persist widths via Tauri store (`~/.pkos/layout.json` or app data dir)
- Left panel (Folders) collapsible — button + `Cmd+\` shortcut
- Right panel toggles between Editor and Calendar view
- Completed tasks in Pages list collapse into a "Completed" accordion at bottom

## Vault Selection (GOO-15)
- First-launch: welcome screen (full window, no panels) with three options:
  - "Create New Vault" → folder picker → creates `vault.db` in that folder → open app
  - "Open Existing Vault" → folder picker → opens an existing Pikos `vault.db` → open app
  - "Import from Obsidian" → triggers GOO-41 import flow → open app with content
- Vault path stored in Tauri app data dir config (not hardcoded)
- Vault switching: "Switch Vault" in File menu (re-shows welcome screen or folder picker)

## Folder CRUD (GOO-37)
- **Create**: right-click sidebar bg or folder → context menu → "New Folder"
  - OR "+" button in Folders panel header
  - Inline rename field auto-focused on creation
- **Rename**: double-click folder name → inline edit → Enter to confirm
- **Delete**: context menu → confirm dialog (warn if pages inside)
- **Color**: color picker in context menu → updates sidebar indicator dot
- Nested folders supported (show expand/collapse chevron)

## Pages List
- Show pages in selected folder
- **GOO-16** Completion: checkbox per page, completed → strikethrough + muted, collapsed into "Completed" accordion. UI toggle button (no keyboard shortcut — `Cmd+Shift+C` is calendar toggle).
- **GOO-16** Drag-to-reorder: `@dnd-kit/core`, drag handle on hover
- **GOO-38** Filters bar in panel header:
  | Filter | Values |
  |--------|--------|
  | Status | All / Active / Done / In Progress |
  | Scheduled | All / Scheduled / Unscheduled / Today / This Week |
  | Priority | All / Urgent / High / Any |
  | Tag | Multi-select |
  Filters persist per session.

## First-Run Onboarding (GOO-42)
- New vault: empty state with friendly prompt + keyboard shortcut hints
- Obsidian import: progress bar → lands in app with data
