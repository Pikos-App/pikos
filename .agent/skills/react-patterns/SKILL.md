---
name: react-patterns
description: React coding conventions and architectural patterns for the Pikos codebase. Reference when writing components, hooks, context providers, or wiring storage. Covers WorkspaceContext, UIContext, StorageAdapter injection, React Compiler rules, and file naming.
compatibility: React 19, babel-plugin-react-compiler, TypeScript strict mode, Tailwind v4
---

# React Patterns for This Codebase

## State management principles

### Derive, don't sync

If a value can be calculated from existing state or props, compute it during render — do not store it in state. Redundant state leads to sync bugs.

```typescript
// ❌ Redundant state + sync bug waiting to happen
const [pages, setPages] = useState<Page[]>([])
const [filteredPages, setFilteredPages] = useState<Page[]>([])
useEffect(() => {
  setFilteredPages(pages.filter(p => !p.archived))
}, [pages])

// ✅ Derived during render — always in sync
const [pages, setPages] = useState<Page[]>([])
const filteredPages = pages.filter(p => !p.archived)
```

This applies to counts, filtered lists, formatted strings, boolean flags, and anything else computable from source state. If you're writing `useEffect` + `setState` to keep two values in sync, you almost certainly want a derived value instead.

### When useEffect is appropriate

Effects are for synchronizing with external systems — not for reacting to state changes. Valid uses in this codebase:

- Syncing Tiptap editor state with the storage adapter
- Subscribing to Tauri event listeners (`listen()` / `unlisten()`)
- Setting up keyboard shortcuts or DOM event listeners
- Initializing SQLite connections on mount

Invalid uses (refactor these if you find them):

- Updating state B when state A changes → derive B from A
- Resetting form state when a prop changes → use a `key` prop
- Running logic in response to a user action → put it in the event handler
- Fetching data when state changes → compute in the handler that changed state, or use a derived value

### Reset state via key, not effects

When a component needs to fully reset because a prop changed (e.g., switching between pages in the editor), use React's `key` mechanism:

```typescript
// ❌ Effect-based reset — causes double render
useEffect(() => { setContent(''); setTitle(''); }, [pageId])

// ✅ Key-based reset — React unmounts and remounts cleanly
<PageEditor key={pageId} page={page} />
```

## WorkspaceContext — data state

```typescript
// apps/desktop/src/shared/context/WorkspaceContext.tsx
interface WorkspaceContextValue {
  pages: Page[]
  folders: Folder[]
  createPage: (input: CreatePageInput) => Promise<Page>
  updatePage: (id: string, update: PageUpdate) => void  // debounced 800ms
  deletePage: (id: string) => Promise<void>
  // ... etc
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const adapter = useStorageAdapter()
  const [pages, setPages] = useState<Page[]>([])
  // ...
  return <WorkspaceContext.Provider value={...}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider')
  return ctx
}
```

## UIContext — UI-only state

No Zustand. UIContext handles modals, sidebar state, and other transient UI.
Modals that manage their own internal state use local component state.

```typescript
// apps/desktop/src/shared/context/UIContext.tsx
type ModalType = 'command-palette'  // extend as needed

interface UIContextValue {
  activeModal: { type: ModalType; props: Record<string, unknown> } | null
  openModal: (type: ModalType, props?: Record<string, unknown>) => void
  closeModal: (type?: ModalType) => void
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void
}
```

## StorageAdapter injection

The adapter is created once inside `WorkspaceProvider` using a lazy state initializer — no separate `StorageContext` needed:

```typescript
// Inside WorkspaceProvider (apps/desktop/src/shared/context/WorkspaceContext.tsx)
const [adapter] = useState<StorageAdapter>(() =>
  import.meta.env.VITE_TEST_MODE === 'true'
    ? new MockStorageAdapter()
    : new TauriSQLiteAdapter()
)
```

`MockStorageAdapter` lives in `packages/core/src/adapters/MockStorageAdapter.ts`.
`TauriSQLiteAdapter` lives in `apps/desktop/src/shared/adapters/TauriSQLiteAdapter.ts` (has Tauri deps — cannot go in packages/core).

## React Compiler rules

`babel-plugin-react-compiler` is enabled in Vite from day 1.

- **Do NOT** manually add `useMemo` / `useCallback` — compiler handles memoization
- Do not use single letter variable names, prefer descriptive names for props, state, and functions
- Follow React rules strictly: no mutation of state/props, no conditional hooks
- If the compiler emits an error, fix the rule violation — never disable the compiler

## TypeScript

All code uses strict mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.

- No `any` — use `unknown` and narrow
- No `@ts-ignore` — fix the type error
- Array access: `arr[0]` returns `T | undefined`, handle both cases
- Optional properties: `{ x?: string }` means `x` can be absent, not `x: string | undefined`

## Component conventions

- Co-locate styles with components using Tailwind classes (no CSS modules)
- Named exports only: `export function MyComponent()` — no default exports
- Props interfaces declared directly above the component: `interface MyComponentProps { ... }`
- No prop drilling more than 2 levels — use context or lift to WorkspaceContext

## Component structure

Two distinct layers — keep them separate:

**UI components** (`src/components/ui/` or `packages/ui/src/`): Pure presentational. Accept props only — no context, no side effects, no business knowledge. Reusable across features. Examples: `Button`, `Badge`, `Popover`. These come from shadcn or are generic primitives.

**Feature components** (`src/features/<name>/components/`): Business-logic consumers. May call `useWorkspace()`, `useUI()`, fire Tauri commands, or own local state. Not reusable across features by design. Examples: `PageListItem`, `FolderRow`, `MetadataHeader`.

Rules:
- Compose UI components inside feature components — never the reverse
- If a feature component is getting complex, extract sub-components into the same feature directory (not `components/ui/`)
- Hooks with business logic live in `src/features/<name>/hooks/` or `src/shared/hooks/` if cross-feature
- Shared non-UI logic (parsers, adapters, type utilities) lives in `packages/core/src/`

## Test coverage

**When to add tests:**

| What | Write tests? | Location |
|---|---|---|
| Pure logic (NL parser, rrule expansion, date math) | Yes — always | `packages/core/src/__tests__/` |
| `MockStorageAdapter` + context integration | Yes — for happy paths + error paths | `packages/core/src/__tests__/` |
| `useAutosave`, `useActivePage`, shared hooks | Yes — if logic is non-trivial | `packages/core/src/__tests__/` |
| shadcn/UI components (`Button`, etc.) | No | — |
| Feature components (render output, snapshots) | No — too fragile | — |
| Critical user flows (create page, editor autosave) | Yes — E2E via Playwright | `apps/desktop/e2e/` |

**What to test:**
- Edge cases in parsers: empty input, ambiguous dates, bounded vs infinite recurrence
- Context mutations: createPage/updatePage/deletePage return correct state
- Error paths in StorageAdapter: rejected promises propagate correctly

**What not to test:**
- Implementation details (internal state shape, private functions)
- UI rendering or CSS classes
- Things that can only fail if React or Tauri itself is broken

## File naming

| Type | Convention | Example |
|------|------------|---------|
| Component | `PascalCase.tsx` | `PageListItem.tsx` |
| Hook | `camelCase.ts` prefixed `use` | `useAutoSave.ts` |
| Utility | `camelCase.ts` | `extractText.ts` |
| Type file | `camelCase.ts` | `page.ts` in `packages/core/src/types/` |

## TypeScript config (tsconfig.json)

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true
  }
}
```