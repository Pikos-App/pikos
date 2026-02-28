---
name: new-feature
description: How to scaffold a new feature module in the Pikos Tauri + React monorepo. Use when adding any new feature to the desktop app — creates the directory structure, wires storage, registers shortcuts, and connects to VaultContext.
compatibility: Claude Code in the Pikos project (apps/desktop, packages/core, packages/ui)
---

# Add a New Feature Module

## Directory Structure

```
apps/desktop/src/features/<feature-name>/
  components/     React components specific to this feature
  hooks/          Custom hooks specific to this feature
  utils/          Pure utility functions (no React)
  index.ts        Public API — only export what other features need
```

Import boundary rules:
- Features import from `src/shared/` freely
- Features **never** import from other features directly — route through shared if needed
- `packages/core/` — types and pure logic only (no React, no Tauri)
- `packages/ui/` — generic shadcn UI wrappers only

## Checklist

1. Create `apps/desktop/src/features/<name>/` with the subdirs above
2. Add domain types to `packages/core/src/types/` if new objects are introduced
3. If storage is needed: add methods to `StorageAdapter` interface first, then implement in `TauriSQLiteAdapter` and `MockStorageAdapter`
4. If a Tauri command is needed: see `../tauri-command/SKILL.md`
5. If a new shadcn component is needed: see `../shadcn-component/SKILL.md`
6. Wire into `VaultContext` if the feature owns shared state
7. Register keyboard shortcuts in `apps/desktop/src/shared/keyboard/actions.ts`
8. Export public API from `apps/desktop/src/features/<name>/index.ts`

## Example — Tags Feature

```
apps/desktop/src/features/tags/
  components/
    TagBadge.tsx
    TagFilter.tsx
  hooks/
    useTags.ts
  index.ts
```

Types: `packages/core/src/types/tag.ts`

StorageAdapter additions:
```typescript
getTags(): Promise<Tag[]>
addTagToPage(pageId: string, tag: string): Promise<void>
removeTagFromPage(pageId: string, tag: string): Promise<void>
```

Rust commands: `get_tags`, `add_tag`, `remove_tag`
