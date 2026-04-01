# @pikos/core

Shared TypeScript library used by the desktop app (and eventually mobile). Contains types, utilities, and the storage adapter interface. No framework dependencies — safe to import anywhere.

## What's in here

- **Types** — `Page`, `Folder`, `Workspace`, `PageStatus`, `PagePriority`, and related interfaces
- **Storage adapter interface** — `StorageAdapter` defines the contract for data access. `TauriSQLiteAdapter` (production) and `MockStorageAdapter` (tests) both implement it.
- **Utilities** — Text extraction from ProseMirror JSON, date helpers, ID generation

## Usage

```typescript
import type { Page, PageStatus } from "@pikos/core";
import { extractText } from "@pikos/core";
```

## Testing

```bash
pnpm test
```

Tests run with Vitest. The `MockStorageAdapter` is the primary test double — it stores data in memory and implements the full `StorageAdapter` interface.
