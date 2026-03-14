# Pikos — Agent Instructions

## Starting a task

1. Read `.agent/CURRENT.md`
2. Mark the task `[~]` in `BACKLOG_ACTIVE.md`
3. If the task spec references a `features/*.md` file, read it before writing any code
4. Check `.agent/skills/<type>/SKILL.md` before scaffolding anything
5. Decisions are settled — see `.agent/decisions.md` when context is needed

## Post-task checks (mandatory — run after every task before marking done)

```
pnpm check   # typecheck + lint + prettier + depcruise — all in parallel
# To fix formatting: pnpm exec prettier --write <file>
```

## End-of-session cleanup (mandatory)

1. Remove completed task from `BACKLOG_ACTIVE.md`
2. Update `CURRENT.md` active task to the next pending item
3. Collapse completed phase history in `CURRENT.md` to a single summary line
4. Keep `CURRENT.md` under 20 lines

## Other rules

- **Never load `BACKLOG.md` whole** — grep/search by GOO number when needed
- Use `.agent/BACKLOG_ACTIVE.md` for next-up items (next ~20 actionable tasks)

## Quality bar

Pikos competes with NotePlan, Obsidian, TickTick, and Linear. It wins by being the only app that combines notes, tasks, and calendar — local-first, no account required, and fast enough to feel native.

Every decision must hold to three standards:

- **Performance**: Every interaction must feel instant. No sluggish renders, no unnecessary re-renders, no bundle bloat. If it's slow, it's not done.
- **Security**: Data never leaves the device without explicit user action. No telemetry, no hidden network calls, no unsafe data handling. User trust is the product.
- **Approachability**: A non-technical user should be able to create a task, write a note, and schedule it without reading docs. Power features exist but are never in the way.

## Stack

Tauri 2 + React 19 + TypeScript (strict) + SQLite + Tiptap + shadcn/ui + Tailwind v4
Monorepo: `apps/desktop/`, `packages/core/`, `packages/ui/`
Package manager: pnpm (never npm/yarn)
