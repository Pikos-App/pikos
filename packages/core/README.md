# @pikos/core

The shared TypeScript library for the apps: domain types, the storage adapter interface and its in-memory test double, the Quick Add parser, and pure utilities.

## Where new code goes

Here goes anything the desktop app and another consumer both need that has no UI and no platform in it. Code that needs React belongs in `apps/desktop` or `packages/ui`. Code that needs Tauri belongs in `apps/desktop/src/shared/adapters/`.

## Rules

- **Free of React and Tauri.** `core-no-react` and `core-no-tauri` in `.dependency-cruiser.cjs` fail `pnpm verify` on an import of either.
- **Import generated types through the package index.** `src/generated` is rewritten wholesale by `scripts/gen-ts-bindings.sh`, so its layout isn't stable. Apps import from `@pikos/core`, and the same dependency-cruiser config enforces it.
- **`StorageAdapter` is the storage contract.** Production and `MockStorageAdapter` both implement it, and the conformance tests keep them agreeing.

## Testing

```bash
pnpm test
```
