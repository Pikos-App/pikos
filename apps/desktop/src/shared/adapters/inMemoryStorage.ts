// The split point for MockStorageAdapter.
//
// Nothing may import this module statically. Its only job is to be the target
// of an `import()` so the bundler puts the ~1,400-line in-memory adapter in a
// chunk of its own — a production build never runs in test mode, so it should
// never download it. A static import anywhere would pull the class straight
// back into the entry chunk and quietly undo that.

import { MockStorageAdapter } from "@pikos/core/testing";

export function createInMemoryStorage(): MockStorageAdapter {
  return new MockStorageAdapter();
}
