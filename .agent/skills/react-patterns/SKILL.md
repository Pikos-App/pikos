---
name: react-patterns
description: React coding conventions and architectural patterns for the Pikos codebase. Reference when writing components, hooks, context providers, or wiring storage. Covers WorkspaceContext, UIContext, StorageAdapter injection, React Compiler rules, and file naming.
compatibility: React 19, babel-plugin-react-compiler, TypeScript strict mode, Tailwind v4
---

# React Patterns for This Codebase

## WorkspaceContext — data state

```typescript
// apps/desktop/src/shared/context/WorkspaceContext.tsx
interface WorkspaceContextValue {
  pages: Page[]
  folders: Folder[]
  activePage: Page | null
  setActivePage: (page: Page | null) => void
  createPage: (input: CreatePageInput) => Promise<Page>
  updatePage: (id: string, update: PageUpdate) => Promise<void>
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
