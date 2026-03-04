# Pikos — Agent Instructions

## Starting a task

1. Read `.agent/CURRENT.md`
2. Mark the task `[~]` in `BACKLOG_ACTIVE.md`
3. If the task spec references a `features/*.md` file, read it before writing any code
4. Check `.agent/skills/<type>/SKILL.md` before scaffolding anything
5. Decisions are settled — see `.agent/decisions.md` when context is needed

## Post-task checks (mandatory — run after every task before marking done)

```
pnpm typecheck                                                    # turbo tsc --noEmit
pnpm exec turbo lint --force                                      # ESLint (--force busts cache)
pnpm exec prettier --check "apps/desktop/src/**/*.{ts,tsx,css}"  # Prettier check
# To fix: pnpm exec prettier --write <file>
```

## End-of-session cleanup (mandatory)

1. Mark completed task `[x]` then remove it from `BACKLOG_ACTIVE.md`
2. Update `CURRENT.md` active task to the next pending item
3. Collapse completed phase history in `CURRENT.md` to a single summary line
4. Keep `CURRENT.md` under 20 lines

## Other rules

- **Never load `BACKLOG.md` whole** — grep/search by GOO number when needed
- Use `.agent/BACKLOG_ACTIVE.md` for next-up items (next ~20 actionable tasks)

## Stack

Tauri 2 + React 19 + TypeScript (strict) + SQLite + Tiptap + shadcn/ui + Tailwind v4
Monorepo: `apps/desktop/`, `packages/core/`, `packages/ui/`
Package manager: pnpm (never npm/yarn)
