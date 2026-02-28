# Current Focus

## Active Task

None. Pick next item from BACKLOG.md — start with Phase 0 Tooling.

## Resolved Decisions

- **App name**: Pikos (productName + identifier in tauri.conf.json)
- **src-tauri location**: `apps/desktop/src-tauri/` (sibling of frontend; `frontendDist: "../dist"`)
- **Package manager**: pnpm (already in tauri.conf.json — delete package-lock.json on migration)
- **Storage**: SQLite as source of truth, no filesystem storage
- **State**: VaultContext + UIContext (no Zustand)
- **Recent pages**: `last_opened_at` column in pages table — persists across restarts
- **New page UX (Cmd+N)**: auto-create with UUID, open editor immediately, auto-focus title field
- **Task list vs page status**: Tiptap task list = inline checkboxes in document body; page `status` field = separate metadata — these are NOT linked
- **Auto-save debounce**: 800ms (flush on blur/close/Mod+W)
- **Editor storage format**: Tiptap JSON in SQLite (`content` column). No markdown in the edit loop. `content_text` column holds extracted plain text for FTS. Markdown only at import/export boundary.
- **`tiptap-markdown` not needed** at runtime — drop from dependencies
- **Linear**: archived — `.agent/` is now the source of truth

## Open Questions

None currently.

## Blockers

None currently.
