---
name: tauri-command
description: How to add a Tauri v2 command (Rust backend → TypeScript frontend). Use when adding any operation that requires the Rust backend — database access, file system, OS integrations.
compatibility: Tauri v2, tauri-plugin-sql, @tauri-apps/api/core
---

# Add a Tauri Command (Rust → TypeScript)

## Step 1 — Write the Rust command

```rust
// apps/desktop/src-tauri/src/db/pages.rs (or appropriate module)
#[tauri::command]
pub async fn my_command(
    arg: String,
    state: tauri::State<'_, AppState>,
) -> Result<ReturnType, String> {
    // ...
    Ok(result)
}
```

Rules:
- Return type must be `Result<T, String>` — the `String` error surfaces to JS
- Use `tauri::State` to access shared state (DB connection pool, etc.)
- All structs crossing the boundary must derive `serde::Serialize` + `serde::Deserialize`

## Step 2 — Register in lib.rs

```rust
// apps/desktop/src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    // existing commands...
    my_command,
])
```

## Step 3 — Call from TypeScript

```typescript
import { invoke } from '@tauri-apps/api/core'

const result = await invoke<ReturnType>('my_command', { arg: 'value' })
```

Always import `invoke` from `@tauri-apps/api/core` (Tauri v2 path — not `@tauri-apps/api/tauri`).

## Step 4 — Add to StorageAdapter (if data-related)

If the command is part of CRUD storage, add it to the `StorageAdapter` interface in
`packages/core/src/storage/StorageAdapter.ts`, then implement in both:

- `apps/desktop/src/shared/adapters/TauriSQLiteAdapter.ts` — calls `invoke`
- `packages/core/src/storage/MockStorageAdapter.ts` — in-memory impl for tests

## Tauri v2 Notes

- Plugin: `tauri-plugin-sql` for SQLite
- Import path changed from v1: `@tauri-apps/api/tauri` → `@tauri-apps/api/core`
- State is registered via `.manage()` in `apps/desktop/src-tauri/src/lib.rs`
- Error strings from Rust become rejected Promises in JS
