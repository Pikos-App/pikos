# Pikos — Agent Instructions

- Read `.agent/CURRENT.md` before starting any task
- **Never load `BACKLOG.md` whole** — grep/search by GOO number when needed
- Use `.agent/BACKLOG_ACTIVE.md` for next-up items (next ~20 actionable tasks)
- Check `.agent/skills/<type>/SKILL.md` before scaffolding anything
- Decisions are settled — see `.agent/decisions.md` when context is needed

## Stack

Tauri 2 + React 19 + TypeScript (strict) + SQLite + Tiptap + shadcn/ui + Tailwind v4
Monorepo: `apps/desktop/`, `packages/core/`, `packages/ui/`
Package manager: pnpm (never npm/yarn)
