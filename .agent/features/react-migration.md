# Feature: React Migration

## Status
Not started — Svelte codebase exists, React not yet started.

## Goal
**Clean build** — delete `src/` entirely and build fresh. The Svelte prototype was a low-commitment
exploration; nothing in it needs to be preserved or ported. Build the React app from scratch
following the architecture in these docs.

What's worth keeping from the existing repo:
- `src-tauri/` — move to `apps/desktop/src-tauri/`, update config, add Cargo deps
- `src/keyboard/registry.ts` — well-written, copy directly to `apps/desktop/src/shared/keyboard/`
- Everything else — delete

## Monorepo Structure
`src-tauri/` moves into `apps/desktop/` — it must be a sibling of the frontend dist since
`tauri.conf.json` uses relative paths (`frontendDist: "../dist"`). One Tauri app = keep it
co-located with its frontend.

```
pkos/
├── apps/
│   ├── desktop/
│   │   ├── src/           (React frontend)
│   │   ├── src-tauri/     (Rust — moved from repo root)
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   ├── marketing/         (Astro site — GOO-53, add when Phase 3 begins)
│   └── mobile/            (RN placeholder — empty for now)
├── packages/
│   ├── core/              (Pure TS: types, storage interface, import/export)
│   └── ui/                (shadcn React wrappers)
├── turbo.json
└── package.json           (pnpm workspace root)
```

`tauri.conf.json` updates:
- `frontendDist`: `"../dist"` (Vite default output)
- `beforeDevCommand`: `"pnpm dev"` (runs in `apps/desktop/` context)

## Reference: Svelte Prototype → Fresh Build
The Svelte prototype established some useful patterns worth knowing, but none are carried forward directly.

| Concept | Svelte prototype had | Fresh build approach |
|---------|---------------------|---------------------|
| App shell | `src/routes/+page.svelte` | `App.tsx` with `react-resizable-panels` |
| State | Svelte stores | WorkspaceContext + UIContext |
| Storage | Tauri FS plugin (reads .md files) | SQLite via TauriSQLiteAdapter |
| Keyboard | `registry.ts` singleton ✓ | **Copy as-is** to `shared/keyboard/registry.ts`. Note: menu shortcuts (Cmd+N, Cmd+W) move out of the registry and into Tauri menu event listeners when GOO-24 is built. |
| Modal state | `uiStore.ts` writable | UIContext |
| Recent pages | In-memory store | `last_opened_at` DB column |
| Editor | CodeMirror | Tiptap (JSON storage) |
| UI components | bits-ui (Svelte shadcn) | shadcn/ui (React) |
| Seed script | Creates .md files | Seed SQLite DB directly |

## Target Directory Structure (apps/desktop/src/)
```
App.tsx
main.tsx
features/
  editor/
    components/   EditorPane.tsx, MetadataHeader.tsx
    hooks/        useAutoSave.ts
  pages/
    components/   PageList.tsx, PageListItem.tsx
    hooks/        usePages.ts
  folders/
    components/   FolderTree.tsx
  search/
    components/   CommandPalette.tsx
shared/
  context/        WorkspaceContext.tsx, UIContext.tsx
  keyboard/       registry.ts, actions.ts, useKeyboard.ts
  hooks/          useStorageAdapter.ts
  adapters/       TauriSQLiteAdapter.ts   ← Tauri-specific, NOT in packages/core
styles/
  global.css
```

## Packages to Remove
```
@sveltejs/kit @sveltejs/adapter-static svelte svelte-check
@sveltejs/vite-plugin-svelte bits-ui prettier prettier-plugin-svelte
@lucide/svelte
@codemirror/commands @codemirror/lang-markdown @codemirror/language
@codemirror/state @codemirror/view @lezer/highlight @lezer/markdown
```

## Packages to Add
```
# Core React
react react-dom @types/react @types/react-dom @vitejs/plugin-react

# Icons
lucide-react

# Layout + animation
react-resizable-panels
framer-motion        # spring physics, layout animations, gesture-driven interactions

# Command palette + search
cmdk
fuse.js              # client-side fuzzy title search in command palette

# Calendar
date-fns

# Tiptap (added during editor feature, not in base migration)
@tiptap/react @tiptap/starter-kit @tiptap/extension-task-list
@tiptap/extension-task-item @tiptap/extension-placeholder
# Note: tiptap-markdown NOT needed — storage is Tiptap JSON, not markdown

# Tauri plugins (add as needed)
@tauri-apps/plugin-dialog    # workspace folder picker (GOO-15)
@tauri-apps/plugin-store     # layout + workspace config persistence (GOO-14)
@tauri-apps/plugin-sql       # (via Rust Cargo.toml, JS types come with it)
@tauri-apps/plugin-updater   # auto-updates (GOO-50) — add before first external release

# Import/Export
gray-matter

# NL date parsing (packages/core dep, added during GOO-19)
chrono-node

# Testing (devDependencies, added during GOO-9)
@testing-library/react @testing-library/user-event
```

## Key Decisions
- **No Zustand** — WorkspaceContext (React context) for data state, UIContext for UI state
- **No filesystem as storage** — StorageAdapter always goes through SQLite (or Mock in tests)
- **`TauriSQLiteAdapter` lives in `apps/desktop/`**, not `packages/core` — it has Tauri deps
- **`packages/core` is pure TS** — zero Tauri/React/DOM imports (must be shareable with mobile)
- **shadcn CLI**: `npx shadcn@latest add <component>`
- **React Compiler**: `babel-plugin-react-compiler` in Vite from day 1
- **pnpm** is the package manager (already set in `tauri.conf.json`)
- **App name**: Pikos — update `productName` and `identifier` in `tauri.conf.json`

## Migration Order
1. Monorepo scaffold (Turborepo + pnpm workspaces, move `src-tauri/` to `apps/desktop/`)
2. Strict TS config
3. Vite + React entry (delete `svelte.config.js`, update `vite.config.ts`)
4. `packages/core/src/types.ts` — Page, Folder, Workspace, Tag, PageFilter
5. `StorageAdapter` interface + `MockStorageAdapter`
6. `TauriSQLiteAdapter` + Rust commands (pairs with GOO-29)
7. `WorkspaceContext` + `UIContext`
8. App shell: three-panel stub layout (static, no data)
9. Keyboard registry → `useKeyboard` hook
10. Pages list wired to WorkspaceContext
11. Folders wired to WorkspaceContext
12. Command palette (replaces PageSwitcher)
13. Tiptap editor (separate feature — GOO-10)
