# @pikos/desktop

The Tauri 2 desktop app. A Rust backend for storage and system integration, and a React + TypeScript frontend.

```bash
pnpm dev:desktop      # from the repository root
```

## Where code goes

- `src/features/`: one folder per feature. Features don't import each other; dependency-cruiser enforces it.
- `src/shared/`: what features share, such as context, hooks, adapters, and the keyboard registry.
- `src-tauri/`: Tauri commands and system integration.

The database and its migrations live in `crates/pikos-db`, which the CLI shares, so they aren't part of this app.

## Rules

- **Storage goes through the `StorageAdapter` from the workspace context.** A component never invokes a DB command or reaches SQLite itself, or test mode can't swap in the in-memory adapter. Other Tauri APIs, like events, windows, and dialogs, may be used directly.
- **Constants shared across features go in `src/shared/constants/`**, never duplicated.

## Testing

```bash
pnpm test              # unit tests (Vitest)
pnpm test:e2e          # end-to-end tests (Playwright, browser mode)
```

Tests run against `MockStorageAdapter`, which is in memory, when `VITE_TEST_MODE=true`.
