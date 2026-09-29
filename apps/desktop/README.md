# @pikos/desktop

The Tauri 2 desktop application. Rust backend for storage and system integration, React + TypeScript frontend for the UI.

## Development

From the repository root:

```bash
pnpm dev:desktop
```

Or directly:

```bash
cd apps/desktop
pnpm tauri dev
```

## Structure

```
src/                    — React frontend
  features/             — Feature modules (editor, pages, calendar, layout, settings)
  shared/               — Shared context, hooks, components, keyboard registry
  components/ui/        — shadcn/ui components
src-tauri/
  src/                  — Rust backend (Tauri commands, SQLite queries)
```

The SQL schema migrations live one level up, in `crates/pikos-db/migrations/` — the
data layer is shared with the CLI, so it is not part of this app.

## Testing

```bash
pnpm test              # Unit tests (Vitest)
pnpm test:e2e          # E2E tests (Playwright, browser mode)
```

Tests use `MockStorageAdapter` (in-memory) instead of real SQLite, controlled by `VITE_TEST_MODE=true`.
