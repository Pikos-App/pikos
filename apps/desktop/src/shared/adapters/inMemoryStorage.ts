// Nothing may import this module statically: it is the target of an `import()` so the bundler
// puts the ~1,400-line in-memory adapter in its own chunk that production never downloads. A
// static import anywhere would pull the class back into the entry chunk.

import { MockStorageAdapter } from "@pikos/core/testing";

export function createInMemoryStorage(): MockStorageAdapter {
  const adapter = new MockStorageAdapter();
  // `?seedPages=20000` fills the workspace before anything renders, so a perf run can time the
  // interface against a realistic row count. Ignored without a number.
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get("seedPages"));
  if (Number.isFinite(seed) && seed > 0) {
    const bodyWords = Number(params.get("bodyWords"));
    const bodyShape = params.get("bodyShape") === "log" ? "log" : "prose";
    adapter.seedPages(seed, {
      bodyShape,
      completedEvery: 5,
      ...(Number.isFinite(bodyWords) && bodyWords > 0 ? { bodyWords } : {}),
    });
    // Building two million objects takes seconds; this keeps the scale benchmark from reporting
    // seeding and booting as one number.
    performance.mark("pikos:seeded");
    // Handed to the scale benchmark to time individual operations against a full workspace.
    (window as unknown as { __pikosStorage?: unknown }).__pikosStorage = adapter;
  }
  return adapter;
}
