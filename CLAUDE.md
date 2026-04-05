# Pikos — Agent Instructions

## Communication Style

Be direct and blunt. Skip encouragement, affirmations, and filler phrases. Don't say things like "Great question!", "Absolutely!", "Nice work!", or "Good catch!" — just move on to the next point.
Don't sugarcoat feedback. If something is wrong or unlikely to work, say so plainly. If an approach is flawed, state the flaw first, then alternatives — don't bury critical information after a paragraph of context.
Base all assessments on facts and realistic probabilities, not optimism. Don't say "this should work" when the reality is "this might work if three assumptions hold." State the assumptions explicitly.
Never pad responses with unnecessary caveats, hedging, or qualifications unless genuine uncertainty exists. When uncertain, quantify the uncertainty rather than hiding it behind vague language.

## Starting a task

1. Read `.agent/CURRENT.md`
2. If the task spec references a `features/*.md` file, read it before writing any code
3. Read `.agent/skills/<type>/SKILL.md` and follow its patterns exactly. Do not deviate from established conventions without explicit approval. Known types: `component`, `hook`, `store`, `service`.
4. If no skill file exists for the component type, say so before proceeding.
5. If a task spec is unclear or contradictory, stop and ask before implementing assumptions.
6. Decisions are settled — see `.agent/decisions.md` when context is needed

## Post-task checks (mandatory — run after every task before marking done)

```
pnpm verify   # runs check (auto-fix + typecheck + lint + depcruise) then unit tests
```

## End-of-session cleanup (mandatory)

1. Remove completed task from `BACKLOG_ACTIVE.md`
2. Update `CURRENT.md` active task to the next pending item
3. Collapse completed phase history in `CURRENT.md` to a single summary line
4. Keep `CURRENT.md` under 20 lines

## Other rules

- Use `.agent/BACKLOG_ACTIVE.md` for next-up items (next ~20 actionable tasks)

## Quality bar

Pikos competes with NotePlan, Obsidian, TickTick, and Linear. It wins by being the only app that combines notes, tasks, and calendar — local-first, no account required, and fast enough to feel native.

Every decision must hold to three standards:

- **Performance**: Every interaction must feel instant. No component should re-render more than once per user interaction. No lazy-loaded route should exceed 50KB. No sluggish renders, no bundle bloat. If it's slow, it's not done.
- **Security**: Data never leaves the device without explicit user action. No telemetry, no hidden network calls, no unsafe data handling. User trust is the product.
- **Approachability**: A non-technical user should be able to create a task, write a note, and schedule it without reading docs. Power features exist but are never in the way. Default UI paths should require zero configuration.

## Testing

Write tests for non-trivial logic: stores, hooks, utilities, and any function with branching paths. Use Vitest. Place test files adjacent to source files as `<name>.test.ts(x)`. Don't write tests for simple pass-through components or pure layout.

## Stack

Tauri 2 + React 19 + React Compiler + TypeScript (strict) + SQLite + Tiptap + shadcn/ui + Tailwind v4
Monorepo: `apps/desktop/`, `apps/marketing/`, `apps/mobile/`, `packages/core/`, `packages/ui/`
Package manager: pnpm (never npm/yarn)

## React rules

- React Compiler is enabled. NEVER use useMemo, useCallback, or React.memo — the compiler handles memoization automatically.
- NEVER call setState inside useEffect. If state is derived from props or other state, compute it during render. This is the React-recommended pattern for derived state.
- NEVER use useEffect for synchronizing state with props. Use a key to reset component state or compute values inline during render.
- Prefer controlled components over refs for form state.

## Testing rules

- Test user-visible behavior, not implementation details.
- Use accessible selectors: getByRole, getByText, getByPlaceholder. Use getByTestId only as a last resort. Never select by CSS class or DOM structure.
- Vitest: test inputs → outputs. Mock boundaries (storage adapters, Tauri IPC), not internal functions.

## Code style

- Prefer early returns over deeply nested conditionals.
- Keep components under 200 lines. Extract hooks or subcomponents when approaching this.
- Use TypeScript discriminated unions over boolean flags for state that has more than two modes.
- NEVER use raw Date methods (setHours, setDate, getFullYear, manual arithmetic). Always use `date-fns` — `addDays`, `set`, `format`, `endOfDay`, etc. The only exception is `new Date()` for "now".
- Always use Lucide icons (`lucide-react`). Never hand-roll SVGs.
- One component per file. If two components share logic, extract a hook or utility.
- Shared constants (like priority labels) go in `src/shared/constants/`, not duplicated across files.

## Tauri

- Desktop app uses MockStorageAdapter in test mode (VITE_TEST_MODE=true) and TauriSQLiteAdapter in production. Never import Tauri APIs directly in components — go through the adapter.
