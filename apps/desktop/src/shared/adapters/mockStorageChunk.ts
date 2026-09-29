// Registry in front of the in-memory adapter, which lives behind an import()
// so production never downloads it (see ./inMemoryStorage).
//
// WorkspaceProvider picks its adapter during a render, which cannot await, so
// the factory has to be registered before anything renders. The two test-mode
// entry points do that differently on purpose:
//
//   - src/main.tsx (the e2e browser build) awaits `loadMockStorage()`, which is
//     the import() the whole split exists for.
//   - src/test/renderWithProviders.tsx registers a factory it imported
//     statically. Vitest has no bundle to keep small, and that module is what
//     every spec rendering the provider already goes through — so the specs
//     that never touch it don't pay to load the adapter at all.
//
// `requireMockStorage` throws rather than falling back to a render-nothing
// state: missing the registration is a wiring mistake in a new entry point, and
// a named error at the point of use is a much shorter path to the fix than a
// component tree that silently never mounts.

import type { StorageAdapter } from "@pikos/core";

export type MockStorageFactory = () => StorageAdapter;

let factory: MockStorageFactory | null = null;

/** Register a factory obtained by other means (see src/test/setup.ts). */
export function setMockStorageFactory(create: MockStorageFactory): void {
  factory = create;
}

/** Pull the in-memory adapter's chunk in and register it. Idempotent. */
export async function loadMockStorage(): Promise<void> {
  factory ??= (await import("./inMemoryStorage")).createInMemoryStorage;
}

/** Construct an in-memory adapter. Requires one of the two calls above to have run. */
export function requireMockStorage(): StorageAdapter {
  if (!factory) {
    throw new Error(
      "In-memory storage not registered — call loadMockStorage() before rendering in test mode"
    );
  }
  return factory();
}
