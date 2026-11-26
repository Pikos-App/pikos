// Registry in front of the in-memory adapter, which lives behind an import() so production never
// downloads it (see ./inMemoryStorage).
//
// WorkspaceProvider picks its adapter during a render, which cannot await, so the factory must be
// registered before anything renders. src/main.tsx (the e2e browser build) awaits
// `loadMockStorage()`; src/test/renderWithProviders.tsx registers a factory it imported
// statically, since Vitest has no bundle to keep small and specs that never touch it don't pay
// to load the adapter.
//
// `requireMockStorage` throws rather than falling back to a render-nothing state: a missing
// registration is a wiring mistake in a new entry point, and a named error at the point of use
// beats a component tree that silently never mounts.

import type { StorageAdapter } from "@pikos/core";

export type MockStorageFactory = () => StorageAdapter;

let factory: MockStorageFactory | null = null;

export function setMockStorageFactory(create: MockStorageFactory): void {
  factory = create;
}

export async function loadMockStorage(): Promise<void> {
  factory ??= (await import("./inMemoryStorage")).createInMemoryStorage;
}

export function requireMockStorage(): StorageAdapter {
  if (!factory) {
    throw new Error(
      "In-memory storage not registered — call loadMockStorage() before rendering in test mode"
    );
  }
  return factory();
}
